import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from receipt_backup import backup, main
from receipt_api import ClientError


class FakeClient:
    origin = 'https://synthetic.example'
    def __init__(self):
        self.rows = [{'id': 'one', 'sha256': 'a' * 64, 'created_at': '2026-01-01'}]
        self.fail = False
    def get(self, path):
        assert path == '/api/captures?limit=100'  # Includes all takes, no current-only filter.
        return {'captures': self.rows, 'next': None}
    def original(self, capture_id, root, metadata=None):
        if self.fail:
            raise ClientError('Synthetic hash mismatch')
        root.mkdir(exist_ok=True)
        path = root / capture_id
        cached = path.exists()
        path.write_bytes(b'synthetic original')
        return {'path': str(path), 'sha256': 'a' * 64, 'scanned_at': '2026-01-01', 'cached': cached}


class BackupPlatformTests(unittest.TestCase):
    @patch('receipt_backup.os.name', 'nt')
    def test_unsupported_platform_fails_before_files_or_network(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = os.path.join(folder, 'must-not-be-created')
            with patch('receipt_backup.private_directory') as mkdir, \
                    patch.object(FakeClient, 'get') as get:
                with self.assertRaisesRegex(ClientError, 'native Windows is unsupported'):
                    backup(FakeClient(), destination)
                mkdir.assert_not_called()
                get.assert_not_called()
            self.assertFalse(os.path.exists(destination))

    @patch('receipt_backup.os.name', 'nt')
    def test_cli_rejects_platform_before_credentials(self):
        with patch('sys.argv', ['backup', '--destination', 'unused', '--mount-root', 'unused']), \
                patch('receipt_backup.credentials') as credentials:
            with self.assertRaisesRegex(ClientError, 'native Windows is unsupported'):
                main()
            credentials.assert_not_called()


@unittest.skipUnless(os.name == 'posix', 'Backup filesystem protections require POSIX; tested on Linux/macOS.')
class BackupTests(unittest.TestCase):
    @patch('receipt_backup.os.sync')
    def test_rejects_internal_symlinks_without_touching_targets(self, sync):
        for child in ('.backup.lock', 'snapshots', 'originals'):
            with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as outside:
                target = Path(outside) / 'target'
                if child == '.backup.lock':
                    target.write_bytes(b'unchanged')
                else:
                    target.mkdir()
                (Path(folder) / child).symlink_to(target)
                with self.assertRaises((ClientError, OSError)):
                    backup(FakeClient(), folder)
                if child == '.backup.lock':
                    self.assertEqual(target.read_bytes(), b'unchanged')
                else:
                    self.assertEqual(list(target.iterdir()), [])

    @patch('receipt_backup.os.sync')
    def test_resumes_and_preserves_originals_after_remote_disappearance(self, sync):
        with tempfile.TemporaryDirectory() as folder:
            client = FakeClient()
            first = backup(client, folder)
            self.assertEqual(first['downloaded'], 1)
            self.assertEqual(backup(client, folder)['downloaded'], 0)
            client.rows = []
            self.assertFalse(backup(client, folder)['complete'])
            self.assertEqual(backup(client, folder)['missing_remote'], 1)
            self.assertTrue((Path(folder) / 'originals/one').exists())
            self.assertEqual(len(list((Path(folder) / 'snapshots').glob('*.json'))), 4)

    @patch('receipt_backup.os.sync')
    def test_records_verification_failure_without_claiming_completion(self, sync):
        with tempfile.TemporaryDirectory() as folder:
            client = FakeClient()
            client.fail = True
            result = backup(client, folder)
            self.assertFalse(result['complete'])
            self.assertEqual(result['verified'], 0)
            manifest = json.loads(Path(result['manifest']).read_text())
            self.assertEqual(len(manifest['failures']), 1)


if __name__ == '__main__':
    unittest.main()
