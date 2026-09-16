"""Synthetic endpoint and transport checks. No external inference calls."""
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import receipt_ollama


class EndpointTest(unittest.TestCase):
    def test_public_and_credential_urls_are_rejected(self):
        for value in ["https://example.com/path", "https://key@example.com", "ftp://localhost"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                receipt_ollama.private_endpoint(value)
        for value in ["http://8.8.8.8", "http://0.0.0.0", "http://169.254.169.254", "http://224.0.0.1", "http://[::]", "http://[fe80::1]", "http://[ff02::1]"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                receipt_ollama.private_endpoint(value)

    def test_private_endpoint_preserves_port(self):
        self.assertEqual(receipt_ollama.private_endpoint("http://192.168.1.2:11434/"), "http://192.168.1.2:11434")
        self.assertEqual(receipt_ollama.private_endpoint("https://[::1]:11434"), "https://[::1]:11434")

    def test_no_redirect_can_forward_receipts(self):
        with self.assertRaises(ValueError):
            receipt_ollama.NoRedirect().redirect_request(None, None, 307, "redirect", {}, "https://example.com")

class LineageTest(unittest.TestCase):
    def test_record_identity_and_generation_completion(self):
        source = {'id':'synthetic', 'sha256':'a'*64}
        config = {'model':'local-model', 'digest':'model-digest'}
        record = {'source_id':'synthetic','sha256':'a'*64,'run_id':'run','config_sha256':'config',
                  'postflight_digest':'model-digest','response':{'model':'local-model','done':True,'done_reason':'stop'}}
        receipt_ollama.check_record(record, source, 'config', 'run')
        receipt_ollama.check_response(record, config)
        for field in ['source_id','sha256','run_id','config_sha256']:
            with self.subTest(field=field), self.assertRaises(ValueError):
                receipt_ollama.check_record(record | {field:'changed'}, source, 'config', 'run')
        with self.assertRaises(ValueError):
            receipt_ollama.check_response(record | {'postflight_digest':'changed'}, config)
        for change in [{'model':'other'}, {'done':False}, {'done_reason':'length'}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                receipt_ollama.check_response(record | {'response':record['response'] | change}, config)

    def test_attempt_hash_and_config_cannot_change(self):
        import tempfile
        import receipt_extraction as w
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root/'original.txt'; original.write_text('Synthetic')
            with closing(w.connect(root/'test.db')) as db, db:
                w.add_sources(db, {'samples':[{'captureId':'synthetic','sha256':w.sha(original.read_bytes()),
                    'original':str(original),'scanned_at':'2026-01-01T00:00:00Z','source_pixels':[10,20]}]})
                w.add_run(db,'run','local','synthetic-model','test')
                config={'run_id':'run','output_directory':str(root)}
                receipt_ollama.register_config(db,'run',config)
                receipt_ollama.register_config(db,'run',config)
                with self.assertRaises(ValueError):
                    receipt_ollama.register_config(db,'run',config | {'output_directory':'changed'})
                raw=root/'raw.json'; w.save_immutable(raw,{'synthetic':True})
                receipt_ollama.register_attempt(db,'run','synthetic',raw,'config')
                receipt_ollama.verify_imported_attempt(db,'run','synthetic')
                raw.write_text('tampered')
                with self.assertRaises(ValueError):
                    receipt_ollama.register_attempt(db,'run','synthetic',raw,'config')
                with self.assertRaises(ValueError):
                    receipt_ollama.verify_imported_attempt(db,'run','synthetic')

    def test_selection_typo_is_rejected_without_inference(self):
        import tempfile
        import receipt_extraction as w
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db_path = root/'test.db'
            db = w.connect(db_path)
            self.addCleanup(db.close)
            argv = ['client','--endpoint','http://127.0.0.1:11434','--model','synthetic-model',
                    '--db',str(db_path),'--run','test','--output',str(root/'raw'),
                    '--source-id','typo']
            with patch.object(w, 'connect', return_value=db), \
                    patch('sys.argv',argv), patch.object(receipt_ollama,'request',side_effect=[
                    {'models':[{'name':'synthetic-model','size':10,'digest':'digest'}]},
                    {'capabilities':['vision']}]) as network:
                with self.assertRaisesRegex(ValueError,'Unknown source selection'):
                    receipt_ollama.main()
                self.assertEqual(network.call_count,2)
            with self.assertRaisesRegex(sqlite3.ProgrammingError, 'closed'):
                db.execute('SELECT 1')


if __name__ == "__main__":
    unittest.main()
