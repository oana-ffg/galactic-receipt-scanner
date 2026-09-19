"""Synthetic Astra selection/readback tests; no live claims or receipt writes."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from receipt_api import ClientError
from receipt_verification import queue, verify


class VerificationTests(unittest.TestCase):
    def test_queue_selects_low_medium_once_without_exposing_receipt_values(self):
        def document(did, confidence='medium', **processing):
            return dict(id=did, revision=3, pageIds=['page'], scannedAt=['2026-01-01'],
                        vendor='PRIVATE MERCHANT', processing=dict(small_model_certainty=confidence,
                        large_model_confidence=None, has_human_review=False, disposition='model-review', **processing))
        reviewed = document('reviewed')
        reviewed['processing']['large_model_confidence'] = 'low'
        human = document('human')
        human['processing']['has_human_review'] = True
        pending = document('pending')
        pending['processing']['disposition'] = 'processing'
        client = Mock(origin='https://synthetic.example')
        client.get.side_effect = [dict(documents=[], next='jev-cursor'),
                                  dict(documents=[
                                      dict(document_id='a', ready=True, jev={'role': 'purchase_document'}),
                                      dict(document_id='b', ready=True, jev={'role': 'purchase_document'}),
                                      dict(document_id='not-ready', ready=False, jev={'role': 'purchase_document'}),
                                  ], next=None),
                                  dict(documents=[document('b'), document('high', 'high'), reviewed, human,
                                                  document('not-ready')], next='cursor'),
                                  dict(documents=[document('a', 'low'), pending, {**document('duplicate'), 'duplicateOf': 'a'}], next=None)]
        result = queue(client, 1)
        self.assertEqual(result['eligible'], 2)
        self.assertEqual([d['document_id'] for d in result['documents']], ['a'])
        self.assertNotIn('PRIVATE MERCHANT', json.dumps(result))
        self.assertTrue(any('after=jev-cursor' in call.args[0] for call in client.get.call_args_list))
        self.assertIn('after=cursor', client.get.call_args.args[0])

    def test_repeated_jev_cursor_is_not_reported_as_complete(self):
        client = Mock(origin='https://synthetic.example')
        client.get.side_effect = [dict(documents=[], next='same'), dict(documents=[], next='same')]
        with self.assertRaisesRegex(ClientError, 'Jev cursor'):
            queue(client)

    def test_repeated_cursor_is_not_reported_as_complete(self):
        client = Mock(origin='https://synthetic.example')
        client.get.side_effect = [dict(documents=[]), dict(documents=[], next='same'), dict(documents=[], next='same')]
        with self.assertRaisesRegex(ClientError, 'cursor'):
            queue(client)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.pages = [dict(captureId='capture', sha256='a' * 64, crop=None, rotation=0, type='receipt')]
        self.extraction = dict(type='receipt', total_minor=1234, certainty='medium', uncertainties=[], broken_reasons=[])
        self.claim = dict(token='synthetic-token', stage='large', document=dict(id='doc', revision=3, pages=self.pages))
        self.final = dict(id='doc', revision=4, pages=self.pages, filename=None, status='review',
                          processing=dict(large_model_confidence='medium', extraction=deepcopy(self.extraction)))
        self.checkpoint = dict(draft_saved=True, attempt_saved=True, claim_active=False)
        self.client = Mock()
        self.client.get.side_effect = lambda path: self.checkpoint if path.startswith('/api/processing/readings?') else {'document': self.final}
        for name, value in {'claim-response.json': {'claim': self.claim},
                'claim-request.json': dict(stage='large', document_id='doc', revision=3),
                'draft-request.json': dict(token='synthetic-token', model='gpt-6-astra', extraction=self.extraction),
                'draft-response.json': {'saved': True},
                'astra-draft-extraction.json': self.extraction,
                'astra-reconciled-extraction.json': self.extraction,
                'context-response.json': dict(document=self.claim['document'], independent_parse=self.extraction),
                'submit-request.json': dict(token='synthetic-token', model='gpt-6-astra', extraction=self.extraction),
                'submit-response.json': {'saved': [dict(id='doc', revision=4)]},
                'final-document.json': self.final}.items():
            self.save(name, value)

    def save(self, name, value):
        (self.work / name).write_text(json.dumps(value))

    def verify(self):
        return verify(self.client, self.work, 'doc', 3)

    def test_saved_medium_review_without_pdf_is_success(self):
        result = self.verify()
        self.assertTrue(result['verified'])
        self.assertEqual(result['confidence'], 'medium')
        self.assertNotIn('synthetic-token', json.dumps(result))

    def test_open_claim_missing_attempt_or_changed_pages_cannot_count(self):
        for field, value in [('claim_active', True), ('attempt_saved', False), ('draft_saved', False)]:
            with self.subTest(field=field):
                before = deepcopy(self.checkpoint)
                self.checkpoint[field] = value
                with self.assertRaises(ClientError): self.verify()
                self.checkpoint = before
        self.final['pages'] = []
        with self.assertRaises(ClientError): self.verify()

    def test_mismatched_draft_file_and_live_values_are_rejected(self):
        self.save('astra-draft-extraction.json', {**self.extraction, 'total_minor': 999})
        with self.assertRaisesRegex(ClientError, 'draft file'): self.verify()
        self.save('astra-draft-extraction.json', self.extraction)
        self.final['processing']['extraction']['total_minor'] = 999
        with self.assertRaisesRegex(ClientError, 'saved extraction'): self.verify()

    def test_server_confidence_cap_and_single_page_type_correction_are_valid(self):
        proposed = {**self.extraction, 'certainty': 'high', 'type': 'payment-slip'}
        self.save('astra-reconciled-extraction.json', proposed)
        self.save('submit-request.json', dict(token='synthetic-token', model='gpt-6-astra', extraction=proposed))
        self.final['processing']['extraction']['type'] = 'payment-slip'
        self.final['processing']['extraction']['uncertainties'] = ['Server OCR disagreement.']
        self.final['pages'] = [{**self.pages[0], 'type': 'payment-slip'}]
        self.save('final-document.json', self.final)
        self.assertTrue(self.verify()['verified'])

    def test_medium_proposal_capped_to_low_by_server_is_valid(self):
        self.final['processing']['large_model_confidence'] = 'low'
        self.final['processing']['extraction']['certainty'] = 'low'
        self.save('final-document.json', self.final)
        result = self.verify()
        self.assertTrue(result['verified'])
        self.assertEqual(result['confidence'], 'low')

    def test_generic_claim_or_different_assigned_target_is_rejected(self):
        with self.assertRaisesRegex(ClientError, 'different target'):
            verify(self.client, self.work, 'other', 3)
        with self.assertRaisesRegex(ClientError, 'different target'):
            verify(self.client, self.work, 'doc', 2)
        self.save('claim-request.json', {'stage': 'large'})
        with self.assertRaisesRegex(ClientError, 'targeted claim'): self.verify()

    def test_unsupported_confidence_increase_and_wrong_submit_revision_fail(self):
        self.extraction['certainty'] = 'low'
        self.save('astra-reconciled-extraction.json', self.extraction)
        self.save('submit-request.json', dict(token='synthetic-token', model='gpt-6-astra', extraction=self.extraction))
        self.final['processing']['large_model_confidence'] = 'medium'
        self.final['processing']['extraction']['certainty'] = 'medium'
        with self.assertRaisesRegex(ClientError, 'server cap'): self.verify()
        self.save('submit-response.json', {'saved': [dict(id='doc', revision=3)]})
        with self.assertRaisesRegex(ClientError, 'claimed revision'): self.verify()

    def test_pdf_requires_exact_hash_and_actual_inspection_evidence(self):
        pdf = self.work / 'synthetic.pdf'
        pdf.write_bytes(b'%PDF-synthetic test bytes')
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        self.final.update(filename='synthetic.pdf', revision=5, checks={'pdf': True},
                          reviewedPdfSha256=sha, pdf={'sha256': sha, 'revision': 4})
        self.save('final-document.json', self.final)
        self.save('pdf-result.json', dict(path=str(pdf), sha256=sha, pages=1, revision=4))
        self.save('pdf-review-request.json', dict(document_id='doc', revision=4, sha256=sha, evidence='Synthetic inspection.'))
        self.assertTrue(self.verify()['verified'])
        self.save('pdf-result.json', dict(path=str(pdf), sha256=sha, pages=1, revision=3))
        with self.assertRaisesRegex(ClientError, 'PDF review'): self.verify()
        self.save('pdf-result.json', dict(path=str(pdf), sha256=sha, pages=1, revision=4))
        pdf.write_bytes(b'changed')
        with self.assertRaisesRegex(ClientError, 'Local PDF'): self.verify()


if __name__ == '__main__':
    unittest.main()
