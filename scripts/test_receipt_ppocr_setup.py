"""Synthetic setup tests; no production access, package installation, or model downloads."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from receipt_api import ClientError
import receipt_ppocr_setup as setup
import receipt_processing_setup as processing_setup


class PPSetupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)

    def executable(self, name):
        path = self.repo / name
        path.write_bytes(b'prepared synthetic executable')
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_fresh_profile_publishes_private_ocr_descriptor_without_pdf_dependencies(self):
        config = self.repo / 'client.json'
        config.write_text('{}', encoding='utf-8')
        runtime = self.repo / '.local' / 'receipt-ppocr-runtime'
        pp_python = runtime / 'cpu-venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        pp_python.parent.mkdir(parents=True)
        pp_python.write_bytes(b'prepared synthetic executable')
        pp_python.chmod(pp_python.stat().st_mode | stat.S_IXUSR)
        node = self.executable('node')
        worker_python = self.executable(f'python{sys.version_info.major}.{sys.version_info.minor}')
        client = Mock(origin='https://synthetic.example')
        client.ocr_backend.preflight.return_value = None

        with patch.object(setup, 'REPO', self.repo), \
                patch.object(setup, 'credentials', return_value={}), \
                patch.object(setup, 'ScannerClient', return_value=client), \
                patch.object(setup, 'run_logged'), patch.object(setup, 'install_models'), \
                patch.object(setup, 'check_node'), patch.object(setup, 'check_layout'):
            profile = setup.ensure_profile(str(config), node=str(node))
            descriptor = setup.publish_host_descriptor(profile, str(worker_python))

        value = json.loads(Path(profile).read_text(encoding='utf-8'))
        self.assertNotIn('renderer', value)
        self.assertEqual(value['client_config'], str(config.resolve()))
        self.assertEqual(value['ppocr']['python'], str(pp_python))
        pointer = json.loads(Path(descriptor).read_text(encoding='utf-8'))
        self.assertEqual(pointer, {'python': str(worker_python.resolve()), 'worker_profile': profile,
                                   'client_config': str(config.resolve())})
        if os.name != 'nt':
            self.assertEqual(stat.S_IMODE(Path(descriptor).stat().st_mode), 0o600)

    def test_unusable_prepared_runtime_reports_why_before_repairing(self):
        config = self.repo / 'client.json'
        config.write_text('{}', encoding='utf-8')
        runtime = self.repo / '.local' / 'receipt-ppocr-runtime'
        pp_python = runtime / 'cpu-venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        pp_python.parent.mkdir(parents=True)
        pp_python.write_bytes(b'prepared synthetic executable')
        pp_python.chmod(pp_python.stat().st_mode | stat.S_IXUSR)
        (runtime / 'profile.json').write_text('{}', encoding='utf-8')
        gpu_profile = self.repo / 'gpu-profile.json'
        gpu_profile.write_text('{}', encoding='utf-8')
        client = Mock(origin='https://synthetic.example')
        client.configure_ppocr.side_effect = [
            ClientError('Configured PP GPU runtime is unavailable; no CPU fallback attempted.'),
            ClientError('PP model files are missing; no downloads attempted.'),
            None,
        ]
        output = io.StringIO()
        with patch.object(setup, 'REPO', self.repo), \
                patch.object(setup, 'credentials', return_value={}), \
                patch.object(setup, 'ScannerClient', return_value=client), \
                patch.object(setup, 'run_logged'), patch.object(setup, 'install_models'), \
                patch.object(setup, 'check_node'), patch.object(setup, 'check_layout'), \
                redirect_stdout(output):
            setup.ensure_profile(str(config), str(gpu_profile), node=str(self.executable('node')))

        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(events[:2], [
            {'event': 'prepared_runtime_unavailable', 'error_type': 'ClientError',
             'error': 'Configured PP GPU runtime is unavailable; no CPU fallback attempted.',
             'next': 'install isolated CPU runtime'},
            {'event': 'isolated_runtime_needs_repair', 'error_type': 'ClientError',
             'error': 'PP model files are missing; no downloads attempted.',
             'next': 'repair isolated CPU runtime'},
        ])

    def test_descriptor_rejects_redirected_profile_and_descriptor(self):
        profile = self.repo / 'profile.json'
        profile.write_text('{}', encoding='utf-8')
        worker_python = self.executable(f'python{sys.version_info.major}.{sys.version_info.minor}')
        with patch.object(setup, 'REPO', self.repo):
            with patch.object(type(profile), 'is_symlink', lambda path: path == profile):
                with self.assertRaisesRegex(ClientError, 'regular absolute worker profile'):
                    setup.publish_host_descriptor(str(profile), str(worker_python))

        profile.unlink()
        profile.write_text('{}', encoding='utf-8')
        local = self.repo / '.local'
        local.mkdir()
        descriptor = local / 'receipt-ocr-host.json'
        descriptor.write_text('{}', encoding='utf-8')
        with patch.object(setup, 'REPO', self.repo):
            with patch.object(type(descriptor), 'is_symlink', lambda path: path == descriptor):
                with self.assertRaisesRegex(ClientError, 'descriptor must be a regular file'):
                    setup.publish_host_descriptor(str(profile), str(worker_python))

    def test_discover_prefers_descriptor_client_config_over_stale_profile_value(self):
        local = self.repo / '.local'
        local.mkdir()
        stale = self.repo / 'missing-client.json'
        current = self.repo / 'current-client.json'
        current.write_text('{}', encoding='utf-8')
        profile = self.repo / 'profile.json'
        profile.write_text(json.dumps({
            'client_config': str(stale),
            'ppocr': {'device': 'synthetic'},
        }), encoding='utf-8')
        (local / 'receipt-ocr-host.json').write_text(json.dumps({
            'worker_profile': str(profile),
            'client_config': str(current),
        }), encoding='utf-8')

        with patch.object(setup, 'REPO', self.repo):
            config, selected_profile = setup.discover()

        self.assertEqual(config, str(current.resolve()))
        self.assertEqual(selected_profile, str(profile))

    def test_processing_profile_contains_no_ocr_runtime(self):
        config = self.repo / 'client.json'
        config.write_text('{}', encoding='utf-8')
        node = self.executable('node')
        renderer = self.executable('pdftoppm')
        client = Mock(origin='https://synthetic.example')
        with patch.object(processing_setup, 'REPO', self.repo), \
                patch.object(processing_setup, 'credentials', return_value={}), \
                patch.object(processing_setup, 'ScannerClient', return_value=client), \
                patch.object(processing_setup, 'check_node'), \
                patch.object(processing_setup, 'check_renderer', return_value=str(renderer.resolve())), \
                patch.object(processing_setup, 'check_layout'):
            profile = processing_setup.ensure_consumer_profile(
                str(config), node=str(node), renderer=str(renderer))
        value = json.loads(Path(profile).read_text(encoding='utf-8'))
        self.assertEqual(value['confirmation_provider'], 'ppocr')
        self.assertNotIn('client_config', value)
        self.assertNotIn('ppocr', value)
        client.configure_saved_ppocr.assert_called_once()

    def test_processing_main_accepts_relative_config_after_profile_normalization(self):
        config = self.repo / 'client.json'
        config.write_text('{}', encoding='utf-8')
        profile = self.repo / 'profile.json'
        profile.write_text('{}', encoding='utf-8')
        worker_python = self.executable(f'python{sys.version_info.major}.{sys.version_info.minor}')

        with patch.object(setup, 'REPO', self.repo), \
                patch.object(processing_setup, 'ensure_consumer_profile', return_value=str(profile)), \
                patch.object(sys, 'argv', ['receipt_processing_setup.py', '--config', 'client.json',
                                          '--worker-python', str(worker_python)]), \
                patch('builtins.print'):
            processing_setup.main()

        descriptor = json.loads(
            (self.repo / '.local' / 'processing-host.json').read_text(encoding='utf-8'))
        self.assertEqual(set(descriptor), {'python', 'worker_profile'})
        self.assertTrue(Path(descriptor['python']).samefile(worker_python))
        self.assertTrue(Path(descriptor['worker_profile']).samefile(profile))

    def test_renderer_must_be_fixed_executable_and_pass_preflight(self):
        renderer = self.executable('pdftoppm')
        with patch.object(setup.subprocess, 'run', return_value=Mock(returncode=0)) as run:
            self.assertEqual(setup.check_renderer(str(renderer)), str(renderer))
        run.assert_called_once_with([str(renderer), '-v'], capture_output=True, timeout=30)
        redirected = self.repo / 'redirected' / renderer.name
        redirected.parent.mkdir()
        redirected.write_bytes(renderer.read_bytes())
        with patch.object(type(redirected), 'is_symlink', lambda path: path == redirected):
            with self.assertRaisesRegex(ClientError, 'prepared absolute pdftoppm'):
                setup.check_renderer(str(redirected))


if __name__ == '__main__':
    unittest.main()
