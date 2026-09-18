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
AUTO_CROP = object()


class ClientError(Exception):
    pass


class OCRRequired(ClientError):
    """No saved PP artifact matches the verified source and requested layout."""

    def __init__(self, origin, source):
        super().__init__('Matching saved PP OCR is required.')
        self.request = dict(origin=origin, capture_id=source['capture_id'],
                            source_sha256=source['sha256'], crop=source['crop'], rotation=source['rotation'])


def matches_ocr_region(value, crop):
    if crop is AUTO_CROP:
        return True
    source = value.get("source") or {}
    if crop is None:
        pixels = source.get("pixels")
        if not isinstance(pixels, list) or len(pixels) != 2 or any(type(v) is not int or v <= 0 for v in pixels):
            return False
        crop = [0, 0, *pixels]
    return source.get("region") == dict(left=crop[0], top=crop[1], width=crop[2]-crop[0], height=crop[3]-crop[1])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ClientError("Redirect refused; check the Site address and credentials.")


def artifact_directory(path):
    """Keep the prepared workspace ACL on Windows; restrict POSIX caches to the owner."""
    # On Windows, 0700 replaces inherited ACLs and excludes the sandbox image viewer.
    # Artifact parents must already be private, authorized workspace directories.
    # Credentials use separate storage and must not use this helper.
    Path(path).mkdir(parents=True, exist_ok=True, mode=0o777 if os.name == "nt" else 0o700)


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
        filename = config.get("credential_file")
        if not isinstance(filename, str) or not Path(filename).is_absolute():
            raise ClientError("Create an agent connection from the signed-in Site; configure its private credential_file.")
        credential_path = Path(filename)
        if (credential_path.is_symlink() or not credential_path.is_file()
                or (os.name != 'nt' and credential_path.stat().st_mode & 0o077)):
            raise ClientError("Credentials must be stored in a private regular file.")
        value = json.loads(credential_path.read_text())
        if value.get("origin") != config.get("origin"):
            raise ClientError("Credential origin differs from configured Site.")
    return value


def matches_ocr(value, capture_id, source_sha):
    if not isinstance(value, dict):
        return False
    source, provenance = value.get("source"), value.get("provenance")
    return (isinstance(source, dict) and isinstance(provenance, dict)
            and source.get("captureId") == capture_id and source.get("sha256") == source_sha
            and isinstance(provenance.get("engine"), str) and
                (provenance["engine"].startswith("tesseract.js") or provenance["engine"] == "PP-OCRv6")
            and isinstance(value.get("text"), str)
            and isinstance(value.get("text_only_pdf_layers"), list) and bool(value["text_only_pdf_layers"])
            and all(isinstance(layer, dict) and isinstance(layer.get("base64"), str) and bool(layer["base64"])
                    and isinstance(layer.get("sha256"), str) and SHA.fullmatch(layer["sha256"])
                    for layer in value["text_only_pdf_layers"]))


