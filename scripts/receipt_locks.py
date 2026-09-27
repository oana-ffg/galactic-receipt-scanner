"""Non-blocking OS locks shared by receipt workers and their batch coordinator."""
import errno
import os


PARALLEL_LANES = tuple(f"parallel-{number}" for number in range(1, 10))
PROCESSING_LANES = ("primary", *PARALLEL_LANES)


def worker_batch_directory(repo, lane):
    if lane not in PROCESSING_LANES:
        raise ValueError("Unknown processing lane.")
    suffix = "" if lane == "primary" else "-" + lane
    return repo / ".local" / ("receipt-worker" + suffix)


def is_worker_batch_directory(repo, base):
    return any(base == worker_batch_directory(repo, lane) for lane in PROCESSING_LANES)


class LockBusy(Exception):
    """Another process holds this lock."""


def acquire_lock(path, *, create=True):
    # Opening errors are access failures, not evidence of a live owner.
    handle = path.open("a+b" if create else "r+b")
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        handle.close()
        if error.errno in {errno.EACCES, errno.EAGAIN}:
            raise LockBusy() from None
        raise
    return handle


def lock_held(path):
    """Probe an existing lock without creating it; propagate access failures."""
    try:
        handle = acquire_lock(path, create=False)
    except FileNotFoundError:
        return False
    except LockBusy:
        return True
    handle.close()
    return False
