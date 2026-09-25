"""Run nightly receipt OCR under an OS scheduler with private local diagnostics."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys

from receipt_api import artifact_directory, diagnostic_text, failure_report, write_new_file


REPO = Path(__file__).resolve().parent.parent
STATE_ROOT = REPO / ".local" / "receipt-ocr-scheduler"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def save_state(path, value):
    """Atomically replace the scheduler status without exposing partial JSON."""
    candidate = path.parent / (path.name + "." + os.urandom(6).hex() + ".tmp")
    write_new_file(candidate, json.dumps(value, separators=(",", ":")).encode())
    try:
        os.replace(candidate, path)
    finally:
        candidate.unlink(missing_ok=True)


def run_command(command, root=STATE_ROOT, *, popen=subprocess.Popen, now=utc_now,
                save=save_state):
    """Run one foreground child and persist bounded scheduler facts outside source."""
    artifact_directory(root)
    started = now()
    log = root / ("run-" + started.replace(":", "-") + "-" + os.urandom(4).hex() + ".log")
    state_path = root / "last-run.json"
    state = {
        "schemaVersion": 1,
        "phase": "starting",
        "started_at": started,
        "log": str(log),
    }
    save(state_path, state)
    with log.open("xb") as output:
        process = popen(
            command,
            cwd=REPO,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            shell=False,
        )
        state.update(phase="running", process_id=process.pid)
        status_error = None
        try:
            save(state_path, state)
        except OSError as error:
            # Diagnostics must never detach a live OCR producer from its scheduler owner.
            status_error = error
        exit_code = process.wait()
    outcome = "success" if exit_code == 0 else "lock-busy" if exit_code == 2 else "failure"
    state.update(phase="finished", outcome=outcome, exit_code=exit_code, finished_at=now())
    if status_error:
        state["status_error_type"] = type(status_error).__name__
        state["status_error"] = diagnostic_text(str(status_error))
    save(state_path, state)
    return exit_code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--inventory-only",
        action="store_true",
        help="Validate scheduled access without acquiring the OCR lock or writing OCR.",
    )
    args = parser.parse_args()
    command = [
        sys.executable,
        "-X",
        "utf8",
        "-B",
        str(REPO / "scripts" / "receipt_ocr_nightly.py"),
    ]
    if args.inventory_only:
        command.append("--inventory-only")
    return run_command(command)


def record_launcher_failure(error, root=STATE_ROOT):
    """Leave the scheduler's status file stating why the launcher itself failed."""
    artifact_directory(root)
    save_state(root / "last-run.json", {
        "schemaVersion": 1,
        "phase": "launcher-failed",
        **failure_report(error, root / "diagnostics", "launcher"),
        "finished_at": utc_now(),
    })


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        record_launcher_failure(error)
        sys.exit(70)
