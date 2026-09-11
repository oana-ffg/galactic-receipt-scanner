"""Start/stop only this project's local server; retain capture and pairing state."""

import argparse
import json
import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
PID_FILE = LOCAL / "server.pid"


def running_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    pid = int(PID_FILE.read_text())
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True
    )
    return pid if str(ROOT / "scripts" / "serve.py") in result.stdout else None


def local_ip() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        connection.connect(("8.8.8.8", 80))
        return connection.getsockname()[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["start", "stop", "status"])
    args = parser.parse_args()
    LOCAL.mkdir(exist_ok=True)
    pid = running_pid()
    if args.action == "stop":
        if pid:
            os.kill(pid, signal.SIGTERM)
            for _ in range(100):
                if not running_pid():
                    break
                time.sleep(0.1)
            else:
                raise SystemExit("Server is still shutting down; try status in a moment.")
            print("Stopped this project's receipt scanner.")
        else:
            print("Receipt scanner is not running.")
        return
    if args.action == "status":
        print(f"Running (PID {pid})" if pid else "Not running")
        return
    if pid:
        print(f"Already running (PID {pid}). Launch details: {LOCAL / 'launch.json'}")
        return
    if not (ROOT / "dist" / "index.html").is_file():
        raise SystemExit("Run python3 scripts/setup.py first.")
    ip = local_ip()
    hostname = socket.gethostname()
    if "." not in hostname:
        hostname += ".local"
    ca_root = Path(subprocess.check_output(["mkcert", "-CAROOT"], text=True).strip())
    subprocess.run(
        [
            "mkcert",
            "-cert-file",
            str(LOCAL / "server.pem"),
            "-key-file",
            str(LOCAL / "server-key.pem"),
            "localhost",
            "127.0.0.1",
            hostname,
            ip,
        ],
        check=True,
    )
    shutil.copyfile(ca_root / "rootCA.pem", LOCAL / "rootCA.pem")
    os.chmod(LOCAL / "server-key.pem", 0o600)
    executable = ROOT / ".venv" / "bin" / "python"
    with (LOCAL / "server.log").open("ab") as log:
        process = subprocess.Popen(
            [str(executable), str(ROOT / "scripts" / "serve.py")],
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    PID_FILE.write_text(str(process.pid))
    context = ssl.create_default_context(cafile=str(LOCAL / "rootCA.pem"))
    for _ in range(45):
        if process.poll() is not None:
            raise SystemExit(f"Server exited. See {LOCAL / 'server.log'}")
        try:
            with urllib.request.urlopen(
                f"https://{ip}:8765/health", context=context, timeout=1
            ) as response:
                health = json.load(response)
            if not health["detectorReady"]:
                raise SystemExit(
                    f"Server started but hand detector is unavailable. See {LOCAL / 'server.log'}"
                )
            break
        except (OSError, urllib.error.URLError):
            time.sleep(0.5)
    else:
        raise SystemExit(f"Server did not become ready. See {LOCAL / 'server.log'}")
    token = json.loads((LOCAL / "settings.json").read_text())["token"]
    details = {
        "dashboard": f"https://{ip}:8765/#key={token}",
        "camera": f"https://{ip}:8765/camera#key={token}",
        "phoneSetup": f"http://{ip}:8764",
        "pid": process.pid,
    }
    (LOCAL / "launch.json").write_text(json.dumps(details, indent=2) + "\n")
    os.chmod(LOCAL / "launch.json", 0o600)
    print(f"Ready. Launch details (private pairing key): {LOCAL / 'launch.json'}")
    print(f"Phone certificate setup: http://{ip}:8764")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
