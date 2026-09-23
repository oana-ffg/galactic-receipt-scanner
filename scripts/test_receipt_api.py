import hashlib
import json
import io
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch, call
from urllib.error import URLError
from urllib.request import Request
from receipt_api import ScannerClient, ScannerConnectionError, ClientError, OCRRequired, NoRedirect, credentials, main, run_jev_completeness


class ClientTests(unittest.TestCase):
    def test_private_provider_config_loads_secret_without_a_credential_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "provider.json"
            config_path.write_text(json.dumps({"origin": "https://scanner.example.test",
                                               "credential_command": ["secret-tool", "read", "scanner"]}))
            config_path.chmod(0o600)
            secret = {"origin": "https://scanner.example.test", "sites_token": "synthetic-sites",
                      "processing_token": "rsc_" + "s" * 43}
            response = subprocess.CompletedProcess([], 0, json.dumps(secret).encode(), b"")
            with patch("receipt_api.subprocess.run", return_value=response) as run:
                self.assertEqual(credentials(config_path), secret)
            self.assertEqual(run.call_args.args[0], ["secret-tool", "read", "scanner"])
            self.assertNotIn("credential_file", json.loads(config_path.read_text()))
            with patch("receipt_api.subprocess.run", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps({**secret, "origin": "https://other.example"}).encode(), b"")):
                with self.assertRaisesRegex(ClientError, "origin differs"):
                    credentials(config_path)
            with patch("receipt_api.subprocess.run", return_value=subprocess.CompletedProcess([], 1, b"", b"private error")):
                with self.assertRaisesRegex(ClientError, "did not return") as failure:
                    credentials(config_path)
            self.assertNotIn("private error", str(failure.exception))

    def test_completeness_race_does_not_count_an_unready_receipt_as_not_receipt(self):
        document = {"document_id": self.id, "kind": "receipt", "ready": True,
                    "jev": {"role": "purchase_document"},
                    "completeness_audit": None, "ocr_characters": 1000,
                    "ocr_truncated": False}
        self.client.get = Mock(return_value={"documents": [document], "next": None})
        self.client.request = Mock(return_value=json.dumps(
            {"assessed": False, "result": "not_ready"}).encode())
        result = run_jev_completeness(self.client)
        self.assertEqual(result["counts"]["not_ready"], 1)
        self.assertEqual(result["counts"]["not_receipt"], 0)
        self.assertEqual(result["needs_human_document_ids"], [])

    def test_completeness_retries_a_temporary_server_failure(self):
        document = {"document_id": self.id, "kind": "receipt", "ready": True,
                    "jev": {"role": "purchase_document"},
                    "completeness_audit": None, "ocr_characters": 1000,
                    "ocr_truncated": False}
        self.client.get = Mock(return_value={"documents": [document], "next": None})
        self.client.request = Mock(side_effect=[ClientError("Scanner returned HTTP 503"),
                                                json.dumps({"assessed": True, "result": "yes",
                                                            "confidence": 0.9}).encode()])
        sleep = Mock()
        result = run_jev_completeness(self.client, sleep=sleep)
        self.assertEqual(result["counts"]["yes"], 1)
        self.assertEqual(self.client.request.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_completeness_skips_explicit_non_receipt_kind(self):
        document = {"document_id": self.id, "kind": "payment-slip", "ready": True,
                    "jev": {"role": "purchase_document"},
                    "completeness_audit": None, "ocr_characters": 1000,
                    "ocr_truncated": False}
        self.client.get = Mock(return_value={"documents": [document], "next": None})
        self.client.request = Mock()
        result = run_jev_completeness(self.client)
        self.assertEqual(result["counts"]["not_purchase"], 1)
        self.client.request.assert_not_called()

    def test_pp_profile_binds_matching_destination_and_runtimes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node = root / "node.exe"
            node.write_bytes(b"synthetic executable; never run")
            profile = root / "profile.json"
            settings = {"origin": self.client.origin, "repository": str(Path(__file__).resolve().parent.parent),
                        "node": str(node), "ppocr": {"python": "unused in mocked backend"}}
            profile.write_text(json.dumps(settings))
            with patch("receipt_ppocr.PPBackend") as backend:
                self.client.configure_ppocr(profile)
                backend.assert_called_once_with(profile, settings["ppocr"])
                self.assertEqual(self.client.node, str(node))
                self.assertIs(self.client.ocr_backend, backend.return_value)
                for field, bad in [("origin", "https://other.example.test"), ("repository", ""),
                                   ("repository", None), ("repository", "."), ("node", None),
                                   ("node", str(profile)), ("ppocr", None)]:
                    with self.subTest(field=field, bad=bad):
                        profile.write_text(json.dumps({**settings, field: bad}))
                        with self.assertRaises(ClientError): self.client.configure_ppocr(profile)
                profile.write_text(json.dumps(settings))
                with patch.object(Path, "is_junction", return_value=True):
                    with self.assertRaises(ClientError): self.client.configure_ppocr(profile)

    def test_saved_pp_profile_binds_without_an_inference_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            node = root / "node.exe"
            node.write_bytes(b"synthetic executable; never run")
            profile = root / "profile.json"
            settings = {"origin": self.client.origin,
                        "repository": str(Path(__file__).resolve().parent.parent),
                        "node": str(node), "confirmation_provider": "ppocr"}
            profile.write_text(json.dumps(settings))
            self.client.configure_saved_ppocr(profile)
            self.assertEqual(self.client.ocr_backend.engine, "PP-OCRv6")
            self.assertFalse(hasattr(self.client.ocr_backend, "run"))
            self.assertEqual(self.client.node, str(node))
            self.client.original = Mock(return_value={"capture_id": self.id, "path": "/synthetic/source.jpg", "sha256": self.sha})
            self.client.get = Mock(return_value={"artifacts": []})
            with self.assertRaisesRegex(ClientError, "saved scan crop"):
                self.client.prepare(self.id, root / "work", crop=[1, 2, 90, 180])
            for bad in ({**settings, "confirmation_provider": "qwen"},
                        {**settings, "ppocr": {"python": "must-not-be-present"}}):
                profile.write_text(json.dumps(bad))
                with self.assertRaisesRegex(ClientError, "contain no OCR runtime"):
                    self.client.configure_saved_ppocr(profile)

    def setUp(self):
        self.client = ScannerClient({"origin": "https://scanner.example.test", "sites_token": "synthetic-sites", "processing_token": "rsc_" + "s" * 43})
        self.client.source_region = Mock(return_value=[0,0,100,200])
        self.client.ocr_backend = Mock(engine="PP-OCRv6")
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
            if os.name != "nt":
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

    def test_new_original_directory_preserves_platform_access_contract(self):
        self.client.get = Mock(return_value=self.meta)
        self.client.request = Mock(return_value=self.body)
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "originals"
            result = self.client.original(self.id, cache)
            self.assertEqual(Path(result["path"]).read_bytes(), self.body)
            if os.name == "nt":
                # A protected child DACL is the regression: it removes permissions
                # the authorized workspace has granted to the image-viewing tool.
                import ctypes
                from ctypes import wintypes
                security = ctypes.WinDLL("advapi32", use_last_error=True)
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                pointer = ctypes.c_void_p
                security.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD,
                    wintypes.DWORD, pointer, pointer, pointer, pointer, ctypes.POINTER(pointer)]
                security.GetNamedSecurityInfoW.restype = wintypes.DWORD
                security.GetSecurityDescriptorControl.argtypes = [pointer,
                    ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.DWORD)]
                security.GetSecurityDescriptorControl.restype = wintypes.BOOL
                kernel.LocalFree.argtypes = [pointer]
                kernel.LocalFree.restype = pointer
                descriptor = pointer()
                self.assertEqual(security.GetNamedSecurityInfoW(str(cache), 1, 4,
                    None, None, None, None, ctypes.byref(descriptor)), 0)
                try:
                    control, revision = wintypes.WORD(), wintypes.DWORD()
                    self.assertTrue(security.GetSecurityDescriptorControl(descriptor,
                        ctypes.byref(control), ctypes.byref(revision)))
                    self.assertFalse(control.value & 0x1000)  # SE_DACL_PROTECTED
                finally:
                    kernel.LocalFree(descriptor)
            else:
                self.assertEqual(cache.stat().st_mode & 0o777, 0o700)

    def test_status_identifies_actual_destination_without_credentials(self):
        output = io.StringIO()
        with patch("receipt_api.credentials", return_value={}), \
                patch("receipt_api.ScannerClient", return_value=self.client), \
                patch.object(self.client, "get", return_value={"version": 2, "origin": "untrusted-server-field"}), \
                patch("sys.argv", ["receipt_api.py", "status"]), redirect_stdout(output):
            main()
        self.assertEqual(json.loads(output.getvalue()), {"version": 2, "origin": self.client.origin})
        self.assertNotIn(self.client.sites_token, output.getvalue())
        self.assertNotIn(self.client.processing_token, output.getvalue())

    def test_jev_backfill_runs_one_retryable_job_per_request_until_complete(self):
        output = io.StringIO()
        self.client.request = Mock(side_effect=[
            json.dumps({"result": {"status": "complete"}, "remaining": 1, "blocked": 0}).encode(),
            json.dumps({"result": {"status": "complete"}, "remaining": 0, "blocked": 0}).encode(),
            json.dumps({"result": None, "remaining": 0, "blocked": 0}).encode(),
        ])
        with patch("receipt_api.credentials", return_value={}), \
                patch("receipt_api.ScannerClient", return_value=self.client), \
                patch("sys.argv", ["receipt_api.py", "jev-backfill"]), redirect_stdout(output):
            main()
        self.assertEqual(json.loads(output.getvalue())["processed"], 2)
        self.assertEqual(self.client.request.call_args_list, [
            call("/api/jev/backfill", b"{}"),
            call("/api/jev/backfill", b"{}"),
            call("/api/jev/backfill", b"{}"),
        ])

    def test_jev_backfill_reports_intentional_busy_state_as_deferred(self):
        output = io.StringIO()
        self.client.request = Mock(return_value=json.dumps({
            "result": None, "phase": "dates", "remaining": 1,
            "busy": True, "blocked": 0,
        }).encode())
        with patch("receipt_api.credentials", return_value={}), \
                patch("receipt_api.ScannerClient", return_value=self.client), \
                patch("sys.argv", ["receipt_api.py", "jev-backfill"]), redirect_stdout(output):
            main()
        self.assertEqual(json.loads(output.getvalue()), {
            "complete": False,
            "deferred": True,
            "processed": 0,
            "remaining": 1,
            "phase": "dates",
            "blocked": 0,
            "last": {
                "result": None,
                "phase": "dates",
                "remaining": 1,
                "busy": True,
                "blocked": 0,
            },
        })
        self.client.request.assert_called_once_with("/api/jev/backfill", b"{}")

    def test_jev_backfill_preserves_waiting_for_ocr_as_incomplete(self):
        output = io.StringIO()
        waiting = {
            "result": {"status": "waiting-for-ocr"},
            "phase": "complete",
            "remaining": 0,
            "waiting": True,
            "busy": False,
            "blocked": 0,
        }
        self.client.request = Mock(return_value=json.dumps(waiting).encode())
        with patch("receipt_api.credentials", return_value={}), \
                patch("receipt_api.ScannerClient", return_value=self.client), \
                patch("sys.argv", ["receipt_api.py", "jev-backfill"]), redirect_stdout(output):
            main()
        self.assertEqual(json.loads(output.getvalue()), {
            "complete": False,
            "waiting": True,
            "processed": 1,
            "remaining": 0,
            "phase": "complete",
            "blocked": 0,
            "last": waiting,
        })
        self.client.request.assert_called_once_with("/api/jev/backfill", b"{}")

    def test_jev_backfill_fails_closed_when_jobs_are_blocked(self):
        self.client.request = Mock(return_value=json.dumps({
            "result": None, "remaining": 0, "blocked": 2
        }).encode())
        with patch("receipt_api.credentials", return_value={}), \
                patch("receipt_api.ScannerClient", return_value=self.client), \
                patch("sys.argv", ["receipt_api.py", "jev-backfill"]):
            with self.assertRaisesRegex(ClientError, "2 blocked"):
                main()

    def test_jev_backfill_rejects_a_non_object_response(self):
        self.client.request = Mock(return_value=b"[]")
        with patch("receipt_api.credentials", return_value={}), \
                patch("receipt_api.ScannerClient", return_value=self.client), \
                patch("sys.argv", ["receipt_api.py", "jev-backfill"]):
            with self.assertRaisesRegex(ClientError, "invalid response"):
                main()

    def test_snapshot_metadata_avoids_per_image_lookup_but_still_verifies_bytes(self):
        self.client.get = Mock(side_effect=AssertionError('Unexpected metadata request'))
        self.client.request = Mock(return_value=self.body)
        with tempfile.TemporaryDirectory() as directory:
            result = self.client.original(self.id, directory, metadata=self.meta)
            self.assertEqual(Path(result['path']).read_bytes(), self.body)
            self.assertTrue(self.client.original(self.id, directory, metadata=self.meta)['cached'])
            self.client.get.assert_not_called()
            self.client.request.assert_called_once()

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

    def test_connection_failure_has_a_distinct_retryable_type(self):
        self.client.opener.open = Mock(side_effect=URLError("synthetic outage"))
        with self.assertRaises(ScannerConnectionError):
            self.client.request("/api/processing/claim", b"{}")

    def test_metadata_identity_and_symlinks_are_checked(self):
        self.client.get = Mock(return_value={**self.meta, "id": "wrong"})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ClientError, "metadata"):
                self.client.original(self.id, directory)
            self.client.get = Mock(return_value=self.meta)
            link = Path(directory) / (self.id + "-" + self.sha + ".jpg")
            try:
                link.symlink_to(Path(directory) / "unrelated")
            except OSError as error:
                if os.name == "nt" and error.winerror == 1314:
                    self.skipTest("Windows symlink creation privilege is unavailable to this test process")
                raise
            with self.assertRaisesRegex(ClientError, "symlink"):
                self.client.original(self.id, directory)


    def ocr_fixture(self):
        return {"text": "Synthetic shop 12,34", "source": {"captureId": self.id, "sha256": self.sha, "pixels": [100,200], "region": dict(left=0,top=0,width=100,height=200), "rotation": 0},
                "provenance": {"engine": "PP-OCRv6"},
                "text_only_pdf_layers": [{"base64": "c3ludGhldGlj", "sha256": "f" * 64}]}

    def test_saved_ocr_skips_malformed_artifacts_without_images_or_inference(self):
        good = json.dumps(self.ocr_fixture()).encode()
        bodies = {hashlib.sha256(body).hexdigest(): body for body in (b'not JSON', b'\xff', good)}
        self.client.get = Mock(return_value={**self.meta, 'artifacts': [dict(kind='ocr', sha256=sha) for sha in bodies]})
        self.client.request = Mock(side_effect=lambda path: bodies[path.split('version=')[1]])
        self.client.original = Mock(side_effect=AssertionError('Saved OCR must not fetch pixels'))
        geometry = Mock(returncode=0, stdout=json.dumps(dict(pixels=[100, 200], crop=[0, 0, 100, 200])))
        with tempfile.TemporaryDirectory() as directory, patch('receipt_api.subprocess.run', return_value=geometry):
            result = self.client.saved_ocr(self.id, directory)
            self.assertEqual(result['ocr_sha256'], hashlib.sha256(good).hexdigest())
            self.assertNotIn('path', result)
        self.client.ocr_backend.run.assert_not_called()
        self.client.ocr_backend.preflight.assert_not_called()

    def test_saved_ocr_reuses_a_region_covering_the_scan_crop(self):
        body = json.dumps(self.ocr_fixture()).encode()
        sha = hashlib.sha256(body).hexdigest()
        self.client.get = Mock(return_value={**self.meta, 'artifacts': [dict(kind='ocr', sha256=sha)]})
        self.client.request = Mock(return_value=body)
        self.client.original = Mock(return_value=dict(capture_id=self.id, sha256=self.sha))
        geometry = Mock(returncode=0, stdout=json.dumps(dict(pixels=[100, 200], crop=[1, 2, 90, 180])))
        with tempfile.TemporaryDirectory() as directory, patch('receipt_api.subprocess.run', return_value=geometry):
            with self.assertRaisesRegex(ClientError, 'saved scan crop'):
                self.client.saved_ocr(self.id, directory, crop=[2, 2, 90, 180])
            self.assertEqual(self.client.saved_ocr(self.id, directory)['ocr_sha256'], sha)
        self.client.ocr_backend.run.assert_not_called()

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
            result = self.client.prepare(self.id, directory, allow_inference=False)
            self.assertEqual(Path(result["ocr_path"]).read_bytes(), good)
            self.assertEqual(result["ocr_sha256"], hashlib.sha256(good).hexdigest())
            run.assert_not_called()

    def test_prepare_generates_uploads_and_returns_the_verified_pinned_path(self):
        data = json.dumps(self.ocr_fixture()).encode()
        sha = hashlib.sha256(data).hexdigest()
        self.client.original = Mock(return_value={"capture_id": self.id, "path": "/synthetic/source.jpg", "sha256": self.sha})
        self.client.get = Mock(return_value={"artifacts": []})
        self.client.request = Mock(side_effect=lambda path, body=None: json.dumps({"sha256": sha}).encode() if body is not None else data)
        self.client.ocr_backend.run.side_effect = lambda manifest, output: Path(output).write_bytes(data)
        with tempfile.TemporaryDirectory() as directory, patch("receipt_api.subprocess.run", side_effect=AssertionError("No Tesseract fallback")):
            result = self.client.prepare(self.id, directory)
            self.assertEqual(Path(result["ocr_path"]).name, self.id + "-" + sha + ".ocr.json")
            self.assertEqual(Path(result["ocr_path"]).read_bytes(), data)
            self.assertEqual(self.client.request.call_count, 2)

    def test_missing_saved_ocr_requests_the_scan_crop_without_inference_or_upload(self):
        self.client.original = Mock(return_value={'capture_id': self.id, 'path': '/synthetic/source.jpg', 'sha256': self.sha})
        self.client.get = Mock(return_value={'artifacts': []})
        self.client.request = Mock()
        self.client.source_region.return_value = [1, 2, 90, 180]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(OCRRequired) as raised:
                self.client.prepare(self.id, directory, crop=[1, 2, 90, 180], rotation=90, allow_inference=False)
        self.assertEqual(raised.exception.request, dict(origin=self.client.origin, capture_id=self.id,
            source_sha256=self.sha, crop=[1, 2, 90, 180], rotation=90))
        self.client.ocr_backend.run.assert_not_called()
        self.client.request.assert_not_called()

    def test_prepare_reruns_ocr_when_old_region_misses_part_of_scan_crop(self):
        old = self.ocr_fixture()
        old["source"]["region"] = dict(left=20, top=20, width=60, height=150)
        new = self.ocr_fixture()
        new["source"]["region"] = dict(left=10, top=20, width=70, height=150)
        old_bytes, new_bytes = json.dumps(old).encode(), json.dumps(new).encode()
        old_sha, new_sha = hashlib.sha256(old_bytes).hexdigest(), hashlib.sha256(new_bytes).hexdigest()
        self.client.original = Mock(return_value={"capture_id": self.id, "path": "/synthetic/source.jpg", "sha256": self.sha})
        self.client.source_region.return_value = [10, 20, 80, 170]
        self.client.get = Mock(return_value={"artifacts": [{"kind": "ocr", "sha256": old_sha}]})
        def request(path, body=None):
            return json.dumps({"sha256": new_sha}).encode() if body is not None else (old_bytes if old_sha in path else new_bytes)
        self.client.request = Mock(side_effect=request)
        def generate(manifest_path, output):
            manifest = json.loads(Path(manifest_path).read_text())
            self.assertEqual(manifest["crop"], [10,20,80,170])
            Path(output).write_bytes(new_bytes)
        self.client.ocr_backend.run.side_effect = generate
        with tempfile.TemporaryDirectory() as directory, patch("receipt_api.subprocess.run", side_effect=AssertionError("No Tesseract fallback")):
            result = self.client.prepare(self.id, directory, crop=[10,20,80,170])
            self.assertEqual(result["ocr_sha256"], new_sha)
            self.client.ocr_backend.run.assert_called_once()

    def test_prepare_requires_pp_before_reading_or_writing_receipts(self):
        self.client.ocr_backend = None
        self.client.get = Mock()
        with self.assertRaisesRegex(ClientError, "Tesseract is not a fallback"):
            self.client.prepare(self.id)
        self.client.get.assert_not_called()

    def test_tesseract_artifact_is_not_reused_for_pp(self):
        old = self.ocr_fixture()
        old["provenance"]["engine"] = "tesseract.js synthetic"
        data = json.dumps(self.ocr_fixture()).encode()
        legacy = json.dumps(old).encode()
        sha, old_sha = hashlib.sha256(data).hexdigest(), hashlib.sha256(legacy).hexdigest()
        self.client.original = Mock(return_value={"capture_id": self.id, "path": "/synthetic/source.jpg", "sha256": self.sha})
        self.client.get = Mock(return_value={"artifacts": [{"kind": "ocr", "sha256": old_sha}]})
        self.client.request = Mock(side_effect=lambda path, body=None: json.dumps({"sha256": sha}).encode() if body is not None else (legacy if old_sha in path else data))
        self.client.ocr_backend.run.side_effect = lambda manifest, output: Path(output).write_bytes(data)
        with tempfile.TemporaryDirectory() as directory:
            result = self.client.prepare(self.id, directory)
            self.assertEqual(result["ocr_sha256"], sha)
            self.client.ocr_backend.run.assert_called_once()

    def test_pdf_reused_sources_create_output_directory_without_preparing_again(self):
        page = dict(captureId=self.id, sha256=self.sha, rotation=0)
        self.client.get = Mock(return_value={"document": dict(id=self.id, revision=3,
            filename="2026-01-01_synthetic.pdf", pages=[page])})
        self.client.prepare = Mock(side_effect=AssertionError("Reuse prepared sources"))
        self.client.original = Mock(return_value=dict(capture_id=self.id, sha256=self.sha))
        data = b"%PDF-synthetic-test-only"
        sha = hashlib.sha256(data).hexdigest()
        self.client.request = Mock(return_value=json.dumps(dict(sha256=sha, revision=3)).encode())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, ocr = root / "source.jpg", root / "ocr.json"
            source.write_bytes(b"synthetic source")
            ocr.write_bytes(b"{}")
            prepared = {self.id: dict(path=str(source), ocr_path=str(ocr), sha256=self.sha,
                ocr_sha256=hashlib.sha256(ocr.read_bytes()).hexdigest(), crop=[0,0,100,200], rotation=0)}
            def generate(args, **kwargs):
                manifest = json.loads(Path(args[-2]).read_text())
                self.assertEqual(manifest["pages"], [{**page, "crop": [0,0,100,200], "path": str(source), "ocr_path": str(ocr)}])
                Path(args[-1]).write_bytes(data)
                return Mock(returncode=0, stdout=json.dumps(dict(sha256=sha, pages=1,
                    layouts=[{**page, "pixels": [10, 20], "crop": [0,0,100,200]}])))
            with patch("receipt_api.subprocess.run", side_effect=generate):
                result = self.client.pdf(self.id, root / "new" / "pdf", prepared=prepared)
            self.assertEqual(Path(result["path"]).read_bytes(), data)
            self.client.prepare.assert_not_called()
            self.client.request.assert_called_once_with(f"/api/documents/{self.id}/pdf?revision=3", data, "application/pdf")

    def test_pdf_verifies_upload_without_redownloading_and_preserves_errors(self):
        self.client.get = Mock(return_value={"document": {"id": self.id, "revision": 3, "filename": "2026-01-01_synthetic.pdf", "pages": [{"captureId": self.id, "sha256": self.sha, "rotation": 0}]}})
        self.client.original = Mock(return_value=dict(capture_id=self.id, sha256=self.sha))
        self.client.prepare = Mock(return_value={"path": "/synthetic/source.jpg", "ocr_path": "/synthetic/ocr.json", "sha256": self.sha})
        data = b"%PDF-synthetic-test-only"
        sha = hashlib.sha256(data).hexdigest()
        def generate(args, **kwargs):
            Path(args[-1]).write_bytes(data)
            return Mock(returncode=0, stdout=json.dumps(dict(sha256=sha, pages=1,
                layouts=[dict(captureId=self.id, sha256=self.sha, pixels=[10, 20], crop=[0,0,100,200], rotation=0)])))
        self.client.request = Mock(side_effect=lambda path, body=None, content_type=None: json.dumps({"sha256": sha, "revision": 3, "filename": "2026-01-01_synthetic.pdf"}).encode() if body is not None else data)
        with tempfile.TemporaryDirectory() as directory, patch("receipt_api.subprocess.run", side_effect=generate):
            result = self.client.pdf(self.id, directory)
            self.assertEqual(Path(result["path"]).read_bytes(), data)
            self.assertEqual(result["sha256"], sha)
            self.assertIn("revision=3", self.client.request.call_args_list[0].args[0])
            self.client.request.assert_called_once_with(
                f"/api/documents/{self.id}/pdf?revision=3", data, "application/pdf")
            self.assertTrue(Path(result["path"]).is_absolute())
            for response, message in [
                    ({"sha256": "0" * 64, "revision": 3}, "checksum"),
                    ({"sha256": sha, "revision": 4}, "revision"),
                    ({"revision": 3}, "checksum"),
                    ({"sha256": sha}, "revision")]:
                with self.subTest(response=response):
                    self.client.request = Mock(return_value=json.dumps(response).encode())
                    before = set(Path(directory).glob("*.pdf"))
                    with self.assertRaisesRegex(ClientError, message):
                        self.client.pdf(self.id, directory)
                    self.client.request.assert_called_once()
                    retained = set(Path(directory).glob("*.pdf")) - before
                    self.assertEqual(len(retained), 1)
                    self.assertEqual(next(iter(retained)).read_bytes(), data)
            self.client.request = Mock(side_effect=ClientError("Scanner returned HTTP 409; reread revision."))
            intent = Mock()
            with self.assertRaisesRegex(ClientError, "409"):
                self.client.pdf(self.id, directory, before_upload=intent)
            intent.assert_called_once()
            self.assertEqual(intent.call_args.args[0]["sha256"], sha)
            self.assertEqual(Path(intent.call_args.args[0]["path"]).read_bytes(), data)
            self.client.request.reset_mock()
            with self.assertRaisesRegex(OSError, "journal unavailable"):
                self.client.pdf(self.id, directory, before_upload=Mock(side_effect=OSError("journal unavailable")))
            self.client.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
