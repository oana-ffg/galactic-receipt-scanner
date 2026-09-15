import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import receipt_worker as module


class WorkerSessionTests(unittest.TestCase):
    def test_protected_profile_denial_is_specific_and_cannot_start_worker(self):
        with patch.object(module.sys, 'argv', ['receipt_worker.py', '--profile', 'private-profile.json']), \
             patch.object(module.Path, 'read_text', side_effect=PermissionError('secret-path-must-not-escape')), \
             patch.object(module, 'Worker') as worker, \
             patch.object(module.sys, 'stdout', io.StringIO()) as output, \
             patch.object(module.sys, 'stderr', io.StringIO()) as errors:
            self.assertEqual(module.main(), 1)
        worker.assert_not_called()
        result = json.loads(output.getvalue())
        self.assertEqual(result['error_code'], 'profile_access_denied')
        self.assertEqual(result['stage'], 'profile_read')
        self.assertFalse(result['claim_started'])
        self.assertTrue(result['blocking'])
        self.assertNotIn('secret-path', output.getvalue())
        self.assertNotIn('private-profile', output.getvalue())
        self.assertEqual(errors.getvalue(), '')

    def run_session(self, phase, failed=None, result=None):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / 'profile.json'
            profile.write_text('{}')
            worker = Mock()
            worker.state = dict(phase='ready')
            worker.preflight.return_value = dict(ready=True)
            worker.mutex = threading.Lock()
            worker.stop_heartbeat = threading.Event()
            def handle(message):
                worker.state = dict(phase=phase, failed=failed)
                return result if result is not None else dict(phase=phase)
            worker.handle.side_effect = handle
            stdin = Mock(buffer=io.BytesIO(b'{"op":"attest"}\n{"op":"quit"}\n'))
            with patch.object(module, 'Worker', return_value=worker), \
                 patch.object(module, 'disable_console_echo'), \
                 patch.object(module.sys, 'argv', ['receipt_worker.py', '--profile', str(profile)]), \
                 patch.object(module.sys, 'stdin', stdin), \
                 patch.object(module.sys, 'stdout', io.StringIO()) as output:
                module.main()
            worker.lock.close.assert_called_once()
            self.assertTrue(worker.stop_heartbeat.is_set())
            worker.release.assert_not_called()
            return worker, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_successful_terminal_result_closes_without_reading_quit(self):
        for phase in ['complete', 'empty']:
            with self.subTest(phase=phase):
                worker, output = self.run_session(phase)
                self.assertEqual(worker.handle.call_count, 1)
                self.assertEqual(output[-1]['phase'], phase)

    def test_nonterminal_pdf_result_keeps_session_for_attestation(self):
        worker, output = self.run_session('pdf')
        self.assertEqual(worker.handle.call_count, 2)
        self.assertEqual(len(output), 3)

    def test_failed_terminal_state_is_not_clean_completion(self):
        worker, output = self.run_session('complete', failed=dict(error='synthetic failure'))
        self.assertEqual(worker.handle.call_count, 2)

    def test_error_response_is_not_clean_completion(self):
        worker, output = self.run_session('complete', result=dict(ok=False, blocking=True))
        self.assertEqual(worker.handle.call_count, 2)


if __name__ == '__main__':
    unittest.main()
