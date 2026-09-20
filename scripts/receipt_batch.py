#!/usr/bin/env python3
"""Hold one local receipt batch across its sequential managed model workers."""
import argparse
import json
from pathlib import Path
import sys
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
from receipt_api import ClientError, ScannerClient, credentials
from receipt_locks import LockBusy as BatchBusy, acquire_lock, lock_held
from receipt_batch_verify import regular_path, verify_run
from receipt_worker import InputError, Once, Worker, artifact_directory, replace_journal_file, require, write_new_file


class ProcessingBatchLease:
    """Keep retroactive Jev merges out of a live Luna verification batch."""

    def __init__(self, repo):
        host_path = regular_path(regular_path(repo / ".local") / "processing-host.json")
        host = json.loads(host_path.read_text(encoding="utf-8"))
        profile_path = regular_path(Path(host["worker_profile"]))
        require(profile_path.is_absolute() and profile_path.is_file(), "Prepared worker profile is unavailable.")
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        require(Path(profile["repository"]).resolve() == repo.resolve(), "Prepared profile belongs to another checkout.")
        self.client = ScannerClient(credentials(profile["client_config"]))
        require(self.client.origin == profile["origin"], "Batch lease destination differs from the prepared profile.")
        self.profile = profile
        self.profile_path = profile_path
        self.batch_id = None
        self.owner = None
        self.expires = 0
        self.error = None
        self.stop = threading.Event()
        self.thread = None

    def request(self, op):
        body = json.dumps(dict(op=op, batch_id=self.batch_id, owner=self.owner)).encode("utf-8")
        value = json.loads(self.client.request("/api/processing/batch-lease", body))
        if op == "release":
            require(type(value.get("released")) is bool, "Receipt batch lease release was not acknowledged.")
            # False means this exact lease is already absent (for example after a
            # lost successful response). Never delete a different owner's lease.
            return
        lease = value.get("lease")
        if op == "acquire" and lease is None and value.get("reason") == "busy":
            raise BatchBusy("Jev currently owns a short pipeline step.")
        require(isinstance(lease, dict) and lease.get("batch_id") == self.batch_id
                and type(lease.get("expires")) is int, "Receipt batch lease is busy or unavailable.")
        self.expires = lease["expires"]
        self.error = None

    def start(self, batch_id, owner):
        self.batch_id, self.owner = batch_id, owner
        self.request("acquire")
        self.thread = threading.Thread(target=self.keepalive, name="receipt-batch-lease", daemon=True)
        self.thread.start()

    def keepalive(self):
        while not self.stop.wait(60):
            try:
                self.request("renew")
            except (ClientError, InputError, OSError, KeyError, TypeError, ValueError) as error:
                self.error = error

    def require_healthy(self):
        require(self.batch_id is not None and self.expires > int(time.time() * 1000) + 60_000,
                "Receipt batch lease expired; stop before dispatching more work.")
        if self.error is not None and self.expires <= int(time.time() * 1000) + 120_000:
            raise InputError("Receipt batch lease renewal failed; stop before dispatching more work.")

    def finish(self, require_healthy=True):
        if self.batch_id is None:
            return
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=5)
        if require_healthy:
            self.require_healthy()
        self.request("release")
        self.batch_id = None

    def close(self):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=5)


