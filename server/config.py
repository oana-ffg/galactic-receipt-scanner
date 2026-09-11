import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    root: Path
    token: str
    data_dir: Path | None = None

    @property
    def data(self) -> Path:
        return self.data_dir or self.root / "captures"

    @property
    def model(self) -> Path:
        return self.root / ".local" / "hand_landmarker.task"


def load_settings(root: Path | None = None) -> Settings:
    root = root or Path(__file__).resolve().parent.parent
    local = root / ".local"
    local.mkdir(parents=True, exist_ok=True)
    path = local / "settings.json"
    if not path.exists():
        # O_EXCL prevents two startup processes from replacing one another's pairing key.
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as stream:
                json.dump({"token": secrets.token_urlsafe(32)}, stream)
                stream.flush()
                os.fsync(stream.fileno())
    data_dir = os.environ.get("RECEIPT_SCANNER_DATA_DIR")
    return Settings(
        root=root,
        token=json.loads(path.read_text())["token"],
        data_dir=Path(data_dir).resolve() if data_dir else None,
    )
