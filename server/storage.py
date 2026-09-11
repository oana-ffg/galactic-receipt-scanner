import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path


def atomic_write(path: Path, data: bytes, *, replace: bool = False) -> None:
    """Flush bytes, install the complete file atomically, then flush its directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".writing-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def __init__(self, root: Path):
        self.root = root
        for folder in ("raw", "processed", "pdfs", "ocr"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        self.db_path = root / "index.sqlite3"
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS captures (
                id TEXT PRIMARY KEY, created_at TEXT NOT NULL, sha256 TEXT NOT NULL,
                raw_path TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL,
                ocr_status TEXT NOT NULL DEFAULT 'pending', ocr_error TEXT
            )""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA synchronous=FULL")
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, capture_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone()
        return self.unpack(row) if row else None

    @staticmethod
    def unpack(row) -> dict:
        item = dict(row)
        item["metadata"] = json.loads(item["metadata"])
        return item

    def recent(self) -> list[dict]:
        with self.connect() as db:
            return [
                self.unpack(row)
                for row in db.execute("SELECT * FROM captures ORDER BY created_at DESC LIMIT 100")
            ]

    def count(self) -> int:
        with self.connect() as db:
            return db.execute("SELECT COUNT(*) FROM captures WHERE status='accepted'").fetchone()[0]

    def save_raw(self, capture_id: str, data: bytes, extension: str, metadata: dict) -> dict:
        digest = hashlib.sha256(data).hexdigest()
        previous = self.get(capture_id)
        if previous:
            if previous["sha256"] != digest:
                raise ValueError(
                    "Capture ID already exists with different bytes. Original preserved."
                )
            raw = self.root / previous["raw_path"]
            if not raw.is_file() or hashlib.sha256(raw.read_bytes()).hexdigest() != digest:
                raise OSError(
                    "Stored original is missing or its checksum differs. Capture not acknowledged."
                )
            return previous
        relative = f"raw/{capture_id}.{extension}"
        raw = self.root / relative
        try:
            atomic_write(raw, data)
        except FileExistsError:
            if hashlib.sha256(raw.read_bytes()).hexdigest() != digest:
                raise ValueError("An original already exists with conflicting bytes.") from None
        created = datetime.now(UTC).isoformat()
        with self.connect() as db:
            db.execute(
                "INSERT INTO captures(id,created_at,sha256,raw_path,status,metadata) "
                "VALUES(?,?,?,?,?,?)",
                (capture_id, created, digest, relative, "checking", json.dumps(metadata)),
            )
        return self.get(capture_id)

    def finish(self, capture_id: str, status: str, metadata: dict) -> dict:
        with self.connect() as db:
            db.execute(
                "UPDATE captures SET status=?,metadata=? WHERE id=?",
                (status, json.dumps(metadata), capture_id),
            )
        return self.get(capture_id)

    def ocr_update(self, capture_id: str, status: str, error: str | None = None) -> None:
        with self.connect() as db:
            db.execute(
                "UPDATE captures SET ocr_status=?,ocr_error=? WHERE id=?",
                (status, error, capture_id),
            )

    def pending_ocr(self) -> list[str]:
        with self.connect() as db:
            return [
                row[0]
                for row in db.execute(
                    "SELECT id FROM captures WHERE status='accepted' "
                    "AND ocr_status IN ('pending','running')"
                )
            ]

    def file(self, capture_id: str, kind: str) -> Path:
        record = self.get(capture_id)
        if not record:
            raise FileNotFoundError(capture_id)
        if kind == "raw":
            return self.root / record["raw_path"]
        folders = {"image": ("processed", "jpg"), "pdf": ("pdfs", "pdf"), "text": ("ocr", "txt")}
        if kind not in folders:
            raise FileNotFoundError(kind)
        folder, extension = folders[kind]
        return self.root / folder / f"{capture_id}.{extension}"
