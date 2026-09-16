"""Non-blocking OS locks shared by receipt workers and their batch coordinator."""
import errno
import os


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
