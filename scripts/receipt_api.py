#!/usr/bin/env python3
"""Private scanner API client. No model calls; credentials never enter command arguments."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
LIMIT = 32 * 1024 * 1024


class ClientError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError("Redirect refused; check the Site address and credentials.")


def write_new_file(target, body):
    """Publish verified bytes atomically without replacing any existing file."""
    fd, temporary = tempfile.mkstemp(prefix=".download-", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
        os.link(temporary, target)
    finally:
        os.unlink(temporary)


def credentials(config_path, from_stdin=False):
    if from_stdin:
        value = json.loads(sys.stdin.read(16384))
    else:
        config = json.loads(Path(config_path).read_text())
        entry = config.get("gopass_entry")
        if not isinstance(entry, str) or not entry or entry.startswith("-"):
            raise ClientError("Configure a gopass_entry in the private client config.")
        result = subprocess.run(["gopass", "show", entry], capture_output=True, text=True, check=False)
        if result.returncode:
            raise ClientError("Cannot unlock scanner credentials in gopass.")
        value = json.loads(result.stdout)
        if value.get("origin") != config.get("origin"):
            raise ClientError("Credential origin differs from configured Site.")
    return value


class ScannerClient:
    def __init__(self, value):
        self.origin = value.get("origin", "")
        url = urlsplit(self.origin)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.path or url.query or url.fragment):
            raise ClientError("Credentials require an exact HTTPS origin without a trailing slash.")
        self.sites_token = value.get("sites_token", "")
        self.processing_token = value.get("processing_token", "")
        if (not isinstance(self.sites_token, str) or not self.sites_token
                or any(c.isspace() for c in self.sites_token)
                or not re.fullmatch(r"rsc_[A-Za-z0-9_-]{43}", self.processing_token)):
            raise ClientError("Invalid scanner credential format.")
        self.opener = build_opener(NoRedirect())

    def request(self, path, data=None, content_type="application/json"):
        if (not path.startswith("/api/") or urlsplit(path).netloc or "#" in path
                or "\\" in path or any(c in path for c in "\r\n")):
            raise ClientError("Expected a relative scanner API path.")
        headers = {
            "OAI-Sites-Authorization": "Bearer " + self.sites_token,
            "Authorization": "Bearer " + self.processing_token,
            "Cache-Control": "no-store",
            "Content-Type": content_type,
        }
        req = Request(self.origin + path, data=data, headers=headers)
        try:
            with self.opener.open(req, timeout=90) as response:
                body = response.read(LIMIT + 1)
                if len(body) > LIMIT:
                    raise ClientError("Response exceeds the client size limit.")
                return body
        except HTTPError as exc:
            # Do not echo proxy HTML, URLs, request headers, or financial payloads.
            raise ClientError(f"Scanner returned HTTP {exc.code}; 401/403 means access denied, 409 requires rereading the current revision.") from None
        except (URLError, TimeoutError):
            raise ClientError("Scanner connection failed; check connectivity and retry.") from None

    def get(self, path):
        try:
            return json.loads(self.request(path))
        except (ValueError, UnicodeError):
            raise ClientError("Expected scanner JSON; verify authentication and endpoint.") from None

    def file(self, path, sha, destination):
        if not SHA.fullmatch(sha):
            raise ClientError("An expected artifact SHA-256 is required.")
        target = Path(destination)
        if target.is_symlink():
            raise ClientError("Artifact destination must not be a symlink.")
        cached = target.exists()
        body = target.read_bytes() if cached else self.request(path)
        if hashlib.sha256(body).hexdigest() != sha:
            raise ClientError("Artifact hash verification failed; existing files were preserved.")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not cached:
            write_new_file(target, body)
        return {"path": str(target.absolute()), "sha256": sha, "bytes": len(body), "cached": cached}

    def original(self, capture_id, directory):
        if not UUID.fullmatch(capture_id):
            raise ClientError("Invalid capture ID.")
        meta = self.get("/api/captures/" + capture_id)
        sha = meta.get("sha256", "")
        size = meta.get("bytes")
        if (meta.get("id") != capture_id or not SHA.fullmatch(sha)
                or not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= LIMIT):
            raise ClientError("Invalid source metadata.")
        suffix = {"image/jpeg": ".jpg", "image/png": ".png"}.get(meta.get("content_type"))
        if not suffix:
            raise ClientError("Unsupported original image type.")
        directory = Path(directory)
        if directory.is_symlink():
            raise ClientError("Image cache must not be a symlink.")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        target = directory / (capture_id + "-" + sha + suffix)
        if target.is_symlink():
            raise ClientError("Cached original must not be a symlink.")
        cached = target.exists()
        body = target.read_bytes() if cached else self.request(f"/api/files/{capture_id}/raw?version={sha}")
        if len(body) != size or hashlib.sha256(body).hexdigest() != sha:
            raise ClientError("Original hash/size verification failed; existing files were preserved.")
        if not cached:
            write_new_file(target, body)
        return {"capture_id": capture_id, "path": str(target.absolute()), "sha256": sha,
                "bytes": size, "scanned_at": meta.get("created_at"), "cached": cached}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".local/processing-access.json")
    parser.add_argument("--credentials-stdin", action="store_true", help="Read credentials from a secure provider pipe, never a command argument")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    get = commands.add_parser("get", help="Read a relative processing API path")
    get.add_argument("path")
    listing = commands.add_parser("captures", help="One current-take page; follow next using --before")
    listing.add_argument("--before")
    listing.add_argument("--limit", type=int, default=100, choices=range(1, 101))
    original = commands.add_parser("original", help="Download and verify an immutable original")
    original.add_argument("capture_id")
    original.add_argument("--directory", default=".local/receipt-api/originals")
    artifact = commands.add_parser("file", help="Download a pinned PDF/artifact and verify its expected SHA-256")
    artifact.add_argument("path")
    artifact.add_argument("sha256")
    artifact.add_argument("destination")
    save = commands.add_parser("save-documents", help="Save a JSON file containing {documents:[...]} with current revisions")
    save.add_argument("file")
    ocr = commands.add_parser("save-extraction", help="Save an immutable extraction JSON artifact")
    ocr.add_argument("capture_id")
    ocr.add_argument("file")
    pdf = commands.add_parser("save-pdf", help="Upload a PDF for an exact document revision")
    pdf.add_argument("document_id")
    pdf.add_argument("revision", type=int)
    pdf.add_argument("file")
    args = parser.parse_args()
    client = ScannerClient(credentials(args.config, args.credentials_stdin))
    if args.command == "status":
        result = client.get("/api/processing/access")
    elif args.command == "get":
        result = client.get(args.path)
    elif args.command == "captures":
        query = {"limit": args.limit, "current": 1}
        if args.before:
            query["before"] = args.before
        result = client.get("/api/captures?" + urlencode(query))
    elif args.command == "original":
        result = client.original(args.capture_id, args.directory)
    elif args.command == "file":
        result = client.file(args.path, args.sha256, args.destination)
    else:
        data = Path(args.file).read_bytes()
        if len(data) > LIMIT:
            raise ClientError("Upload exceeds the client size limit.")
        content_type = "application/json"
        if args.command == "save-documents":
            path = "/api/documents"
            if len(data) > 24000:
                raise ClientError("Document transaction exceeds 24 KB; reduce the batch.")
        elif args.command == "save-extraction":
            if not UUID.fullmatch(args.capture_id):
                raise ClientError("Invalid capture ID.")
            if len(data) > 1024 * 1024:
                raise ClientError("Extraction artifact exceeds 1 MB.")
            path = f"/api/captures/{args.capture_id}/artifacts/ocr"
        else:
            if not UUID.fullmatch(args.document_id) or args.revision < 1:
                raise ClientError("Invalid document ID or revision.")
            path = f"/api/documents/{args.document_id}/pdf?revision={args.revision}"
            content_type = "application/pdf"
        if content_type == "application/json":
            json.loads(data)
        result = json.loads(client.request(path, data, content_type))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ClientError, OSError, ValueError, TypeError) as error:
        # Parser/OS messages can contain private input; keep these generic.
        print(str(error) if isinstance(error, ClientError) else "Cannot read valid private configuration/input; check paths and credential storage.", file=sys.stderr)
        sys.exit(1)
