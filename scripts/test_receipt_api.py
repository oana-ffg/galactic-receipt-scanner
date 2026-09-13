import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from urllib.request import Request
from receipt_api import ScannerClient, ClientError, NoRedirect


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.client = ScannerClient({"origin": "https://scanner.example.test", "sites_token": "synthetic-sites", "processing_token": "rsc_" + "s" * 43})
        self.id = "00000000-0000-4000-8000-000000000001"
        self.body = b"\xff\xd8\xffsynthetic"
        self.sha = hashlib.sha256(self.body).hexdigest()
        self.meta = {"id": self.id, "sha256": self.sha, "bytes": len(self.body), "content_type": "image/jpeg", "created_at": "2026-01-01T00:00:00Z"}

    def test_download_verifies_and_resumes_without_redownloading(self):
        self.client.get = Mock(return_value=self.meta)
        self.client.request = Mock(return_value=self.body)
        with tempfile.TemporaryDirectory() as directory:
            first = self.client.original(self.id, directory)
            self.assertFalse(first["cached"])
            self.assertEqual(Path(first["path"]).read_bytes(), self.body)
            self.assertEqual(Path(first["path"]).stat().st_mode & 0o777, 0o600)
            self.assertTrue(self.client.original(self.id, directory)["cached"])
            self.client.request.assert_called_once()
            Path(first["path"]).write_bytes(b"corrupted")
            with self.assertRaisesRegex(ClientError, "hash/size"):
                self.client.original(self.id, directory)
            self.assertEqual(Path(first["path"]).read_bytes(), b"corrupted")

    def test_bad_download_is_not_saved(self):
        self.client.get = Mock(return_value=self.meta)
        self.client.request = Mock(return_value=b"wrong")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ClientError, "hash/size"):
                self.client.original(self.id, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_pinned_artifact_is_verified_and_never_overwrites_existing_data(self):
        self.client.request = Mock(return_value=self.body)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "document.pdf"
            self.assertFalse(self.client.file("/api/documents/" + self.id + "/pdf", self.sha, path)["cached"])
            self.assertTrue(self.client.file("/api/documents/" + self.id + "/pdf", self.sha, path)["cached"])
            self.client.request.assert_called_once()
            path.write_bytes(b"different artifact")
            with self.assertRaisesRegex(ClientError, "hash verification"):
                self.client.file("/api/documents/" + self.id + "/pdf", self.sha, path)
            self.assertEqual(path.read_bytes(), b"different artifact")

    def test_redirects_and_unsafe_destinations_fail_closed(self):
        with self.assertRaisesRegex(ClientError, "Redirect refused"):
            NoRedirect().redirect_request(Request("https://scanner.example.test/api/captures"), None, 302, "", {}, "https://attacker.example")
        for path in ["https://attacker.example", "//attacker.example/api/captures", "/camera", "/api/captures\r\n"]:
            with self.assertRaises(ClientError):
                self.client.request(path)
        for origin in ["http://scanner.example", "https://user:pass@scanner.example", "https://scanner.example/api", "https://scanner.example?next=bad"]:
            with self.assertRaises(ClientError):
                ScannerClient({"origin": origin})

    def test_metadata_identity_and_symlinks_are_checked(self):
        self.client.get = Mock(return_value={**self.meta, "id": "wrong"})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ClientError, "metadata"):
                self.client.original(self.id, directory)
            self.client.get = Mock(return_value=self.meta)
            link = Path(directory) / (self.id + "-" + self.sha + ".jpg")
            link.symlink_to(Path(directory) / "unrelated")
            with self.assertRaisesRegex(ClientError, "symlink"):
                self.client.original(self.id, directory)


if __name__ == "__main__":
    unittest.main()
