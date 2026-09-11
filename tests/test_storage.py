import hashlib
from uuid import uuid4

import pytest

from server.processing import process_capture
from server.storage import Store, atomic_write
from server.vision import Detector
from tests.conftest import NoHands


def test_idempotent_capture_and_traceable_pdf(tmp_path, receipt_bytes):
    store = Store(tmp_path / "captures")
    detector = Detector(tmp_path, hands=NoHands())
    key = str(uuid4())
    result = process_capture(store, detector, key, receipt_bytes, {"captureMethod": "test"})
    assert result["status"] == "accepted"
    assert store.file(key, "raw").read_bytes() == receipt_bytes
    assert result["sha256"] == hashlib.sha256(receipt_bytes).hexdigest()
    assert store.file(key, "pdf").read_bytes().startswith(b"%PDF")
    assert process_capture(store, detector, key, receipt_bytes, {})["status"] == "accepted"
    assert store.count() == 1
    with pytest.raises(ValueError, match="different bytes"):
        store.save_raw(key, receipt_bytes + b"changed", "jpg", {})
    assert store.file(key, "raw").read_bytes() == receipt_bytes


def test_disk_failure_cannot_create_accepted_record(tmp_path, receipt_bytes, monkeypatch):
    store = Store(tmp_path / "captures")

    def fail(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("server.storage.atomic_write", fail)
    with pytest.raises(OSError):
        store.save_raw(str(uuid4()), receipt_bytes, "jpg", {})
    assert store.count() == 0 and store.recent() == []


def test_atomic_write_does_not_overwrite_original(tmp_path):
    file = tmp_path / "source.jpg"
    atomic_write(file, b"original")
    with pytest.raises(FileExistsError):
        atomic_write(file, b"replacement")
    assert file.read_bytes() == b"original"
    assert not list(tmp_path.glob(".writing-*"))


def test_missing_original_is_not_acknowledged(tmp_path):
    store = Store(tmp_path / "captures")
    key = str(uuid4())
    store.save_raw(key, b"original", "jpg", {})
    store.file(key, "raw").unlink()
    with pytest.raises(OSError, match="missing"):
        store.save_raw(key, b"original", "jpg", {})
