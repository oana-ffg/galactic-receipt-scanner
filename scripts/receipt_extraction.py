#!/usr/bin/env python3
"""Offline, resumable extraction workspace. Makes no network/model calls."""

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import unicodedata

ROOT = Path(__file__).resolve().parent.parent
TYPES = {"receipt", "invoice", "credit_note", "payment_slip", "voucher", "other", "unknown"}
FINANCIAL = {"receipt", "invoice", "credit_note"}
SCHEMA = json.loads((ROOT / "scripts/receipt_extract_schema.json").read_text())


def now():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def save_immutable(path, value):
    """Publish a complete fsynced file without replacing an existing artifact."""
    path = Path(path)
    data = (encoded(value) + "\n").encode()
    if path.exists():
        require(path.read_bytes() == data, f"Immutable artifact already exists: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        try:
            os.link(name, path)  # Atomic create-if-absent, also under concurrent writers.
            if os.name == "posix":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        except FileExistsError:
            require(path.read_bytes() == data, f"Immutable artifact conflict: {path}")
    finally:
        Path(name).unlink(missing_ok=True)


def schema_validate(value, schema, location="result"):
    """Validate the finite JSON-schema subset used by our shared worker contract."""
    types = schema.get("type", [])
    types = [types] if isinstance(types, str) else types
    actual = ("null" if value is None else "boolean" if type(value) is bool else
              "integer" if type(value) is int else "number" if type(value) is float else
              "string" if isinstance(value, str) else "array" if isinstance(value, list) else
              "object" if isinstance(value, dict) else "invalid")
    require(actual in types or (actual == "integer" and "number" in types), f"Invalid type at {location}")
    if "enum" in schema:
        require(value in schema["enum"], f"Invalid value at {location}")
    if actual == "object":
        properties = schema.get("properties", {})
        require(all(k in value for k in schema.get("required", [])), f"Missing required fields at {location}")
        if schema.get("additionalProperties") is False:
            require(not (value.keys() - properties.keys()), f"Unexpected fields at {location}")
        for k, v in value.items():
            if k in properties:
                schema_validate(v, properties[k], location + "." + k)
    if actual == "array":
        require(len(value) <= 1000, f"Too many entries at {location}")
        for item in value:
            schema_validate(item, schema["items"], location + "[]")


def text(value, name, nullable=False):
    require((nullable and value is None) or
            (isinstance(value, str) and 0 < len(value.strip()) <= 20000),
            f"Invalid {name}")


def money(value, name, nullable=False):
    require((nullable and value is None) or
            (type(value) is int and abs(value) <= 100_000_000_000),
            f"{name} must be signed integer minor units or explicitly unknown")


def validate(result):
    require(isinstance(result, dict), "Expected extraction object")
    schema_validate({k: v for k, v in result.items() if k not in {"source_id", "sha256"}}, SCHEMA)
    for key in ("source_id", "sha256", "document_type", "evidence"):
        text(result.get(key), key)
    require(re.fullmatch(r"[a-f0-9]{64}", result["sha256"]), "Invalid source hash")
    kind = result["document_type"]
    require(kind in TYPES, "Invalid document_type")
    for key in ("not_invoice", "has_handwriting"):
        require(result.get(key) is None or type(result.get(key)) is bool,
                f"{key} must be boolean or null")
        require(key in result, f"Missing {key}")
    expected = None if kind == "unknown" else kind not in FINANCIAL
    require(result["not_invoice"] is expected, "not_invoice contradicts document_type")
    for key in ("vendor", "receipt_date", "currency", "reference"):
        require(key in result, f"Missing {key}")
        text(result[key], key, nullable=True)
    if result["receipt_date"] is not None:
        require(re.fullmatch(r"\d{4}-\d{2}-\d{2}", result["receipt_date"]), "Use YYYY-MM-DD")
        date.fromisoformat(result["receipt_date"])
    if result["currency"] is not None:
        require(re.fullmatch(r"[A-Z]{3}", result["currency"]), "Use currency code")
    money(result.get("printed_total_minor"), "printed_total_minor", nullable=True)
    require("printed_total_minor" in result, "Missing printed_total_minor")
    for key in ("charged_total_minor", "included_tax_minor"):
        if key in result:
            money(result[key], key, nullable=True)
    require(result.get("arithmetic_basis") in {"gross", "net-plus-tax", "unknown"},
            "Invalid arithmetic_basis")
    require(result.get("completeness") in {"complete", "fragment", "uncertain"}, "Invalid completeness")
    for key in ("line_items", "adjustments", "handwritten_notes", "uncertainties"):
        require(isinstance(result.get(key), list) and len(result[key]) <= 1000, f"Invalid {key}")
    for item in result["line_items"]:
        require(isinstance(item, dict), "Invalid line item")
        text(item.get("description"), "line description")
        require("amount_minor" in item, "Missing line amount")
        money(item["amount_minor"], "line amount", nullable=True)
        if "unit_price_minor" in item:
            money(item["unit_price_minor"], "unit price", nullable=True)
        if item.get("quantity") is not None:
            require(type(item["quantity"]) in (int, float) and
                    abs(item["quantity"]) <= 1_000_000, "Invalid quantity")
    for item in result["adjustments"]:
        require(isinstance(item, dict), "Invalid adjustment")
        text(item.get("label"), "adjustment label")
        money(item.get("amount_minor"), "adjustment amount")
    if "payment_adjustments" in result:
        require(isinstance(result["payment_adjustments"], list) and
                len(result["payment_adjustments"]) <= 100, "Invalid payment_adjustments")
        for item in result["payment_adjustments"]:
            require(isinstance(item, dict), "Invalid payment adjustment")
            text(item.get("label"), "payment adjustment label")
            money(item.get("amount_minor"), "payment adjustment amount")
    for note in result["handwritten_notes"]:
        require(isinstance(note, dict), "Invalid handwriting note")
        text(note.get("text"), "handwriting text", nullable=True)
        require(type(note.get("uncertain")) is bool, "Specify handwriting uncertainty")
        require(note["box"] is not None or (note["uncertain"] and result["uncertainties"]),
                "Unknown handwriting location needs an explicit uncertainty")
        if note["box"] is not None:
            box = note["box"]
            require(len(box) == 4 and all(type(n) is int for n in box) and
                    0 <= box[0] < box[2] and 0 <= box[1] < box[3], "Invalid handwriting box")
    require(not result["handwritten_notes"] or result["has_handwriting"] is not False,
            "Notes contradict absent handwriting")
    for uncertainty in result["uncertainties"]:
        text(uncertainty, "uncertainty")


def arithmetic(result):
    if result["document_type"] not in FINANCIAL:
        return "not_applicable", None, None
    amounts = [item["amount_minor"] for item in result["line_items"]]
    if (result["completeness"] != "complete" or not amounts or None in amounts or
            result["printed_total_minor"] is None or result["currency"] is None or
            result["arithmetic_basis"] == "unknown"):
        return "incomplete", None, None
    total = sum(amounts) + sum(a["amount_minor"] for a in result["adjustments"])
    difference = total - result["printed_total_minor"]
    return ("matched" if difference == 0 else "mismatch"), total, difference


def payment_arithmetic(result):
    charged = result.get("charged_total_minor")
    printed = result["printed_total_minor"]
    adjustments = result.get("payment_adjustments")
    if charged is None or printed is None or adjustments is None:
        return None
    return printed + sum(a["amount_minor"] for a in adjustments) - charged


def processing_status(result, check):
    # A model mismatch needs another extraction attempt, not a claim of broken paper.
    if result["completeness"] == "fragment":
        return "awaiting_pages"
    if (result["document_type"] == "unknown" or result["has_handwriting"] is None or
            result["uncertainties"] or result["completeness"] == "uncertain" or
            any(n["uncertain"] or n["text"] is None for n in result["handwritten_notes"])):
        return "needs_processing"
    if result["not_invoice"]:
        return "not_invoice"
    if (not result["vendor"] or not result["receipt_date"] or check != "matched" or
            payment_arithmetic(result) not in (None, 0) or
            (result.get("payment_adjustments") and result.get("charged_total_minor") is None)):
        return "needs_processing"
    return "extracted"  # Never implies verified, grouped or ready for accounting.


def filename_base(result):
    if not result["vendor"] or not result["receipt_date"]:
        return None
    vendor = unicodedata.normalize("NFKC", result["vendor"]).lower()
    vendor = re.sub(r"[^\w]+", "_", vendor, flags=re.UNICODE).strip("_")[:100]
    return f'{result["receipt_date"]}_{vendor}' if vendor else None


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not path.exists():
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        except FileExistsError:
            pass
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript((ROOT / "db/receipt-extraction.sql").read_text())
    return db


def add_sources(db, manifest):
    items = manifest["samples"]
    with db:
        for item in items:
            source_id = item["captureId"]
            text(source_id, "captureId")
            scanned = item["scanned_at"]
            require(datetime.fromisoformat(scanned.replace("Z", "+00:00")).tzinfo is not None,
                    "Scan time needs timezone")
            dimensions = item.get("source_pixels")
            require(isinstance(dimensions, list) and len(dimensions) == 2 and
                    all(type(n) is int and 0 < n <= 100000 for n in dimensions),
                    "source_pixels must be original [width,height] positive integers")
            original = Path(item["original"]).resolve()
            digest = sha(original.read_bytes())
            require(digest == item["sha256"], f"Original hash mismatch: {source_id}")
            existing = db.execute("SELECT * FROM extraction_sources WHERE id=?", (source_id,)).fetchone()
            if existing:
                require(existing["sha256"] == digest and existing["scanned_at"] == scanned and
                        json.loads(existing["metadata_json"]).get("source_pixels") == dimensions,
                        f"Conflicting immutable source: {source_id}")
                continue
            db.execute("INSERT INTO extraction_sources VALUES(?,?,?,?,?)",
                       (source_id, digest, scanned, str(original), encoded(item)))


def add_run(db, run_id, engine, model, prompt_version):
    for v in (run_id, engine, model, prompt_version):
        text(v, "run metadata")
    with db:
        row = db.execute("SELECT * FROM extraction_runs WHERE id=?", (run_id,)).fetchone()
        if row:
            require((row["engine"], row["model"], row["prompt_version"]) ==
                    (engine, model, prompt_version), "Run metadata conflict; create a new run")
        else:
            db.execute("INSERT INTO extraction_runs VALUES(?,?,?,?,?)",
                       (run_id, engine, model, prompt_version, now()))


def import_results(db, run_id, results, evidence=None):
    require(isinstance(results, list), "Expected array of extraction records")
    require(db.execute("SELECT 1 FROM extraction_runs WHERE id=?", (run_id,)).fetchone(), "Unknown run")
    with db:
        for result in results:
            validate(result)
            source = db.execute("SELECT * FROM extraction_sources WHERE id=?", (result["source_id"],)).fetchone()
            require(source and source["sha256"] == result["sha256"], "Unknown or conflicting source hash")
            dimensions = json.loads(source["metadata_json"]).get("source_pixels")
            for note in result["handwritten_notes"]:
                if note["box"] is not None:
                    require(isinstance(dimensions, list) and len(dimensions) == 2 and
                            note["box"][2] <= dimensions[0] and note["box"][3] <= dimensions[1],
                            "Handwriting box exceeds registered original dimensions")
            payload = encoded(result)
            digest = sha(payload.encode())
            existing = db.execute("SELECT payload_sha256 FROM extraction_results WHERE run_id=? AND source_id=?",
                                  (run_id, result["source_id"])).fetchone()
            if existing:
                require(existing[0] == digest, "Result already saved; retain it and create a new run for corrections")
                continue
            check, total, difference = arithmetic(result)
            base = filename_base(result)
            filename = None
            if base:
                suffix = 1
                while True:
                    filename = base + ("" if suffix == 1 else f"_{suffix}") + ".pdf"
                    if not db.execute("SELECT 1 FROM extraction_results WHERE run_id=? AND filename=?",
                                      (run_id, filename)).fetchone():
                        break
                    suffix += 1
            db.execute("""INSERT INTO extraction_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (run_id, result["source_id"], digest, now(), result["document_type"],
                        result["not_invoice"], result["has_handwriting"], result["vendor"],
                        result["receipt_date"], result["currency"], result["printed_total_minor"],
                        total, difference, check, processing_status(result, check), filename, payload))
            provenance = evidence or {"kind": "direct_payload", "payload_sha256": digest}
            db.execute("INSERT INTO extraction_evidence VALUES(?,?,?)",
                       (run_id, result["source_id"], encoded(provenance)))


def audit_run(db, run_id):
    run = db.execute("SELECT * FROM extraction_runs WHERE id=?", (run_id,)).fetchone()
    require(run is not None, "Unknown run")
    source_count = db.execute("SELECT COUNT(*) FROM extraction_sources").fetchone()[0]
    imported = db.execute("SELECT COUNT(*) FROM extraction_results WHERE run_id=?", (run_id,)).fetchone()[0]
    unresolved = db.execute("""SELECT a.* FROM extraction_attempts a WHERE a.run_id=? AND NOT EXISTS
        (SELECT 1 FROM extraction_results r WHERE r.run_id=a.run_id AND r.source_id=a.source_id)""", (run_id,)).fetchall()
    return {"run": dict(run), "registered_sources": source_count, "imported_results": imported,
            "pending_results": source_count - imported,
            "attempts_without_result": [dict(row) for row in unresolved]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="Private SQLite path (keep outside tracked source)")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("sources"); p.add_argument("manifest")
    p = sub.add_parser("run")
    for name in ("id", "engine", "model", "prompt_version"): p.add_argument(name)
    p = sub.add_parser("import"); p.add_argument("run"); p.add_argument("results")
    p = sub.add_parser("status"); p.add_argument("run")
    p = sub.add_parser("pending"); p.add_argument("run"); p.add_argument("--limit", type=int, default=10)
    p = sub.add_parser("export"); p.add_argument("run")
    args = parser.parse_args()
    with connect(args.db) as db:
        if args.command == "sources":
            add_sources(db, json.loads(Path(args.manifest).read_text()))
        elif args.command == "run":
            add_run(db, args.id, args.engine, args.model, args.prompt_version)
        elif args.command == "import":
            raw = Path(args.results).read_bytes()
            import_results(db, args.run, json.loads(raw), evidence={"kind": "worker_file",
                "path": str(Path(args.results).resolve()), "sha256": sha(raw), "run_id": args.run})
        elif args.command == "pending":
            require(1 <= args.limit <= 100, "Limit must be 1..100")
            require(db.execute("SELECT 1 FROM extraction_runs WHERE id=?", (args.run,)).fetchone(), "Unknown run")
            rows = db.execute("""SELECT s.* FROM extraction_sources s WHERE NOT EXISTS
                (SELECT 1 FROM extraction_results r WHERE r.source_id=s.id AND r.run_id=?)
                ORDER BY s.scanned_at,s.id LIMIT ?""", (args.run, args.limit))
            print(encoded([dict(row) for row in rows]))
        elif args.command == "export":
            rows = db.execute("""SELECT r.*,s.scanned_at,s.sha256,s.original_path,e.evidence_json,c.config_json,
                       a.raw_path,a.raw_sha256,a.config_sha256
                FROM extraction_results r JOIN extraction_sources s ON s.id=r.source_id
                LEFT JOIN extraction_evidence e ON e.run_id=r.run_id AND e.source_id=r.source_id
                LEFT JOIN extraction_run_config c ON c.run_id=r.run_id
                LEFT JOIN extraction_attempts a ON a.run_id=r.run_id AND a.source_id=r.source_id
                WHERE r.run_id=? ORDER BY s.scanned_at,s.id""", (args.run,))
            print(encoded({"audit": audit_run(db, args.run), "results": [dict(row) for row in rows]}))
        else:
            counts = db.execute("""SELECT processing_status,arithmetic_status,COUNT(*) AS count
                FROM extraction_results WHERE run_id=? GROUP BY processing_status,arithmetic_status""", (args.run,))
            print(encoded({"audit": audit_run(db, args.run), "counts": [dict(row) for row in counts]}))


if __name__ == "__main__":
    main()
