"""Produce compact receipt completion evidence from journals and live readback."""
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlencode
import uuid

from receipt_api import ScannerClient, UUID, credentials
from receipt_worker import require, write_new_file


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def regular_path(path):
    require(not path.is_symlink() and not path.is_junction(), "Verification paths must not redirect.")
    return path


def verify_run(repo, run_id, owner):
    require(isinstance(run_id, str) and len(run_id) == 32
            and all(c in "0123456789abcdef" for c in run_id), "Invalid worker run ID.")
    base = regular_path(regular_path(repo / ".local") / "receipt-worker")
    batch = read_json(regular_path(base / "batch-state.json"))
    batch_id = batch["batch_id"]
    require(isinstance(batch_id, str) and len(batch_id) == 32
            and all(c in "0123456789abcdef" for c in batch_id)
            and batch["phase"] in {"active", "blocked"} and batch["owner"] == owner,
            "Verification requires the current active or blocked batch and its exact owner.")
    work = regular_path(base / run_id)
    state = read_json(regular_path(work / "state.json"))
    require(state["run_id"] == run_id and state["phase"] == "complete" and not state.get("failed"),
            "Worker is failed or unfinished; it cannot count as verified completion.")
    require(state["claim_started"] >= batch["started_at"], "Worker predates the current batch.")
    require(state.get("batch_id", batch_id) == batch_id, "Worker belongs to a different batch.")
    claim = state["claim"]
    document_id = claim["document"]["id"]
    require(isinstance(document_id, str) and UUID.fullmatch(document_id), "Invalid claimed document ID.")
    require(isinstance(claim["token"], str) and bool(claim["token"]), "Missing checkpoint token.")
    submit_name = state["submit_response"]
    require(isinstance(submit_name, str) and submit_name not in {"", ".", ".."}
            and "/" not in submit_name and "\\" not in submit_name and ":" not in submit_name,
            "Submit response must name a journal file in this run.")
    submit = read_json(regular_path(work / submit_name))
    saved = [d for d in submit["saved"] if d["id"] == document_id]
    require(len(saved) == 1, "Submit acknowledgement must identify this document exactly once.")

    host = read_json(regular_path(repo / ".local" / "processing-host.json"))
    profile_path = Path(host["worker_profile"])
    require(profile_path.is_absolute(), "Prepared worker profile must be absolute.")
    profile = read_json(regular_path(profile_path))
    require(Path(profile["repository"]).resolve() == repo.resolve(), "Prepared profile belongs to another checkout.")
    client = ScannerClient(credentials(profile["client_config"]))
    require(client.origin == profile["origin"] == state["origin"], "Verification destination differs from the worker.")
    checkpoint = client.get("/api/processing/readings?" + urlencode({
        "document_id": document_id, "checkpoint_token": claim["token"],
    }))
    require(checkpoint.get("claim_active") is False and checkpoint.get("attempt_saved") is True,
            "The saved attempt or closed claim could not be verified.")
    document = client.get("/api/documents/" + document_id)["document"]
    require(document["id"] == document_id == state["document"]["id"], "Document identity differs.")
    intended = state["draft"]["page_review"]["capture_ids"]
    frozen = [page["captureId"] for page in state["draft"]["target"]["pages"]]
    actual = [page["captureId"] for page in document["pages"]]
    require(intended == frozen == actual and document["pages"] == state["document"]["pages"],
            "Intended, journal and saved page order or layout differ.")
    applicable = bool(document.get("filename") and not document.get("duplicateOf") and not document.get("mergedInto"))
    structural = (state.get("input_mode") == "ppocr-first"
                  and state.get("pdf_validation") == "source-layout-and-upload"
                  and state.get("layout_approval", {}).get("visual") is False)
    require(document["revision"] == state["document"]["revision"]
            == saved[0]["revision"] + int(applicable and not structural),
            "Saved document revision differs from the completed worker and PDF attestation.")
    pdf_hash = None
    if applicable:
        pdf_hash = state["pdf"]["sha256"]
        require(pdf_hash == document["pdf"]["sha256"]
                and state["pdf"]["pages"] == len(actual),
                "Final PDF attestation or page count differs.")
        if structural:
            require(document["checks"]["pdf"] is False and document["reviewedPdfSha256"] is None
                    and document["pdf"]["revision"] == state["pdf"]["revision"] == document["revision"],
                    "OCR-first PDF must preserve the distinction between an upload and visual review.")
            require(hashlib.sha256(regular_path(Path(state["pdf"]["path"])).read_bytes()).hexdigest() == pdf_hash,
                    "Generated PDF changed after upload.")
        else:
            require(document["checks"]["pdf"] is True and document["reviewedPdfSha256"] == pdf_hash,
                    "Final PDF visual attestation differs.")
    summary = dict(verified=True, batch_id=batch["batch_id"], batch_phase=batch["phase"], run_id=run_id, document_id=document_id,
                   capture_ids=actual, page_count=len(actual), status=document["status"],
                   revision=document["revision"], claim_closed=True, attempt_saved=True,
                   pdf_applicable=applicable, pdf_sha256=pdf_hash,
                   pdf_validation="source-layout-and-upload" if structural else "visual" if applicable else "inapplicable",
                   checked_at=time.time())
    proof = work / ("verification-" + uuid.uuid4().hex + ".json")
    write_new_file(proof, json.dumps(summary).encode("utf-8"))
    return {**summary, "verification_file": str(proof)}
