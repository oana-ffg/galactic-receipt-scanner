"""Produce compact receipt completion evidence from journals and live readback."""
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlencode
import uuid

from receipt_api import UUID
from receipt_worker import require, write_new_file


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def regular_path(path):
    require(not path.is_symlink() and not path.is_junction(), "Verification paths must not redirect.")
    return path


def source_pages(document):
    return [dict(capture_id=page['captureId'], sha256=page.get('sha256')) for page in document['pages']]


def superseded_documents(base, batch, run_id, document, affected_documents):
    """Prove that an earlier counted result was wholly absorbed, not merely touched."""
    superseded = []
    target_pages = document['pages']
    target_ids = [page['captureId'] for page in target_pages]
    absorbed = {did for did, value in affected_documents.items()
                if value.get('mergedInto') == document['id'] and not value['pages']}
    archived = {rid: item['proof'] for rid, item in batch.get('superseded_runs', {}).items()
                if item['replaced_by'] == run_id}
    require(all(proof['document_id'] in affected_documents for proof in archived.values()),
            'A previously superseded document is missing from the replacement acknowledgement.')
    previous_proofs = {**batch.get('verified_runs', {}), **archived}
    for previous_run, proof in previous_proofs.items():
        if previous_run == run_id or proof['document_id'] not in affected_documents:
            continue
        require(previous_run != run_id and len(previous_run) == 32
                and all(c in '0123456789abcdef' for c in previous_run), 'Invalid previous verification run.')
        require(proof['document_id'] != document['id'], 'Do not count the same document twice in one batch.')
        previous = read_json(regular_path(regular_path(base / previous_run) / 'state.json'))
        old = previous['document']
        current = affected_documents[proof['document_id']]
        require(previous['run_id'] == previous_run and previous['phase'] == 'complete'
                and not previous.get('failed') and previous.get('batch_id', batch['batch_id']) == batch['batch_id']
                and old['id'] == proof['document_id'] and old['revision'] == proof['revision']
                and [page['captureId'] for page in old['pages']] == proof['capture_ids']
                and current['revision'] == old['revision'] + 1,
                'Affected previous completion changed outside this verified merge.')
        require('source_pages' not in proof or source_pages(old) == proof['source_pages'],
                'Previous source hashes differ from the archived verification proof.')
        if old.get('duplicateOf') in absorbed:
            require(current.get('duplicateOf') == document['id'] and not current.get('mergedInto')
                    and current['pages'] == old['pages'],
                    'A retargeted duplicate must preserve its original pages and retained destination.')
        else:
            require(old['pages'] and current['id'] in absorbed and not current.get('duplicateOf'),
                    'An affected previous completion must be wholly merged into the new document.')
            old_ids = [page['captureId'] for page in old['pages']]
            start = target_ids.index(old_ids[0]) if old_ids[0] in target_ids else -1
            retained = target_pages[start:start + len(old_ids)] if start >= 0 else []
            require([page['captureId'] for page in retained] == old_ids
                    and all(page.get('sha256') and page['sha256'] == other.get('sha256')
                            for page, other in zip(old['pages'], retained)),
                    'The new document must preserve every prior source hash and its consecutive page order.')
        superseded.append(dict(run_id=previous_run, document_id=old['id'],
                               from_revision=old['revision'], to_revision=current['revision'],
                               relationship='duplicate' if old.get('duplicateOf') in absorbed else 'merged'))
    return superseded


def verify_run(repo, run_id, owner, *, client):
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
    require(isinstance(submit.get('saved'), list) and all(isinstance(item, dict)
            and isinstance(item.get('id'), str) and type(item.get('revision')) is int and item['revision'] > 0
            for item in submit['saved']), 'Invalid affected-document acknowledgement.')
    saved_ids = [item["id"] for item in submit["saved"]]
    require(len(saved_ids) == len(set(saved_ids))
            and all(isinstance(did, str) and UUID.fullmatch(did) for did in saved_ids),
            "Submit acknowledgement contains invalid affected documents.")
    saved = [d for d in submit["saved"] if d["id"] == document_id]
    require(len(saved) == 1, "Submit acknowledgement must identify this document exactly once.")
    affected = state["draft"].get("documents")
    drafted_ids = [document["id"] for document in affected] if affected is not None else [document_id]
    require(len(drafted_ids) == len(set(drafted_ids))
            and all(isinstance(did, str) and UUID.fullmatch(did) for did in drafted_ids)
            and document_id in drafted_ids,
            "Draft affected-document history is invalid.")
    require(set(saved_ids) >= set(drafted_ids),
            "Submit acknowledgement omitted an affected document.")
    affected_ids = saved_ids

    host = read_json(regular_path(repo / ".local" / "processing-host.json"))
    profile_path = Path(host["worker_profile"])
    require(profile_path.is_absolute(), "Prepared worker profile must be absolute.")
    profile = read_json(regular_path(profile_path))
    require(Path(profile["repository"]).resolve() == repo.resolve(), "Prepared profile belongs to another checkout.")
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
    affected_documents = {document_id: document}
    for acknowledgement in submit['saved']:
        did = acknowledgement['id']
        if did == document_id:
            continue
        current = client.get('/api/documents/' + did)['document']
        require(current['id'] == did and current['revision'] == acknowledgement['revision'],
                'An affected document changed after submission.')
        intended_document = next((item for item in affected or [] if item['id'] == did), None)
        if intended_document is not None:
            require(current['revision'] == intended_document['revision'] + 1
                    and current['pages'] == intended_document['pages']
                    and current.get('mergedInto') == intended_document.get('mergedInto')
                    and current.get('duplicateOf') == intended_document.get('duplicateOf'),
                    'Saved donor pages or relationships differ from the frozen merge.')
        affected_documents[did] = current
    superseded = superseded_documents(base, batch, run_id, document, affected_documents)
    summary = dict(verified=True, batch_id=batch["batch_id"], batch_phase=batch["phase"], run_id=run_id, document_id=document_id,
                   affected_document_ids=affected_ids,
                   superseded_run_ids=[item['run_id'] for item in superseded],
                   superseded_documents=superseded, source_pages=source_pages(document),
                   capture_ids=actual, page_count=len(actual), status=document["status"],
                   revision=document["revision"], claim_closed=True, attempt_saved=True,
                   pdf_applicable=applicable, pdf_sha256=pdf_hash,
                   pdf_validation="source-layout-and-upload" if structural else "visual" if applicable else "inapplicable",
                   checked_at=time.time())
    proof = work / ("verification-" + uuid.uuid4().hex + ".json")
    write_new_file(proof, json.dumps(summary).encode("utf-8"))
    return {**summary, "verification_file": str(proof)}
