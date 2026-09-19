"""Grouped workflow tests with isolated synthetic scanner state; no production access."""
import hashlib
import json
from copy import deepcopy
from pathlib import Path
import unittest
from unittest.mock import patch

import receipt_worker as module
import test_receipt_worker as fixtures


class WorkflowTests(unittest.TestCase):
    make_worker = fixtures.WorkerTests.make_worker
    send = fixtures.WorkerTests.send

    def setUp(self):
        fixtures.WorkerTests.setUp(self)
        self.fake.jev_ready = True

    def test_ocr_first_finishes_without_viewing_or_attesting_pdf(self):
        finish = self.start_review()
        finish.update(all_pages_inspected=False, layout_evidence='Ordered PP source records checked; no visual review.')
        with patch.object(self.worker, 'render', side_effect=AssertionError('No final render needed')):
            result = self.worker.handle(finish)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['phase'], 'complete')
        self.assertFalse(result['result']['pdf_review_attested'])
        self.assertTrue(result['result']['pdf_applicable'])
        self.assertFalse(self.fake.documents[fixtures.DID]['checks']['pdf'])
        self.assertNotIn(('POST', '/api/processing/pdf-review'), self.fake.calls)
        self.assertIsNone(json.loads(self.fake.submit_bytes[0])['extraction']['has_handwriting'])

    def test_pdf_preparation_failure_recovers_without_resubmitting_or_viewing(self):
        finish = self.start_review()
        finish['all_pages_inspected'] = False
        with patch.object(self.fake, 'pdf', side_effect=FileNotFoundError('output directory')):
            failed = self.worker.handle(finish)
        self.assertTrue(failed['blocking'])
        self.assertEqual(self.worker.state['phase'], 'pdf-preparing')
        self.assertNotIn('pdf_intent', self.worker.state)
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state['run_id'])
        self.assertTrue(self.worker.handle(dict(op='reconcile'))['ok'])
        with patch.object(self.worker, 'render', side_effect=AssertionError('No visual review')):
            result = self.worker.handle(dict(op='pdf'))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['phase'], 'complete')
        self.assertTrue(result['result']['pdf_applicable'])
        self.assertFalse(result['result']['pdf_review_attested'])
        self.assertIn('completion_file', result['result'])
        self.assertEqual(len(self.fake.submit_bytes), 1)
        self.assertEqual(self.fake.pdf_calls, 1)

    def test_lost_ocr_first_pdf_ack_recovers_without_visual_review_or_reupload(self):
        finish = self.start_review()
        finish['all_pages_inspected'] = False
        self.fake.lost_pdf = True
        self.assertTrue(self.worker.handle(finish)['blocking'])
        self.worker.lock.close()
        self.worker = self.make_worker(self.worker.state['run_id'])
        with patch.object(self.worker, 'render', side_effect=AssertionError('Recovery must not require vision')):
            result = self.worker.handle(dict(op='retry-pdf'))
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['result']['phase'], 'complete')
        self.assertEqual(self.fake.pdf_calls, 1)
        self.assertEqual(self.fake.pdf_uploads, [])
        self.assertIn('completion_file', result['result'])

    def test_unrelated_preview_does_not_prove_retained_handwriting_absent(self):
        finish = self.start_review()
        self.worker.state['preview_records'] = {fixtures.OTHER: {'preview': 'unrelated.jpg'}}
        finish.update(all_pages_inspected=False)
        finish['extraction']['has_handwriting'] = False
        self.assertIn('has_handwriting null', self.worker.handle(finish)['input_error'])
        self.assertEqual(self.fake.submit_bytes, [])

    def test_missing_ocr_waits_then_retries_same_claim(self):
        prepare = self.fake.prepare
        def missing(cid, directory, **kwargs):
            self.assertFalse(kwargs['allow_inference'])
            raise module.OCRRequired(self.fake.origin, dict(capture_id=cid,
                sha256=self.fake.documents[cid]['pages'][0]['sha256'], crop=kwargs['crop'], rotation=kwargs['rotation']))
        self.fake.prepare = missing
        waiting = self.worker.handle({'op': 'begin', 'viewer_checked': True})
        self.assertTrue(waiting['ocr_required'])
        self.assertFalse(waiting['blocking'])
        self.assertEqual(self.worker.state['phase'], 'claimed')
        self.assertNotIn('failed', self.worker.state)
        self.assertEqual(json.loads(Path(waiting['request_file']).read_text())['capture_id'], fixtures.DID)
        self.fake.prepare = prepare
        self.assertIn('claimed_ocr', self.send('begin', viewer_checked=True))
        self.assertEqual(self.fake.calls.count(('POST', '/api/processing/claim')), 1)

    def test_renewal_failure_while_waiting_for_ocr_stays_blocking_on_retry(self):
        with patch.object(self.fake, 'prepare', side_effect=module.OCRRequired(self.fake.origin,
                dict(capture_id=fixtures.DID, sha256='a' * 64, crop=None, rotation=0))):
            self.assertTrue(self.worker.handle({'op': 'begin', 'viewer_checked': True})['ocr_required'])
        self.worker.failure('renew', 'Synthetic automatic claim renewal failure.')
        original_failure = dict(self.worker.state['failed'])
        retried = self.worker.handle({'op': 'begin', 'viewer_checked': True})
        self.assertTrue(retried['blocking'])
        self.assertNotIn('input_error', retried)
        self.assertEqual(self.worker.state['failed'], original_failure)
        self.assertEqual(self.fake.calls.count(('POST', '/api/processing/claim')), 1)

    def start_review(self):
        self.worker.confirmation_provider = "ppocr"
        begun = self.send("begin", viewer_checked=True)
        self.assertEqual(begun["image_request"]["capture_ids"], [fixtures.DID])
        self.assertEqual(begun["claimed_ocr"][0]["capture_id"], fixtures.DID)
        self.assertTrue(begun["jev"]["ready"])
        self.assertTrue(begun["images_optional"])
        request = begun["request"]
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

    def test_three_requests_save_initial_pp_jev_updated_and_completion_separately(self):
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
        self.assertNotIn("prepare", steps)
        self.assertLess(steps.index("ocr"), steps.index("draft"))
        self.assertEqual(self.worker.state['draft']['input_mode'], 'ppocr-first')
        self.assertIn('not an independent visual OCR reading', self.fake.initial_draft['extraction']['evidence'])
        self.assertLess(steps.index("confirm"), steps.index("assess"))
        self.assertEqual(self.fake.pdf_calls, 1)

    def test_confirmation_reuses_exact_initial_ocr_without_refetch(self):
        original_prepare = self.fake.prepare
        calls = []
        def prepare(*args, **kwargs):
            calls.append(args[0])
            return original_prepare(*args, **kwargs)
        self.fake.prepare = prepare
        self.start_review()
        for item in self.worker.state['draft']['ocr_inputs']:
            self.assertEqual(calls.count(item['capture_id']), 1)
            self.assertEqual(self.worker.state['prepared'][item['capture_id']]['ocr_sha256'], item['ocr_sha256'])

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
        for changes in ({"all_pages_inspected": None}, {"draft_sha256": "0"*64}, {"layout_evidence": ""},
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

    def test_begin_exposes_all_claimed_ocr_and_jev_without_neighbor_context(self):
        self.fake.next_images = [{"id": fixtures.OTHER, "sha256": self.fake.documents[fixtures.OTHER]["pages"][0]["sha256"],
                                  "document_id": fixtures.OTHER}]
        begun = self.send("begin", viewer_checked=True)
        self.assertEqual(list(self.worker.state["sources"]), [])
        self.assertEqual(begun['claimed_ocr'][0]['source_sha256'], self.fake.documents[fixtures.DID]['pages'][0]['sha256'])
        self.assertNotIn('text_only_pdf_layers', begun['claimed_ocr'][0])
        self.assertTrue(begun['jev']['ready'])
        self.assertFalse(any("context?" in path for _, path in self.fake.calls))
        review = begun["request"]
        review["extraction"] = fixtures.extraction()
        self.assertTrue(self.worker.handle(review)["result"]["draft"]["drafted"])

    def test_begin_crop_retry_never_claims_again(self):
        with patch.object(self.fake, "saved_ocr", side_effect=module.InputError("Synthetic layout needs correction")):
            result = self.worker.handle(dict(op="begin", viewer_checked=True))
        self.assertIn("input_error", result)
        self.assertEqual(self.worker.state["phase"], "claimed")
        self.send("begin", viewer_checked=True)
        self.assertEqual(sum(path.endswith("/claim") for _, path in self.fake.calls), 1)

    def test_review_freezes_and_prepares_every_preassembled_page_in_order(self):
        self.worker.confirmation_provider = "ppocr"
        self.fake.raw[fixtures.FOREIGN] = b"synthetic second page"
        self.fake.documents[fixtures.DID]["pages"].append({
            "captureId": fixtures.FOREIGN,
            "sha256": hashlib.sha256(self.fake.raw[fixtures.FOREIGN]).hexdigest(),
            "rotation": 0,
            "crop": None,
        })
        begun = self.send("begin", viewer_checked=True)
        request = begun["request"]
        request["extraction"] = fixtures.extraction()
        reviewed = self.worker.handle(request)
        self.assertTrue(reviewed["ok"], reviewed)
        self.assertEqual(reviewed["result"]["draft"]["pages"], 2)
        self.assertEqual(list(self.worker.state["prepared"]), [fixtures.DID, fixtures.FOREIGN])
        self.assertEqual([p["captureId"] for p in self.fake.initial_draft["documents"][0]["pages"]],
                         [fixtures.DID, fixtures.FOREIGN])
        confirmation = self.worker.state["confirmation"]["qwen"]  # FakeScanner stores the provider request here.
        self.assertEqual(confirmation["provider"], "ppocr")
        self.assertEqual([p["capture_id"] for p in confirmation["artifacts"]], [fixtures.DID, fixtures.FOREIGN])

    def test_begin_preserves_an_explicitly_corrected_crop(self):
        self.send("begin", viewer_checked=True)
        corrected = self.send("previews", capture_ids=[fixtures.DID], layouts={fixtures.DID: {"crop": [2, 3, 8, 17]}})[0]
        repeated = self.send("begin", viewer_checked=True)
        self.assertEqual(repeated["claimed_ocr"][0]["layout"], corrected['layout'])
        self.assertEqual(self.worker.state["layouts"][fixtures.DID]["crop"], [2, 3, 8, 17])
        self.assertEqual(sum(path.endswith("/claim") for _, path in self.fake.calls), 1)

    def test_ocr_request_validation_is_correctable(self):
        result = self.worker.handle({'op': 'ocr'})
        self.assertIn('input_error', result)
        self.assertNotIn('failed', self.worker.state)

    def test_changed_crop_requires_new_ocr_before_initial_draft(self):
        begun = self.send('begin', viewer_checked=True)
        self.send('previews', capture_ids=[fixtures.DID], layouts={fixtures.DID: {'crop': [2, 3, 8, 17]}})
        review = begun['request']
        review['extraction'] = fixtures.extraction()
        self.assertIn('Read ocr', self.worker.handle(review)['input_error'])
        self.assertFalse(self.worker.state.get('draft_saved'))
        reading = self.send('ocr', capture_ids=[fixtures.DID])[0]
        self.assertTrue(self.worker.handle(review)['result']['draft']['drafted'])
        pinned = self.worker.state['draft']['ocr_inputs'][0]
        self.assertEqual(pinned['ocr_sha256'], reading['ocr_sha256'])
        self.assertEqual(pinned['layout']['crop'], [2, 3, 8, 17])

    def test_non_string_evidence_is_correctable_before_provenance_injection(self):
        begun = self.send('begin', viewer_checked=True)
        review = begun['request']
        review['extraction'] = fixtures.extraction()
        review['extraction']['evidence'] = None
        original_check = self.worker.check
        self.worker.check = lambda operation, **values: (
            {'errors': ['Source evidence is required'], 'arithmetic': {}}
            if operation == 'validate' and not isinstance(values['extraction'].get('evidence'), str)
            else original_check(operation, **values))
        result = self.worker.handle(review)
        self.assertFalse(result['result']['drafted'])
        self.assertNotIn('failed', self.worker.state)
        review['extraction']['evidence'] = 'Category: Synthetic shop. Confidence: clear PP text.'
        self.assertTrue(self.worker.handle(review)['result']['draft']['drafted'])

    def test_new_extraction_template_has_all_fields_but_no_fabricated_observations(self):
        template = module.extraction_template()
        self.assertEqual(set(template), set(fixtures.extraction()))
        self.assertIsNone(template["has_handwriting"])
        self.assertIsNone(template["has_payment_slip"])
        self.assertIsNone(template["vendor"])


if __name__ == "__main__":
    unittest.main()
