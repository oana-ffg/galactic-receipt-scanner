#!/usr/bin/env python3
"""Hold one local receipt batch across its sequential managed model workers."""
import argparse
import json
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from receipt_api import ClientError
from receipt_locks import LockBusy as BatchBusy, acquire_lock, lock_held
from receipt_batch_verify import verify_run
from receipt_worker import InputError, Once, artifact_directory, replace_journal_file, require, write_new_file


class BatchGuard:
    def __init__(self, base, owner):
        require(isinstance(owner, str) and 0 < len(owner.strip()) <= 200, "A task owner identifier is required.")
        require(not base.parent.is_symlink() and not base.parent.is_junction()
                and not base.is_symlink() and not base.is_junction(), "Batch directory must not redirect.")
        artifact_directory(base)
        self.base = base
        self.lock = acquire_lock(base / "batch.lock")
        self.path = base / "batch-state.json"
        self.state = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else None
        self.owner = owner

    def save(self, state):
        try:
            transition = acquire_lock(self.base / "batch-transition.lock")
        except BatchBusy:
            raise InputError("A claim is in flight; await its response, then retry the batch transition in this same session.") from None
        with transition:
            return self.save_transition(state)

    def save_transition(self, state):
        # Keep every prior state transition; the pointer is only the current summary.
        state = {**state, "updated_at": time.time()}
        data = json.dumps(state).encode()
        write_new_file(self.base / ("batch-event-" + uuid.uuid4().hex + ".json"), data)
        temporary = self.base / ("batch-state-" + uuid.uuid4().hex + ".json")
        write_new_file(temporary, data)
        replace_journal_file(temporary, self.path)
        self.state = state
        return state

    def start(self):
        require(not self.state or self.state["phase"] == "complete",
                "Previous batch did not finish cleanly. Preserve its state for owner-directed recovery.")
        self.check_worker_closed()
        return self.save(dict(batch_id=uuid.uuid4().hex, owner=self.owner, phase="active", started_at=time.time()))

    def handle(self, request):
        require(isinstance(request, dict), "Expected a batch request object.")
        op = request.get("op")
        if op == "status":
            return self.state
        require(self.state and self.state["phase"] == "active", "No active batch to finish.")
        if op == "finish":
            self.check_worker_closed()
            return self.save({**self.state, "phase": "complete"})
        require(op == "block", "Expected status, finish, or block.")
        reason = request.get("reason")
        require(isinstance(reason, str) and 0 < len(reason.strip()) <= 2000, "A non-sensitive failure reason is required.")
        return self.save({**self.state, "phase": "blocked", "reason": reason})

    def check_worker_closed(self):
        require(not lock_held(self.base / "worker.lock"),
                "Worker process is still running; await its exit before completing or replacing the batch.")
        worker_pointer = self.base / "active-run.json"
        if worker_pointer.exists():
            run_id = json.loads(worker_pointer.read_text(encoding="utf-8"))["run_id"]
            require(isinstance(run_id, str) and len(run_id) == 32 and all(c in "0123456789abcdef" for c in run_id), "Invalid worker pointer.")
            worker = json.loads((self.base / run_id / "state.json").read_text(encoding="utf-8"))
            require(not worker.get("failed") and worker["phase"] in {"complete", "empty", "released", "ready"},
                    "Worker is failed or unfinished; reconcile it before completing this batch.")

    def resolve(self, batch_id, reason):
        require(self.state and self.state["batch_id"] == batch_id and self.state["phase"] in {"active", "blocked"},
                "Owner-directed recovery must name the exact unfinished batch.")
        require(isinstance(reason, str) and 0 < len(reason.strip()) <= 2000, "Recovery needs an explicit resolution reason.")
        self.check_worker_closed()
        return self.save({**self.state, "phase": "complete", "resolved_by": self.owner, "resolution": reason})

    def close(self):
        self.lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, action=Once)
    parser.add_argument("--resolve", action=Once)
    parser.add_argument("--reason", action=Once)
    parser.add_argument("--verify", action=Once)
    args = parser.parse_args()
    # The scheduled owner's standing approval covers processing, never recovery.
    require(not args.resolve or args.owner != "receipt-processing-scheduled",
            "Scheduled processing cannot resolve an unfinished batch; use owner-directed recovery.")
    repo = Path(__file__).resolve().parent.parent
    if args.verify is not None:
        require(args.resolve is None and args.reason is None, "Verification cannot request recovery.")
        print(json.dumps(verify_run(repo, args.verify, args.owner)), flush=True)
        return
    base = repo / ".local" / "receipt-worker"
    try:
        guard = BatchGuard(base, args.owner)
    except BatchBusy:
        print(json.dumps(dict(busy=True)), flush=True)
        return
    try:
        if args.resolve:
            print(json.dumps(dict(resolved=True, **guard.resolve(args.resolve, args.reason))), flush=True)
            return
        require(args.reason is None, "--reason requires --resolve.")
        try:
            result = guard.start()
        except InputError as error:
            print(json.dumps(dict(blocking=True, error=str(error), previous=guard.state)), flush=True)
            return
        print(json.dumps(dict(acquired=True, **result)), flush=True)
        for line in sys.stdin:
            try:
                result = guard.handle(json.loads(line))
                print(json.dumps(dict(ok=True, **result)), flush=True)
                if result["phase"] != "active":
                    return
            except (InputError, ValueError) as error:
                print(json.dumps(dict(input_error=str(error))), flush=True)
        guard.handle(dict(op="block", reason="Coordinator input closed before confirmed batch completion."))
    finally:
        guard.close()


if __name__ == "__main__":
    try:
        main()
    except (InputError, ClientError, OSError, KeyError, TypeError, ValueError) as error:
        print(json.dumps(dict(blocking=True, error="Batch guard failed; preserve its state for inspection.", error_type=type(error).__name__)), flush=True)
        sys.exit(1)
