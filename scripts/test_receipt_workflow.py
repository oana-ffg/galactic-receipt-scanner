"""Grouped workflow tests with isolated synthetic scanner state; no production access."""
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import receipt_worker as module
import test_receipt_worker as fixtures


class WorkflowTests(unittest.TestCase):
    setUp = fixtures.WorkerTests.setUp
    make_worker = fixtures.WorkerTests.make_worker
    send = fixtures.WorkerTests.send

    def start_review(self):
        self.worker.confirmation_provider = "ppocr"
        begun = self.send("begin", viewer_checked=True)
        self.assertEqual(begun["claimed_preview"]["captureId"], fixtures.DID)
        request = begun["request"]
        request["observation"].update(type="receipt", vendor="Synthetic Shop")
        packet = self.worker.handle(request)
        self.assertTrue(packet["ok"], packet)
        request = packet["result"]["request"]
        request["extraction"] = fixtures.extraction()
        reviewed = self.worker.handle(request)
        self.assertTrue(reviewed["ok"], reviewed)
        self.assertNotIn(fixtures.TOKEN, json.dumps(reviewed))
        self.assertNotIn("must-not-escape", json.dumps(reviewed))
        self.assertEqual(self.worker.state["phase"], "drafted")
        self.assertTrue(self.worker.state["draft_saved"])
        self.assertNotIn("assessment", self.worker.state)
        finish = reviewed["result"]["request"]
        finish.update(all_pages_inspected=True, layout_evidence="Both paper edges and complete source content retained.",
                      rationale="PP agrees with the visible synthetic date and amount.")
        return finish

    def matching_renders(self, mismatch=False):
        # Real Poppler equality is separately tested by test_receipt_pdf_pixels.py.
        def render(dpi):
            path = self.worker.work / "final.png"
            path.write_bytes(b"synthetic rendered pixels")
            self.worker.state["rendered"] = [str(path)]
            return {"pages": [str(path)], "dpi": dpi, "sha256": self.worker.state["pdf"]["sha256"]}
        path = self.worker.work / "baseline.png"
        path.write_bytes(b"different pixels" if mismatch else b"synthetic rendered pixels")
        self.worker.state["draft"]["rendered"] = [str(path)]
        self.worker.state["draft"]["images"] = [{"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "pixels": [10, 20]}]
        self.worker.render = render

    def test_four_requests_save_initial_pp_updated_and_completion_separately(self):
        finish = self.start_review()
        self.matching_renders()
        finish["extraction"]["vendor"] = "Corrected Synthetic Shop"
        result = self.worker.handle(finish)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"]["phase"], "complete")
        self.assertEqual(self.fake.initial_draft["extraction"]["vendor"], "Synthetic Shop")
        submitted = json.loads(self.fake.submit_bytes[0])
        self.assertEqual(submitted["assessment"]["confirmation_sha256"], self.worker.state["confirmation"]["sha256"])
        self.assertEqual(self.worker.state["layout_approval"]["sha256"], self.worker.state["draft"]["pixel_pdf"]["sha256"])
        self.assertEqual(submitted["extraction"]["vendor"], "Corrected Synthetic Shop")
        self.assertIn("vendor", submitted["assessment"]["changed_fields"])
        proof = self.worker.load(self.worker.state["pixel_verification"])
        self.assertTrue(proof["identical"])
        completion = json.loads(Path(result["result"]["completion_file"]).read_text())
        self.assertEqual(completion["claim_state"], "closed")
        self.assertNotIn("Synthetic Shop", json.dumps(completion))
        self.assertTrue(self.fake.documents[fixtures.DID]["checks"]["pdf"])
        steps = [json.loads(p.read_text())["op"] for p in sorted(self.worker.work.glob("*-workflow-step.json"))]
        self.assertLess(steps.index("draft"), steps.index("prepare"))
        self.assertLess(steps.index("confirm"), steps.index("assess"))
        self.assertEqual(self.fake.pdf_calls, 1)

    def test_changed_final_pixels_require_real_final_visual_attestation(self):
        finish = self.start_review()
        self.matching_renders(mismatch=True)
        result = self.worker.handle(finish)
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["result"]["needs_pdf_review"])
        self.assertEqual(self.worker.state["phase"], "pdf")
        self.assertFalse(self.fake.documents[fixtures.DID]["checks"]["pdf"])
        self.assertNotIn("completion_file", self.worker.state)
        request = result["result"]["request"]
        request.update(all_pages_inspected=True, evidence="Inspected every final synthetic page; layout remains correct.")
        attested = self.worker.handle(request)
        self.assertTrue(attested["ok"], attested)
        self.assertIn("completion_file", attested["result"])

    def test_missing_inspection_or_caller_hash_overrides_do_not_submit(self):
        finish = self.start_review()
        for changes in ({"all_pages_inspected": False}, {"draft_sha256": "0"*64}, {"layout_evidence": ""},
                        {"confirmation_sha256": "0"*64}):
            with self.subTest(changes=changes):
                result = self.worker.handle({**finish, **changes})
                self.assertIn("input_error", result)
                self.assertNotIn("assessment", self.worker.state)
                self.assertEqual(self.fake.submit_bytes, [])

    def test_validation_error_keeps_initial_checkpoint_and_allows_corrected_finish(self):
        finish = self.start_review()
        self.matching_renders()
        result = self.worker.handle({**finish, "extraction": {}})
        self.assertTrue(result["ok"])
        self.assertFalse(result["result"]["assessed"])
        self.assertEqual(self.fake.submit_bytes, [])
        result = self.worker.handle(finish)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"]["phase"], "complete")

    def test_no_pdf_document_finishes_without_rendering_or_attesting(self):
        finish = self.start_review()
        finish["extraction"]["vendor"] = None
        result = self.worker.handle(finish)
        self.assertTrue(result["ok"], result)
        self.assertFalse(result["result"]["pdf_applicable"])
        self.assertEqual(self.fake.pdf_calls, 0)
        self.assertIn("completion_file", result["result"])

    def test_lost_submit_stops_before_pdf_and_preserves_exact_payload(self):
        finish = self.start_review()
        self.fake.lost_submit = True
        result = self.worker.handle(finish)
        self.assertTrue(result["blocking"])
        self.assertEqual(self.worker.state["phase"], "submit-uncertain")
        self.assertEqual(self.worker.state["failed"]["step"], "submit")
        self.assertEqual(self.fake.pdf_calls, 0)
        self.assertEqual((self.worker.work / self.worker.state["submit_request"]).read_bytes(), self.fake.submit_bytes[0])
        self.assertFalse(self.worker.handle(finish)["ok"])
        self.assertEqual(len(self.fake.submit_bytes), 1)

    def test_lost_upload_stops_before_any_automatic_attestation(self):
        finish = self.start_review()
        self.fake.lost_pdf = True
        result = self.worker.handle(finish)
        self.assertTrue(result["blocking"])
        self.assertEqual(self.worker.state["phase"], "pdf-uncertain")
        self.assertEqual(self.worker.state["failed"]["step"], "pdf")
        self.assertFalse(self.fake.documents[fixtures.DID]["checks"]["pdf"])
        self.assertTrue(Path(self.worker.state["pdf_intent"]["path"]).is_file())

    def test_changed_approved_draft_blocks_attestation(self):
        finish = self.start_review()
        self.matching_renders()
        Path(self.worker.state["draft"]["pixel_pdf"]["path"]).write_bytes(b"changed draft")
        result = self.worker.handle(finish)
        self.assertTrue(result["blocking"])
        self.assertFalse(self.fake.documents[fixtures.DID]["checks"]["pdf"])

    def test_begin_exposes_only_claimed_image_before_independent_observation(self):
        self.fake.next_images = [{"id": fixtures.OTHER, "sha256": self.fake.documents[fixtures.OTHER]["pages"][0]["sha256"],
                                  "document_id": fixtures.OTHER}]
        begun = self.send("begin", viewer_checked=True)
        self.assertEqual(list(self.worker.state["sources"]), [fixtures.DID])
        self.assertFalse(any("context?" in path for _, path in self.fake.calls))
        request = begun["request"]
        request["observation"]["type"] = "receipt"
        packet = self.worker.handle(request)
        self.assertTrue(packet["ok"], packet)
        self.assertEqual([p["captureId"] for p in packet["result"]["previews"]], [fixtures.OTHER])
        review = packet["result"]["request"]
        review["extraction"] = fixtures.extraction()
        result = self.worker.handle(review)
        self.assertIn("input_error", result)  # unaccounted neighbor may not be silently discarded
        self.assertFalse(self.worker.state.get("draft_saved"))

    def test_begin_crop_retry_never_claims_again(self):
        with patch.object(self.worker, "render_file", side_effect=module.InputError("Synthetic layout needs correction")):
            result = self.worker.handle(dict(op="begin", viewer_checked=True))
        self.assertIn("input_error", result)
        self.assertEqual(self.worker.state["phase"], "claimed")
        self.send("begin", viewer_checked=True)
        self.assertEqual(sum(path.endswith("/claim") for _, path in self.fake.calls), 1)

    def test_review_freezes_and_prepares_every_grouped_page_in_order(self):
        self.worker.confirmation_provider = "ppocr"
        self.fake.next_images = [{"id": fixtures.OTHER, "sha256": self.fake.documents[fixtures.OTHER]["pages"][0]["sha256"],
                                  "document_id": fixtures.OTHER}]
        begun = self.send("begin", viewer_checked=True)
        request = begun["request"]
        request["observation"]["type"] = "receipt"
        packet = self.worker.handle(request)["result"]
        self.send("context", filters={"after_capture": fixtures.OTHER})
        request = packet["request"]
        request.update(extraction=fixtures.extraction(),
            grouping={"donor_ids": [fixtures.OTHER], "capture_ids": [fixtures.DID, fixtures.OTHER],
                      "evidence": "Synthetic complementary continuation."},
            page_review={"capture_ids": [fixtures.DID, fixtures.OTHER], "excluded": []})
        reviewed = self.worker.handle(request)
        self.assertTrue(reviewed["ok"], reviewed)
        self.assertEqual(reviewed["result"]["draft"]["pages"], 2)
        self.assertEqual(list(self.worker.state["prepared"]), [fixtures.DID, fixtures.OTHER])
        self.assertEqual([p["captureId"] for p in self.fake.initial_draft["documents"][0]["pages"]],
                         [fixtures.DID, fixtures.OTHER])
        confirmation = self.worker.state["confirmation"]["qwen"]  # FakeScanner stores the provider request here.
        self.assertEqual(confirmation["provider"], "ppocr")
        self.assertEqual([p["capture_id"] for p in confirmation["artifacts"]], [fixtures.DID, fixtures.OTHER])

    def test_begin_preserves_an_explicitly_corrected_crop(self):
        self.send("begin", viewer_checked=True)
        corrected = self.send("previews", capture_ids=[fixtures.DID], layouts={fixtures.DID: {"crop": [2, 3, 8, 17]}})[0]
        repeated = self.send("begin", viewer_checked=True)
        self.assertEqual(repeated["claimed_preview"], corrected)
        self.assertEqual(self.worker.state["layouts"][fixtures.DID]["crop"], [2, 3, 8, 17])
        self.assertEqual(sum(path.endswith("/claim") for _, path in self.fake.calls), 1)

    def test_new_extraction_template_has_all_fields_but_no_fabricated_observations(self):
        template = module.extraction_template()
        self.assertEqual(set(template), set(fixtures.extraction()))
        self.assertIsNone(template["has_handwriting"])
        self.assertIsNone(template["has_payment_slip"])
        self.assertIsNone(template["vendor"])


if __name__ == "__main__":
    unittest.main()