class BatchGuard:
    def __init__(self, base, owner, lease=None):
        require(isinstance(owner, str) and 0 < len(owner.strip()) <= 200, "A task owner identifier is required.")
        require(not base.parent.is_symlink() and not base.parent.is_junction()
                and not base.is_symlink() and not base.is_junction(), "Batch directory must not redirect.")
        artifact_directory(base)
        self.base = base
        self.lock = acquire_lock(base / "batch.lock")
        self.path = base / "batch-state.json"
        self.state = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else None
        self.owner = owner
        self.lease = lease
        self.worker = None
        self.worker_thread = None
        self.preflight_complete = False
        self.categories = None

    def lease_healthy(self):
        if self.lease is not None:
            self.lease.require_healthy()

    def finish_lease(self, require_healthy=True):
        if self.lease is not None:
            self.lease.finish(require_healthy)

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
        batch_id = uuid.uuid4().hex
        if self.lease is not None:
            self.lease.start(batch_id, self.owner)
        try:
            return self.save(dict(batch_id=batch_id, owner=self.owner, phase="active", started_at=time.time(),
                                  requested_count=count, workflow=workflow, verified_runs={}, completed_count=0))
        except Exception:
            self.finish_lease()
            raise

    def handle(self, request):
        require(isinstance(request, dict), "Expected a batch request object.")
        op = request.get("op")
        if op == "status":
            self.lease_healthy()
            return self.state
        require(self.state and self.state["phase"] in {"active", "finishing"}, "No active batch to finish.")
        if self.state["phase"] == "finishing":
            require(op in {"complete", "finish"}, "Retry the terminal controller operation while batch release finishes.")
            try:
                return self.finish_pending_batch()
            except ClientError:
                return self.verification_retry({"op": "finish"})
        if op == "block":
            reason = request.get("reason")
            require(isinstance(reason, str) and 0 < len(reason.strip()) <= 2000, "A non-sensitive failure reason is required.")
            lease_error = None
            try:
                self.lease_healthy()
            except InputError as error:
                lease_error = str(error)
            result = self.save({**self.state, "phase": "blocked", "reason": reason,
                                **({"lease_error": lease_error} if lease_error else {})})
            self.close_worker(release=True)
            self.finish_lease(False)
            return result
        self.lease_healthy()
        if op == "next":
            require(self.state.get("workflow", "luna") == "luna", "Prepared tasks are only available for Luna batches.")
            if self.state.get("completed_count", 0) >= self.state.get("requested_count", 10):
                return self.try_finish_batch("target-reached")
            require(self.worker is None, "Complete the prepared Luna task before requesting another document.")
            self.check_worker_closed()
            worker = Worker(self.lease.profile, profile_path=self.lease.profile_path)
            self.worker = worker
            try:
                require(worker.confirmation_provider == "ppocr",
                        "Normal Luna processing requires the saved-PP consumer profile; OCR inference belongs to the nightly worker.")
                if not self.preflight_complete:
                    worker.preflight()
                    self.preflight_complete = True
                if self.categories is None:
                    self.categories = worker.client.get("/api/processing/categories")
                prepared = worker.prepare_luna_task(self.categories)
                if worker.state["phase"] == "empty" and not worker.state.get("failed"):
                    self.close_worker()
                    return self.try_finish_batch("queue-empty-or-busy", task=None)
                require(prepared.get("ok") is True and worker.state["phase"] == "claimed",
                        "Deterministic task preparation failed; preserve the worker journal for recovery.")
                self.start_worker_heartbeat()
                self.save({**self.state, "active_run_id": worker.state["run_id"],
                           "active_task_path": prepared["task_path"]})
                return {**self.state, "task": prepared, "next": "spawn-luna"}
            except Exception:
                # No Luna has received this task yet, so a confirmed unsubmitted
                # claim is safe to release. Never retain a half-prepared worker that
                # has no controller operation capable of completing it.
                self.close_worker(release=True)
                raise
        if op == "complete":
            require(self.state.get("workflow", "luna") == "luna", "Prepared completion is only available for Luna batches.")
            run_id = request.get("run_id")
            if self.worker is None:
                require(run_id in self.state.get("verified_runs", {}),
                        "Complete the exact active or already verified Luna task.")
                if self.state["completed_count"] >= self.state["requested_count"]:
                    return self.try_finish_batch(
                        "target-reached", verification=self.state["verified_runs"][run_id])
                return {**self.state, "verification": self.state["verified_runs"][run_id], "next": "dispatch"}
            require(run_id == self.worker.state["run_id"], "Complete the exact active Luna task.")
            with self.worker.mutex:
                result = self.worker.complete_luna_task()
            if result.get("correction_required"):
                return {**self.state, **result, "next": "correct-luna-result"}
            if result.get("ok") is not True or self.worker.state["phase"] != "complete":
                return {**self.state, "completion": {
                    "ok": result.get("ok") is True,
                    "blocking": result.get("blocking") is True,
                    "phase": self.worker.state["phase"],
                    "error": result.get("error", "Deterministic completion did not finish."),
                }, "next": "retry-controller", "retry_request": {"op": "complete", "run_id": run_id}}
            try:
                proof = verify_run(self.base.parent.parent, run_id, self.owner)
            except (ClientError, OSError):
                return self.verification_retry({"op": "complete", "run_id": run_id})
            state = self.record_verification(proof)
            self.close_worker()
            if state["completed_count"] >= state["requested_count"]:
                return self.try_finish_batch("target-reached", verification=proof)
            return {**state, "verification": proof, "next": "dispatch"}
        if op == "verify":
            require(self.state.get("workflow", "luna") == "luna", "Astra uses its independent verification protocol.")
            self.check_worker_closed()
            proof = verify_run(self.base.parent.parent, request.get("run_id"), self.owner)
            state = self.record_verification(proof)
            return {**state, "verification": proof,
                    "next": "finish" if state["completed_count"] >= state["requested_count"] else "dispatch"}
        if op == "finish":
            self.check_worker_closed()
            if self.state.get("workflow") == "astra":
                # Astra's API-based workers have a separate, independently checked
                # completion protocol; they do not produce bounded Luna journals.
                return self.try_finish_batch("external-astra-verification")
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
            return self.try_finish_batch("queue-empty-or-busy" if exhausted else "target-reached")
        raise InputError("Expected status, next, complete, verify, finish, or block.")

    def record_verification(self, proof):
        runs = dict(self.state.get("verified_runs", {}))
        history = dict(self.state.get("superseded_runs", {}))
        prior_targets = [item["document_id"] for rid, item in runs.items() if rid != proof["run_id"]]
        prior_targets.extend(item["proof"]["document_id"] for item in history.values())
        require(proof["document_id"] not in prior_targets, "Do not count the same document twice in one batch.")
        affected = set(proof.get("affected_document_ids", [proof["document_id"]]))
        overlaps = {rid for rid, previous in runs.items() if rid != proof["run_id"]
                    and previous["document_id"] in affected}
        superseded = set(proof.get("superseded_run_ids", []))
        archived = {rid for rid, item in history.items() if item["replaced_by"] == proof["run_id"]}
        require(superseded == overlaps | archived,
                "Every affected previous completion must have a verified whole-document replacement.")
        for rid in overlaps:
            history[rid] = dict(proof=runs.pop(rid), replaced_by=proof["run_id"], superseded_at=time.time())
        runs[proof["run_id"]] = proof
        return self.save({**self.state, "verified_runs": runs, "superseded_runs": history,
                          "completed_count": len(runs), "active_run_id": None,
                          "active_task_path": None})

    def finish_batch(self, reason, **values):
        self.check_worker_closed()
        runs = self.state.get("verified_runs", {})
        refreshed = {rid: verify_run(self.base.parent.parent, rid, self.owner) for rid in runs}
        self.save({**self.state, "verified_runs": refreshed, "phase": "finishing",
                   "stop_reason": reason, **values})
        return self.finish_pending_batch()

    def try_finish_batch(self, reason, **values):
        try:
            return self.finish_batch(reason, **values)
        except ClientError:
            return self.verification_retry({"op": "finish"})

    def finish_pending_batch(self):
        require(self.state.get("phase") == "finishing", "No terminal batch release is pending.")
        # The proofs were checkpointed while the lease was healthy. A delayed
        # release replay may find that exact lease already absent or expired.
        self.finish_lease(False)
        return self.save({**self.state, "phase": "complete"})

    def verification_retry(self, retry_request):
        require(isinstance(retry_request, dict) and retry_request.get("op") in {"complete", "finish"},
                "Controller retry needs an exact content-free request.")
        return {**self.state, "completion": {
            "ok": False,
            "blocking": False,
            "phase": "verification",
            "error": "Live verification is temporarily unavailable; retry the same controller operation.",
        }, "next": "retry-controller", "retry_request": retry_request}

    def close_worker(self, release=False):
        worker = self.worker
        if worker is None:
            return
        worker.stop_heartbeat.set()
        if self.worker_thread is not None:
            self.worker_thread.join(timeout=95)
        if release and worker.state["phase"] in {"claimed", "drafted"}:
            try:
                worker.release()
            except (ClientError, InputError, OSError, KeyError, TypeError, ValueError):
                worker.failure("release", "Unsubmitted controller-owned claim could not be released; preserve it until expiry.")
        worker.lock.close()
        self.worker = None
        self.worker_thread = None

    def start_worker_heartbeat(self):
        require(self.worker is not None, "No controller-owned worker is available for renewal.")
        if self.worker_thread is None:
            self.worker_thread = threading.Thread(
                target=self.worker.heartbeat,
                name="receipt-document-lease",
                daemon=True,
            )
            self.worker_thread.start()

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
        require(self.state and self.state["batch_id"] == batch_id
                and self.state["phase"] in {"active", "blocked", "finishing"},
                "Owner-directed recovery must name the exact unfinished batch.")
        require(isinstance(reason, str) and 0 < len(reason.strip()) <= 2000, "Recovery needs an explicit resolution reason.")
        self.check_worker_closed()
        if self.state["phase"] == "finishing":
            require(self.lease is not None, "Terminal batch recovery requires the configured backend lease client.")
            self.lease.batch_id = self.state["batch_id"]
            self.lease.owner = self.state["owner"]
            self.finish_lease(False)
        result = self.save({**self.state, "phase": "complete", "resolved_by": self.owner, "resolution": reason})
        if self.lease is not None and self.lease.batch_id is not None:
            self.finish_lease()
        return result

    def close(self):
        self.close_worker(release=True)
        if self.lease is not None:
            self.lease.close()
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
        guard = BatchGuard(base, args.owner, ProcessingBatchLease(repo))
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
        except BatchBusy:
            print(json.dumps(dict(busy=True)), flush=True)
            return
        except InputError as error:
            print(json.dumps(dict(blocking=True, error=str(error), previous=guard.state)), flush=True)
            return
        print(json.dumps(dict(acquired=True, **result)), flush=True)
        for line in sys.stdin:
            try:
                result = guard.handle(json.loads(line))
                print(json.dumps(dict(ok=True, **{k: v for k, v in result.items() if k != "verified_runs"})), flush=True)
                if result["phase"] not in {"active", "finishing"}:
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
