#!/usr/bin/env python3
"""Run a bounded image extraction batch on an existing private Ollama server."""
import argparse
import base64
import ipaddress
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler, HTTPRedirectHandler, Request

import receipt_extraction as workspace


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Ollama endpoint redirected; refusing to forward private documents")


def private_endpoint(value):
    url = urlsplit(value)
    workspace.require(url.scheme in {"http", "https"} and url.hostname and
                      not url.username and not url.password and not url.query and
                      not url.fragment and url.path in {"", "/"}, "Use a private server origin")
    try:
        address = ipaddress.ip_address(url.hostname)
    except ValueError as error:
        raise ValueError("Use a literal private IP address; resolve hostnames before configuring the client") from error
    networks = [ipaddress.ip_network(n) for n in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]]
    workspace.require(address.is_loopback or any(address in n for n in networks),
                      "Only loopback and private LAN inference endpoints are allowed")
    workspace.require(url.port is None or 1 <= url.port <= 65535, "Invalid endpoint port")
    return value.rstrip("/")


def request(endpoint, route, payload=None, timeout=120):
    # Do not send financial images through environment-configured HTTP proxies.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    data = None if payload is None else workspace.encoded(payload).encode()
    req = Request(endpoint + route, data=data, headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        detail = error.read(65536).decode("utf-8", errors="replace")
        raise ValueError(f"Local inference HTTP {error.code}: {detail}") from error


def check_record(record, source, config_hash, run_id):
    workspace.require(record.get("source_id") == source["id"] and
                      record.get("sha256") == source["sha256"] and
                      record.get("config_sha256") == config_hash and
                      record.get("run_id") == run_id,
                      "Retained attempt has different run/source/configuration")


def register_config(db, run_id, config):
    payload = workspace.encoded(config)
    row = db.execute("SELECT config_json FROM extraction_run_config WHERE run_id=?", (run_id,)).fetchone()
    if row:
        workspace.require(row[0] == payload, "Run configuration/output directory changed; use a new run")
    else:
        with db:
            db.execute("INSERT INTO extraction_run_config VALUES(?,?)", (run_id, payload))


def register_attempt(db, run_id, source_id, path, config_hash):
    digest = workspace.sha(path.read_bytes())
    values = (str(path.resolve()), digest, config_hash)
    row = db.execute("SELECT raw_path,raw_sha256,config_sha256 FROM extraction_attempts WHERE run_id=? AND source_id=?",
                     (run_id, source_id)).fetchone()
    if row:
        workspace.require(tuple(row) == values, "Retained raw attempt was changed")
    else:
        with db:
            db.execute("INSERT INTO extraction_attempts VALUES(?,?,?,?,?)", (run_id, source_id, *values))
    return {"kind": "local_inference", "path": values[0], "sha256": digest,
            "config_sha256": config_hash, "run_id": run_id}


def verify_imported_attempt(db, run_id, source_id):
    row = db.execute("SELECT raw_path,raw_sha256 FROM extraction_attempts WHERE run_id=? AND source_id=?",
                     (run_id, source_id)).fetchone()
    workspace.require(row and Path(row["raw_path"]).is_file(), "Imported result raw evidence is missing")
    workspace.require(workspace.sha(Path(row["raw_path"]).read_bytes()) == row["raw_sha256"],
                      "Imported result raw evidence changed")


def check_response(record, config):
    response = record["response"]
    workspace.require(response.get("model") == config["model"], "Inference response model differs from requested model")
    workspace.require(record.get("postflight_digest") == config["digest"], "Model digest changed during inference")
    workspace.require(response.get("done") is True and response.get("done_reason") != "length",
                      "Incomplete generation retained; use a new run to retry")
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--db", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--output", required=True, help="Private raw-response directory")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--source-id", action="append", default=[])
    args = parser.parse_args()
    workspace.require(1 <= args.limit <= 100, "Limit must be 1..100")
    workspace.require(len(set(args.source_id)) == len(args.source_id) and
                      len(args.source_id) <= args.limit, "Source selection must be unique and fit --limit")
    endpoint = private_endpoint(args.endpoint)
    workspace.require("cloud" not in args.model.lower(), "Cloud models are not allowed")
    installed = request(endpoint, "/api/tags")
    model = next((m for m in installed["models"] if m["name"] == args.model), None)
    workspace.require(model and model.get("size", 0) > 0, "Model must already be installed locally")
    details = request(endpoint, "/api/show", {"model": args.model})
    workspace.require("vision" in details.get("capabilities", []), "Selected model does not support image input")
    workspace.require(not details.get("remote_host") and not details.get("remote_model"), "Remote/cloud model refused")
    prompt = (Path(__file__).with_name("receipt_extract_prompt.txt")).read_text()
    schema = json.loads(Path(__file__).with_name("receipt_extract_schema.json").read_text())
    version = workspace.sha((prompt + workspace.encoded(schema)).encode())
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = {"run_id": args.run, "output_directory": str(output.resolve()),
              "endpoint": endpoint, "model": args.model, "digest": model["digest"],
              "prompt_sha256": version, "schema": schema, "options": {"temperature": 0, "num_predict": 6000},
              "image_transform": "none: original bytes"}
    config_path = output / "run.json"
    config_hash = workspace.sha(workspace.encoded(config).encode())
    failures = 0
    with workspace.connect(args.db) as db:
        workspace.add_run(db, args.run, "ollama-local", args.model + "@" + model["digest"], version)
        register_config(db, args.run, config)
        workspace.save_immutable(config_path, config)
        for source_id in args.source_id:
            workspace.require(db.execute("SELECT 1 FROM extraction_sources WHERE id=?", (source_id,)).fetchone(),
                              "Unknown source selection: " + source_id)
            if db.execute("SELECT 1 FROM extraction_results WHERE source_id=? AND run_id=?", (source_id, args.run)).fetchone():
                verify_imported_attempt(db, args.run, source_id)
                print(workspace.encoded({"source_id": source_id, "status": "already_imported_verified"}), flush=True)
        if not args.source_id:
            for row in db.execute("SELECT source_id FROM extraction_results WHERE run_id=?", (args.run,)):
                verify_imported_attempt(db, args.run, row[0])
        rows = db.execute("""SELECT s.* FROM extraction_sources s WHERE NOT EXISTS
            (SELECT 1 FROM extraction_results r WHERE r.source_id=s.id AND r.run_id=?)
            ORDER BY s.scanned_at,s.id""", (args.run,)).fetchall()
        if args.source_id:
            rows = [r for r in rows if r["id"] in args.source_id]
        for source in rows[:args.limit]:
            source_id = source["id"]
            raw_path = output / (workspace.sha(source_id.encode()) + ".json")
            if raw_path.exists():
                try:
                    record = json.loads(raw_path.read_text())
                    check_record(record, source, config_hash, args.run)
                    register_attempt(db, args.run, source_id, raw_path, config_hash)
                except (ValueError, KeyError, TypeError) as error:
                    failures += 1
                    print(workspace.encoded({"source_id": source_id, "status": "invalid_retained_attempt", "error": str(error)}), flush=True)
                    continue
                print(workspace.encoded({"source_id": source_id, "status": "saved_attempt_retained"}), flush=True)
                if record.get("error"):
                    failures += 1
                    continue
            else:
                original = Path(source["original_path"]).read_bytes()
                workspace.require(workspace.sha(original) == source["sha256"], "Original changed; stop")
                message = {"role": "user", "content": prompt, "images": [base64.b64encode(original).decode()]}
                started = time.monotonic()
                record = {"source_id": source_id, "sha256": source["sha256"], "started_at": workspace.now(),
                          "config_sha256": config_hash, "run_id": args.run}
                try:
                    response = request(endpoint, "/api/chat", {"model": args.model,
                        "messages": [message], "stream": False, "format": schema,
                        "options": config["options"], "keep_alive": "5m"}, args.timeout)
                    record["response"] = response
                    after = request(endpoint, "/api/tags")
                    record["postflight_digest"] = next((m.get("digest") for m in after["models"]
                                                         if m["name"] == args.model), None)
                except Exception as error:
                    record["error"] = str(error)
                record["elapsed_seconds"] = time.monotonic() - started
                workspace.save_immutable(raw_path, record)
            try:
                check_record(record, source, config_hash, args.run)
                evidence = register_attempt(db, args.run, source_id, raw_path, config_hash)
                workspace.require(not record.get("error"), record.get("error"))
                response = check_response(record, config)
                result = json.loads(response["message"]["content"])
                result.update(source_id=source_id, sha256=source["sha256"])
                workspace.import_results(db, args.run, [result], evidence=evidence)
                status = "imported"
            except Exception as error:
                failures += 1
                status = "invalid_or_failed_output: " + str(error)
            print(workspace.encoded({"source_id": source_id, "status": status,
                                     "elapsed_seconds": record.get("elapsed_seconds")}), flush=True)
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
