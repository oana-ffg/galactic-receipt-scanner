import copy
import json
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import receipt_batch_verify as module
from receipt_worker import InputError


class VerificationTests(unittest.TestCase):
    def test_ocr_first_saved_pdf_verifies_without_claiming_visual_attestation(self):
        data = b'%PDF-synthetic-structural'
        digest = hashlib.sha256(data).hexdigest()
        path = self.work / 'final.pdf'
        path.write_bytes(data)
        self.state.update(input_mode='ppocr-first', pdf_validation='source-layout-and-upload', layout_approval=dict(visual=False))
        self.state['pdf'] = dict(path=str(path), sha256=digest, revision=4, pages=1)
        self.document.update(revision=4, checks=dict(pdf=False), reviewedPdfSha256=None, pdf=dict(sha256=digest, revision=4))
        self.state['document'] = copy.deepcopy(self.document)
        self.assertEqual(self.verify()['pdf_validation'], 'source-layout-and-upload')
        path.write_bytes(b'corrupted')
        with self.assertRaisesRegex(InputError, 'changed after upload'):
            self.verify()
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.run_id = 'a' * 32
        self.work = self.repo / '.local' / 'receipt-worker' / self.run_id
        self.work.mkdir(parents=True)
        self.write(self.work.parent / 'batch-state.json', dict(batch_id='c' * 32, started_at=100, phase='active', owner='synthetic-task'))
        self.origin = 'https://scanner.example'
        self.document_id = '11111111-1111-4111-8111-111111111111'
        self.capture_id = '22222222-2222-4222-8222-222222222222'
        self.page = dict(captureId=self.capture_id, crop=[0, 0, 100, 200], rotation=0)
        self.document = dict(id=self.document_id, revision=5, status='model-review',
                             filename='synthetic.pdf', pages=[self.page],
                             checks=dict(pdf=True), reviewedPdfSha256='b' * 64,
                             pdf=dict(sha256='b' * 64))
        self.state = dict(run_id=self.run_id, phase='complete', origin=self.origin, claim_started=101,
                          claim=dict(document=dict(id=self.document_id), token='synthetic-private-token'),
                          submit_response='0039-submit-response.json',
                          draft=dict(page_review=dict(capture_ids=[self.capture_id]), target=dict(pages=[self.page])),
                          document=copy.deepcopy(self.document), pdf=dict(sha256='b' * 64, pages=1))
        self.write(self.work / '0039-submit-response.json', dict(saved=[dict(id=self.document_id, revision=4)]))
        self.profile = dict(repository=str(self.repo), origin=self.origin, client_config='synthetic-config')
        self.write(self.repo / 'profile.json', self.profile)
        self.write(self.repo / '.local' / 'processing-host.json', dict(worker_profile=str(self.repo / 'profile.json')))
        self.client = Mock(origin=self.origin)
        self.client.get.side_effect = lambda url: (dict(claim_active=False, attempt_saved=True)
            if url.startswith('/api/processing/readings?') else dict(document=self.document))
        self.addCleanup(patch.stopall)
        patch.object(module, 'credentials', return_value={}).start()
        self.client_factory = patch.object(module, 'ScannerClient', return_value=self.client).start()

    def write(self, path, value):
        path.write_text(json.dumps(value), encoding='utf-8')

    def verify(self):
        self.write(self.work / 'state.json', self.state)
        return module.verify_run(self.repo, self.run_id, 'synthetic-task')

    def test_actual_journal_reference_and_live_readback_generate_compact_proof(self):
        result = self.verify()
        self.assertTrue(result['verified'])
        self.assertEqual(result['capture_ids'], [self.capture_id])
        self.assertEqual(result['page_count'], 1)
        self.assertEqual(result['affected_document_ids'], [self.document_id])
        proof = json.loads(Path(result['verification_file']).read_text())
        self.assertEqual(proof, {k: v for k, v in result.items() if k != 'verification_file'})
        self.assertNotIn('synthetic-private-token', json.dumps(result))
        self.assertNotIn('extraction', result)
        self.assertEqual(self.client.get.call_count, 2)

    def test_failed_or_unfinished_run_cannot_count(self):
        for values in [dict(phase='submitted'), dict(failed=dict(error='synthetic'))]:
            original = copy.deepcopy(self.state)
            self.state.update(values)
            with self.assertRaises(InputError):
                self.verify()
            self.state = original
        self.client_factory.assert_not_called()

    def test_missing_submit_acknowledgement_is_not_success(self):
        self.state['submit_response'] = 'guessed-submit-response.json'
        with self.assertRaises(FileNotFoundError):
            self.verify()
        self.client_factory.assert_not_called()

    def test_response_for_different_document_is_rejected(self):
        self.write(self.work / '0039-submit-response.json', dict(saved=[dict(id=self.capture_id)]))
        with self.assertRaises(InputError):
            self.verify()

    def test_active_or_unsaved_claim_is_rejected(self):
        for checkpoint in [dict(claim_active=True, attempt_saved=True), dict(claim_active=False, attempt_saved=False), {}]:
            self.client.get.side_effect = None
            self.client.get.return_value = checkpoint
            with self.assertRaises(InputError):
                self.verify()
        self.assertEqual(list(self.work.glob('verification-*.json')), [])

    def test_changed_page_membership_or_layout_is_rejected(self):
        original = copy.deepcopy(self.document)
        for pages in [[], [dict(self.page, captureId=self.document_id)], [dict(self.page, rotation=90)]]:
            self.document['pages'] = pages
            with self.assertRaises(InputError):
                self.verify()
        self.document = original
        self.state['draft']['page_review']['capture_ids'] = [self.document_id]
        with self.assertRaises(InputError):
            self.verify()

    def test_missing_or_changed_pdf_attestation_is_rejected(self):
        original = copy.deepcopy(self.document)
        for values in [dict(checks=dict(pdf=False)), dict(reviewedPdfSha256='c' * 64), dict(pdf=dict(sha256='c' * 64))]:
            self.document.update(values)
            with self.assertRaises(InputError):
                self.verify()
            self.document = copy.deepcopy(original)
        self.state['pdf']['pages'] = 2
        with self.assertRaises(InputError):
            self.verify()

    def test_explicit_non_pdf_outcome_is_supported(self):
        self.document['filename'] = None
        self.state['document']['filename'] = None
        self.state.pop('pdf')
        self.document['revision'] = self.state['document']['revision'] = 4
        result = self.verify()
        self.assertFalse(result['pdf_applicable'])
        self.assertIsNone(result['pdf_sha256'])

    def test_later_same_page_revision_is_rejected(self):
        self.document['revision'] += 1
        with self.assertRaises(InputError):
            self.verify()
        self.assertEqual(list(self.work.glob('verification-*.json')), [])

    def test_unrelated_historical_run_is_rejected(self):
        self.state['claim_started'] = 99
        with self.assertRaises(InputError):
            self.verify()
        self.client_factory.assert_not_called()

    def test_origin_mismatch_is_rejected_before_network(self):
        self.state['origin'] = 'https://different.example'
        with self.assertRaises(InputError):
            self.verify()
        self.client.get.assert_not_called()

    def test_profile_checkout_mismatch_is_rejected(self):
        self.profile['repository'] = str(self.repo / 'other')
        self.write(self.repo / 'profile.json', self.profile)
        with self.assertRaises(InputError):
            self.verify()
        self.client_factory.assert_not_called()

    def test_inactive_or_differently_owned_batch_is_rejected(self):
        for changes in [dict(phase='complete'), dict(owner='different-task'), dict(batch_id='invalid')]:
            self.write(self.work.parent / 'batch-state.json', {
                'batch_id': 'c' * 32, 'started_at': 100, 'phase': 'active',
                'owner': 'synthetic-task', **changes,
            })
            with self.assertRaises(InputError):
                self.verify()
        self.client_factory.assert_not_called()
        self.assertEqual(list(self.work.glob('verification-*.json')), [])

    def test_blocked_batch_allows_read_only_verification_without_resuming_it(self):
        path = self.work.parent / 'batch-state.json'
        batch = json.loads(path.read_text())
        self.write(path, {**batch, 'phase': 'blocked'})
        before = path.read_bytes()
        result = self.verify()
        self.assertTrue(result['verified'])
        self.assertEqual(result['batch_phase'], 'blocked')
        self.assertEqual(path.read_bytes(), before)

    def test_worker_bound_to_another_batch_is_rejected(self):
        self.state['batch_id'] = 'd' * 32
        with self.assertRaisesRegex(InputError, 'different batch'):
            self.verify()
        self.client_factory.assert_not_called()

    def test_submit_acknowledgement_must_cover_every_affected_document(self):
        donor_id = '33333333-3333-4333-8333-333333333333'
        self.state['draft']['documents'] = [
            dict(id=self.document_id),
            dict(id=donor_id),
        ]
        with self.assertRaisesRegex(InputError, 'omitted an affected document'):
            self.verify()
        self.client_factory.assert_not_called()

    def test_path_escape_is_rejected(self):
        with self.assertRaises(InputError):
            module.verify_run(self.repo, '../other', 'synthetic-task')
        self.state['submit_response'] = str(self.repo / 'outside.json')
        with self.assertRaises(InputError):
            self.verify()


if __name__ == '__main__':
    unittest.main()
