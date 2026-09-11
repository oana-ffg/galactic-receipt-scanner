"""Foreground server entrypoint. Provisioning serves only a PUBLIC CA certificate."""

import argparse
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import uvicorn

ROOT = Path(__file__).resolve().parent.parent

SETUP = b"""<!doctype html><html lang=en><meta charset=utf-8>
<meta name=viewport content='width=device-width, initial-scale=1'>
<title>Receipt Scanner - local HTTPS</title>
<style>body{font:18px/1.6 system-ui;
max-width:640px;margin:50px auto;padding:0 24px;color:#16232d}
a{color:#075a9c}li{margin:18px 0}</style>
<h1>Connect this phone</h1>
<p>The camera needs HTTPS. This uses the computer's local development certificate authority.
Install it only on your own device for this local scanning station.</p>
<ol><li><a href=/ca.pem>Download the local development CA certificate</a>
and allow the profile download.</li>
<li>Open <b>Settings &gt; General &gt; VPN &amp; Device Management</b>
(or <b>Profile Downloaded</b>) and install the downloaded certificate.</li>
<li>Open <b>Settings &gt; General &gt; About &gt; Certificate Trust Settings</b>
and enable full trust for that local development CA.</li>
<li>Scan the pairing QR code on the Mac again, then tap <b>Enable camera</b>.</li></ol>
<p>This installs a trust certificate, not an app. The signing private key stays on the computer;
this page serves only the public certificate. You can remove the profile later.</p></html>"""


class Provisioning(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            content, mime = SETUP, "text/html; charset=utf-8"
        elif self.path == "/ca.pem":
            content = (ROOT / ".local" / "rootCA.pem").read_bytes()
            mime = "application/x-x509-ca-cert"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, _format, *args):
        pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    provisioning = ThreadingHTTPServer(("0.0.0.0", 8764), Provisioning)
    thread = threading.Thread(target=provisioning.serve_forever, daemon=True)
    thread.start()
    try:
        uvicorn.run(
            "server.app:app",
            app_dir=str(ROOT),
            host="0.0.0.0",
            port=args.port,
            ssl_certfile=str(ROOT / ".local" / "server.pem"),
            ssl_keyfile=str(ROOT / ".local" / "server-key.pem"),
            ws_max_size=500_000,
            ws_max_queue=2,
            access_log=False,
        )
    finally:
        provisioning.shutdown()
