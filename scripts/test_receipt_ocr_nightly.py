"""Synthetic tests for unattended OCR; no production writes or model downloads."""
from datetime import date, datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import redirect_stdout

from receipt_api import ClientError, ScannerClient
import receipt_ocr_nightly as nightly
from receipt_ocr_nightly import CachedBackend, day_window, drain, fingerprint, inventory, needs_ocr, read_requirement, prepare_requirement
from receipt_ppocr_setup import install_models, MODELS, check_node


def capture(cid='one', created='2026-09-16T12:00:00Z'):
    return dict(id=cid, sha256='a' * 64, created_at=created, is_current=True,
                status='accepted', ocr_status='awaiting Work', artifacts=[], metadata={})


def result():
    return {'ocr_sha256': 'b' * 64}


class NightlyTests(unittest.TestCase):
    def test_request_cli_catches_full_backlog_and_does_not_continue_after_access_loss(self):
        requirement = dict(origin='https://synthetic.example', capture_id='00000000-0000-4000-8000-000000000001',
                           source_sha256='a' * 64, crop=None, rotation=0)
        request = self.root / 'request.json'
        request.write_text(json.dumps(requirement))
        self.client.origin = requirement['origin']
        self.client.get.return_value = {'capabilities': ['save_ocr_artifacts']}
        scans = [capture('older', '2026-01-01T00:00:00Z'), capture('recent')]
        for blocked in (False, True):
            summary = dict(complete=not blocked, selected=2, verified=0, reused=0, retired=0,
                           failures={}, remaining=2 if blocked else 0)
            if blocked:
                summary['blocked'] = 'authorization'
            with self.subTest(blocked=blocked), patch.object(nightly, 'REPO', self.root), \
                    patch.object(nightly.os, 'chdir'), patch.object(nightly, 'discover', return_value=('config', 'profile')), \
                    patch.object(nightly, 'credentials', return_value={}), \
                    patch.object(nightly, 'ScannerClient', return_value=self.client), \
                    patch.object(nightly, 'ensure_profile', return_value='profile'), \
                    patch.object(nightly, 'inventory', return_value=scans) as listed, \
                    patch.object(nightly, 'drain', return_value=summary) as drained, \
                    patch.object(nightly, 'prepare_requirement', return_value={'verified': True}) as required, \
                    patch('sys.argv', ['receipt_ocr_nightly.py', '--request', str(request)]), redirect_stdout(io.StringIO()):
                before = datetime.now(timezone.utc)
                self.assertEqual(nightly.main(), 1 if blocked else 0)
                self.assertEqual(drained.call_args.args[1], scans)
                self.assertGreaterEqual(listed.call_args.args[1], before)
                if blocked:
                    required.assert_not_called()
                else:
                    required.assert_called_once_with(self.client, requirement, drained.call_args.args[2])

    def test_luna_requirement_matches_origin_source_and_exact_layout(self):
        value = dict(origin='https://synthetic.example', capture_id='00000000-0000-4000-8000-000000000001',
                     source_sha256='a' * 64, crop=[1, 2, 50, 90], rotation=90)
        request = self.root / 'request.json'
        request.write_text(json.dumps(value))
        self.assertEqual(read_requirement(request, value['origin']), value)
        with self.assertRaises(ClientError):
            read_requirement(request, 'https://another.example')
        self.client.original.return_value = dict(sha256=value['source_sha256'])
        self.client.prepare.return_value = dict(sha256=value['source_sha256'], ocr_sha256='b' * 64)
        self.assertTrue(prepare_requirement(self.client, value, self.root)['verified'])
        self.client.prepare.assert_called_once_with(value['capture_id'], self.root / 'required', crop=value['crop'], rotation=90)
        self.client.prepare.reset_mock()
        self.client.original.return_value = dict(sha256='c' * 64)
        with self.assertRaisesRegex(ClientError, 'source hash changed'):
            prepare_requirement(self.client, value, self.root)
        self.client.prepare.assert_not_called()

    def test_main_drains_only_inventory_pages_awaiting_ocr(self):
        completed = {**capture('completed'), 'ocr_status': 'unverified'}
        missing = capture('missing')
        self.client.origin = 'https://synthetic.example'
        self.client.get.return_value = {'capabilities': ['save_ocr_artifacts']}
        summary = dict(complete=True, selected=1, verified=1, reused=0, retired=0,
                       failures={}, remaining=0)

        with patch.object(nightly, 'REPO', self.root), patch.object(nightly.os, 'chdir'), \
                patch.object(nightly, 'discover', return_value=('config', 'profile')), \
                patch.object(nightly, 'credentials', return_value={}), \
                patch.object(nightly, 'ScannerClient', return_value=self.client), \
                patch.object(nightly, 'ensure_profile', return_value='profile'), \
                patch.object(nightly, 'inventory', return_value=[completed, missing]), \
                patch.object(nightly, 'drain', return_value=summary) as drained, \
                patch('sys.argv', ['receipt_ocr_nightly.py', '--date', '2026-09-16']), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(nightly.main(), 0)

        self.assertEqual(drained.call_args.args[1], [missing])
        saved = json.loads(next((self.root / '.local' / 'receipt-ocr-nightly').glob('*/last-run.json')).read_text())
        self.assertEqual(saved['eligible'], 2)
        self.assertEqual(saved['ocr_available'], 1)
        self.assertEqual(saved['ocr_missing'], 1)

    def test_catchup_inventory_includes_today_without_future_scans(self):
        now = datetime(2026, 9, 17, 15, tzinfo=timezone.utc)
        self.client.get.return_value = dict(captures=[capture('old', '2026-09-16T12:00:00Z'),
            capture('today', '2026-09-17T14:00:00Z'), capture('future', '2026-09-17T16:00:00Z')], next=None)
        self.assertEqual([c['id'] for c in inventory(self.client, now)], ['old', 'today'])

    def test_unsupported_node_is_rejected_before_publishing_a_profile(self):
        with patch('receipt_ppocr_setup.subprocess.run', return_value=Mock(returncode=0, stdout='v20.19.0\n')):
            with self.assertRaisesRegex(ClientError, 'Node 22.18'):
                check_node('node', Path('.'))

    def test_pinned_model_checksums_are_complete_sha256(self):
        self.assertEqual(set(MODELS), {'det', 'rec'})
        for sha in MODELS.values():
            self.assertRegex(sha, r'^[0-9a-f]{64}$')

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.state = {'origin': 'https://synthetic.example', 'completed': {}}
        self.client = Mock()
        self.client.prepare.return_value = result()

    def run_drain(self, captures, **kwargs):
        return drain(self.client, captures, self.root, self.state, sleep=lambda _: None, emit=Mock(), **kwargs)

    def test_calendar_days_include_dst_and_end_exclusive(self):
        start, end = day_window(date(2026, 3, 29), 'Europe/Copenhagen')
        self.assertEqual((end-start).total_seconds(), 23 * 3600)
        start, end = day_window(date(2026, 10, 25), 'Europe/Copenhagen')
        self.assertEqual((end-start).total_seconds(), 25 * 3600)
        recent = capture('today', '2026-09-16T22:00:00Z')
        accepted = capture('wanted', '2026-09-16T21:59:59Z')
        retired = {**capture('retired'), 'is_current': False}
        rejected = {**capture('rejected'), 'status': 'rejected'}
        older = capture('backlog', '2026-01-01T12:00:00Z')
        self.client.get.side_effect = [dict(captures=[recent, accepted, retired, rejected], next='cursor'),
                                       dict(captures=[older], next=None)]
        _, end = day_window(date(2026, 9, 16), 'Europe/Copenhagen')
        self.assertEqual([c['id'] for c in inventory(self.client, end)], ['backlog', 'wanted'])
        self.assertIn('before=cursor', self.client.get.call_args.args[0])

    def test_inventory_rejects_cursor_loop(self):
        self.client.get.return_value = dict(captures=[], next='repeat')
        with self.assertRaisesRegex(ClientError, 'cursor'):
            inventory(self.client, datetime.now(timezone.utc))

    def test_one_broken_scan_does_not_block_others_and_is_retried(self):
        scans = {cid: capture(cid) for cid in ('bad', 'good')}
        self.client.get.side_effect = lambda path: scans[path.rsplit('/', 1)[1]]
        calls = []
        def prepare(cid, _):
            calls.append(cid)
            if cid == 'bad':
                raise ClientError('Unreadable source')
            return result()
        self.client.prepare.side_effect = prepare
        outcome = self.run_drain(list(scans.values()))
        self.assertEqual(calls, ['bad', 'good', 'bad', 'bad'])
        self.assertFalse(outcome['complete'])
        self.assertEqual(outcome['verified'], 1)
        self.assertEqual(outcome['remaining'], 1)
        self.assertEqual(set(self.state['completed']), {'good'})

    def test_resume_requires_remote_artifact_and_same_outline(self):
        scan = capture()
        self.state['completed']['one'] = dict(fingerprint=fingerprint(scan), **result())
        scan['artifacts'] = [dict(kind='ocr', sha256='b' * 64)]
        self.client.get.return_value = scan
        self.assertEqual(self.run_drain([scan])['reused'], 1)
        self.client.prepare.assert_not_called()
        scan['manual_outline'] = dict(id='changed', quad=[[0, 0], [1, 0], [1, 1], [0, 1]])
        self.assertEqual(self.run_drain([scan])['verified'], 1)
        self.client.prepare.assert_called_once()
        self.client.prepare.reset_mock()
        scan['artifacts'] = []
        self.assertEqual(self.run_drain([scan])['verified'], 1)
        self.client.prepare.assert_called_once()

    def test_inventory_ocr_status_selects_only_missing_pages(self):
        missing = capture('missing')
        completed = {**capture('completed'), 'ocr_status': 'unverified'}
        self.assertTrue(needs_ocr(missing))
        self.assertFalse(needs_ocr(completed))
        with self.assertRaisesRegex(ClientError, 'invalid OCR status'):
            needs_ocr({**capture('invalid'), 'ocr_status': 'complete'})

    def test_scan_retaken_after_inventory_is_skipped(self):
        self.client.get.return_value = {**capture(), 'is_current': False}
        outcome = self.run_drain([capture()])
        self.assertTrue(outcome['complete'])
        self.assertEqual(outcome['retired'], 1)
        self.client.prepare.assert_not_called()

    def test_layout_change_during_inference_is_retried_not_marked_done(self):
        original = capture()
        changed = {**original, 'manual_outline': dict(id='new')}
        self.client.get.side_effect = [original, changed, changed, changed]
        outcome = self.run_drain([original])
        self.assertTrue(outcome['complete'])
        self.assertEqual(self.client.prepare.call_count, 2)
        self.assertEqual(self.state['completed']['one']['fingerprint'], fingerprint(changed))

    def test_auth_failure_stops_requests_and_reports_unattempted_scans(self):
        self.client.get.side_effect = ClientError('Scanner returned HTTP 403; access denied.')
        outcome = self.run_drain([capture('one'), capture('two')])
        self.assertEqual(outcome['blocked'], 'authorization')
        self.assertEqual(outcome['remaining'], 2)
        self.client.get.assert_called_once()

    def test_global_connectivity_failure_is_bounded_instead_of_retrying_thousands(self):
        self.client.get.side_effect = ClientError('Scanner connection failed; check connectivity and retry.')
        outcome = self.run_drain([capture(str(i)) for i in range(1000)])
        self.assertEqual(outcome['blocked'], 'connectivity')
        self.assertEqual(outcome['remaining'], 1000)
        self.assertEqual(self.client.get.call_count, 3)

    def test_transient_retry_resolves_failure_report(self):
        self.client.get.return_value = capture()
        self.client.prepare.side_effect = [ClientError('Temporary upload failure'), result()]
        outcome = self.run_drain([capture()])
        self.assertTrue(outcome['complete'])
        self.assertEqual(outcome['failures'], {})
        self.assertEqual(json.loads((self.root / 'failures.json').read_text()), {})

    def test_pending_ocr_is_reused_after_restart_and_corruption_is_detected(self):
        source = dict(capture_id='one', sha256='a' * 64, crop=[0, 0, 100, 200], rotation=0)
        value = dict(text='Synthetic', source=dict(captureId='one', sha256='a' * 64,
                     pixels=[100, 200], region=dict(left=0, top=0, width=100, height=200), rotation=0),
                     provenance=dict(engine='PP-OCRv6'), text_only_pdf_layers=[dict(base64='eA==', sha256='f' * 64)])
        manifest = self.root / 'source.json'
        manifest.write_text(json.dumps(source))
        backend = Mock()
        backend.run.side_effect = lambda _manifest, output: Path(output).write_text(json.dumps(value))
        cache = self.root / 'cache'
        first, second = self.root / 'first.json', self.root / 'second.json'
        CachedBackend(backend, cache).run(manifest, first)
        CachedBackend(backend, cache).run(manifest, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        backend.run.assert_called_once()
        next(cache.glob('*.ocr.json')).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ClientError, 'checksum'):
            CachedBackend(backend, cache).run(manifest, self.root / 'third.json')

    def test_verified_model_archive_install_is_repeatable_and_preserves_modified_files(self):
        name = 'PP-OCRv6_medium_det_infer'
        archive = self.root / (name + '.tar')
        data = b'synthetic model'
        with tarfile.open(archive, 'w') as bundle:
            entry = tarfile.TarInfo(name + '/inference.json')
            entry.size = len(data)
            bundle.addfile(entry, io.BytesIO(data))
        expected = hashlib.sha256(archive.read_bytes()).hexdigest()
        with patch('receipt_ppocr_setup.MODELS', {'det': expected}):
            install_models(self.root)
            install_models(self.root)
            path = self.root / name / 'inference.json'
            self.assertEqual(path.read_bytes(), data)
            path.write_bytes(b'preserve me')
            with self.assertRaisesRegex(ClientError, 'differs'):
                install_models(self.root)
            self.assertEqual(path.read_bytes(), b'preserve me')

    def test_archive_path_escape_is_rejected(self):
        archive = self.root / 'PP-OCRv6_medium_det_infer.tar'
        with tarfile.open(archive, 'w') as bundle:
            entry = tarfile.TarInfo('../escape')
            entry.size = 1
            bundle.addfile(entry, io.BytesIO(b'x'))
        with patch('receipt_ppocr_setup.MODELS', {'det': hashlib.sha256(archive.read_bytes()).hexdigest()}):
            with self.assertRaisesRegex(ClientError, 'Unsafe'):
                install_models(self.root)

    def test_manual_outline_is_used_only_for_matching_original(self):
        client = ScannerClient(dict(origin='https://synthetic.example', sites_token='synthetic', processing_token='rsc_' + 'a' * 43))
        body = b'synthetic-original'
        sha = hashlib.sha256(body).hexdigest()
        cid = '11111111-1111-4111-8111-111111111111'
        quad = [[0, 0], [1, 0], [1, 1], [0, 1]]
        meta = dict(id=cid, sha256=sha, bytes=len(body), content_type='image/jpeg',
                    manual_outline=dict(source_sha256=sha, quad=quad))
        client.get = Mock(return_value=meta)
        client.request = Mock(return_value=body)
        self.assertEqual(client.original(cid, self.root)['quad'], quad)
        meta['manual_outline']['source_sha256'] = '0' * 64
        with self.assertRaisesRegex(ClientError, 'outline'):
            client.original(cid, self.root)


if __name__ == '__main__':
    unittest.main()
