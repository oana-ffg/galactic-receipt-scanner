import json
from pathlib import Path
import tempfile
import unittest

import receipt_ocr_scheduled as scheduled


class FakeProcess:
    def __init__(self, exit_code):
        self.exit_code = exit_code
        self.pid = 1234
        self.waited = False

    def wait(self):
        self.waited = True
        return self.exit_code


class ScheduledOcrTests(unittest.TestCase):
    def run_scheduled(self, exit_code):
        calls = []
        times = iter(["2026-09-20T12:00:00+00:00", "2026-09-20T12:05:00+00:00"])

        def popen(command, **kwargs):
            calls.append((command, kwargs))
            kwargs["stdout"].write(b"private child output\n")
            return FakeProcess(exit_code)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = scheduled.run_command(["python", "worker.py"], root, popen=popen, now=lambda: next(times))
            state = json.loads((root / "last-run.json").read_text(encoding="utf-8"))
            log = Path(state["log"])
            self.assertEqual(log.read_bytes(), b"private child output\n")
            return result, state, calls

    def test_success_records_private_log_and_preserves_child_exit_code(self):
        result, state, calls = self.run_scheduled(0)

        self.assertEqual(result, 0)
        self.assertEqual(state["phase"], "finished")
        self.assertEqual(state["outcome"], "success")
        self.assertEqual(state["exit_code"], 0)
        self.assertEqual(state["process_id"], 1234)
        self.assertEqual(calls[0][0], ["python", "worker.py"])
        self.assertEqual(calls[0][1]["cwd"], scheduled.REPO)
        self.assertFalse(calls[0][1]["shell"])

    def test_failure_and_lock_contention_remain_distinct(self):
        for exit_code, outcome in [(1, "failure"), (2, "lock-busy")]:
            with self.subTest(exit_code=exit_code):
                result, state, _ = self.run_scheduled(exit_code)
                self.assertEqual(result, exit_code)
                self.assertEqual(state["outcome"], outcome)

    def test_running_status_failure_does_not_detach_child(self):
        process = FakeProcess(0)
        saves = 0

        def fail_running_state(path, value):
            nonlocal saves
            saves += 1
            if saves == 2:
                raise OSError("synthetic status failure")
            scheduled.save_state(path, value)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = scheduled.run_command(
                ["python", "worker.py"],
                root,
                popen=lambda command, **kwargs: process,
                now=lambda: "2026-09-20T12:00:00+00:00",
                save=fail_running_state,
            )
            state = json.loads((root / "last-run.json").read_text(encoding="utf-8"))

        self.assertEqual(result, 0)
        self.assertTrue(process.waited)
        self.assertEqual(state["phase"], "finished")
        self.assertEqual(state["status_error_type"], "OSError")
        self.assertEqual(state["status_error"], "synthetic status failure")

    def test_launcher_failure_states_its_cause_and_keeps_the_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            root = repo / ".local" / "receipt-ocr-scheduler"
            try:
                raise FileNotFoundError(2, "No such file or directory", "/synthetic/python3.13")
            except FileNotFoundError as error:
                scheduled.record_launcher_failure(error, root)
            state = json.loads((root / "last-run.json").read_text(encoding="utf-8"))
            self.assertEqual(state["phase"], "launcher-failed")
            self.assertEqual(state["error_type"], "FileNotFoundError")
            self.assertEqual(state["error"], "[Errno 2] No such file or directory: '/synthetic/python3.13'")
            self.assertEqual(Path(state["diagnostic_file"]).parent, root / "diagnostics")
            evidence = json.loads(Path(state["diagnostic_file"]).read_text(encoding="utf-8"))
            self.assertIn("test_launcher_failure_states_its_cause", evidence["traceback"])


if __name__ == "__main__":
    unittest.main()