def matches_prepared_ocr(value, capture_id, source_sha, crop, backend, rotation):
    if not matches_ocr(value, capture_id, source_sha) or not matches_ocr_region(value, crop):
        return False
    engine = value["provenance"]["engine"]
    return backend is not None and engine == backend.engine and value["source"].get("rotation") == rotation


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
        self.ocr_backend = None
        self.node = "node"

    def configure_ppocr(self, profile_path):
        """Bind prepared PP and Node runtimes to this client's existing destination."""
        profile_path = Path(profile_path)
        if not profile_path.is_absolute() or profile_path.is_symlink() or profile_path.is_junction() or not profile_path.is_file():
            raise ClientError("Use a prepared regular PP worker profile.")
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        repo = Path(__file__).resolve().parent.parent
        if not isinstance(profile, dict):
            raise ClientError("Use a prepared PP worker profile object.")
        repository = profile.get("repository")
        if (profile.get("origin") != self.origin or not isinstance(repository, str)
                or not Path(repository).is_absolute() or Path(repository).resolve() != repo
                or Path(repository).is_symlink() or Path(repository).is_junction()):
            raise ClientError("PP profile must match the configured scanner and checkout.")
        if not isinstance(profile.get("node"), str):
            raise ClientError("PP profile needs the prepared absolute Node executable.")
        node = Path(profile["node"])
        if (not node.is_absolute() or not node.is_file() or node.is_symlink() or node.is_junction()
                or node.name.lower() not in {"node", "node.exe"}):
            raise ClientError("PP profile needs the prepared absolute Node executable.")
        if not isinstance(profile.get("ppocr"), dict):
            raise ClientError("Configure PP-OCRv6 before processing; Tesseract is not a fallback.")
        from receipt_ppocr import PPBackend
        self.ocr_backend = PPBackend(profile_path, profile["ppocr"])
        self.node = str(node)

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
        artifact_directory(target.parent)
        if not cached:
            write_new_file(target, body)
        return {"path": str(target.absolute()), "sha256": sha, "bytes": len(body), "cached": cached}

    def original(self, capture_id, directory, metadata=None):
        if not UUID.fullmatch(capture_id):
            raise ClientError("Invalid capture ID.")
        meta = metadata if metadata is not None else self.get("/api/captures/" + capture_id)
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
        artifact_directory(directory)
        target = directory / (capture_id + "-" + sha + suffix)
        if target.is_symlink():
            raise ClientError("Cached original must not be a symlink.")
        cached = target.exists()
        body = target.read_bytes() if cached else self.request(f"/api/files/{capture_id}/raw?version={sha}")
        if len(body) != size or hashlib.sha256(body).hexdigest() != sha:
            raise ClientError("Original hash/size verification failed; existing files were preserved.")
        if not cached:
            write_new_file(target, body)
        outline = meta.get("manual_outline")
        if outline and outline.get("source_sha256") != sha:
            raise ClientError("Manual outline does not match the original checksum.")
        return {"capture_id": capture_id, "path": str(target.absolute()), "sha256": sha,
                "bytes": size, "scanned_at": meta.get("created_at"), "cached": cached,
                "quad": outline["quad"] if outline else ((meta.get("metadata") or {}).get("quality") or {}).get("quad")}


    def image_pdf(self, pages, directory):
        """Build a private pixel-only document preview with the production PDF layout."""
        root = Path(directory)
        artifact_directory(root)
        stem = root / ("preview-" + os.urandom(8).hex())
        manifest, output = stem.with_suffix(".pages.json"), stem.with_suffix(".pdf")
        write_new_file(manifest, json.dumps({"mode": "image-only", "pages": pages}).encode("utf-8"))
        result = subprocess.run([self.node, "scripts/receipt_pdf.mjs", str(manifest), str(output)],
                                capture_output=True, timeout=180)
        if result.returncode:
            raise ClientError("Pixel-only PDF preview failed; preserve the source layout.")
        value = json.loads(result.stdout)
        if value["sha256"] != hashlib.sha256(output.read_bytes()).hexdigest() or value["pages"] != len(pages):
            raise ClientError("Pixel-only PDF preview does not match the requested pages.")
        return value

    def source_region(self, source, directory):
        """Resolve default OCR bounds through the shared detector geometry, without OCR."""
        stem = Path(directory) / ("source-layout-" + os.urandom(8).hex())
        manifest, output = stem.with_suffix(".source.json"), stem.with_suffix(".json")
        write_new_file(manifest, json.dumps(source).encode("utf-8"))
        result = subprocess.run([self.node, "scripts/receipt_ocr.mjs", str(manifest), str(output), "--layout-only"],
                                capture_output=True, timeout=60)
        if result.returncode:
            raise ClientError("Could not resolve source dimensions and detected OCR region.")
        return json.loads(output.read_text(encoding="utf-8"))["crop"]

    def saved_ocr(self, capture_id, directory, *, crop=AUTO_CROP, rotation=0):
        """Read source/layout-pinned saved PP without image retrieval or model startup."""
        if not UUID.fullmatch(capture_id) or rotation not in (0, 90, 180, 270):
            raise ClientError("Invalid OCR source or rotation.")
        meta = self.get("/api/captures/" + capture_id)
        sha = meta.get("sha256", "")
        if meta.get("id") != capture_id or not SHA.fullmatch(sha):
            raise ClientError("Invalid OCR source metadata.")
        outline = meta.get("manual_outline")
        if outline and outline.get("source_sha256") != sha:
            raise ClientError("Manual outline does not match the source checksum.")
        quad = outline["quad"] if outline else ((meta.get("metadata") or {}).get("quality") or {}).get("quad")
        root = Path(directory)
        artifact_directory(root)
        for artifact in meta.get("artifacts", []):
            digest = artifact.get("sha256", "")
            if artifact.get("kind") != "ocr" or not SHA.fullmatch(digest):
                continue
            pinned = self.file(f"/api/files/{capture_id}/ocr?version={digest}", digest, root / (capture_id + "-" + digest + ".ocr.json"))
            try:
                value = json.loads(Path(pinned["path"]).read_text(encoding="utf-8"))
            except (ValueError, UnicodeError):
                continue
            if not matches_prepared_ocr(value, capture_id, sha, AUTO_CROP, self.ocr_backend, rotation):
                continue
            geometry = dict(pixels=value["source"].get("pixels"), quad=quad)
            if crop is not AUTO_CROP:
                geometry["crop"] = crop
            result = subprocess.run([self.node, "scripts/receipt_layout.mjs"], input=json.dumps(geometry),
                                    text=True, encoding="utf-8", capture_output=True, timeout=30)
            if result.returncode:
                raise ClientError("Saved OCR has invalid source dimensions or crop.")
            layout = json.loads(result.stdout)
            if matches_ocr_region(value, layout["crop"]):
                return dict(capture_id=capture_id, sha256=sha, crop=layout["crop"], pixels=layout["pixels"],
                            rotation=rotation, ocr_path=pinned["path"], ocr_sha256=digest)
        # A missing artifact needs a precise source/layout request for the OCR job.
        source = self.original(capture_id, root / "originals", metadata=meta)
        source["crop"] = self.source_region(source, root) if crop is AUTO_CROP else crop
        source["rotation"] = rotation
        raise OCRRequired(self.origin, source)

    def prepare(self, capture_id, directory=".local/receipt-api", *, crop=AUTO_CROP, rotation=0, allow_inference=True):
        """Verify an original and reuse or run prepared PP OCR, returning references."""
        if self.ocr_backend is None or self.ocr_backend.engine != "PP-OCRv6":
            raise ClientError("Configure PP-OCRv6 before processing; Tesseract is not a fallback.")
        root = Path(directory)
        original = self.original(capture_id, root / "originals")
        meta = self.get("/api/captures/" + capture_id)
        artifact_directory(root)
        if crop is AUTO_CROP:
            crop = self.source_region(original, root)
        if crop is not AUTO_CROP:
            if crop is not None and (not isinstance(crop, list) or len(crop) != 4 or
                    any(type(v) is not int for v in crop) or not (0 <= crop[0] < crop[2] and 0 <= crop[1] < crop[3])):
                raise ClientError("Invalid OCR crop bounds.")
            original["crop"] = crop
        if rotation not in (0, 90, 180, 270):
            raise ClientError("Invalid OCR rotation.")
        original["rotation"] = rotation
        for artifact in meta.get("artifacts", []):
            if artifact.get("kind") != "ocr":
                continue
            sha = artifact.get("sha256", "")
            if not SHA.fullmatch(sha):
                continue
            destination = root / (capture_id + "-" + sha + ".ocr.json")
            self.file(f"/api/files/{capture_id}/ocr?version={sha}", sha, destination)
            try:
                value = json.loads(destination.read_text())
            except (ValueError, UnicodeError):
                continue
            if matches_prepared_ocr(value, capture_id, original["sha256"], crop, self.ocr_backend, rotation):
                return {**original, "ocr_path": str(destination.absolute()), "ocr_sha256": sha}
        if not allow_inference:
            raise OCRRequired(self.origin, original)
        run = root / (capture_id + "-" + os.urandom(8).hex())
        manifest = run.with_suffix(".source.json")
        output = run.with_suffix(".ocr.json")
        write_new_file(manifest, json.dumps(original).encode())
        self.ocr_backend.run(manifest, output)
        data = output.read_bytes()
        if not matches_prepared_ocr(json.loads(data), capture_id, original["sha256"], crop, self.ocr_backend, rotation):
            raise ClientError("Generated OCR does not match the verified source.")
        if len(data) > 1024 * 1024:
            raise ClientError("OCR artifact exceeds 1 MB; preserve the local result for review.")
        result = json.loads(self.request(f"/api/captures/{capture_id}/artifacts/ocr", data))
        sha = hashlib.sha256(data).hexdigest()
        if result.get("sha256") != sha:
            raise ClientError("Stored OCR checksum mismatch.")
        pinned = self.file(f"/api/files/{capture_id}/ocr?version={sha}", sha, root / (capture_id + "-" + sha + ".ocr.json"))
        return {**original, "ocr_path": pinned["path"], "ocr_sha256": sha}

    def pdf(self, document_id, directory=".local/receipt-api", before_upload=None, *, prepared=None):
        if not UUID.fullmatch(document_id):
            raise ClientError("Invalid document ID.")
        document = self.get("/api/documents/" + document_id)["document"]
        if not document.get("filename") or document.get("mergedInto") or document.get("duplicateOf"):
            raise ClientError("This document needs a supported date/vendor and retained pages before PDF export.")
        root = Path(directory)
        pages = []
        for page in document["pages"]:
            source = (prepared or {}).get(page["captureId"])
            if source is None:
                source = self.prepare(page["captureId"], directory, crop=page["crop"], rotation=page["rotation"])
            elif (source.get("crop") != page["crop"] or source.get("rotation") != page["rotation"]
                  or hashlib.sha256(Path(source["ocr_path"]).read_bytes()).hexdigest() != source["ocr_sha256"]):
                raise ClientError("Prepared OCR differs from the frozen source/layout.")
            if source["sha256"] != page["sha256"]:
                raise ClientError("Document source hash mismatch.")
            pages.append({**page, "path": source["path"], "ocr_path": source["ocr_path"]})
        run = root / (document_id + "-" + str(document["revision"]) + "-" + os.urandom(8).hex())
        manifest, output = run.with_suffix(".pages.json"), run.with_suffix(".pdf")
        write_new_file(manifest, json.dumps({"pages": pages}).encode())
        process = subprocess.run([self.node, "scripts/receipt_pdf.mjs", str(manifest), str(output)], capture_output=True, timeout=180)
        if process.returncode:
            raise ClientError("Searchable PDF generation failed; retain its sources and inspect the local layout/runtime.")
        data = output.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        generated = json.loads(process.stdout)
        if (generated["sha256"] != sha or generated["pages"] != len(pages)
                or generated["layouts"] != [{"captureId": p["captureId"], "sha256": p["sha256"],
                    "pixels": generated["layouts"][i]["pixels"], "crop": p["crop"], "rotation": p["rotation"]}
                    for i, p in enumerate(pages)]):
            raise ClientError("Generated PDF differs from the saved ordered source layout.")
        if before_upload is not None:
            before_upload({"path": str(output.absolute()), "sha256": sha, "revision": document["revision"],
                           "filename": document["filename"], "pages": len(pages), "searchable": True})
        result = json.loads(self.request(f"/api/documents/{document_id}/pdf?revision={document['revision']}", data, "application/pdf"))
        if result.get("sha256") != sha:
            raise ClientError("PDF upload checksum mismatch.")
        if result.get("revision") != document["revision"]:
            raise ClientError("PDF upload revision mismatch.")
        # The server hashes the received bytes and acknowledges only after storage
        # and metadata persistence. Inspect these identical local bytes; reserve a
        # pinned download through file() for explicit retrieval-path verification.
        return {**result, "path": str(output.absolute()), "pages": len(pages), "searchable": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=".local/processing-access.json")
    parser.add_argument("--worker-profile", help="Prepared PP profile; otherwise discover .local/processing-host.json for prepare/pdf")
    parser.add_argument("--credentials-stdin", action="store_true", help="Read credentials from a secure provider pipe, never a command argument")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    get = commands.add_parser("get", help="Read a relative processing API path")
    get.add_argument("path")
    post = commands.add_parser("post", help="Submit a private JSON file to an allowed processing endpoint")
    post.add_argument("path")
    post.add_argument("file")
    listing = commands.add_parser("captures", help="One current-take page; follow next using --before")
    listing.add_argument("--before")
    listing.add_argument("--limit", type=int, default=100, choices=range(1, 101))
    prepare = commands.add_parser("prepare", help="Verify an original and run/reuse prepared PP-OCRv6")
    prepare.add_argument("capture_id")
    generate = commands.add_parser("pdf", help="Generate, upload and verify a searchable PDF from saved document pages")
    generate.add_argument("document_id")
    original = commands.add_parser("original", help="Download and verify an immutable original")
    original.add_argument("capture_id")
    original.add_argument("--directory", default=".local/receipt-api/originals")
    artifact = commands.add_parser("file", help="Download a pinned PDF/artifact and verify its expected SHA-256")
    artifact.add_argument("path")
    artifact.add_argument("sha256")
    artifact.add_argument("destination")
    ocr = commands.add_parser("save-ocr", help="Save an immutable ordinary OCR JSON artifact")
    ocr.add_argument("capture_id")
    ocr.add_argument("file")
    pdf = commands.add_parser("save-pdf", help="Upload a PDF for an exact document revision")
    pdf.add_argument("document_id")
    pdf.add_argument("revision", type=int)
    pdf.add_argument("file")
    args = parser.parse_args()
    client = ScannerClient(credentials(args.config, args.credentials_stdin))
    if args.command in {"prepare", "pdf"}:
        profile_path = args.worker_profile
        if not profile_path:
            descriptor = Path(__file__).resolve().parent.parent / ".local" / "processing-host.json"
            if descriptor.is_symlink() or descriptor.is_junction() or not descriptor.is_file():
                raise ClientError("Configure the PP processing host before OCR or PDF generation.")
            profile_path = json.loads(descriptor.read_text(encoding="utf-8")).get("worker_profile")
        if not isinstance(profile_path, str) or not Path(profile_path).is_absolute():
            raise ClientError("Use a prepared absolute PP profile path.")
        client.configure_ppocr(profile_path)
    if args.command == "status":
        result = {**client.get("/api/processing/access"), "origin": client.origin}
    elif args.command == "get":
        result = client.get(args.path)
    elif args.command == "captures":
        query = {"limit": args.limit, "current": 1}
        if args.before:
            query["before"] = args.before
        result = client.get("/api/captures?" + urlencode(query))
    elif args.command == "prepare":
        result = client.prepare(args.capture_id)
    elif args.command == "pdf":
        result = client.pdf(args.document_id)
    elif args.command == "original":
        result = client.original(args.capture_id, args.directory)
    elif args.command == "file":
        result = client.file(args.path, args.sha256, args.destination)
    else:
        data = Path(args.file).read_bytes()
        if len(data) > LIMIT:
            raise ClientError("Upload exceeds the client size limit.")
        content_type = "application/json"
        if args.command == "post":
            if not args.path.startswith("/api/processing/"):
                raise ClientError("Use post only for processing endpoints.")
            path = args.path
        elif args.command == "save-ocr":
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
    except (ClientError, OSError, ValueError, TypeError, subprocess.TimeoutExpired) as error:
        # Parser/OS messages can contain private input; keep these generic.
        print(str(error) if isinstance(error, ClientError) else "Cannot read valid private configuration/input; check paths and credential storage.", file=sys.stderr)
        sys.exit(1)
