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
        self.page = dict(captureId=self.capture_id, sha256='1' * 64, crop=[0, 0, 100, 200], rotation=0)
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
        self.profile = dict(repository=str(self.repo), origin=self.origin)
        self.write(self.repo / 'profile.json', self.profile)
        self.write(self.repo / '.local' / 'processing-host.json', dict(worker_profile=str(self.repo / 'profile.json')))
        self.client = Mock(origin=self.origin)
        self.client.get.side_effect = lambda url: (dict(claim_active=False, attempt_saved=True)
            if url.startswith('/api/processing/readings?') else dict(document=self.document))
        self.addCleanup(patch.stopall)

    def write(self, path, value):
        path.write_text(json.dumps(value), encoding='utf-8')

    def verify(self):
        self.write(self.work / 'state.json', self.state)
        return module.verify_run(self.repo, self.run_id, 'synthetic-task', client=self.client)

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

    def merged_receipt(self):
        donor_id = '33333333-3333-4333-8333-333333333333'
        pages = [dict(self.page, captureId='44444444-4444-4444-8444-444444444444', sha256='4' * 64),
                 dict(self.page, captureId='55555555-5555-4555-8555-555555555555', sha256='5' * 64)]
        old = dict(id=donor_id, revision=7, pages=copy.deepcopy(pages), duplicateOf=None, mergedInto=None)
        previous_run = 'b' * 32
        previous_dir = self.work.parent / previous_run
        previous_dir.mkdir()
        self.write(previous_dir / 'state.json', dict(run_id=previous_run, phase='complete',
                   batch_id='c' * 32, document=old))
        self.write(self.work.parent / 'batch-state.json', dict(batch_id='c' * 32, started_at=100,
                   phase='active', owner='synthetic-task', verified_runs={previous_run: dict(
                       document_id=donor_id, revision=7, capture_ids=[p['captureId'] for p in pages],
                       source_pages=module.source_pages(old))}))
        self.document['pages'].extend(pages)
        self.state['document'] = copy.deepcopy(self.document)
        self.state['draft']['target']['pages'] = copy.deepcopy(self.document['pages'])
        self.state['draft']['page_review']['capture_ids'] = [p['captureId'] for p in self.document['pages']]
        self.state['pdf']['pages'] = 3
        donor = dict(id=donor_id, revision=8, pages=[], mergedInto=self.document_id, duplicateOf=None)
        self.state['draft']['documents'] = [dict(self.document, revision=3), dict(donor, revision=7)]
        self.write(self.work / '0039-submit-response.json', dict(saved=[
            dict(id=self.document_id, revision=4), dict(id=donor_id, revision=8)]))
        self.client.get.side_effect = lambda url: (dict(claim_active=False, attempt_saved=True)
            if url.startswith('/api/processing/readings?') else dict(document=donor if url.endswith(donor_id) else self.document))
        return donor

    def test_later_slip_verifies_whole_receipt_absorption_after_pdf_completion(self):
        self.merged_receipt()
        self.assertEqual(self.verify()['superseded_run_ids'], ['b' * 32])
        self.document['pdf']['sha256'] = '0' * 64
        with self.assertRaisesRegex(InputError, 'PDF attestation'):
            self.verify()

    def test_actual_guard_counts_a_late_merge_once_and_revalidates_it_at_finish(self):
        from receipt_batch import BatchGuard
        self.merged_receipt()
        self.write(self.work / 'state.json', self.state)
        path = self.work.parent / 'batch-state.json'
        batch = json.loads(path.read_text())
        self.write(path, {**batch, 'requested_count': 1, 'completed_count': 1})
        guard = BatchGuard(self.work.parent, 'synthetic-task', Mock(client=self.client))
        self.addCleanup(guard.close)
        result = guard.handle(dict(op='verify', run_id=self.run_id))
        self.assertEqual(result['completed_count'], 1)
        self.assertEqual(set(result['verified_runs']), {self.run_id})
        self.assertEqual(result['superseded_runs']['b' * 32]['proof'], batch['verified_runs']['b' * 32])
        replay = guard.handle(dict(op='verify', run_id=self.run_id))
        self.assertEqual(replay['completed_count'], 1)
        finished = guard.handle(dict(op='finish'))
        self.assertEqual(finished['phase'], 'complete')
        for state in [replay, finished]:
            proof = state['verified_runs'][self.run_id]
            self.assertEqual(proof['superseded_run_ids'], ['b' * 32])
            self.assertEqual(proof['superseded_documents'], result['verification']['superseded_documents'])
            self.assertEqual(proof['source_pages'], module.source_pages(self.document))

    def test_archived_merge_evidence_is_rechecked_on_repeat_and_finish(self):
        from receipt_batch import BatchGuard
        donor = self.merged_receipt()
        self.write(self.work / 'state.json', self.state)
        path = self.work.parent / 'batch-state.json'
        batch = json.loads(path.read_text())
        self.write(path, {**batch, 'requested_count': 1, 'completed_count': 1})
        guard = BatchGuard(self.work.parent, 'synthetic-task', Mock(client=self.client))
        self.addCleanup(guard.close)
        guard.handle(dict(op='verify', run_id=self.run_id))
        original_pages = copy.deepcopy(self.document['pages'])
        previous_path = self.work.parent / ('b' * 32) / 'state.json'
        previous = json.loads(previous_path.read_text())
        for corruption in ['source', 'order', 'prior-proof', 'revision']:
            with self.subTest(corruption=corruption):
                pages = copy.deepcopy(original_pages)
                old = copy.deepcopy(previous)
                donor['revision'] = 8
                if corruption == 'source':
                    pages[1]['sha256'] = '0' * 64
                elif corruption == 'order':
                    pages[1], pages[2] = pages[2], pages[1]
                elif corruption == 'prior-proof':
                    old['document']['pages'][0]['sha256'] = pages[1]['sha256'] = '0' * 64
                else:
                    donor['revision'] = 9
                self.write(previous_path, old)
                self.document['pages'] = copy.deepcopy(pages)
                self.state['document']['pages'] = copy.deepcopy(pages)
                self.state['draft']['target']['pages'] = copy.deepcopy(pages)
                self.state['draft']['page_review']['capture_ids'] = [p['captureId'] for p in pages]
                self.state['draft']['documents'][1]['revision'] = donor['revision'] - 1
                self.write(self.work / '0039-submit-response.json', dict(saved=[
                    dict(id=self.document_id, revision=4), dict(id=donor['id'], revision=donor['revision'])]))
                self.write(self.work / 'state.json', self.state)
                for request in [dict(op='verify', run_id=self.run_id), dict(op='finish')]:
                    with self.assertRaises(InputError):
                        guard.handle(request)
                    self.assertEqual(guard.state['phase'], 'active')

    def test_retargeted_duplicate_preserves_its_pages_without_entering_the_pdf(self):
        donor = self.merged_receipt()
        alias_id = '66666666-6666-4666-8666-666666666666'
        duplicate = dict(id=alias_id, revision=2, pages=[dict(self.page, captureId=alias_id)],
                         duplicateOf=donor['id'], mergedInto=None)
        old_run = 'd' * 32
        old_dir = self.work.parent / old_run
        old_dir.mkdir()
        self.write(old_dir / 'state.json', dict(run_id=old_run, phase='complete', document=duplicate))
        path = self.work.parent / 'batch-state.json'
        batch = json.loads(path.read_text())
        batch['verified_runs'][old_run] = dict(document_id=alias_id, revision=2, capture_ids=[alias_id])
        self.write(path, batch)
        alias = {**copy.deepcopy(duplicate), 'revision': 3, 'duplicateOf': self.document_id}
        path = self.work / '0039-submit-response.json'
        response = json.loads(path.read_text())
        response['saved'].append(dict(id=alias_id, revision=3))
        self.write(path, response)
        self.client.get.side_effect = lambda url: (dict(claim_active=False, attempt_saved=True)
            if url.startswith('/api/processing/readings?') else dict(document={
                donor['id']: donor, alias_id: alias, self.document_id: self.document}[url.rsplit('/', 1)[1]]))
        self.assertEqual(self.verify()['superseded_run_ids'], ['b' * 32, old_run])
        alias['pages'][0]['rotation'] = 90
        with self.assertRaisesRegex(InputError, 'duplicate must preserve'):
            self.verify()

    def test_merge_cannot_supersede_changed_sources_or_reordered_pages(self):
        self.merged_receipt()
        original = copy.deepcopy(self.document['pages'])
        for pages in [[original[0], original[2], original[1]], original[:2],
                      [original[0], dict(original[1], sha256='0' * 64), original[2]]]:
            self.document['pages'] = copy.deepcopy(pages)
            self.state['document']['pages'] = copy.deepcopy(pages)
            self.state['draft']['target']['pages'] = copy.deepcopy(pages)
            self.state['draft']['page_review']['capture_ids'] = [p['captureId'] for p in pages]
            self.state['pdf']['pages'] = len(pages)
            with self.assertRaisesRegex(InputError, 'prior source hash'):
                self.verify()

    def test_unrelated_or_stale_donor_change_cannot_replace_previous_proof(self):
        donor = self.merged_receipt()
        donor['mergedInto'] = self.capture_id
        with self.assertRaisesRegex(InputError, 'relationships differ'):
            self.verify()
        donor['mergedInto'] = self.document_id
        donor['revision'] += 1
        with self.assertRaisesRegex(InputError, 'changed after submission'):
            self.verify()
        donor['revision'] -= 1
        self.state['draft']['documents'][1]['revision'] -= 1
        with self.assertRaisesRegex(InputError, 'relationships differ'):
            self.verify()

    def test_failed_or_unfinished_run_cannot_count(self):
        for values in [dict(phase='submitted'), dict(failed=dict(error='synthetic'))]:
            original = copy.deepcopy(self.state)
            self.state.update(values)
            with self.assertRaises(InputError):
                self.verify()
            self.state = original
        self.client.get.assert_not_called()

    def test_missing_submit_acknowledgement_is_not_success(self):
        self.state['submit_response'] = 'guessed-submit-response.json'
        with self.assertRaises(FileNotFoundError):
            self.verify()
        self.client.get.assert_not_called()

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
        self.client.get.assert_not_called()

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
        self.client.get.assert_not_called()

    def test_inactive_or_differently_owned_batch_is_rejected(self):
        for changes in [dict(phase='complete'), dict(owner='different-task'), dict(batch_id='invalid')]:
            self.write(self.work.parent / 'batch-state.json', {
                'batch_id': 'c' * 32, 'started_at': 100, 'phase': 'active',
                'owner': 'synthetic-task', **changes,
            })
            with self.assertRaises(InputError):
                self.verify()
        self.client.get.assert_not_called()
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
        self.client.get.assert_not_called()

    def test_submit_acknowledgement_must_cover_every_affected_document(self):
        donor_id = '33333333-3333-4333-8333-333333333333'
        self.state['draft']['documents'] = [
            dict(id=self.document_id),
            dict(id=donor_id),
        ]
        with self.assertRaisesRegex(InputError, 'omitted an affected document'):
            self.verify()
        self.client.get.assert_not_called()

    def test_path_escape_is_rejected(self):
        with self.assertRaises(InputError):
            module.verify_run(self.repo, '../other', 'synthetic-task', client=self.client)
        self.state['submit_response'] = str(self.repo / 'outside.json')
        with self.assertRaises(InputError):
            self.verify()


if __name__ == '__main__':
    unittest.main()
