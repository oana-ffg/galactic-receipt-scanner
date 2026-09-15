"""Synthetic protocol/state tests; never contact a deployed scanner."""
from copy import deepcopy
from contextlib import contextmanager
import errno
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


@contextmanager
def windows_replace_failure(*, fail_at, retry_once=False):
    """Make one journal replace transiently or permanently unavailable on Windows."""
    real_replace = module.os.replace
    calls = 0

    def replace(temporary, destination):
        nonlocal calls
        calls += 1
        if calls == fail_at or (not retry_once and calls >= fail_at):
            raise PermissionError(errno.EACCES, "synthetic access denied")
        return real_replace(temporary, destination)

    with patch.object(module.os, "name", "nt"), patch.object(module.os, "replace", side_effect=replace), patch.object(module.time, "sleep"):
        yield lambda: calls


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
        self.pdf_calls = 0
        self.lost_claim = False
        self.categories = []
        self.next_images = []
        self.readings = {"draft_saved": False, "attempt_saved": False, "claim_active": False}

    def get(self, path):
        self.calls.append(("GET", path))
        if path == "/api/processing/access":
            return {"version": 2, "queueClaims": True}
        if path == "/api/processing/categories":
            return deepcopy(self.categories)
        if path.startswith("/api/processing/readings?"):
            return deepcopy(self.readings)
        if path.startswith("/api/processing/context?"):
            return dict(document=deepcopy(self.documents[DID]), candidates=[deepcopy(self.documents[OTHER])],
                next_images=[] if "after_capture=" in path else deepcopy(self.next_images),
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
        if path.endswith("/draft"):
            self.initial_draft=deepcopy(body)
            return b'{"saved":true}'
        if path.endswith("/confirmation"):
            return json.dumps({"saved":True,"sha256":"b"*64,"qwen":body,"evidence":{"initial_arithmetic":{},"qwen_arithmetic":{}}}).encode()
        if path.endswith("/submit"):
            self.submit_bytes.append(data)
            if not self.submitted:
                for doc in body.get("documents", [self.documents[DID]]):
                    saved = deepcopy(doc)
                    saved["revision"] += 1
                    if doc["id"] == DID:
                        if len(saved["pages"]) == 1:
                            saved["pages"][0]["type"] = body["extraction"]["type"]
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

    def image_pdf(self, pages, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ("pixel-" + str(len(list(directory.glob("*.pdf")))) + ".pdf")
        path.write_bytes(b"%PDF-synthetic-pixels")
        layouts = []
        for page in pages:
            crop = page.get("crop", [1, 2, 9, 18])
            layouts.append(dict(captureId=page["captureId"], sha256=page["sha256"],
                                pixels=[10, 20], crop=crop, rotation=page.get("rotation", 0)))
        return dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                    pages=len(pages), layouts=layouts, searchable=False)

    def prepare(self, cid, directory, *, crop=None, rotation=0):
        result = self.original(cid, directory)
        ocr = Path(directory) / (cid + ".json")
        ocr.write_text(json.dumps({"text": "Synthetic text", "lines": [], "text_only_pdf_layers": [{"base64": "must-not-escape"}]}))
        return {**result, "ocr_path": str(ocr), "crop": crop, "rotation": rotation,
                "ocr_sha256": hashlib.sha256(ocr.read_bytes()).hexdigest()}

    def pdf(self, did, directory, before_upload=None):
        self.pdf_calls += 1
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
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
            patch.object(module, "ScannerClient", return_value=self.fake),
            patch.object(module.receipt_qwen, "describe_images", side_effect=lambda paths:[{"sha256":"a"*64,"pixels":[10,20]} for p in paths]),
            patch.object(module.receipt_qwen, "extract", side_effect=lambda paths,images,pdf_hash,output: {"extraction":extraction(),"images":images,"pixel_pdf_sha256":pdf_hash})]
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
        worker.render_file = lambda path, pages, dpi, label: [f"synthetic-{label}-{i + 1}.jpg" for i in range(pages)]
        return worker

    def send(self, op, **fields):
        if op == "draft" and "page_review" not in fields:
            ids = fields.get("grouping", {}).get("capture_ids", [DID])
            fields["page_review"] = dict(capture_ids=ids, excluded=[])
        result = self.worker.handle({"op": op, **fields})
        self.assertTrue(result["ok"], result)
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("must-not-escape", json.dumps(result))
        return result["result"]

    def claimed(self):
        self.send("claim", viewer_checked=True)
        self.send("context")

    def prepared(self, ids=(DID,), *, grouping=None, value=None, layouts=None):
        self.claimed()
        self.send("previews", capture_ids=list(ids), **({"layouts": layouts} if layouts else {}))
        self.send("draft", extraction=value or extraction(), **({"grouping": grouping} if grouping else {}))
        self.send("prepare", capture_ids=list(ids))
        confirmation = self.send("confirm")
        self.send("assess", confirmation_sha256=confirmation["sha256"], extraction=deepcopy(self.worker.state["draft"]["extraction"]), rationale="Synthetic reassessment retains the pixel-supported initial reading.")

    def test_available_neighbor_must_be_inspected_even_if_not_selected(self):
        self.fake.next_images = [dict(id=OTHER, sha256=self.fake.documents[OTHER]["pages"][0]["sha256"], document_id=OTHER)]
        self.claimed()
        self.send("previews", capture_ids=[DID])
        request = dict(op="draft", extraction=extraction(), page_review=dict(capture_ids=[DID], excluded=[]))
        self.assertIn("Inspect the next available", self.worker.handle(request)["input_error"])
        self.assertNotIn("draft", self.worker.state)
        self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)
        # Advancing the query does not erase the obligation to inspect the first neighbor.
        self.send("context", filters=dict(after_capture=OTHER))
        self.assertIn("Inspect the next available", self.worker.handle(request)["input_error"])
        self.send("previews", capture_ids=[OTHER])
        request["page_review"]["excluded"] = [dict(capture_id=OTHER, reason="Different transaction on a complete receipt.")]
        self.assertTrue(self.worker.handle(request)["result"]["drafted"])

    def test_retained_lookahead_requires_checking_the_following_boundary(self):
        self.fake.next_images = [dict(id=OTHER, sha256=self.fake.documents[OTHER]["pages"][0]["sha256"], document_id=OTHER)]
        self.claimed()
        self.send("previews", capture_ids=[DID, OTHER])
        request = dict(op="draft", extraction=extraction(), page_review=dict(capture_ids=[DID, OTHER], excluded=[]),
                       grouping=dict(donor_ids=[OTHER], capture_ids=[DID, OTHER], evidence="Complementary synthetic sections."))
        self.assertIn("All lookahead pages are retained", self.worker.handle(request)["input_error"])
        self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)
        self.send("context", filters=dict(after_capture=OTHER))
        self.assertEqual(self.worker.handle(request)["result"]["pages"], 2)

    def test_draft_requires_initial_context_even_when_there_are_no_neighbors(self):
        self.send("claim", viewer_checked=True)
        self.send("previews", capture_ids=[DID])
        request=dict(op="draft", extraction=extraction(), page_review=dict(capture_ids=[DID], excluded=[]))
        self.assertIn("Read the initial context", self.worker.handle(request)["input_error"])
        self.send("context", filters=dict(date="2026-01-01"))
        self.assertIn("Read the initial context", self.worker.handle(request)["input_error"])
        self.send("context")
        self.assertTrue(self.worker.handle(request)["result"]["drafted"])

    def test_missing_grouping_cannot_freeze_recognized_continuation(self):
        self.claimed()
        self.send("previews", capture_ids=[DID, OTHER])
        request = dict(op="draft", extraction=extraction(),
                       page_review=dict(capture_ids=[DID, OTHER], excluded=[]))
        result = self.worker.handle(request)
        self.assertIn("supply grouping", result["input_error"])
        self.assertEqual(self.worker.state["phase"], "claimed")
        self.assertNotIn("draft", self.worker.state)
        self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)
        request["grouping"] = dict(donor_ids=[OTHER], capture_ids=[DID, OTHER],
                                   evidence="Consecutive complementary sections of a synthetic receipt.")
        result = self.worker.handle(request)["result"]
        self.assertEqual(result["pages"], 2)
        self.assertEqual(result["page_review"], request["page_review"])

    def test_page_review_accounts_for_exclusions_and_order_before_saving(self):
        self.claimed()
        self.send("previews", capture_ids=[DID, OTHER])
        bad = [None, {}, {"capture_ids": [DID], "excluded": []},
               {"capture_ids": [OTHER, DID], "excluded": []},
               {"capture_ids": [DID], "excluded": [{"capture_id": OTHER, "reason": " "}]},
               {"capture_ids": [DID], "excluded": [{"capture_id": FOREIGN, "reason": "Unrelated"}]},
               {"capture_ids": [DID], "excluded": [{"capture_id": OTHER, "reason": "Unrelated"}] * 2}]
        for review in bad:
            result = self.worker.handle(dict(op="draft", extraction=extraction(), page_review=review))
            self.assertIn("input_error", result)
            self.assertNotIn("draft", self.worker.state)
            self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)
        review = dict(capture_ids=[DID], excluded=[dict(capture_id=OTHER,
                      reason="Different printed transaction reference on a complete unrelated receipt.")])
        result = self.send("draft", extraction=extraction(), page_review=review)
        self.assertEqual(result["pages"], 1)
        self.assertEqual(self.worker.state["draft"]["page_review"], review)

    def test_failed_released_worker_blocks_fresh_automatic_run(self):
        self.claimed()
        self.fake.raw[DID] = b"wrong bytes"
        self.assertTrue(self.worker.handle(dict(op="originals", capture_ids=[DID]))["blocking"])
        self.send("release")
        self.worker.lock.close()
        with self.assertRaisesRegex(module.InputError, "Previous worker failed"):
            self.make_worker()
        self.worker = self.make_worker(self.worker.state["run_id"])
        self.assertIn("input_error", self.worker.handle(dict(op="reconcile")))
        self.send("reconcile", rationale="Owner requested recovery after the synthetic input was repaired.")
        self.assertTrue(list(self.worker.work.glob("*-failure-resolution.json")))
        self.worker.lock.close()
        self.worker = self.make_worker()
        self.assertEqual(self.worker.state["phase"], "ready")

    def test_checkpoint_lost_acknowledgements_replay_exactly_without_new_qwen(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        original_request = self.fake.request
        for endpoint in ["draft", "confirmation"]:
            if endpoint == "confirmation":
                self.send("prepare", capture_ids=[DID])
            writes=[]
            def lose_once(path, data=None, content_type=None):
                result=original_request(path,data,content_type)
                if path.endswith("/"+endpoint):
                    writes.append(data)
                    if len(writes)==1: raise ClientError("Synthetic lost acknowledgement")
                return result
            with patch.object(self.fake,"request",side_effect=lose_once):
                message={"op":"draft","page_review":{"capture_ids":[DID],"excluded":[]},"extraction":extraction()} if endpoint=="draft" else {"op":"confirm"}
                failed=self.worker.handle(message)
                self.assertTrue(failed["blocking"])
                self.assertEqual(self.worker.state["phase"],endpoint+"-uncertain")
                self.assertFalse(self.send("release")["released"])
                self.worker.lock.close()
                self.worker=self.make_worker(self.worker.state["run_id"])
                with patch.object(module.receipt_qwen,"extract",side_effect=AssertionError("Must not rerun inference")):
                    self.send("retry-checkpoint")
                self.assertEqual(writes[0],writes[1])
                self.assertEqual(self.worker.state["phase"],"drafted")

    def test_reassessment_preserves_initial_and_requires_confirmation(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        self.send("draft",extraction=extraction())
        self.assertIn("input_error",self.worker.handle({"op":"submit"}))
        self.send("prepare",capture_ids=[DID])
        confirmation = self.send("confirm")
        final=extraction()
        final["vendor"]="Synthetic corrected shop"
        self.send("assess",confirmation_sha256=confirmation["sha256"],extraction=final,rationale="Synthetic correction grounded in pixels.")
        self.assertEqual(self.worker.state["draft"]["extraction"]["vendor"],"Synthetic Shop")
        self.assertEqual(self.fake.initial_draft["extraction"]["vendor"],"Synthetic Shop")
        self.send("submit")
        saved=json.loads(self.fake.submit_bytes[0])
        self.assertEqual(saved["extraction"]["vendor"],"Synthetic corrected shop")
        self.assertEqual(saved["assessment"]["changed_fields"],["vendor"])

    def test_exact_category_names_resolve_for_draft_and_assessment_without_mutating_input(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        self.fake.categories = [{"id": OTHER, "name": "Synthetic supplies"}, {"id": FOREIGN, "name": "Synthetic personal"}]
        value = extraction()
        self.send("draft", extraction=value, category_name="Synthetic supplies")
        self.assertIsNone(value["category_id"])
        self.assertEqual(self.fake.initial_draft["extraction"]["category_id"], OTHER)
        self.send("prepare", capture_ids=[DID])
        confirmation = self.send("confirm")
        self.send("assess", extraction=value, category_name="Synthetic personal", confirmation_sha256=confirmation["sha256"], rationale="Synthetic category correction.")
        self.assertIsNone(value["category_id"])
        self.assertEqual(self.worker.state["draft"]["extraction"]["category_id"], OTHER)
        self.assertEqual(self.worker.state["assessment"]["extraction"]["category_id"], FOREIGN)
        self.assertIn("category_id", self.worker.state["assessment"]["assessment"]["changed_fields"])

    def test_category_name_errors_are_correctable_and_never_guessed(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        self.fake.categories = [{"id": OTHER, "name": "Synthetic supplies"}]
        for name in ("synthetic supplies", "Synthetic", "", 3):
            result = self.worker.handle({"op": "draft", "page_review": {"capture_ids": [DID], "excluded": []}, "extraction": extraction(), "category_name": name})
            self.assertIn("input_error", result)
            self.assertNotIn("draft", self.worker.state)
        value = extraction()
        value["category_id"] = OTHER
        self.assertIn("input_error", self.worker.handle({"op": "draft", "page_review": {"capture_ids": [DID], "excluded": []}, "extraction": value, "category_name": "Synthetic supplies"}))
        self.fake.categories.append({"id": FOREIGN, "name": "Synthetic supplies"})
        self.assertIn("input_error", self.worker.handle({"op": "draft", "page_review": {"capture_ids": [DID], "excluded": []}, "extraction": extraction(), "category_name": "Synthetic supplies"}))
        self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)

    def test_unknown_category_is_correctable_before_draft_is_frozen(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        value = extraction()
        value["category_id"] = FOREIGN
        result = self.worker.handle({"op": "draft", "page_review": {"capture_ids": [DID], "excluded": []}, "extraction": value})
        self.assertIn("Unknown purchase category", result["input_error"])
        self.assertEqual(self.worker.state["phase"], "claimed")
        self.assertNotIn("draft", self.worker.state)
        self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)
        self.fake.categories = [{"id": OTHER, "name": "Synthetic supplies"}]
        value["category_id"] = OTHER
        self.send("draft", extraction=value)
        self.assertEqual(self.fake.initial_draft["extraction"]["category_id"], OTHER)

    def test_unknown_reassessment_category_preserves_initial_and_can_be_corrected(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        self.send("draft", extraction=extraction())
        self.send("prepare", capture_ids=[DID])
        confirmation = self.send("confirm")
        value = extraction()
        value["category_id"] = FOREIGN
        request = {"op": "assess", "extraction": value, "confirmation_sha256": confirmation["sha256"], "rationale": "Synthetic reassessment."}
        self.assertIn("input_error", self.worker.handle(request))
        self.assertNotIn("assessment", self.worker.state)
        self.assertIsNone(self.worker.state["draft"]["extraction"]["category_id"])
        value["category_id"] = None
        self.assertTrue(self.worker.handle(request)["result"]["assessed"])

    def test_expired_unsaved_draft_reconciliation_requires_unsaved_inactive_checkpoint_and_unchanged_documents(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        with patch.object(self.fake, "request", side_effect=ClientError("Synthetic rejected draft")):
            self.assertTrue(self.worker.handle({"op": "draft", "page_review": {"capture_ids": [DID], "excluded": []}, "extraction": extraction()})["blocking"])
        run_id = self.worker.state["run_id"]
        self.worker.lock.close()
        self.worker = self.make_worker(run_id)
        self.assertFalse(self.worker.handle({"op": "reconcile"})["ok"])
        expiry = self.worker.state["claim"]["expires"] / 1000
        with patch.object(module.time, "time", return_value=expiry + 211):
            original = deepcopy(self.fake.readings)
            for key in original:
                for value in (True, None, 0):
                    self.fake.readings[key] = value
                    self.assertFalse(self.worker.handle({"op": "reconcile"})["ok"])
                    self.assertEqual(self.worker.state["phase"], "draft-uncertain")
                self.fake.readings = deepcopy(original)
            self.fake.documents[DID]["revision"] += 1
            self.assertFalse(self.worker.handle({"op": "reconcile"})["ok"])
            self.fake.documents[DID]["revision"] -= 1
            writes = sum(method == "POST" for method, _ in self.fake.calls)
            result = self.send("reconcile")
            self.assertEqual(result["phase"], "released")
            self.assertEqual(writes, sum(method == "POST" for method, _ in self.fake.calls))
            self.assertTrue((self.worker.work / self.worker.state["checkpoint_request"]).exists())

    def test_complete_one_document_protocol(self):
        self.prepared()
        self.assertEqual(self.worker.state["draft"]["layouts"][0]["crop"], [1, 2, 9, 18])
        self.assertEqual(self.worker.state["draft"]["target"]["pages"][0]["crop"], [1, 2, 9, 18])
        self.send("categories")
        self.send("category", name="Synthetic category", description="Synthetic category description")
        self.send("validate", extraction=extraction())
        self.send("submit")
        self.send("document", document_id=DID)
        pdf = self.send("pdf")
        result = self.send("attest", pdf_sha256=pdf["pdf"]["sha256"], all_pages_inspected=True, evidence="Synthetic page inspected.")
        self.assertTrue(result["pdf_review_attested"])
        self.assertEqual(result["revision"], 4)
        self.send("quit")
        self.assertNotIn(("POST", "/api/processing/release"), self.fake.calls)
        self.assertFalse(self.worker.handle({"op": "claim", "viewer_checked": True})["ok"])
        self.worker.lock.close()
        self.worker = self.make_worker()
        self.assertEqual(self.worker.state["phase"], "ready")

    def test_speculative_or_stale_assessment_cannot_save_a_reading(self):
        # Even after prerequisites finish, a prewritten request without the actual
        # evidence reference must not acquire a valid confirmation automatically.
        request = {"op": "assess", "extraction": extraction(), "rationale": "Synthetic assessment."}
        self.claimed()
        self.send("previews", capture_ids=[DID])
        self.send("draft", extraction=extraction())
        self.send("prepare", capture_ids=[DID])
        confirmation = self.send("confirm")
        for fields in ({}, {"confirmation_sha256": "a" * 64}):
            with self.subTest(fields=fields):
                calls = list(self.fake.calls)
                result = self.worker.handle({**request, **fields})
                self.assertIn("input_error", result)
                self.assertNotIn("assessment", self.worker.state)
                self.assertEqual(self.fake.calls, calls)
        self.send("assess", confirmation_sha256=confirmation["sha256"],
                  extraction=extraction(), rationale="Synthetic assessment after reading confirmation.")

    def test_speculative_or_stale_attestation_cannot_approve_pdf(self):
        request = {"op": "attest", "all_pages_inspected": True, "evidence": "Synthetic inspection."}
        self.prepared()
        self.send("submit")
        pdf = self.send("pdf")
        for fields in ({}, {"pdf_sha256": "a" * 64},
                       {"pdf_sha256": self.worker.state["draft"]["pixel_pdf"]["sha256"]}):
            with self.subTest(fields=fields):
                calls = list(self.fake.calls)
                result = self.worker.handle({**request, **fields})
                self.assertIn("input_error", result)
                self.assertEqual(self.worker.state["phase"], "pdf")
                self.assertFalse(self.fake.documents[DID]["checks"]["pdf"])
                self.assertEqual(self.fake.calls, calls)
        self.send("attest", pdf_sha256=pdf["pdf"]["sha256"], all_pages_inspected=True,
                  evidence="Synthetic inspection after opening final renders.")

    def test_pp_confirmation_never_calls_qwen_and_preserves_reassessment(self):
        self.worker.confirmation_provider = "ppocr"
        with patch.object(module.receipt_qwen, "extract", side_effect=AssertionError("Qwen must not run")):
            self.prepared()
        request = self.worker.load(self.worker.state["checkpoint_request"])
        self.assertEqual(request["provider"], "ppocr")
        self.assertEqual(request["artifacts"][0]["capture_id"], DID)
        self.assertIn("confirmation", self.worker.state)
        self.assertEqual(self.worker.state["draft"]["extraction"], self.worker.state["assessment"]["extraction"])
        self.send("submit")
        self.assertEqual(len(self.fake.submit_bytes), 1)

    def test_explicit_raw_preview_freezes_full_original_pixel_bounds(self):
        self.claimed()
        result = self.send("previews", capture_ids=[DID], layouts={DID: {"crop": None, "rotation": 90}})
        self.assertEqual(result[0]["layout"]["crop"], [0, 0, 10, 20])
        self.assertEqual(result[0]["layout"]["rotation"], 90)
        self.send("draft", extraction=extraction())
        self.send("prepare", capture_ids=[DID])
        self.assertEqual(self.worker.state["prepared"][DID]["crop"], [0, 0, 10, 20])
        confirmation = self.send("confirm")
        self.send("assess", confirmation_sha256=confirmation["sha256"], extraction=extraction(), rationale="Synthetic reviewed crop.")
        self.send("submit")
        self.assertEqual(self.fake.documents[DID]["pages"][0]["crop"], [0, 0, 10, 20])
        self.assertEqual(self.fake.documents[DID]["pages"][0]["rotation"], 90)

    def test_rotation_only_override_cannot_authorize_undetected_raw_layout(self):
        self.claimed()
        original_image_pdf = self.fake.image_pdf

        def undetected(pages, directory):
            result = original_image_pdf(pages, directory)
            result["layouts"][0]["crop"] = None
            return result

        self.fake.image_pdf = undetected
        result = self.worker.handle({"op": "previews", "capture_ids": [DID],
                                     "layouts": {DID: {"rotation": 90}}})
        self.assertFalse(result["ok"])
        self.assertIn("explicitly choose crop bounds or raw", result["input_error"])
        self.assertNotIn(DID, self.worker.state["layouts"])

    def test_invalid_preview_override_stops_before_draft_or_remote_write(self):
        self.claimed()
        before = len(self.fake.calls)
        result = self.worker.handle({"op": "previews", "capture_ids": [DID],
                                     "layouts": {DID: {"crop": [0, 0, 11, 20], "rotation": 0}}})
        self.assertTrue(result["blocking"])
        self.assertEqual(self.worker.state["phase"], "claimed")
        self.assertFalse(self.worker.state.get("draft"))
        self.assertNotIn(("POST", "/api/processing/submit"), self.fake.calls[before:])

    def test_prepare_requires_frozen_draft(self):
        self.claimed()
        self.send("previews", capture_ids=[DID])
        result = self.worker.handle({"op": "prepare", "capture_ids": [DID]})
        self.assertFalse(result["ok"])
        self.assertNotIn(DID, self.worker.state["prepared"])

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
        failed = self.worker.handle({"op": "submit"})
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

    def test_unchecked_capture_defaults_do_not_override_luna_handwriting_or_confidence(self):
        for doc in self.fake.documents.values():
            doc["handwriting"] = "unchecked"
        self.prepared(ids=(DID, OTHER), grouping={"donor_ids": [OTHER], "capture_ids": [DID, OTHER],
                      "evidence": "Synthetic consecutive sections of one receipt."})
        initial = self.fake.initial_draft["extraction"]
        self.assertEqual(initial["certainty"], "high")
        self.assertFalse(initial["has_handwriting"])
        self.assertEqual(initial["uncertainties"], [])
        self.assertEqual(self.worker.state["assessment"]["extraction"]["certainty"], "high")
        self.assertEqual(len(self.worker.state["draft"]["target"]["pages"]), 2)
        self.assertTrue(all(d["handwriting"] == "unchecked" for d in self.fake.documents.values()))

    def test_actual_handwriting_uncertainty_retains_review_note_and_luna_confidence(self):
        self.fake.documents[OTHER]["handwriting"] = "uncertain"
        self.prepared(ids=(DID, OTHER), grouping={"donor_ids": [OTHER], "capture_ids": [DID, OTHER],
                      "evidence": "Synthetic consecutive sections with a prior uncertain observation."})
        initial = self.fake.initial_draft["extraction"]
        self.assertEqual(initial["certainty"], "high")
        self.assertFalse(initial["has_handwriting"])
        self.assertIn("Retained source grouping includes an unresolved handwriting-presence observation.",
                      initial["uncertainties"])

    def test_known_handwriting_cannot_be_silently_discarded_by_grouping(self):
        self.fake.documents[OTHER]["handwriting"] = "present"
        self.claimed()
        self.send("previews", capture_ids=[DID, OTHER])
        result = self.worker.handle({"op": "draft", "page_review": {"capture_ids": [DID, OTHER], "excluded": []}, "extraction": extraction(),
            "grouping": {"donor_ids": [OTHER], "capture_ids": [DID, OTHER],
                         "evidence": "Synthetic grouping contradicts recorded handwriting."}})
        self.assertIn("input_error", result)
        self.assertNotIn(("POST", "/api/processing/draft"), self.fake.calls)
        self.assertNotIn("draft", self.worker.state)

    def test_grouping_preserves_sources_and_annotations(self):
        self.fake.documents[OTHER]["annotations"] = [{"captureId": OTHER, "text": "synthetic prior annotation"}]
        self.fake.documents[OTHER]["handwriting"] = "present"
        e = extraction()
        e["has_handwriting"] = True
        grouping = {"donor_ids": [OTHER], "capture_ids": [DID, OTHER], "evidence": "Synthetic continuation page match."}
        self.prepared((DID, OTHER), grouping=grouping, value=e)
        self.send("submit")
        self.assertEqual([p["captureId"] for p in self.fake.documents[DID]["pages"]], [DID, OTHER])
        self.assertEqual(len(self.fake.documents[DID]["annotations"]), 1)
        self.assertEqual(self.fake.documents[OTHER]["pages"], [])
        self.assertEqual(self.fake.documents[OTHER]["mergedInto"], DID)

    def test_valid_no_filename_outcome_finishes_without_pdf(self):
        e = extraction()
        e["vendor"] = None
        self.prepared(value=e)
        self.send("submit")
        result = self.send("pdf")
        self.assertFalse(result["pdf_applicable"])
        self.assertEqual(result["phase"], "complete")

    def test_pdf_attestation_refuses_changed_local_bytes(self):
        self.prepared()
        self.send("submit")
        self.send("pdf")
        Path(self.worker.state["pdf"]["path"]).write_bytes(b"corrupted")
        result = self.worker.handle({"op": "attest", "pdf_sha256": self.worker.state["pdf"]["sha256"], "all_pages_inspected": True, "evidence": "Synthetic inspection."})
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

    def test_transient_windows_claim_checkpoint_retries_before_the_request(self):
        with windows_replace_failure(fail_at=2, retry_once=True) as calls:
            self.send("claim", viewer_checked=True)

        self.assertEqual(calls(), 5)  # input, failed intent, retry, result, response
        self.assertEqual(self.fake.calls.count(("POST", "/api/processing/claim")), 1)
        self.assertEqual(self.worker.state["phase"], "claimed")

    def test_permanent_claim_checkpoint_failure_never_posts_or_becomes_possibly_active(self):
        with windows_replace_failure(fail_at=2):
            result = self.worker.handle({"op": "claim", "viewer_checked": True})

        self.assertTrue(result["blocking"])
        self.assertEqual(result["phase"], "ready")
        self.assertEqual(result["claim_state"], "closed")
        self.assertNotIn(("POST", "/api/processing/claim"), self.fake.calls)
        self.assertIn("PermissionError, errno=13", result["error"])
        self.assertNotIn("synthetic access denied", result["error"])
        self.assertFalse(self.worker.handle({"op": "claim", "viewer_checked": True})["ok"])
        self.assertTrue(self.send("quit")["released"] is False)

    def test_claim_checkpoint_write_failure_never_posts_or_becomes_possibly_active(self):
        real_write = module.write_new_file
        calls = 0

        def write(path, value):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise PermissionError(errno.EACCES, "synthetic access denied")
            return real_write(path, value)

        with patch.object(module, "write_new_file", side_effect=write):
            result = self.worker.handle({"op": "claim", "viewer_checked": True})

        self.assertTrue(result["blocking"])
        self.assertEqual(result["phase"], "ready")
        self.assertEqual(result["claim_state"], "closed")
        self.assertNotIn(("POST", "/api/processing/claim"), self.fake.calls)

    def test_submit_intent_checkpoint_failure_does_not_send_a_write(self):
        self.prepared()
        with windows_replace_failure(fail_at=3):
            submit = self.worker.handle({"op": "submit"})
        self.assertEqual(submit["phase"], "drafted")
        self.assertNotIn(("POST", "/api/processing/submit"), self.fake.calls)
        self.assertTrue(self.send("release")["released"])

    def test_pdf_intent_checkpoint_failure_does_not_upload(self):
        self.prepared()
        self.send("submit")
        with windows_replace_failure(fail_at=3):
            pdf = self.worker.handle({"op": "pdf"})
        self.assertEqual(pdf["phase"], "submitted")
        self.assertEqual(self.fake.pdf_calls, 1)
        self.assertNotIn("pdf", self.fake.documents[DID])

    def test_attestation_intent_checkpoint_failure_does_not_send_a_write(self):
        self.prepared()
        self.send("submit")
        self.send("pdf")
        with windows_replace_failure(fail_at=3):
            attest = self.worker.handle({"op": "attest", "pdf_sha256": self.worker.state["pdf"]["sha256"], "all_pages_inspected": True,
                                         "evidence": "Synthetic inspection."})
        self.assertEqual(attest["phase"], "pdf")
        self.assertNotIn(("POST", "/api/processing/pdf-review"), self.fake.calls)

    def test_lost_pdf_ack_recovers_local_file_without_upload_or_regeneration(self):
        self.prepared()
        self.send("submit")
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

    def test_submit_readback_accepts_server_classification_without_mutating_frozen_draft(self):
        self.prepared()
        frozen = deepcopy(self.worker.state["draft"])
        result = self.send("submit")
        self.assertEqual(result["phase"], "submitted")
        self.assertEqual(self.worker.state["document"]["pages"][0]["type"], "receipt")
        self.assertEqual(self.worker.state["draft"], frozen)

    def test_malformed_requests_are_correctable_without_remote_calls_or_failed_state(self):
        self.prepared()
        for submitted in (False, True):
            if submitted:
                self.send("submit")
            for message in ({"op": "document"}, {"op": "document", "document_id": []},
                            {"op": "document", "document_id": ""}, {"op": "draft"},
                            {"op": "validate", "extraction": None}, {"op": "assess", "extraction": {}},
                            {"op": []}, None):
                with self.subTest(submitted=submitted, message=message):
                    previous = deepcopy(self.worker.state)
                    calls = len(self.fake.calls)
                    result = self.worker.handle(message)
                    self.assertIn("input_error", result)
                    self.assertNotIn("blocking", result)
                    self.assertEqual(self.fake.calls[calls:], [])
                    previous["sequence"] += 1  # The rejected request is still journaled.
                    self.assertEqual(self.worker.state, previous)
            self.assertEqual(self.send("document", document_id=DID)["id"], DID)

    def test_submit_readback_rejects_changed_source_layout_or_wrong_classification(self):
        self.prepared()
        self.send("submit")
        body = json.loads(self.fake.submit_bytes[0])
        response = {"saved": [{"id": DID, "revision": 3}]}
        original = deepcopy(self.fake.documents[DID]["pages"])
        changes = {"captureId": OTHER, "sha256": "f" * 64, "rotation": 90,
                   "crop": [0, 0, 1, 1], "type": "payment_slip"}
        for field, value in changes.items():
            with self.subTest(field=field):
                self.fake.documents[DID]["pages"] = deepcopy(original)
                self.fake.documents[DID]["pages"][0][field] = value
                error = ClientError if field in {"captureId", "sha256"} else module.InputError
                message = "Discovered source hash changed" if error is ClientError else "Saved page membership differs"
                with self.assertRaisesRegex(error, message):
                    self.worker.finish_submit(body, response)

    def test_submit_readback_failure_resumes_without_replaying_mutation(self):
        grouping = {"donor_ids": [OTHER], "capture_ids": [DID, OTHER], "evidence": "Synthetic merge."}
        self.prepared((DID, OTHER), grouping=grouping)
        original_get = self.fake.get
        def get(path):
            if self.fake.submitted and path == "/api/documents/" + OTHER:
                raise ClientError("Synthetic readback failure")
            return original_get(path)
        self.fake.get = get
        result = self.worker.handle({"op": "submit"})
        self.assertEqual(result["phase"], "submit-readback")
        self.fake.get = original_get
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state["run_id"])
        self.send("reconcile")
        self.assertEqual(len(self.fake.submit_bytes), 1)
        self.assertEqual(self.worker.state["phase"], "submitted")

    def test_missing_pdf_retries_identical_saved_bytes_after_explicit_resume(self):
        self.prepared()
        self.send("submit")
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
        self.send("submit")
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
