import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import receipt_batch as module


class BatchGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / '.local' / 'receipt-worker'
        self.base.parent.mkdir()

    def guard(self):
        guard = module.BatchGuard(self.base, 'synthetic-task')
        self.addCleanup(guard.close)
        return guard

    def worker_state(self, **state):
        run = 'a' * 32
        (self.base / run).mkdir(exist_ok=True)
        (self.base / run / 'state.json').write_text(json.dumps(state))
        (self.base / 'active-run.json').write_text(json.dumps(dict(run_id=run)))

    def test_second_coordinator_is_busy_until_first_finishes(self):
        first = self.guard()
        state = first.start()
        with self.assertRaises(module.BatchBusy):
            self.guard()
        self.worker_state(phase='empty', claim=None, batch_id=state['batch_id'], claim_started=state['started_at'] + 1)
        first.handle(dict(op='finish'))
        first.close()
        self.assertEqual(self.guard().start()['phase'], 'active')

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
             patch.object(module.sys, 'argv', ['receipt_batch.py', '--owner', 'synthetic-task']), \
             patch.object(module.sys, 'stdin', io.StringIO('')), \
             patch.object(module.sys, 'stdout', io.StringIO()):
            module.main()
        state = json.loads((self.base / 'batch-state.json').read_text())
        self.assertEqual(state['phase'], 'blocked')

    def test_scheduled_owner_cannot_resolve_before_opening_guard(self):
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
            '--resolve', 'a' * 32, '--reason', 'Automatic retry',
        ]), patch.object(module, 'BatchGuard') as guard:
            with self.assertRaisesRegex(module.InputError, 'Scheduled processing cannot resolve'):
                module.main()
            guard.assert_not_called()

    def test_repeated_guard_arguments_are_rejected_before_opening_guard(self):
        for extra in [
            ['--owner', 'manual-recovery'],
            ['--resolve', 'b' * 32],
            ['--reason', 'Changed reason'],
        ]:
            with self.subTest(extra=extra), patch.object(module.sys, 'argv', [
                'receipt_batch.py', '--owner', 'receipt-processing-scheduled',
                '--resolve', 'a' * 32, '--reason', 'Automatic retry', *extra,
            ]), patch.object(module, 'BatchGuard') as guard, \
                 patch.object(module.sys, 'stderr', io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    module.main()
                self.assertEqual(error.exception.code, 2)
                guard.assert_not_called()

    def test_verification_never_opens_a_second_batch_guard(self):
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled', '--verify', 'a' * 32,
        ]), patch.object(module, 'BatchGuard') as guard, \
             patch.object(module, 'verify_run', return_value=dict(verified=True)) as verify, \
             patch.object(module.sys, 'stdout', io.StringIO()):
            module.main()
            verify.assert_called_once()
            guard.assert_not_called()

    def test_empty_verify_argument_cannot_start_a_batch(self):
        with patch.object(module.sys, 'argv', [
            'receipt_batch.py', '--owner', 'receipt-processing-scheduled', '--verify', '',
        ]), patch.object(module, 'BatchGuard') as guard:
            with self.assertRaises(module.InputError):
                module.main()
            guard.assert_not_called()

    def test_lock_open_failure_is_not_busy(self):
        with patch.object(Path, 'open', side_effect=PermissionError('Synthetic denied directory')):
            with self.assertRaises(PermissionError):
                self.guard()

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
