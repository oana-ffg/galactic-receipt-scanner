import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import receipt_batch as module


class FakeLease:
    def __init__(self):
        self.batch_id = None
        self.events = []
        self.profile = {}
        self.profile_path = Path("synthetic-profile.json")
        self.client = Mock()

    def start(self, batch_id, owner):
        self.batch_id = batch_id
        self.events.append(("start", batch_id, owner))

    def require_healthy(self):
        self.events.append(("healthy", self.batch_id))

    def finish(self, require_healthy=True):
        self.events.append(("finish", self.batch_id, require_healthy))
        self.batch_id = None

    def close(self):
        self.events.append(("close", self.batch_id))


class BatchGuardTests(unittest.TestCase):
    def test_correctable_worker_result_keeps_controller_acknowledgement(self):
        response = module.controller_response({
            "ok": False,
            "correction_required": True,
            "errors": ["Synthetic validation error."],
            "next": "correct-luna-result",
            "verified_runs": {"private": "proof"},
        })
        self.assertEqual(response, {
            "ok": True,
            "correction_required": True,
            "errors": ["Synthetic validation error."],
            "next": "correct-luna-result",
        })
        self.assertTrue(json.loads(json.dumps(response))["ok"])

    def test_completed_request_can_emit_a_luna_validation_correction(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.state = {"run_id": "a" * 32, "phase": "claimed"}
        worker.mutex = threading.RLock()
        worker.complete_luna_task.return_value = {
            "ok": False, "correction_required": True,
            "errors": ["Synthetic validation error."],
        }
        guard.worker = worker
        response = json.loads(json.dumps(module.controller_response(
            guard.handle({"op": "complete", "run_id": "a" * 32}))))
        self.assertTrue(response["ok"])
        self.assertEqual(response["next"], "correct-luna-result")
        self.assertEqual(response["errors"], ["Synthetic validation error."])
        self.assertIs(guard.worker, worker)

    def test_resume_reopens_only_exact_active_run_without_claiming(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        state = guard.start(1)
        run_id = 'a' * 32
        self.worker_state(phase='claimed', run_id=run_id, batch_id=state['batch_id'])
        guard.save({**guard.state, 'active_run_id': run_id, 'active_task_path': '/private/task.json'})
        lease.finish(False)  # The former controller has exited.
        worker = Mock()
        worker.confirmation_provider = 'ppocr'
        worker.state = {'run_id': run_id, 'batch_id': state['batch_id'], 'phase': 'claimed'}
        worker.stop_heartbeat = threading.Event()
        worker.heartbeat.side_effect = lambda: worker.stop_heartbeat.wait()
        worker.lock = Mock()
        with patch.object(module, 'Worker', return_value=worker) as worker_class:
            result = guard.resume(state['batch_id'], run_id)
            self.assertEqual(result['next'], 'complete-active-run')
            self.assertTrue(result['resumed'])
            worker_class.assert_called_once_with(lease.profile, resume=run_id, profile_path=lease.profile_path)
            with self.assertRaisesRegex(module.InputError, 'Complete the prepared Luna task'):
                guard.handle({'op': 'next'})
        worker.prepare_luna_task.assert_not_called()

    def test_resume_rejects_wrong_run_and_failed_checkpoint_before_lease(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        state = guard.start(1)
        run_id = 'a' * 32
        self.worker_state(phase='claimed', run_id=run_id, batch_id=state['batch_id'])
        guard.save({**guard.state, 'active_run_id': run_id})
        lease.events.clear()
        with self.assertRaises(module.InputError):
            guard.resume(state['batch_id'], 'b' * 32)
        self.worker_state(phase='submit-uncertain', run_id=run_id,
                          batch_id=state['batch_id'], failed={'operation': 'submit'})
        with self.assertRaisesRegex(module.InputError, 'not safely resumable'):
            guard.resume(state['batch_id'], run_id)
        self.assertEqual(lease.events, [])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / '.local' / 'receipt-worker'
        self.base.parent.mkdir()
        self.client_config = Path(self.tmp.name) / 'client.json'
        self.client_config.write_text('{}')

    def guard(self):
        guard = module.BatchGuard(self.base, 'synthetic-task')
        self.addCleanup(guard.close)
        return guard

    def worker_state(self, **state):
        run = 'a' * 32
        (self.base / run).mkdir(exist_ok=True)
        (self.base / run / 'state.json').write_text(json.dumps(state))
        (self.base / 'active-run.json').write_text(json.dumps(dict(run_id=run)))

    def test_batch_lease_uses_only_the_explicit_fresh_config(self):
        repo = Path(self.tmp.name)
        runtime = repo / '.local' / 'runtime'
        runtime.mkdir(parents=True)
        profile = runtime / 'profile.json'
        profile.write_text(json.dumps({
            'repository': str(repo),
            'origin': 'https://synthetic.example',
            'client_config': '/stale/config-that-must-not-be-used.json',
        }))
        (repo / '.local' / 'processing-host.json').write_text(json.dumps({
            'worker_profile': str(profile),
        }))
        client = Mock(origin='https://synthetic.example')
        with patch.object(module, 'credentials', return_value={'fresh': True}) as load, \
             patch.object(module, 'ScannerClient', return_value=client):
            lease = module.ProcessingBatchLease(repo, str(self.client_config))
        self.assertTrue(load.call_args.args[0].samefile(self.client_config))
        self.assertTrue(Path(lease.profile['client_config']).samefile(self.client_config))

    def test_second_coordinator_is_busy_until_first_finishes(self):
        first = self.guard()
        state = first.start()
        with self.assertRaises(module.BatchBusy):
            self.guard()
        self.worker_state(phase='empty', claim=None, batch_id=state['batch_id'], claim_started=state['started_at'] + 1)
        first.handle(dict(op='finish'))
        first.close()
        self.assertEqual(self.guard().start()['phase'], 'active')

    def test_live_batch_lease_spans_verification_and_releases_after_finish(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        state = guard.start(1)
        proof = dict(verified=True, run_id='a' * 32, document_id='receipt')
        with patch.object(module, 'verify_run', return_value=proof):
            guard.handle(dict(op='verify', run_id='a' * 32))
            guard.handle(dict(op='finish'))
        self.assertEqual(lease.events[0], ('start', state['batch_id'], 'synthetic-task'))
        self.assertIn(('healthy', state['batch_id']), lease.events)
        self.assertEqual(lease.events[-1], ('finish', state['batch_id'], False))
        self.assertIsNone(lease.batch_id)

    def test_lost_lease_can_still_record_and_release_a_blocked_batch(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        state = guard.start(1)

        def lost():
            raise module.InputError('Synthetic lease expired.')

        lease.require_healthy = lost
        result = guard.handle(dict(op='block', reason='Stop after the lease expired.'))
        self.assertEqual(result['phase'], 'blocked')
        self.assertEqual(result['lease_error'], 'Synthetic lease expired.')
        self.assertIn(('finish', state['batch_id'], False), lease.events)

    def test_controller_prepares_and_completes_one_luna_task_without_terra_mechanics(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "claimed"}
        worker.client.get.return_value = []
        worker.prepare_luna_task.return_value = {
            "ok": True,
            "run_id": "a" * 32,
            "task_path": "/private/task.json",
            "result_path": "/private/result.json",
            "pages": 1,
        }
        worker.mutex = threading.RLock()
        worker.stop_heartbeat = threading.Event()
        worker.heartbeat.side_effect = lambda: worker.stop_heartbeat.wait()
        worker.lock = Mock()

        def complete():
            worker.state["phase"] = "complete"
            return {"ok": True}

        worker.complete_luna_task.side_effect = complete
        proof = {"verified": True, "run_id": "a" * 32, "document_id": "receipt"}
        with patch.object(module, "Worker", return_value=worker), \
             patch.object(module, "verify_run", return_value=proof):
            prepared = guard.handle({"op": "next"})
            self.assertEqual(prepared["next"], "spawn-luna")
            self.assertEqual(prepared["task"]["run_id"], "a" * 32)
            completed = guard.handle({"op": "complete", "run_id": "a" * 32})
        worker.preflight.assert_called_once_with()
        worker.prepare_luna_task.assert_called_once_with([])
        worker.complete_luna_task.assert_called_once_with()
        worker.lock.close.assert_called_once_with()
        self.assertEqual(completed["phase"], "complete")
        self.assertEqual(completed["completed_count"], 1)
        self.assertEqual(completed["stop_reason"], "target-reached")

    def test_controller_closes_an_unclaimed_worker_after_preflight_failure(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "ready"}
        worker.preflight.side_effect = module.InputError("Synthetic preflight failure.")
        worker.stop_heartbeat = threading.Event()
        worker.lock = Mock()
        with patch.object(module, "Worker", return_value=worker), \
             self.assertRaisesRegex(module.InputError, "preflight"):
            guard.handle({"op": "next"})
        worker.lock.close.assert_called_once_with()
        self.assertIsNone(guard.worker)

    def test_controller_releases_a_healthy_claim_after_late_preparation_failure(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "ready"}
        worker.client.get.return_value = []
        worker.stop_heartbeat = threading.Event()
        worker.heartbeat.side_effect = lambda: worker.stop_heartbeat.wait()
        worker.lock = Mock()

        def fail_after_claim(_categories):
            worker.state["phase"] = "claimed"
            worker.state["failed"] = {"operation": "previews", "error": "Synthetic preview failure after claim."}
            raise module.InputError("Synthetic preview failure after claim.")

        worker.prepare_luna_task.side_effect = fail_after_claim
        with patch.object(module, "Worker", return_value=worker), \
             self.assertRaisesRegex(module.InputError, "preview"):
            guard.handle({"op": "next"})
        worker.release.assert_called_once_with()
        worker.lock.close.assert_called_once_with()
        self.assertIsNone(guard.worker)
        self.assertIsNone(guard.worker_thread)

    def test_controller_keeps_completed_worker_until_live_verification_succeeds(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "claimed"}
        worker.client.get.return_value = []
        worker.prepare_luna_task.return_value = {
            "ok": True, "run_id": "a" * 32, "task_path": "/private/task.json",
            "result_path": "/private/result.json", "pages": 1,
        }
        worker.mutex = threading.RLock()
        worker.stop_heartbeat = threading.Event()
        worker.heartbeat.side_effect = lambda: worker.stop_heartbeat.wait()
        worker.lock = Mock()

        def complete():
            worker.state["phase"] = "complete"
            return {"ok": True}

        worker.complete_luna_task.side_effect = complete
        proof = {"verified": True, "run_id": "a" * 32, "document_id": "receipt"}
        with patch.object(module, "Worker", return_value=worker), \
             patch.object(module, "verify_run", side_effect=[module.ClientError("Synthetic readback failure."), proof, proof]):
            guard.handle({"op": "next"})
            retry = guard.handle({"op": "complete", "run_id": "a" * 32})
            self.assertEqual(retry["next"], "retry-controller")
            self.assertEqual(retry["retry_request"], {"op": "complete", "run_id": "a" * 32})
            self.assertIs(guard.worker, worker)
            worker.lock.close.assert_not_called()
            result = guard.handle({"op": "complete", "run_id": "a" * 32})
        self.assertEqual(result["phase"], "complete")
        worker.lock.close.assert_called_once_with()

    def test_controller_contains_unexpected_completion_error_and_preserves_exact_claim(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "ready"}
        worker.client.get.return_value = []
        def prepare(_categories):
            worker.state["phase"] = "claimed"
            return {
                "ok": True, "run_id": "a" * 32, "task_path": "/private/task.json",
                "result_path": "/private/result.json", "pages": 1,
            }

        worker.prepare_luna_task.side_effect = prepare
        worker.mutex = threading.RLock()
        worker.stop_heartbeat = threading.Event()
        worker.heartbeat.side_effect = lambda: worker.stop_heartbeat.wait()
        worker.lock = Mock()
        worker.work = self.base / ("a" * 32)
        completion_calls = 0

        def complete():
            nonlocal completion_calls
            completion_calls += 1
            if completion_calls == 1:
                worker.state["phase"] = "drafted"
                raise TypeError("private implementation detail")
            worker.state["phase"] = "complete"
            return {"ok": True}

        worker.complete_luna_task.side_effect = complete
        worker.record.return_value = "0001-controller-completion-error.json"
        proof = {"verified": True, "run_id": "a" * 32, "document_id": "receipt"}
        with patch.object(module, "Worker", return_value=worker), \
             patch.object(module, "verify_run", return_value=proof):
            guard.handle({"op": "next"})
            result = guard.handle({"op": "complete", "run_id": "a" * 32})
            self.assertEqual(result["next"], "retry-controller")
            self.assertEqual(result["retry_request"], {"op": "complete", "run_id": "a" * 32})
            self.assertEqual(result["completion"]["error_type"], "TypeError")
            self.assertTrue(result["completion"]["blocking"])
            self.assertNotIn("private implementation detail", str(result))
            self.assertNotIn("failed", worker.state)
            self.assertFalse(worker.stop_heartbeat.is_set())
            self.assertTrue(guard.worker_thread.is_alive())
            self.assertIs(guard.worker, worker)
            worker.failure.assert_not_called()
            diagnostic = worker.record.call_args.args[1]
            self.assertEqual(diagnostic["error_type"], "TypeError")
            self.assertIn("private implementation detail", diagnostic["traceback"])

            completed = guard.handle(result["retry_request"])

        self.assertEqual(completed["phase"], "complete")
        self.assertEqual(completed["completed_count"], 1)
        self.assertNotIn("controller_failure", completed)
        worker.release.assert_not_called()
        worker.lock.close.assert_called_once_with()

    def test_guard_close_does_not_release_recoverable_worker_after_process_error(self):
        guard = self.guard()
        worker = Mock()
        worker.state = {"run_id": "a" * 32, "phase": "drafted"}
        worker.stop_heartbeat = threading.Event()
        worker.lock = Mock()
        guard.worker = worker

        guard.close()

        worker.release.assert_not_called()
        worker.lock.close.assert_called_once_with()

    def test_verified_completion_can_finish_after_transient_final_refresh_failure(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "claimed"}
        worker.client.get.return_value = []
        worker.prepare_luna_task.return_value = {
            "ok": True, "run_id": "a" * 32, "task_path": "/private/task.json",
            "result_path": "/private/result.json", "pages": 1,
        }
        worker.mutex = threading.RLock()
        worker.stop_heartbeat = threading.Event()
        worker.heartbeat.side_effect = lambda: worker.stop_heartbeat.wait()
        worker.lock = Mock()
        worker.complete_luna_task.side_effect = lambda: worker.state.update(phase="complete") or {"ok": True}
        proof = {"verified": True, "run_id": "a" * 32, "document_id": "receipt"}
        with patch.object(module, "Worker", return_value=worker), \
             patch.object(module, "verify_run", side_effect=[proof, module.ClientError("Synthetic final refresh failure."), proof]):
            guard.handle({"op": "next"})
            retry = guard.handle({"op": "complete", "run_id": "a" * 32})
            self.assertEqual(retry["next"], "retry-controller")
            self.assertEqual(retry["retry_request"], {"op": "finish"})
            self.assertIsNone(guard.worker)
            self.assertEqual(guard.state["completed_count"], 1)
            result = guard.handle({"op": "complete", "run_id": "a" * 32})
        self.assertEqual(result["phase"], "complete")
        self.assertEqual(result["stop_reason"], "target-reached")

    def test_terminal_lease_release_is_resumable_without_premature_completion(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(1)
        run_id = "a" * 32
        proof = {"verified": True, "run_id": run_id, "document_id": "receipt"}
        guard.save({**guard.state, "verified_runs": {run_id: proof}, "completed_count": 1})
        real_finish = lease.finish
        calls = 0

        def flaky_finish(require_healthy=True):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise module.ClientError("Synthetic lost release response.")
            return real_finish(require_healthy)

        lease.finish = flaky_finish
        with patch.object(module, "verify_run", return_value=proof):
            retry = guard.handle({"op": "complete", "run_id": run_id})
            self.assertEqual(retry["phase"], "finishing")
            self.assertEqual(retry["next"], "retry-controller")
            self.assertEqual(retry["retry_request"], {"op": "finish"})
            self.assertIsNotNone(lease.batch_id)
            completed = guard.handle(retry["retry_request"])
        self.assertEqual(completed["phase"], "complete")
        self.assertIsNone(lease.batch_id)

    def test_empty_queue_release_retry_uses_returned_finish_request(self):
        lease = FakeLease()
        guard = module.BatchGuard(self.base, 'synthetic-task', lease)
        self.addCleanup(guard.close)
        guard.start(10)
        worker = Mock()
        worker.confirmation_provider = "ppocr"
        worker.state = {"run_id": "a" * 32, "phase": "ready"}
        worker.client.get.return_value = []
        worker.mutex = threading.RLock()
        worker.stop_heartbeat = threading.Event()
        worker.lock = Mock()

        def empty(_categories):
            worker.state.update(phase="empty", claim=None)
            return {"ok": True}

        worker.prepare_luna_task.side_effect = empty
        real_finish = lease.finish
        calls = 0

        def flaky_finish(require_healthy=True):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise module.ClientError("Synthetic lost empty-batch release response.")
            return real_finish(require_healthy)

        lease.finish = flaky_finish
        with patch.object(module, "Worker", return_value=worker):
            retry = guard.handle({"op": "next"})
            self.assertEqual(retry["phase"], "finishing")
            self.assertEqual(retry["retry_request"], {"op": "finish"})
            completed = guard.handle(retry["retry_request"])
        self.assertEqual(completed["phase"], "complete")
        self.assertEqual(completed["stop_reason"], "queue-empty-or-busy")
        worker.lock.close.assert_called_once_with()

    def test_unclean_exit_requires_exact_owner_resolution(self):
        first = self.guard()
        state = first.start()
        first.close()
        next_guard = self.guard()
        with self.assertRaises(module.InputError):
            next_guard.start()
        with self.assertRaises(module.InputError):
            next_guard.resolve('wrong-batch', 'Investigated')
        self.worker_state(phase='claimed')
        with self.assertRaises(module.InputError):
            next_guard.resolve(state['batch_id'], 'Investigated')
        self.worker_state(phase='released', failed={'error': 'Synthetic failure'})
        with self.assertRaises(module.InputError):
            next_guard.resolve(state['batch_id'], 'Investigated')
        self.worker_state(phase='released')
        resolved = next_guard.resolve(state['batch_id'], 'Owner-directed recovery after failed worker was reconciled.')
        self.assertEqual(resolved['phase'], 'complete')
        self.assertEqual(len(list(self.base.glob('batch-event-*.json'))), 2)
        next_guard.start()

    def test_owner_can_recover_exact_finishing_batch_after_controller_restart(self):
        original_lease = FakeLease()
        first = module.BatchGuard(self.base, 'synthetic-task', original_lease)
        state = first.start(1)
        proof = {"verified": True, "run_id": "a" * 32, "document_id": "receipt"}
        first.save({**first.state, "phase": "finishing", "verified_runs": {proof["run_id"]: proof},
                    "completed_count": 1, "stop_reason": "target-reached"})
        first.close()

        recovery_lease = FakeLease()
        recovery = module.BatchGuard(self.base, 'owner-recovery', recovery_lease)
        self.addCleanup(recovery.close)
        resolved = recovery.resolve(
            state["batch_id"],
            "Recovered exact terminal lease after the original controller exited.",
        )
        self.assertEqual(resolved["phase"], "complete")
        self.assertEqual(resolved["verified_runs"], {proof["run_id"]: proof})
        self.assertIn(("finish", state["batch_id"], False), recovery_lease.events)
        self.assertEqual(recovery_lease.owner, "synthetic-task")

    def test_failure_and_unfinished_worker_cannot_be_reported_complete(self):
        guard = self.guard()
        guard.start()
        for state in [dict(phase='submit-uncertain'), dict(phase='released', failed={'error': 'Synthetic failure'})]:
            self.worker_state(**state)
            with self.assertRaises(module.InputError):
                guard.handle(dict(op='finish'))
        self.assertEqual(guard.handle(dict(op='block', reason='Synthetic worker failure'))['phase'], 'blocked')
        with self.assertRaises(module.InputError):
            guard.start()

    def test_input_eof_blocks_and_preserves_batch(self):
        with patch.object(module, '__file__', str(Path(self.tmp.name) / 'scripts' / 'receipt_batch.py')), \
             patch.object(module, 'ProcessingBatchLease', return_value=FakeLease()), \
             patch.object(module.sys, 'argv', ['receipt_batch.py', '--owner', 'synthetic-task',
                                                '--client-config', str(self.client_config)]), \
             patch.object(module.sys, 'stdin', io.StringIO('')), \
             patch.object(module.sys, 'stdout', io.StringIO()):
            module.main()
        state = json.loads((self.base / 'batch-state.json').read_text())
        self.assertEqual(state['phase'], 'blocked')

    def test_scheduled_owner_cannot_resolve_before_opening_guard(self):
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
            '--client-config', str(self.client_config),
            '--resolve', 'a' * 32, '--reason', 'Automatic retry',
        ]), patch.object(module, 'BatchGuard') as guard:
            with self.assertRaisesRegex(module.InputError, 'Scheduled processing cannot recover'):
                module.main()
            guard.assert_not_called()

    def test_scheduled_owner_cannot_resume_before_lease_setup(self):
        for recovery_args in [
            ['--resume-batch', 'a' * 32],
            ['--resume-run', 'b' * 32],
            ['--resume-batch', 'a' * 32, '--resume-run', 'b' * 32],
        ]:
            with self.subTest(recovery_args=recovery_args), patch.object(module.sys, 'argv', [
                'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
                '--client-config', str(self.client_config), *recovery_args,
            ]), patch.object(module, 'ProcessingBatchLease') as lease, \
                 patch.object(module, 'BatchGuard') as guard:
                with self.assertRaisesRegex(module.InputError, 'Scheduled processing cannot recover'):
                    module.main()
                lease.assert_not_called()
                guard.assert_not_called()

    def test_interactive_actor_can_resume_the_scheduled_owners_exact_run(self):
        guard = Mock()
        guard.resume.return_value = {'phase': 'active', 'batch_id': 'a' * 32,
                                     'active_run_id': 'b' * 32}
        guard.handle.return_value = {'phase': 'blocked'}
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
            '--client-config', str(self.client_config), '--resume-batch', 'a' * 32,
            '--resume-run', 'b' * 32, '--recovery-by', 'interactive-synthetic-task',
        ]), patch.object(module, 'ProcessingBatchLease', return_value=FakeLease()), \
             patch.object(module, 'BatchGuard', return_value=guard), \
             patch.object(module.sys, 'stdin', io.StringIO('{"op":"block","reason":"Synthetic stop"}\n')), \
             patch.object(module.sys, 'stdout', io.StringIO()):
            module.main()
        guard.resume.assert_called_once_with('a' * 32, 'b' * 32)

    def test_verify_rejects_recovery_flags_before_opening_guard(self):
        for recovery_args in [
            ['--resume-batch', 'a' * 32],
            ['--resume-run', 'b' * 32],
            ['--resume-batch', 'a' * 32, '--resume-run', 'b' * 32],
        ]:
            with self.subTest(recovery_args=recovery_args), patch.object(module.sys, 'argv', [
                'receipt_batch.py', '--owner', 'manual-recovery', '--verify', 'c' * 32,
                '--client-config', str(self.client_config), *recovery_args,
            ]), patch.object(module, 'ProcessingBatchLease', return_value=FakeLease()), \
                 patch.object(module, 'BatchGuard') as guard, \
                 patch.object(module, 'verify_run') as verify:
                with self.assertRaisesRegex(module.InputError, 'Verification cannot request recovery'):
                    module.main()
                guard.assert_not_called()
                verify.assert_not_called()

    def test_repeated_guard_arguments_are_rejected_before_opening_guard(self):
        for extra in [
            ['--owner', 'manual-recovery'],
            ['--resolve', 'b' * 32],
            ['--reason', 'Changed reason'],
        ]:
            with self.subTest(extra=extra), patch.object(module.sys, 'argv', [
                'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
                '--client-config', str(self.client_config),
                '--resolve', 'a' * 32, '--reason', 'Automatic retry', *extra,
            ]), patch.object(module, 'BatchGuard') as guard, \
                 patch.object(module.sys, 'stderr', io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    module.main()
                self.assertEqual(error.exception.code, 2)
                guard.assert_not_called()

    def test_verification_never_opens_a_second_batch_guard(self):
        lease = FakeLease()
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled', '--verify', 'a' * 32,
            '--client-config', str(self.client_config),
        ]), patch.object(module, 'ProcessingBatchLease', return_value=lease), \
             patch.object(module, 'BatchGuard') as guard, \
             patch.object(module, 'verify_run', return_value=dict(verified=True)) as verify, \
             patch.object(module.sys, 'stdout', io.StringIO()):
            module.main()
            self.assertIs(verify.call_args.kwargs['client'], lease.client)
            verify.assert_called_once()
            guard.assert_not_called()

    def test_empty_verify_argument_cannot_start_a_batch(self):
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled', '--verify', '',
            '--client-config', str(self.client_config),
        ]), patch.object(module, 'ProcessingBatchLease', return_value=FakeLease()), \
             patch.object(module, 'BatchGuard') as guard:
            with self.assertRaises(module.InputError):
                module.main()
            guard.assert_not_called()

    def test_lock_open_failure_is_not_busy(self):
        with patch.object(Path, 'open', side_effect=PermissionError('Synthetic denied directory')):
            with self.assertRaises(PermissionError):
                self.guard()

    def test_lease_client_setup_failure_reports_cause_before_opening_guard(self):
        stdout = io.StringIO()
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
            '--client-config', str(self.client_config),
        ]), patch.object(
            module,
            'ProcessingBatchLease',
            side_effect=module.ClientError('Scanner returned HTTP 403; access denied.'),
        ), patch.object(module, 'BatchGuard') as guard, patch.object(module.sys, 'stdout', stdout):
            with self.assertRaises(SystemExit) as error:
                module.main()
        self.assertEqual(error.exception.code, 1)
        guard.assert_not_called()
        self.assertEqual(json.loads(stdout.getvalue()), {
            'blocking': True,
            'batch_started': False,
            'stage': 'batch-lease-setup',
            'error': 'Scanner returned HTTP 403; access denied.',
            'error_type': 'ClientError',
        })

    def test_missing_lease_setup_file_does_not_leak_its_private_path(self):
        private_repo = Path(self.tmp.name) / 'SENTINEL-private-checkout'
        private_base = private_repo / '.local' / 'receipt-worker'
        private_base.mkdir(parents=True)
        previous = json.dumps({
            'batch_id': 'a' * 32,
            'owner': 'SENTINEL-prior-owner',
            'phase': 'complete',
            'completed_count': 1,
            'active_run_id': None,
        }).encode()
        state_path = private_base / 'batch-state.json'
        state_path.write_bytes(previous)
        event_path = private_base / ('batch-event-' + 'b' * 32 + '.json')
        event_path.write_bytes(previous)
        stdout = io.StringIO()
        with patch.object(module, '__file__', str(private_repo / 'scripts' / 'receipt_batch.py')), \
             patch.object(module.sys, 'argv', [
                 'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
                 '--client-config', str(self.client_config),
             ]), patch.object(module, 'BatchGuard') as guard, patch.object(module.sys, 'stdout', stdout):
            with self.assertRaises(SystemExit) as error:
                module.main()
        self.assertEqual(error.exception.code, 1)
        guard.assert_not_called()
        self.assertEqual(state_path.read_bytes(), previous)
        self.assertEqual(event_path.read_bytes(), previous)
        self.assertFalse(module.lock_held(private_base / 'batch.lock'))
        output = stdout.getvalue()
        self.assertNotIn('SENTINEL', output)
        self.assertEqual(json.loads(output), {
            'blocking': True,
            'batch_started': False,
            'stage': 'batch-lease-setup',
            'error': 'Batch lease setup failed before a new batch started.',
            'error_type': 'FileNotFoundError',
        })

    def test_invalid_lease_response_preserves_previous_completed_batch_without_leaking(self):
        self.base.mkdir()
        previous = json.dumps({
            'batch_id': 'a' * 32,
            'owner': 'prior-owner',
            'phase': 'complete',
            'completed_count': 1,
            'active_run_id': None,
        }).encode()
        state_path = self.base / 'batch-state.json'
        state_path.write_bytes(previous)
        lease = module.ProcessingBatchLease.__new__(module.ProcessingBatchLease)
        lease.client = Mock()
        lease.client.request.return_value = b'SENTINEL invalid private response'
        lease.batch_id = None
        lease.owner = None
        lease.expires = 0
        lease.error = None
        lease.stop = threading.Event()
        lease.thread = None
        stdout = io.StringIO()
        with patch.object(module, '__file__', str(Path(self.tmp.name) / 'scripts' / 'receipt_batch.py')), \
             patch.object(module, 'ProcessingBatchLease', return_value=lease), \
             patch.object(module.sys, 'argv', [
                 'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
                 '--client-config', str(self.client_config),
             ]), patch.object(module.sys, 'stdout', stdout):
            with self.assertRaises(SystemExit) as error:
                module.main()
        self.assertEqual(error.exception.code, 1)
        self.assertEqual(state_path.read_bytes(), previous)
        self.assertEqual(list(self.base.glob('batch-event-*.json')), [])
        self.assertFalse(module.lock_held(self.base / 'batch.lock'))
        output = stdout.getvalue()
        self.assertNotIn('SENTINEL', output)
        reported = json.loads(output)
        self.assertRegex(reported.pop('batch_id'), r'^[0-9a-f]{32}$')
        self.assertEqual(reported, {
            'blocking': True,
            'batch_started': False,
            'stage': 'batch-lease-acquire',
            'error': 'Batch lease acquisition failed before a new batch started.',
            'error_type': 'JSONDecodeError',
        })

    def test_live_worker_prevents_finish_and_resolution_even_with_ready_journal(self):
        guard = self.guard()
        state = guard.start()
        self.worker_state(phase='ready')
        with module.acquire_lock(self.base / 'worker.lock'):
            with self.assertRaisesRegex(module.InputError, 'still running'):
                guard.handle(dict(op='finish'))
            guard.handle(dict(op='block', reason='Synthetic preflight failure'))
            with self.assertRaisesRegex(module.InputError, 'still running'):
                guard.resolve(state['batch_id'], 'Synthetic inspection')
        self.assertEqual(guard.resolve(state['batch_id'], 'Worker has exited')['phase'], 'complete')

    def test_live_worker_prevents_start_even_without_previous_batch(self):
        guard = self.guard()
        with module.acquire_lock(self.base / 'worker.lock'):
            with self.assertRaisesRegex(module.InputError, 'still running'):
                guard.start()

    def test_finish_rejects_seven_of_ten_even_after_clean_worker_exit(self):
        guard = self.guard()
        state = guard.start()
        for index in range(7):
            run = f'{index:032x}'
            with patch.object(module, 'verify_run', return_value=dict(verified=True, run_id=run, document_id=f'doc-{index}')):
                result = guard.handle(dict(op='verify', run_id=run))
            self.assertEqual(result['next'], 'dispatch')
        with self.assertRaisesRegex(module.InputError, 'target not reached'):
            guard.handle(dict(op='finish'))
        self.assertEqual(guard.state['phase'], 'active')
        for index in range(7, 10):
            run = f'{index:032x}'
            with patch.object(module, 'verify_run', return_value=dict(verified=True, run_id=run, document_id=f'doc-{index}')):
                result = guard.handle(dict(op='verify', run_id=run))
        self.assertEqual(result['next'], 'finish')
        with patch.object(module, 'verify_run', side_effect=lambda repo, rid, owner, client: guard.state['verified_runs'][rid]):
            self.assertEqual(guard.handle(dict(op='finish'))['stop_reason'], 'target-reached')

    def test_verification_is_idempotent_and_different_run_cannot_double_count_document(self):
        guard = self.guard()
        guard.start(1)
        with patch.object(module, 'verify_run', return_value=dict(verified=True, run_id='a'*32, document_id='same-document')):
            guard.handle(dict(op='verify', run_id='a'*32))
            self.assertEqual(guard.handle(dict(op='verify', run_id='a'*32))['completed_count'], 1)
        with patch.object(module, 'verify_run', return_value=dict(verified=True, run_id='b'*32, document_id='same-document')):
            with self.assertRaisesRegex(module.InputError, 'same document twice'):
                guard.handle(dict(op='verify', run_id='b'*32))

    def test_verification_rejects_a_run_that_mutated_an_already_verified_donor(self):
        guard = self.guard()
        guard.start(2)
        first = dict(verified=True, batch_id=guard.state['batch_id'], run_id='a' * 32,
                     document_id='retained-document', affected_document_ids=['retained-document'])
        second = dict(verified=True, batch_id=guard.state['batch_id'], run_id='b' * 32,
                      document_id='new-target', affected_document_ids=['new-target', 'retained-document'])
        with patch.object(module, 'verify_run', return_value=first):
            guard.handle(dict(op='verify', run_id='a' * 32))
        with patch.object(module, 'verify_run', return_value=second):
            with self.assertRaisesRegex(module.InputError, 'verified whole-document replacement'):
                guard.handle(dict(op='verify', run_id='b' * 32))
        self.assertEqual(guard.state['completed_count'], 1)
        self.assertEqual(set(guard.state['verified_runs']), {'a' * 32})

    def test_later_merge_supersedes_multiple_completions_and_keeps_history(self):
        guard = self.guard()
        guard.start(3)
        for rid, did in [('a', 'receipt'), ('b', 'continuation'), ('c', 'unrelated')]:
            proof = dict(verified=True, run_id=rid * 32, document_id=did)
            with patch.object(module, 'verify_run', return_value=proof):
                guard.handle(dict(op='verify', run_id=rid * 32))
        merged = dict(verified=True, run_id='d' * 32, document_id='slip',
                      affected_document_ids=['slip', 'receipt', 'continuation'],
                      superseded_run_ids=['a' * 32, 'b' * 32])
        with patch.object(module, 'verify_run', return_value=merged):
            result = guard.handle(dict(op='verify', run_id='d' * 32))
        self.assertEqual(result['completed_count'], 2)
        self.assertEqual(result['next'], 'dispatch')
        self.assertEqual(set(guard.state['verified_runs']), {'c' * 32, 'd' * 32})
        self.assertEqual(guard.state['superseded_runs']['a' * 32]['proof']['document_id'], 'receipt')
        replay = dict(merged)
        with patch.object(module, 'verify_run', return_value=replay):
            self.assertEqual(guard.handle(dict(op='verify', run_id='d' * 32))['completed_count'], 2)
        with patch.object(module, 'verify_run', return_value=dict(verified=True, run_id='e' * 32, document_id='receipt')):
            with self.assertRaisesRegex(module.InputError, 'same document twice'):
                guard.handle(dict(op='verify', run_id='e' * 32))
        again = dict(verified=True, run_id='f' * 32, document_id='later-slip',
                     affected_document_ids=['later-slip', 'slip'], superseded_run_ids=['d' * 32])
        with patch.object(module, 'verify_run', return_value=again):
            self.assertEqual(guard.handle(dict(op='verify', run_id='f' * 32))['completed_count'], 2)
        self.assertEqual(set(guard.state['superseded_runs']), {'a' * 32, 'b' * 32, 'd' * 32})

    def test_finish_rechecks_current_completions_and_refuses_drift(self):
        guard = self.guard()
        guard.start(1)
        proof = dict(verified=True, run_id='a' * 32, document_id='receipt')
        with patch.object(module, 'verify_run', return_value=proof):
            guard.handle(dict(op='verify', run_id='a' * 32))
        with patch.object(module, 'verify_run', side_effect=module.InputError('Saved document revision differs')):
            with self.assertRaisesRegex(module.InputError, 'revision differs'):
                guard.handle(dict(op='finish'))
        self.assertEqual(guard.state['phase'], 'active')

    def test_previous_empty_or_released_claim_is_not_exhaustion(self):
        guard = self.guard()
        state = guard.start()
        for fields in [dict(phase='released', batch_id=state['batch_id']),
                       dict(phase='empty', batch_id='old-batch'),
                       dict(phase='empty', batch_id=state['batch_id'], claim_started=0)]:
            self.worker_state(claim=None, **fields)
            with self.assertRaisesRegex(module.InputError, 'target not reached'):
                guard.handle(dict(op='finish'))

    def test_current_queue_exhaustion_finishes_early_with_reason(self):
        guard = self.guard()
        state = guard.start()
        self.worker_state(phase='empty', claim=None, batch_id=state['batch_id'], claim_started=state['started_at'] + 1)
        self.assertEqual(guard.handle(dict(op='finish'))['stop_reason'], 'queue-empty-or-busy')

    def test_astra_retains_its_separate_verification_workflow(self):
        guard = self.guard()
        guard.start(workflow='astra')
        self.assertEqual(guard.handle(dict(op='finish'))['stop_reason'], 'external-astra-verification')


if __name__ == '__main__':
    unittest.main()
