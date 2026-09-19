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

    def start(self, count=10, workflow="luna"):
        require(type(count) is int and 1 <= count <= 1000, "Batch count must be between 1 and 1000.")
        require(workflow in {"luna", "astra"}, "Unknown batch workflow.")
        require(not self.state or self.state["phase"] == "complete",
                "Previous batch did not finish cleanly. Preserve its state for owner-directed recovery.")
        self.check_worker_closed()
        return self.save(dict(batch_id=uuid.uuid4().hex, owner=self.owner, phase="active", started_at=time.time(),
                              requested_count=count, workflow=workflow, verified_runs={}, completed_count=0))

    def handle(self, request):
        require(isinstance(request, dict), "Expected a batch request object.")
        op = request.get("op")
        if op == "status":
            return self.state
        require(self.state and self.state["phase"] == "active", "No active batch to finish.")
        if op == "verify":
            require(self.state.get("workflow", "luna") == "luna", "Astra uses its independent verification protocol.")
            self.check_worker_closed()
            proof = verify_run(self.base.parent.parent, request.get("run_id"), self.owner)
            runs = dict(self.state.get("verified_runs", {}))
            previously_verified = {p["document_id"] for rid, p in runs.items() if rid != proof["run_id"]}
            affected = set(proof.get("affected_document_ids", [proof["document_id"]]))
            require(not (previously_verified & affected),
                    "Do not count the same document twice or affect a document already verified in one batch.")
            runs[proof["run_id"]] = proof
            state = self.save({**self.state, "verified_runs": runs, "completed_count": len(runs)})
            return {**state, "verification": proof, "next": "finish" if len(runs) >= state["requested_count"] else "dispatch"}
        if op == "finish":
            self.check_worker_closed()
            if self.state.get("workflow") == "astra":
                # Astra's API-based workers have a separate, independently checked
                # completion protocol; they do not produce bounded Luna journals.
                return self.save({**self.state, "phase": "complete", "stop_reason": "external-astra-verification"})
            pointer = self.base / "active-run.json"
            worker = None
            if pointer.exists():
                run = json.loads(pointer.read_text(encoding="utf-8"))["run_id"]
                worker = json.loads((self.base / run / "state.json").read_text(encoding="utf-8"))
            runs = self.state.get("verified_runs", {})
            # Only an actual claim response from this batch establishes exhaustion.
            exhausted = bool(worker and worker.get("batch_id") == self.state["batch_id"]
                             and worker["phase"] == "empty" and worker.get("claim") is None
                             and worker.get("claim_started", 0) >= self.state["started_at"])
            if worker and worker.get("batch_id") == self.state["batch_id"] and worker["phase"] == "complete":
                require(worker["run_id"] in runs, "Verify the last completed worker through this guard before finishing.")
            require(len(runs) >= self.state.get("requested_count", 10) or exhausted,
                    "Batch target not reached. Dispatch the next worker; only a recorded empty/busy claim can finish early.")
            return self.save({**self.state, "phase": "complete", "stop_reason": "queue-empty-or-busy" if exhausted else "target-reached"})
        require(op == "block", "Expected status, verify, finish, or block.")
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
    parser.add_argument("--count", type=int, action=Once)
    parser.add_argument("--workflow", choices=("luna", "astra"), action=Once)
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
            result = guard.start(args.count if args.count is not None else 10, args.workflow or "luna")
        except InputError as error:
            print(json.dumps(dict(blocking=True, error=str(error), previous=guard.state)), flush=True)
            return
        print(json.dumps(dict(acquired=True, **result)), flush=True)
        for line in sys.stdin:
            try:
                result = guard.handle(json.loads(line))
                print(json.dumps(dict(ok=True, **{k: v for k, v in result.items() if k != "verified_runs"})), flush=True)
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
