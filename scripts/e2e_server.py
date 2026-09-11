"""Serve the real scanner against disposable synthetic-only data for browser tests."""

import tempfile
from pathlib import Path

import uvicorn

from server.app import create_app
from server.config import Settings

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="receipt-scanner-e2e-", dir=root / ".local") as folder:
        app = create_app(Settings(root, "synthetic-browser-test-key", Path(folder)))
        uvicorn.run(app, host="127.0.0.1", port=8766, access_log=False)
