"""Synthetic protocol/state tests; never contact a deployed scanner."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import receipt_worker as module
from receipt_api import ClientError

DID = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
FOREIGN = "00000000-0000-4000-8000-000000000003"
TOKEN = "synthetic-claim-token"


def extraction():
    return dict(type="receipt", vendor="Synthetic Shop", receipt_date="2026-01-01", reference=None,
        currency="DKK", has_handwriting=False, has_payment_slip=False, confirmed_arithmetic_mismatch=False,
        payment_status="approved", card_last_four=None,
        line_items=[dict(description="Synthetic item", quantity=None, unit_price_minor=None, amount_minor=100)],
        adjustments=[], payment_adjustments=[], total_minor=100, charged_total_minor=100, vat_minor=None,
        tax_basis="gross", completeness="complete", category_id=None, certainty="high", uncertainties=[],
        broken_reasons=[], evidence="Synthetic fixture only.")


class FakeScanner:
    origin = "https://scanner.example.test"

    def __init__(self):
        self.calls, self.submit_bytes = [], []
        self.raw = {did: ("synthetic source " + did).encode() for did in (DID, OTHER)}
        self.documents = {}
        for did in (DID, OTHER):
            sha = hashlib.sha256(self.raw[did]).hexdigest()
            self.documents[did] = dict(id=did, revision=2, pages=[dict(captureId=did, sha256=sha, rotation=0, crop=None)],
                filename=None, mergedInto=None, duplicateOf=None, annotations=[], handwriting="absent",
                checks=dict(visual=False, transcription=False, grouping=False, pdf=False), invoice=None,
                reviewedPdfSha256=None, uncertainties=[], broken=[], evidence="", processing=None, status="unprocessed")
        self.lost_submit = False
        self.submitted = False
        self.lost_pdf = False
        self.lost_pdf_before_storage = False
        self.pdf_uploads = []
        self.lost_claim = False

    def get(self, path):
        self.calls.append(("GET", path))
        if path == "/api/processing/access":
            return {"version": 2, "queueClaims": True}
        if path == "/api/processing/categories":
            return []
        if path.startswith("/api/processing/context?"):
            source = self.documents[OTHER]["pages"][0]
            return dict(document=deepcopy(self.documents[DID]), candidates=[],
                next_images=[dict(id=OTHER, sha256=source["sha256"], document_id=OTHER)],
                rejected_associations=[], candidates_truncated=False)
        if path.startswith("/api/documents/"):
            return {"document": deepcopy(self.documents[path.rsplit("/", 1)[1]])}
        raise AssertionError("Unexpected read")

    def request(self, path, data=None, content_type=None):
        self.calls.append(("POST", path))
        if content_type == "application/pdf":
            self.pdf_uploads.append(data)
            sha = hashlib.sha256(data).hexdigest()
            self.documents[DID]["pdf"] = {"sha256": sha, "revision": self.documents[DID]["revision"]}
            return json.dumps(self.documents[DID]["pdf"]).encode()
        body = json.loads(data)
        if path.endswith("/claim"):
            if self.lost_claim:
                raise ClientError("Scanner connection failed; check connectivity and retry.")
            return json.dumps({"claim": dict(token=TOKEN, expires=time.time()*1000+1200000,
                stage="small", document=deepcopy(self.documents[DID]))}).encode()
        if path.endswith("/renew"):
            return json.dumps({"expires": time.time()*1000+1200000}).encode()
        if path.endswith("/release"):
            return b'{"released":true}'
        if path.endswith("/submit"):
            self.submit_bytes.append(data)
            if not self.submitted:
                for doc in body.get("documents", [self.documents[DID]]):
                    saved = deepcopy(doc)
                    saved["revision"] += 1
                    if doc["id"] == DID:
                        saved["filename"] = "2026-01-01_synthetic.pdf" if body["extraction"]["vendor"] else None
                        saved["status"] = "model-review"
                    self.documents[doc["id"]] = saved
                self.submitted = True
            if self.lost_submit:
                self.lost_submit = False
                raise ClientError("Scanner connection failed; check connectivity and retry.")
            return json.dumps({"saved": [dict(id=d["id"], revision=self.documents[d["id"]]["revision"])
                for d in body.get("documents", [self.documents[DID]])]}).encode()
        if path.endswith("/pdf-review"):
            self.documents[DID]["checks"]["pdf"] = True
            self.documents[DID]["reviewedPdfSha256"] = body["sha256"]
            self.documents[DID]["revision"] += 1
            return b'{"saved":true}'
        if path.endswith("/categories"):
            return json.dumps({"id": OTHER, **body}).encode()
        raise AssertionError("Unexpected write")

    def original(self, cid, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / (cid + ".png")
        path.write_bytes(self.raw[cid])
        return {"capture_id": cid, "path": str(path), "sha256": hashlib.sha256(self.raw[cid]).hexdigest()}

    def prepare(self, cid, directory):
        result = self.original(cid, directory)
        ocr = Path(directory) / (cid + ".json")
        ocr.write_text(json.dumps({"text": "Synthetic text", "lines": [], "text_only_pdf_layers": [{"base64": "must-not-escape"}]}))
        return {**result, "ocr_path": str(ocr)}

    def pdf(self, did, directory, before_upload=None):
        directory = Path(directory)
        directory.mkdir(parents=True)
        path = directory / "synthetic.pdf"
        path.write_bytes(b"%PDF-synthetic-test-only")
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        result = dict(path=str(path), sha256=sha, revision=self.documents[did]["revision"],
                    filename=self.documents[did]["filename"], pages=len(self.documents[did]["pages"]), searchable=True)
        if before_upload:
            before_upload(result)
        if self.lost_pdf_before_storage:
            raise ClientError("Scanner connection failed; check connectivity and retry.")
        self.documents[did]["pdf"] = {"sha256": sha, "revision": self.documents[did]["revision"]}
        if self.lost_pdf:
            raise ClientError("Scanner connection failed; check connectivity and retry.")
        return result


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        (self.repo / "scripts").mkdir()
        self.fake = FakeScanner()
        self.patches = [patch.object(module, "__file__", str(self.repo / "scripts" / "receipt_worker.py")),
            patch.object(module, "credentials", return_value={}),
            patch.object(module, "ScannerClient", return_value=self.fake)]
        self.cwd = Path.cwd()
        self.addCleanup(module.os.chdir, self.cwd)
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        for filename in ("node.exe", "pdftoppm.exe"):
            (self.repo / filename).write_bytes(b"synthetic executable fixture; never launched")
        self.profile = dict(repository=str(self.repo), node=str(self.repo / "node.exe"), renderer=str(self.repo / "pdftoppm.exe"),
                            client_config="synthetic-config", origin=self.fake.origin)
        self.worker = self.make_worker()

    def make_worker(self, resume=None):
        worker = module.Worker(self.profile, resume)
        self.addCleanup(worker.lock.close)
        worker.check = lambda operation, **values: (
            {"errors": [] if "type" in values["extraction"] else ["Invalid extraction"], "arithmetic": {}}
            if operation == "validate" else [{"uncertainties": d["uncertainties"], "broken": d["broken"]} for d in values["documents"]])
        def render(dpi):
            worker.state["rendered"] = ["synthetic-render"] * worker.state["pdf"]["pages"]
            return {"pages": worker.state["rendered"], "dpi": dpi}
        worker.render = render
        return worker

    def send(self, op, **fields):
        result = self.worker.handle({"op": op, **fields})
        self.assertTrue(result["ok"], result)
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("must-not-escape", json.dumps(result))
        return result["result"]

    def claimed(self):
        self.send("claim", viewer_checked=True)
        self.send("context")

    def prepared(self, ids=(DID,)):
        self.claimed()
        self.send("originals", capture_ids=list(ids))
        self.send("prepare", capture_ids=list(ids))

    def test_complete_one_document_protocol(self):
        self.prepared()
        self.send("categories")
        self.send("category", name="Synthetic category", description="Synthetic category description")
        self.send("validate", extraction=extraction())
        self.send("submit", extraction=extraction())
        self.send("document", document_id=DID)
        self.send("pdf")
        result = self.send("attest", all_pages_inspected=True, evidence="Synthetic page inspected.")
        self.assertTrue(result["pdf_review_attested"])
        self.assertEqual(result["revision"], 4)
        self.send("quit")
        self.assertNotIn(("POST", "/api/processing/release"), self.fake.calls)
        self.assertFalse(self.worker.handle({"op": "claim", "viewer_checked": True})["ok"])

    def test_unknown_operations_and_undiscovered_sources_never_call_network(self):
        self.claimed()
        before = len(self.fake.calls)
        for message in [{"op": "http", "url": "https://unrelated.example.test"},
                        {"op": "originals", "capture_ids": [FOREIGN]},
                        {"op": "document", "document_id": FOREIGN},
                        {"op": "context", "filters": {"after_capture": FOREIGN}},
                        {"op": "context", "filters": {"date": "2026-02-31"}},
                        {"op": "context", "filters": {"total_minor": True}},
                        {"op": "context", "filters": {"currency": "not-a-currency"}}]:
            self.assertFalse(self.worker.handle(message)["ok"])
        self.assertEqual(len(self.fake.calls), before)

    def test_lease_renewal_is_available_during_idle_vision(self):
        self.claimed()
        self.worker.state["claim"]["expires"] = time.time()*1000+1000
        self.worker.renew_if_needed()
        self.assertIn(("POST", "/api/processing/renew"), self.fake.calls)
        self.assertGreater(self.worker.state["claim"]["expires"], time.time()*1000+300000)

    def test_integrity_failure_stops_and_releases_only_unsubmitted_claim(self):
        self.claimed()
        self.fake.raw[DID] = b"wrong bytes"
        failed = self.worker.handle({"op": "originals", "capture_ids": [DID]})
        self.assertTrue(failed["blocking"])
        self.assertFalse(self.worker.handle({"op": "context"})["ok"])
        self.assertTrue(self.send("release")["released"])
        self.assertEqual(self.worker.state["phase"], "released")

    def test_lost_submit_response_preserves_exact_bytes_for_owner_resume(self):
        self.prepared()
        self.fake.lost_submit = True
        failed = self.worker.handle({"op": "submit", "extraction": extraction()})
        self.assertTrue(failed["blocking"])
        self.assertEqual(self.worker.state["phase"], "submit-uncertain")
        self.assertFalse(self.send("release")["released"])
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        self.send("retry-submit")
        self.assertEqual(self.fake.submit_bytes[0], self.fake.submit_bytes[1])
        self.assertEqual(self.fake.documents[DID]["revision"], 3)

    def test_new_process_refuses_unfinished_journal(self):
        self.claimed()
        self.worker.lock.close()
        with self.assertRaisesRegex(module.InputError, "unfinished"):
            self.make_worker()

    def test_grouping_preserves_sources_and_annotations(self):
        self.fake.documents[OTHER]["annotations"] = [{"captureId": OTHER, "text": "synthetic prior annotation"}]
        self.fake.documents[OTHER]["handwriting"] = "present"
        self.prepared((DID, OTHER))
        e = extraction()
        e["has_handwriting"] = True
        self.send("submit", extraction=e, grouping={"donor_ids": [OTHER], "capture_ids": [DID, OTHER], "evidence": "Synthetic continuation page match."})
        self.assertEqual([p["captureId"] for p in self.fake.documents[DID]["pages"]], [DID, OTHER])
        self.assertEqual(len(self.fake.documents[DID]["annotations"]), 1)
        self.assertEqual(self.fake.documents[OTHER]["pages"], [])
        self.assertEqual(self.fake.documents[OTHER]["mergedInto"], DID)

    def test_valid_no_filename_outcome_finishes_without_pdf(self):
        self.prepared()
        e = extraction()
        e["vendor"] = None
        self.send("submit", extraction=e)
        result = self.send("pdf")
        self.assertFalse(result["pdf_applicable"])
        self.assertEqual(result["phase"], "complete")

    def test_pdf_attestation_refuses_changed_local_bytes(self):
        self.prepared()
        self.send("submit", extraction=extraction())
        self.send("pdf")
        Path(self.worker.state["pdf"]["path"]).write_bytes(b"corrupted")
        result = self.worker.handle({"op": "attest", "all_pages_inspected": True, "evidence": "Synthetic inspection."})
        self.assertTrue(result["blocking"])
        self.assertNotIn(("POST", "/api/processing/pdf-review"), self.fake.calls)

    def test_exclusive_lock_prevents_two_workers_using_global_lease(self):
        with self.assertRaises(OSError):
            self.make_worker()

    def test_lost_claim_response_waits_for_lease_window_then_terminalizes(self):
        self.fake.lost_claim = True
        result = self.worker.handle({"op": "claim", "viewer_checked": True})
        self.assertEqual(result["phase"], "claim-uncertain")
        self.assertEqual(result["claim_state"], "possibly-active")
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        self.assertFalse(self.worker.handle({"op": "reconcile"})["ok"])
        self.worker.state["claim_started"] -= 1500
        self.send("reconcile")
        self.assertEqual(self.worker.state["phase"], "released")
        self.assertNotIn(("POST", "/api/processing/release"), self.fake.calls)

    def test_lost_pdf_ack_recovers_local_file_without_upload_or_regeneration(self):
        self.prepared()
        self.send("submit", extraction=extraction())
        self.fake.lost_pdf = True
        result = self.worker.handle({"op": "pdf"})
        self.assertEqual(result["phase"], "pdf-uncertain")
        original = self.worker.state["pdf_intent"]["path"]
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        before = len(self.fake.calls)
        result = self.send("reconcile")
        self.assertTrue(result["recovered"])
        self.assertEqual(self.worker.state["pdf"]["path"], original)
        self.assertTrue(all(call[0] == "GET" for call in self.fake.calls[before:]))

    def test_submit_readback_failure_resumes_without_replaying_mutation(self):
        self.prepared((DID, OTHER))
        original_get = self.fake.get
        def get(path):
            if self.fake.submitted and path == "/api/documents/" + OTHER:
                raise ClientError("Synthetic readback failure")
            return original_get(path)
        self.fake.get = get
        result = self.worker.handle({"op": "submit", "extraction": extraction(),
            "grouping": {"donor_ids": [OTHER], "capture_ids": [DID, OTHER], "evidence": "Synthetic merge."}})
        self.assertEqual(result["phase"], "submit-readback")
        self.fake.get = original_get
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        self.send("reconcile")
        self.assertEqual(len(self.fake.submit_bytes), 1)
        self.assertEqual(self.worker.state["phase"], "submitted")

    def test_missing_pdf_retries_identical_saved_bytes_after_explicit_resume(self):
        self.prepared()
        self.send("submit", extraction=extraction())
        self.fake.lost_pdf_before_storage = True
        self.assertTrue(self.worker.handle({"op": "pdf"})["blocking"])
        intent = self.worker.state["pdf_intent"]
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        self.assertEqual(self.send("reconcile")["next"], "retry-pdf")
        self.assertTrue(self.send("retry-pdf")["recovered"])
        self.assertEqual(self.fake.pdf_uploads, [Path(intent["path"]).read_bytes()])
        self.assertEqual(len(list(Path(intent["path"]).parent.glob("*.pdf"))), 1)

    def test_pdf_recovery_never_uploads_over_a_different_server_artifact(self):
        self.prepared()
        self.send("submit", extraction=extraction())
        self.fake.lost_pdf = True
        self.assertTrue(self.worker.handle({"op": "pdf"})["blocking"])
        self.fake.documents[DID]["pdf"]["sha256"] = "f" * 64
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        before = len(self.fake.calls)
        self.assertTrue(self.worker.handle({"op": "retry-pdf"})["blocking"])
        self.assertTrue(all(call[0] == "GET" for call in self.fake.calls[before:]))
        self.assertEqual(self.fake.documents[DID]["pdf"]["sha256"], "f" * 64)


if __name__ == "__main__":
    unittest.main()
