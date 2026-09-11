"""Install pinned dependencies and local model assets; never touch receipt data."""

import hashlib
import json
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = {
    "hand_landmarker.task": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "tessdata/dan.traineddata": "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/dan.traineddata",
    "tessdata/eng.traineddata": "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata",
}


def main():
    os.chdir(ROOT)
    for executable in ("uv", "npm", "mkcert"):
        if not shutil.which(executable):
            raise SystemExit(f"Install {executable} first; see README.md.")
    subprocess.run(["uv", "sync"], check=True)
    subprocess.run(
        ["npm", "ci" if (ROOT / "package-lock.json").exists() else "install"], check=True
    )
    subprocess.run(["npm", "run", "build"], check=True)
    local = ROOT / ".local"
    local.mkdir(exist_ok=True)
    manifest = {}
    expected_path = ROOT / "model-assets.json"
    expected = json.loads(expected_path.read_text()) if expected_path.exists() else {}
    for filename, url in ASSETS.items():
        path = local / filename
        path.parent.mkdir(exist_ok=True)
        if not path.exists():
            print(f"Downloading {filename}", flush=True)
            with urllib.request.urlopen(url, timeout=60) as response:
                content = response.read(32 * 1024 * 1024)
            digest = hashlib.sha256(content).hexdigest()
            if filename in expected and digest != expected[filename]["sha256"]:
                raise SystemExit(f"Checksum mismatch for {filename}; refusing the download.")
            temporary = path.with_suffix(".download")
            temporary.write_bytes(content)
            temporary.replace(path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if filename in expected and digest != expected[filename]["sha256"]:
            raise SystemExit(f"Checksum mismatch for {filename}; inspect the local asset.")
        manifest[filename] = {"url": url, "sha256": digest}
    (local / "asset-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Setup complete. Run: python3 scripts/manage.py start")


if __name__ == "__main__":
    main()
