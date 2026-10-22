"""Security floors must cover runtime reuse and direct receipt decoding."""
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image
from receipt_api import ClientError
import receipt_ppocr
import receipt_ppocr_setup as setup
from receipt_runtime_versions import UnsafePillowError, require_supported_node


class RuntimeVersionTests(unittest.TestCase):
    def test_node_supported_release_boundaries(self):
        for value in ('v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.23.0', 'v26.12.1'):
            with self.subTest(value=value):
                require_supported_node(value)
        for value in ('v20.19.0', 'v22.23.3', 'v23.11.0', 'v24.22.0',
                      'v25.9.0', 'v26.12.0', 'v27.0.0', 'v24.22.1-rc.1', ''):
            with self.subTest(value=value), self.assertRaises(ClientError):
                require_supported_node(value)

    def test_direct_ocr_and_preflight_reject_old_pillow_before_opening_inputs(self):
        for args in (['--check'], ['--source', 'original.json', '--output', 'result.json']):
            with self.subTest(args=args), patch('PIL.__version__', '12.3.0'), \
                    patch.object(sys, 'argv', ['receipt_ppocr.py', '--profile', 'private.json', *args]), \
                    patch.object(Image, 'open') as image_open, \
                    patch.object(Path, 'read_text') as read_profile:
                with self.assertRaisesRegex(UnsafePillowError, 'Pillow 13.0.0'):
                    receipt_ppocr.main()
                image_open.assert_not_called()
                read_profile.assert_not_called()

    def test_external_cpu_and_gpu_profiles_require_patched_interpreter(self):
        for device in ('cpu', 'gpu:0'):
            for version in ('12.3.0', '13.0.0rc1', '13.0.0'):
                with self.subTest(device=device, version=version), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    profile = root / 'prepared.json'
                    original = json.dumps({'ppocr': {'device': device}})
                    profile.write_text(original)
                    client = Mock()
                    client.ocr_backend.python = root / 'python'
                    with patch.object(setup, 'REPO', root), \
                            patch.object(setup, 'credentials', return_value={}), \
                            patch.object(setup, 'ScannerClient', return_value=client), \
                            patch.object(setup, 'check_node'), patch.object(setup, 'check_layout'), \
                            patch.object(setup.subprocess, 'run', return_value=Mock(returncode=0, stdout=version)), \
                            patch.object(setup, 'run_logged') as install:
                        if version == '13.0.0':
                            self.assertEqual(setup.ensure_profile('config', str(profile)), str(profile.resolve()))
                            client.ocr_backend.preflight.assert_called_once()
                        else:
                            with self.assertRaisesRegex(UnsafePillowError, 'Upgrade Pillow'):
                                setup.ensure_profile('config', str(profile))
                            client.ocr_backend.preflight.assert_not_called()
                        install.assert_not_called()
                    self.assertEqual(profile.read_text(), original)

    def test_existing_managed_cpu_repairs_old_pillow_even_with_cpu_option(self):
        for force_cpu in (False, True):
            for version in ('12.3.0', '13.0.0'):
                with self.subTest(force_cpu=force_cpu, version=version), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    runtime = root / '.local' / 'receipt-ppocr-runtime'
                    python = runtime / 'cpu-venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
                    python.parent.mkdir(parents=True)
                    python.write_bytes(b'synthetic executable')
                    prepared = runtime / 'profile.json'
                    prepared.write_text('{}')
                    model = runtime / 'models' / 'preserved-model'
                    model.parent.mkdir()
                    model.write_bytes(b'original model bytes')
                    node = root / 'node'
                    node.write_bytes(b'synthetic executable')
                    config = root / 'client.json'
                    config.write_text('{}')
                    client = Mock(origin='https://synthetic.example')
                    client.ocr_backend.python = python
                    with patch.object(setup, 'REPO', root), \
                            patch.object(setup, 'credentials', return_value={}), \
                            patch.object(setup, 'ScannerClient', return_value=client), \
                            patch.object(setup, 'check_node'), patch.object(setup, 'check_layout'), \
                            patch.object(setup.subprocess, 'run', return_value=Mock(returncode=0, stdout=version)), \
                            patch.object(setup, 'run_logged') as install, \
                            patch.object(setup, 'install_models'), redirect_stdout(io.StringIO()):
                        self.assertEqual(setup.ensure_profile(str(config), force_cpu=force_cpu, node=str(node)), str(prepared))
                        if version == '12.3.0':
                            self.assertIn('Pillow==13.0.0', install.call_args_list[0].args[0])
                        else:
                            install.assert_not_called()
                    self.assertEqual(model.read_bytes(), b'original model bytes')
                    self.assertEqual(config.read_text(), '{}')


if __name__ == '__main__':
    unittest.main()
