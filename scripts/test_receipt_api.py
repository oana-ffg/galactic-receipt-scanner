import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
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


    def ocr_fixture(self):
        return {"text": "Synthetic shop 12,34", "source": {"captureId": self.id, "sha256": self.sha},
                "provenance": {"engine": "tesseract.js synthetic"},
                "text_only_pdf_layers": [{"base64": "c3ludGhldGlj", "sha256": "f" * 64}]}

    def test_prepare_reuses_only_source_matched_ocr_and_skips_malformed_candidates(self):
        good = json.dumps(self.ocr_fixture()).encode()
        wrong = json.dumps({**self.ocr_fixture(), "source": {"captureId": self.id, "sha256": "0" * 64}}).encode()
        malformed = json.dumps({**self.ocr_fixture(), "text_only_pdf_layers": [1]}).encode()
        missing_text = self.ocr_fixture()
        del missing_text["text"]
        bodies = [b"broken JSON", b'{"source":null}', wrong, malformed, json.dumps(missing_text).encode(), good]
        hashed = {hashlib.sha256(body).hexdigest(): body for body in bodies}
        self.client.original = Mock(return_value={"capture_id": self.id, "path": "/synthetic/source.jpg", "sha256": self.sha})
        self.client.get = Mock(return_value={"artifacts": [{"kind": "ocr", "sha256": sha} for sha in hashed]})
        self.client.request = Mock(side_effect=lambda path: hashed[path.split("version=")[1]])
        with tempfile.TemporaryDirectory() as directory, patch("receipt_api.subprocess.run") as run:
            result = self.client.prepare(self.id, directory)
            self.assertEqual(Path(result["ocr_path"]).read_bytes(), good)
            self.assertEqual(result["ocr_sha256"], hashlib.sha256(good).hexdigest())
            run.assert_not_called()

    def test_prepare_generates_uploads_and_returns_the_verified_pinned_path(self):
        data = json.dumps(self.ocr_fixture()).encode()
        sha = hashlib.sha256(data).hexdigest()
        self.client.original = Mock(return_value={"capture_id": self.id, "path": "/synthetic/source.jpg", "sha256": self.sha})
        self.client.get = Mock(return_value={"artifacts": []})
        self.client.request = Mock(side_effect=lambda path, body=None: json.dumps({"sha256": sha}).encode() if body is not None else data)
        def generate(args, **kwargs):
            Path(args[-1]).write_bytes(data)
            return Mock(returncode=0)
        with tempfile.TemporaryDirectory() as directory, patch("receipt_api.subprocess.run", side_effect=generate):
            result = self.client.prepare(self.id, directory)
            self.assertEqual(Path(result["ocr_path"]).name, self.id + "-" + sha + ".ocr.json")
            self.assertEqual(Path(result["ocr_path"]).read_bytes(), data)
            self.assertEqual(self.client.request.call_count, 2)

    def test_pdf_verifies_upload_readback_and_preserves_stale_revision_errors(self):
        self.client.get = Mock(return_value={"document": {"id": self.id, "revision": 3, "filename": "2026-01-01_synthetic.pdf", "pages": [{"captureId": self.id, "sha256": self.sha, "rotation": 0, "crop": None}]}})
        self.client.prepare = Mock(return_value={"path": "/synthetic/source.jpg", "ocr_path": "/synthetic/ocr.json", "sha256": self.sha})
        data = b"%PDF-synthetic-test-only"
        sha = hashlib.sha256(data).hexdigest()
        def generate(args, **kwargs):
            Path(args[-1]).write_bytes(data)
            return Mock(returncode=0)
        self.client.request = Mock(side_effect=lambda path, body=None, content_type=None: json.dumps({"sha256": sha, "revision": 3, "filename": "2026-01-01_synthetic.pdf"}).encode() if body is not None else data)
        with tempfile.TemporaryDirectory() as directory, patch("receipt_api.subprocess.run", side_effect=generate):
            result = self.client.pdf(self.id, directory)
            self.assertEqual(Path(result["path"]).read_bytes(), data)
            self.assertEqual(result["sha256"], sha)
            self.assertIn("revision=3", self.client.request.call_args_list[0].args[0])
            self.client.request = Mock(side_effect=ClientError("Scanner returned HTTP 409; reread revision."))
            with self.assertRaisesRegex(ClientError, "409"):
                self.client.pdf(self.id, directory)


if __name__ == "__main__":
    unittest.main()
