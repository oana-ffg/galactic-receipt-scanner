#!/usr/bin/env python3
"""One-document receipt worker protocol. No arbitrary URLs, paths or shell commands."""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time
import threading
import uuid
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import receipt_qwen
from receipt_ppocr import PPBackend
from receipt_api import ScannerClient, ClientError, artifact_directory, credentials, write_new_file

MAX_INPUT = 512 * 1024
WINDOWS_REPLACE_ATTEMPTS = 7
WINDOWS_TRANSIENT_REPLACE_ERRNOS = {errno.EACCES, errno.EPERM, errno.EBUSY}
WINDOWS_TRANSIENT_REPLACE_WINERRORS = {5, 32, 33}
OPERATIONS = {
    "status", "claim", "context", "document", "originals", "previews", "draft", "prepare", "confirm", "assess", "categories",
    "category", "validate", "submit", "pdf", "render", "attest", "renew", "release",
    "retry-submit", "retry-checkpoint", "retry-pdf", "reconcile", "quit",
}
CHECKS = '''
import {extractionErrors,arithmetic} from "./web/extraction.ts";
let text=""; for await (const part of process.stdin) text+=part;
const input=JSON.parse(text);
if(input.operation==="validate") {
  const errors=extractionErrors(input.extraction);
  console.log(JSON.stringify({errors,arithmetic:errors.length?null:arithmetic(input.extraction)}));
} else {
  const {build}=await import("esbuild");
  const built=await build({entryPoints:["web/documents.ts"],bundle:true,platform:"node",format:"esm",write:false});
  const {mergeReviewReasons}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
  console.log(JSON.stringify(input.documents.map(mergeReviewReasons)));
}
'''


class InputError(Exception):
    """A rejected protocol input; no remote mutation has started."""


class ProtocolInputError(InputError):
    """Malformed request envelope rejected before dispatch or remote operations."""


def validate_request(message):
    if not isinstance(message, dict) or not isinstance(message.get("op"), str) or message["op"] not in OPERATIONS:
        raise ProtocolInputError("Expected a request object with a supported op.")
    required = {
        "document": {"document_id": str},
        "validate": {"extraction": dict},
        "draft": {"extraction": dict, "page_review": dict},
        "assess": {"extraction": dict, "rationale": str, "confirmation_sha256": str},
        "attest": {"pdf_sha256": str},
    }.get(message["op"], {})
    for field, kind in required.items():
        if not isinstance(message.get(field), kind) or (kind is str and not message[field].strip()):
            raise ProtocolInputError(f"{message['op']} requires {field} as a nonempty string." if kind is str
                                     else f"{message['op']} requires {field} as an object.")


class JournalCheckpointError(OSError):
    """A local journal replacement failed before the associated request began."""

    def __init__(self, error):
        self.error_type = type(error).__name__
        self.errno = error.errno
        super().__init__(error.errno, "journal checkpoint failed")

    def diagnostic(self):
        return f"Journal checkpoint failed ({self.error_type}, errno={self.errno})."


class Once(argparse.Action):
    def __call__(self, parser, namespace, values, option_string=None):
        if getattr(namespace, self.dest, None) is not None:
            parser.error("Each worker option may be supplied only once.")
        setattr(namespace, self.dest, values)


def require(condition, message):
    if not condition:
        raise InputError(message)


def verify(condition, message):
    if not condition:
        raise ClientError(message)


def replace_journal_file(temporary, destination):
    """Replace a journal file, retrying only transient Windows sharing/access failures."""
    for attempt in range(WINDOWS_REPLACE_ATTEMPTS):
        try:
            os.replace(temporary, destination)
            return
        except OSError as error:
            transient = (os.name == "nt"
                         and error.errno in WINDOWS_TRANSIENT_REPLACE_ERRNOS
                         and getattr(error, "winerror", None) in (None, *WINDOWS_TRANSIENT_REPLACE_WINERRORS))
            if not transient or attempt == WINDOWS_REPLACE_ATTEMPTS - 1:
                raise JournalCheckpointError(error) from None
            time.sleep(0.025 * (2 ** attempt))


def clean(value):
    """Keep tokens and embedded OCR PDF layers out of model/tool output."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()
                if k not in {"token", "sites_token", "processing_token", "text_only_pdf_layers"}}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def synthetic_png():
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 32, 32, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\0\xc0\0" * 32) * 32)) + chunk(b"IEND", b""))


def disable_console_echo():
    """Do not echo extraction input back into the worker's transcript on Windows."""
    if os.name == "nt":
        import ctypes
        import msvcrt
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
        mode = wintypes.DWORD()
        if kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            kernel.SetConsoleMode(handle, mode.value & ~4)


class Worker:
    def __init__(self, profile, resume=None, profile_path=None):
        self.lock = None
        try:
            self.initialize(profile, resume, profile_path)
        except Exception:
            if self.lock is not None:
                self.lock.close()
            raise

    def initialize(self, profile, resume, profile_path=None):
        self.repo = Path(__file__).resolve().parent.parent
        require(Path(profile["repository"]).resolve() == self.repo, "Profile repository does not match this helper.")
        for key, names in (("node", {"node", "node.exe"}), ("renderer", {"pdftoppm", "pdftoppm.exe"})):
            path = Path(profile[key])
            require(path.is_absolute() and path.is_file() and not path.is_symlink() and path.name.lower() in names,
                    "Profile must name the prepared Node and Poppler executables.")
        self.node = str(Path(profile["node"]).resolve(strict=True))
        self.renderer = str(Path(profile["renderer"]).resolve(strict=True))
        self.client = ScannerClient(credentials(profile["client_config"]))
        self.confirmation_provider = "ppocr" if "ppocr" in profile else "qwen"
        if self.confirmation_provider == "ppocr":
            require(profile_path is not None, "PP OCR requires the prepared profile file.")
            self.client.ocr_backend = PPBackend(profile_path, profile["ppocr"])
        require(self.client.origin == profile["origin"], "Configured scanner differs from the approved origin.")
        self.env = {k: v for k, v in os.environ.items() if k not in {"NODE_OPTIONS", "NODE_PATH", "PYTHONPATH"}}
        self.env["PATH"] = str(Path(self.node).parent) + os.pathsep + self.env.get("PATH", "")
        os.chdir(self.repo)
        # Existing client subprocesses inherit the same fixed prepared runtime.
        os.environ.update(self.env)
        for key in ("NODE_OPTIONS", "NODE_PATH", "PYTHONPATH"):
            os.environ.pop(key, None)
        base = self.repo / ".local" / "receipt-worker"
        require(all(not p.is_symlink() and not p.is_junction() for p in (self.repo / ".local", base)), "Worker cache must not be a symlink or junction.")
        artifact_directory(base)
        self.lock = (base / "worker.lock").open("a+b")
        self.lock.seek(0)
        if os.name == "nt":
            import msvcrt
            if not self.lock.read(1):
                self.lock.write(b"0")
                self.lock.flush()
            self.lock.seek(0)
            msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.mutex = threading.RLock()
        self.stop_heartbeat = threading.Event()
        pointer = base / "active-run.json"
        if pointer.exists() and resume is None:
            previous_id = json.loads(pointer.read_text(encoding="utf-8"))["run_id"]
            require(re.fullmatch(r"[0-9a-f]{32}", previous_id), "Invalid previous run reference.")
            previous = json.loads((base / previous_id / "state.json").read_text(encoding="utf-8"))
            require(not previous.get("failed"), "Previous worker failed; owner-directed reconciliation is required before another document.")
            require(previous["phase"] in {"ready", "complete", "released", "empty"}, "Previous worker has unfinished state; resume that run before claiming another document.")
        self.resumed = resume is not None
        run_id = resume if self.resumed else uuid.uuid4().hex
        require(isinstance(run_id, str) and re.fullmatch(r"[0-9a-f]{32}", run_id), "Invalid worker run ID.")
        self.work = base / run_id
        require(not self.work.is_symlink() and not self.work.is_junction(), "Worker run must not be a symlink or junction.")
        if self.resumed:
            self.state = self.load("state.json")
            require(self.state["origin"] == self.client.origin, "Run belongs to a different scanner.")
            require(self.state.get("confirmation_provider", "qwen") == self.confirmation_provider,
                    "Resume with the original confirmation provider; do not mix workflow evidence.")
        else:
            require(not self.work.exists(), "Worker run already exists.")
            artifact_directory(self.work)
            self.state = {"run_id": run_id, "origin": self.client.origin, "phase": "ready", "claim": None,
                          "confirmation_provider": self.confirmation_provider,
                          "capture_ids": [], "capture_hashes": {}, "document_ids": [], "sources": {}, "prepared": {}, "sequence": 0}
            self.save("viewer-preflight.png", synthetic_png(), binary=True)
            self.checkpoint()
        temporary = base / ("active-" + uuid.uuid4().hex + ".json")
        write_new_file(temporary, json.dumps({"run_id": run_id}).encode())
        replace_journal_file(temporary, pointer)

    def load(self, name):
        return json.loads((self.work / name).read_text(encoding="utf-8"))

    def save(self, name, value, binary=False):
        write_new_file(self.work / name, value if binary else json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def checkpoint(self):
        temporary = self.work / ("state-" + uuid.uuid4().hex + ".json")
        write_new_file(temporary, json.dumps(self.state, ensure_ascii=False).encode("utf-8"))
        replace_journal_file(temporary, self.work / "state.json")

    def checkpoint_intent(self, previous_state):
        """Persist a pre-request intent or leave its in-memory phase confirmed."""
        try:
            self.checkpoint()
        except OSError as error:
            self.rollback_pre_request_state(previous_state)
            if isinstance(error, JournalCheckpointError):
                raise
            raise JournalCheckpointError(error) from None

    def rollback_pre_request_state(self, previous_state):
        """Restore a confirmed phase without reusing an already-written journal sequence."""
        current_sequence = self.state.get("sequence", 0)
        self.state = previous_state
        self.state["sequence"] = max(self.state.get("sequence", 0), current_sequence)

    def record(self, label, value):
        self.state["sequence"] += 1
        name = f"{self.state['sequence']:04d}-{label}.json"
        self.save(name, value)
        self.checkpoint()
        return name

    def summary(self):
        claim = self.state.get("claim")
        document = self.state.get("document") or (claim or {}).get("document")
        return {"run_id": self.state["run_id"], "phase": self.state["phase"], "work_dir": str(self.work),
                "document_id": (document or {}).get("id"), "revision": (document or {}).get("revision"),
                "pages": len((document or {}).get("pages", [])), "status": (document or {}).get("status"),
                "claim_active": self.state["phase"] in {"claimed", "drafted"},
                "claim_state": ("active" if self.state["phase"] in {"claimed", "drafted"} else "possibly-active"
                    if self.state["phase"] in {"claim-uncertain", "draft-uncertain", "confirmation-uncertain", "submit-uncertain"} else "closed"),
                "claim_expires": (claim or {}).get("expires"), "failure": self.state.get("failed"),
                "viewer_preflight": str(self.work / "viewer-preflight.png")}

    def check(self, operation, **values):
        process = subprocess.run([self.node, "--input-type=module", "-e", CHECKS],
            input=json.dumps({"operation": operation, **values}), text=True, encoding="utf-8",
            capture_output=True, cwd=self.repo, env=self.env, timeout=60)
        if process.returncode:
            raise ClientError("Prepared extraction validator failed; no model install or fallback attempted.")
        return json.loads(process.stdout)

    def post(self, endpoint, body):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        require(len(payload) <= MAX_INPUT, "Processing request exceeds 512 KiB.")
        return json.loads(self.client.request("/api/processing/" + endpoint, payload))

    def active(self):
        require(self.state["phase"] in {"claimed", "drafted"}, "This operation needs the active document claim.")
        return self.state["claim"]

    def page(self, capture_id):
        """Return a discovered current page record without accepting caller-made geometry."""
        for document_id in self.state["document_ids"]:
            document = self.get_document(document_id)
            for page in document.get("pages", []):
                if page["captureId"] == capture_id:
                    return page
        raise InputError("Capture page was not discovered in this receipt context.")

    def render_file(self, path, pages, dpi, label):
        require(dpi in (150, 300), "Rendering supports 150 or 300 dpi.")
        prefix = self.work / (label + "-" + uuid.uuid4().hex)
        process = subprocess.run([self.renderer, "-r", str(dpi), "-jpeg", path, str(prefix)],
            capture_output=True, timeout=180, cwd=self.repo, env=self.env)
        if process.returncode:
            raise ClientError("Prepared PDF renderer failed.")
        paths = sorted(self.work.glob(prefix.name + "-*.jpg"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
        require(len(paths) == pages, "PDF rendered page count differs from saved source pages.")
        return [str(p) for p in paths]

    def renew_if_needed(self):
        claim = self.active()
        if claim["expires"] < time.time() * 1000 + 300000:
            result = self.post("renew", {"token": claim["token"]})
            claim["expires"] = result["expires"]
            self.record("renew", result)

    def discover(self, document):
        if not document:
            return
        if document["id"] not in self.state["document_ids"]:
            self.state["document_ids"].append(document["id"])
        for page in document.get("pages", []):
            expected = self.state["capture_hashes"].get(page["captureId"])
            verify(expected in (None, page["sha256"]), "Discovered source hash changed.")
            self.state["capture_hashes"][page["captureId"]] = page["sha256"]
            if page["captureId"] not in self.state["capture_ids"]:
                self.state["capture_ids"].append(page["captureId"])

    def get_document(self, document_id):
        require(document_id in self.state["document_ids"], "Document was not discovered in this receipt context.")
        document = self.client.get("/api/documents/" + document_id)["document"]
        self.discover(document)
        return document

    def grouping(self, selection, extraction):
        claim = self.active()
        target = self.get_document(claim["document"]["id"])
        verify(target["revision"] == claim["document"]["revision"], "Claimed document revision changed.")
        require(set(selection) <= {"donor_ids", "capture_ids", "evidence", "duplicate_of"}, "Unknown grouping option.")
        evidence = selection.get("evidence")
        require(isinstance(evidence, str) and 0 < len(evidence.strip()) <= 2000, "Grouping needs visual evidence.")
        duplicate = selection.get("duplicate_of")
        donor_ids = selection.get("donor_ids", [])
        selected = selection.get("capture_ids", [p["captureId"] for p in target["pages"]])
        require(isinstance(donor_ids, list) and len(donor_ids) < 20 and len(set(donor_ids)) == len(donor_ids)
                and target["id"] not in donor_ids, "Invalid grouping donors.")
        donors = [self.get_document(did) for did in donor_ids]
        before = deepcopy([target] + donors)
        require(all(not d["mergedInto"] and not d["duplicateOf"] for d in before), "Grouping requires retained documents.")
        pages = {p["captureId"]: p for d in before for p in d["pages"]}
        require(len(pages) == sum(len(d["pages"]) for d in before), "Grouping sources overlap.")
        require(isinstance(selected, list) and 0 < len(selected) <= 100 and len(set(selected)) == len(selected)
                and set(selected) <= pages.keys() and {p["captureId"] for p in target["pages"]} <= set(selected),
                "Grouping must preserve all target pages exactly once.")
        require(set(selected) <= self.state["sources"].keys(), "Open verified originals before grouping pages.")
        if duplicate:
            require(not donors and duplicate != target["id"] and selected == [p["captureId"] for p in target["pages"]], "Duplicate marking cannot move pages.")
            original = self.get_document(duplicate)
            require(not original["mergedInto"] and not original["duplicateOf"], "Duplicate target must be retained.")
            require({p["captureId"] for p in original["pages"]} <= self.state["sources"].keys(), "Verify both documents before marking a duplicate.")
            target["duplicateOf"] = duplicate
        target["pages"] = [deepcopy(pages[cid]) for cid in selected]
        for donor in donors:
            moved = {p["captureId"] for p in donor["pages"]} & set(selected)
            require(bool(moved), "Each donor must contribute a page.")
            target["annotations"].extend(a for a in donor["annotations"] if a["captureId"] in moved)
            donor["annotations"] = [a for a in donor["annotations"] if a["captureId"] not in moved]
            donor["pages"] = [p for p in donor["pages"] if p["captureId"] not in moved]
            if not donor["pages"]:
                donor["mergedInto"], donor["handwriting"] = target["id"], "unchecked"
        for doc in [target] + donors:
            doc["checks"] = dict(visual=False, transcription=False, grouping=False, pdf=False)
            doc["invoice"] = doc["reviewedPdfSha256"] = None
        reasons = self.check("reasons", documents=before)
        for field, reason in [("uncertainties", "uncertainties"), ("broken_reasons", "broken")]:
            extraction[field] = list(dict.fromkeys(extraction[field] + [r for item in reasons for r in item[reason]]))
        extraction["evidence"] = "\n".join(dict.fromkeys([extraction["evidence"], evidence]))
        require(not any(d["handwriting"] == "present" or d["annotations"] for d in before) or extraction["has_handwriting"], "Reconcile preserved handwriting against originals.")
        # Unchecked is the capture default, not contrary visual evidence. Preserve
        # actual uncertainty for review without rewriting Luna's own confidence.
        if any(d["handwriting"] == "uncertain" for d in before):
            extraction["uncertainties"] = list(dict.fromkeys(extraction["uncertainties"] + ["Retained source grouping includes an unresolved handwriting-presence observation."]))
        target["evidence"] = extraction["evidence"]
        require(len({p["captureId"] for d in [target] + donors for p in d["pages"]}) == len(pages)
                and sum(len(d["pages"]) for d in [target] + donors) == len(pages), "Grouping did not preserve every source page exactly once.")
        return [target] + donors

    def check_page_review(self, review, retained):
        require(isinstance(review, dict) and set(review) == {"capture_ids", "excluded"},
                "Draft requires page_review with ordered capture_ids and excluded pages with reasons.")
        selected = review["capture_ids"]
        require(isinstance(selected, list) and all(isinstance(cid, str) for cid in selected)
                and selected == retained,
                "page_review.capture_ids must exactly match the ordered pages to save. "
                "To retain adjacent pages, supply grouping with their donor_ids and ordered capture_ids before draft.")
        windows = self.state.get("lookahead_windows")
        require(windows and windows[0]["after_capture"] is None,
                "Read the initial context before drafting so adjacent scans can be checked.")
        for window in windows:
            ids = window["capture_ids"]
            boundary = next((cid for cid in ids if cid not in retained), None)
            if boundary is not None:
                require(boundary in self.state["sources"],
                        "Inspect the next available scan before draft; it may be a continuation, payment slip or duplicate. "
                        "Retain it with grouping or explain its exclusion in page_review.")
            elif ids:
                require(any(later["after_capture"] == ids[-1] for later in windows),
                        "All lookahead pages are retained. Request context with filters.after_capture set to the last "
                        "lookahead ID and inspect the next boundary before freezing the document.")
        excluded = review["excluded"]
        require(isinstance(excluded, list) and len(excluded) <= 100,
                "page_review.excluded must list each inspected page left outside this document.")
        for item in excluded:
            require(isinstance(item, dict) and set(item) == {"capture_id", "reason"}
                    and isinstance(item["capture_id"], str)
                    and isinstance(item["reason"], str) and 0 < len(item["reason"].strip()) <= 2000,
                    "Each excluded page needs capture_id and a concrete visual reason for keeping it separate.")
        ids = [item["capture_id"] for item in excluded]
        require(len(ids) == len(set(ids)) and set(ids) == set(self.state["sources"]) - set(retained),
                "Account for every inspected non-retained page exactly once in page_review.excluded. "
                "A known continuation belongs in grouping; it is not a missing future page.")

    def draft(self, message):
        require(self.state["phase"] == "claimed", "Freeze one Luna draft before OCR preparation.")
        require(set(message) <= {"op", "extraction", "grouping", "category_name", "page_review"}, "Unknown draft option.")
        extraction = deepcopy(message["extraction"])
        validation = self.check("validate", extraction=extraction)
        if validation["errors"]:
            return {"validation": validation, "drafted": False}
        self.check_category(extraction, message.get("category_name"))
        claim = self.active()
        documents = self.grouping(message["grouping"], extraction) if message.get("grouping") else [deepcopy(self.get_document(claim["document"]["id"]))]
        target = next(d for d in documents if d["id"] == claim["document"]["id"])
        layouts = self.state.get("layouts", {})
        retained = [p["captureId"] for p in target["pages"]]
        self.check_page_review(message.get("page_review"), retained)
        previous = self.state.get("previous_ids", [])
        if previous and (extraction["type"] == "payment-slip" or extraction["completeness"] == "fragment"):
            require(previous[0] in self.state["sources"],
                    "Inspect the immediately preceding scan for a payment slip or fragment; it may hold the main receipt or earlier section.")
        require(set(retained) <= layouts.keys(), "Preview every retained page before freezing the Luna draft.")
        for document in documents:
            for page in document["pages"]:
                if page["captureId"] in layouts:
                    layout = layouts[page["captureId"]]
                    verify(layout["sha256"] == page["sha256"], "Preview source differs from the grouped page.")
                    page["crop"], page["rotation"] = layout["crop"], layout["rotation"]
        validation = self.check("validate", extraction=extraction)
        require(not validation["errors"], "Grouping exceeded extraction limits; revise the extraction.")
        pages = [{**p, "path": self.state["sources"][p["captureId"]]["path"]} for p in target["pages"]]
        pixel_pdf = self.client.image_pdf(pages, self.work / "draft")
        verify(pixel_pdf["pages"] == len(pages) and pixel_pdf["layouts"] == [layouts[cid] for cid in retained],
               "Frozen pixel layout differs from the reviewed previews.")
        rendered = self.render_file(pixel_pdf["path"], pixel_pdf["pages"], 300, "draft-page")
        frozen = {"extraction": extraction, "grouping": deepcopy(message.get("grouping")),
                  "page_review": deepcopy(message["page_review"]),
                  "target": deepcopy(target),
                  "documents": documents,
                  "layouts": [layouts[cid] for cid in retained], "pixel_pdf": pixel_pdf, "rendered": rendered, "images": receipt_qwen.describe_images(rendered)}
        self.state["draft_file"] = self.record("luna-draft", frozen)
        self.state["draft"] = frozen
        self.checkpoint()
        return self.database_checkpoint("draft", {"token":claim["token"], "model":"gpt-5.6-luna", "extraction":extraction,
             "documents":deepcopy(documents), "pixel_pdf_sha256":pixel_pdf["sha256"], "images":frozen["images"]})

    def check_category(self, extraction, category_name=None):
        category_id = extraction.get("category_id")
        if category_name is not None:
            require(isinstance(category_name, str) and category_name.strip(), "Use an exact category name from categories.")
            require(category_id is None, "With category_name, set extraction.category_id to null; do not supply conflicting selections.")
            categories = self.client.get("/api/processing/categories")
            matches = [category for category in categories if category.get("name") == category_name]
            require(len(matches) == 1, "Unknown or ambiguous purchase category name. Copy its exact name from categories and retry.")
            extraction["category_id"] = matches[0]["id"]
        elif category_id is not None:
            categories = self.client.get("/api/processing/categories")
            require(any(category.get("id") == category_id for category in categories),
                    "Unknown purchase category. Use categories and copy its exact id; then retry the same operation.")

    def database_checkpoint(self, endpoint, body):
        previous_state = deepcopy(self.state)
        try:
            self.state["checkpoint_request"] = self.record(endpoint+"-request", body)
            require((self.work/self.state["checkpoint_request"]).stat().st_size <= MAX_INPUT, "Processing request exceeds 512 KiB.")
            self.state["phase"] = endpoint+"-uncertain"
            self.checkpoint_intent(previous_state)
        except OSError as error:
            self.rollback_pre_request_state(previous_state)
            if isinstance(error, JournalCheckpointError):
                raise
            raise JournalCheckpointError(error) from None
        return self.retry_checkpoint()

    def retry_checkpoint(self):
        endpoint = self.state["phase"].removesuffix("-uncertain")
        verify(endpoint in {"draft", "confirmation"}, "No database checkpoint to retry.")
        response = json.loads(self.client.request("/api/processing/"+endpoint, (self.work/self.state["checkpoint_request"]).read_bytes()))
        verify(response.get("saved") is True, "Database checkpoint was not acknowledged.")
        if endpoint == "draft":
            self.state["draft_saved"] = True
            frozen = self.state["draft"]
            result = {"drafted":True, "document_id":frozen["target"]["id"], "pages":len(frozen["layouts"]),
                "pixel_pdf_sha256":frozen["pixel_pdf"]["sha256"], "rendered":frozen["rendered"], "layouts":frozen["layouts"],
                "page_review":frozen.get("page_review")}
        else:
            self.state["confirmation"] = response
            result = response
        self.state["phase"] = "drafted"
        self.state.pop("failed", None)
        self.checkpoint()
        return result

    def submit(self, message):
        claim = self.active()
        require(self.state["phase"] == "drafted" and self.state.get("draft"), "Freeze and inspect the Luna draft before submission.")
        require(set(message) == {"op"}, "Submit reuses the frozen Luna draft without changing its reading or grouping.")
        frozen = self.state["draft"]
        require(self.state.get("confirmation") and self.state.get("assessment"), "Complete independent confirmation and Luna reassessment before submission.")
        extraction = deepcopy(self.state["assessment"]["extraction"])
        body = {"token": claim["token"], "model": "gpt-5.6-luna", "extraction": extraction}
        body["assessment"] = deepcopy(self.state["assessment"]["assessment"])
        if frozen["documents"] is not None:
            body["documents"] = deepcopy(frozen["documents"])
        result = self.check("validate", extraction=extraction)
        require(not result["errors"], "Grouping exceeded extraction limits; revise the extraction.")
        target = next((d for d in body.get("documents", []) if d["id"] == claim["document"]["id"]), frozen["target"])
        require({p["captureId"] for p in target["pages"]} <= self.state["prepared"].keys(), "Prepare OCR for every retained page before submitting.")
        for page in target["pages"]:
            prepared = self.state["prepared"][page["captureId"]]
            require(prepared.get("crop") == page["crop"], "Prepared OCR does not use the frozen page crop.")
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        require(len(payload) <= MAX_INPUT, "Processing request exceeds 512 KiB.")
        previous_state = deepcopy(self.state)
        try:
            self.state["submit_request"] = self.record("submit-request", body)
            self.state["phase"] = "submit-uncertain"
            self.checkpoint_intent(previous_state)
        except OSError as error:
            self.rollback_pre_request_state(previous_state)
            if isinstance(error, JournalCheckpointError):
                raise
            raise JournalCheckpointError(error) from None
        response = json.loads(self.client.request("/api/processing/submit", payload))
        return self.finish_submit(body, response)

    def finish_submit(self, body, response):
        self.state["submit_response"] = self.record("submit-response", response)
        document_id = self.state["claim"]["document"]["id"]
        expected = body.get("documents") or [self.state["claim"]["document"]]
        require(document_id in {r["id"] for r in response["saved"]}, "Submit response omitted the claimed document.")
        self.state["phase"] = "submit-readback"
        self.checkpoint()
        for previous in expected:
            saved = self.get_document(previous["id"])
            require(saved["revision"] == previous["revision"] + 1, "Saved revision differs; reconcile before continuing.")
            expected_pages = deepcopy(previous["pages"])
            # The server applies extraction.type to the claimed single-page document.
            # Keep every source/layout field (and all donor metadata) strictly checked.
            if previous["id"] == document_id and len(expected_pages) == 1:
                expected_pages[0]["type"] = body["extraction"]["type"]
            require(saved["pages"] == expected_pages, "Saved page membership differs; reconcile before continuing.")
            if "documents" in body:
                require(saved["annotations"] == previous["annotations"] and saved["mergedInto"] == previous["mergedInto"]
                        and saved["duplicateOf"] == previous["duplicateOf"], "Saved grouping differs; reconcile before continuing.")
            if saved["id"] == document_id:
                self.state["document"] = saved
        self.state["phase"] = "submitted"
        self.checkpoint()
        return self.summary()

    def render(self, dpi):
        require(dpi in (150, 300), "Rendering supports 150 or 300 dpi.")
        pdf = self.state.get("pdf")
        require(pdf is not None, "Generate the PDF before rendering.")
        require(hashlib.sha256(Path(pdf["path"]).read_bytes()).hexdigest() == pdf["sha256"], "Local PDF changed; preserve and reconcile.")
        prefix = self.work / ("pdf-page-" + uuid.uuid4().hex)
        process = subprocess.run([self.renderer, "-r", str(dpi), "-png", pdf["path"], str(prefix)],
            capture_output=True, timeout=180, cwd=self.repo, env=self.env)
        if process.returncode:
            raise ClientError("Prepared PDF renderer failed.")
        paths = sorted(self.work.glob(prefix.name + "-*.png"), key=lambda p: int(p.stem.rsplit("-", 1)[1]))
        require(len(paths) == pdf["pages"], "PDF rendered page count differs from saved source pages.")
        self.state["rendered"] = [str(p) for p in paths]
        self.checkpoint()
        return {"pages": self.state["rendered"], "dpi": dpi, "sha256": pdf["sha256"]}

    def pdf_intent(self, value, previous_state):
        self.state["pdf_intent"] = value
        self.state["phase"] = "pdf-uncertain"
        self.checkpoint_intent(previous_state)

    def restore_pdf(self):
        intent = self.state["pdf_intent"]
        doc = self.get_document(self.state["document"]["id"])
        verify(doc["revision"] == intent["revision"] and doc["pages"] == self.state["document"]["pages"], "Document changed during PDF recovery.")
        verify(hashlib.sha256(Path(intent["path"]).read_bytes()).hexdigest() == intent["sha256"], "Local recovery PDF changed.")
        stored = doc.get("pdf")
        if stored is None:
            return {"recovered": False, "next": "retry-pdf", **self.summary()}
        verify(stored.get("sha256") == intent["sha256"] and stored.get("revision") == intent["revision"],
               "A different PDF is already stored; preserve both artifacts and reconcile with the owner.")
        self.state["pdf"], self.state["phase"] = intent, "pdf"
        self.state.pop("failed", None)
        self.checkpoint()
        return {"recovered": True, "pdf": intent, **self.render(150)}

    def dispatch(self, message):
        require(isinstance(message, dict) and message.get("op") in OPERATIONS, "Unknown receipt operation.")
        op = message["op"]
        if self.state.get("failed"):
            require(op in {"status", "release", "retry-submit", "retry-checkpoint", "retry-pdf", "reconcile", "quit"}, "Worker stopped after failure; owner direction is required to resume.")
        if op == "status":
            return self.summary()
        if op == "quit":
            return self.release()
        if op == "release":
            return self.release()
        if op == "retry-checkpoint":
            require(self.resumed and self.state["phase"] in {"draft-uncertain", "confirmation-uncertain"}, "Exact checkpoint recovery needs an explicitly resumed uncertain run.")
            return self.retry_checkpoint()
        if op == "retry-submit":
            require(self.resumed and self.state["phase"] == "submit-uncertain", "Exact submit recovery needs an explicitly resumed uncertain run.")
            body = self.load(self.state["submit_request"])
            response = json.loads(self.client.request("/api/processing/submit", (self.work / self.state["submit_request"]).read_bytes()))
            result = self.finish_submit(body, response)
            self.state.pop("failed", None)
            self.checkpoint()
            return self.summary()
        if op == "retry-pdf":
            require(self.resumed and self.state["phase"] == "pdf-uncertain", "PDF retry requires an explicitly resumed uncertain upload.")
            restored = self.restore_pdf()
            if restored["recovered"]:
                return restored
            intent, doc = self.state["pdf_intent"], self.state["document"]
            data = Path(intent["path"]).read_bytes()
            response = json.loads(self.client.request(f"/api/documents/{doc['id']}/pdf?revision={intent['revision']}", data, "application/pdf"))
            verify(response.get("sha256") == intent["sha256"] and response.get("revision") == intent["revision"], "Recovered PDF upload acknowledgement differs.")
            return self.restore_pdf()
        if op == "reconcile":
            require(self.resumed, "Reconciliation requires an explicitly resumed run.")
            if self.state["phase"] == "released" and self.state.get("failed"):
                rationale = message.get("rationale")
                require(isinstance(rationale, str) and 0 < len(rationale.strip()) <= 2000,
                        "Owner-directed recovery of a released failure requires a rationale.")
                self.record("failure-resolution", {"failure": deepcopy(self.state["failed"]), "rationale": rationale})
                self.state.pop("failed", None)
                self.checkpoint()
                return self.summary()
            if self.state["phase"] == "draft-uncertain":
                claim = self.state["claim"]
                require(time.time() * 1000 >= claim["expires"] + 210000,
                        "Draft claim may still be active; preserve it until its lease and request margin have elapsed.")
                status = self.client.get("/api/processing/readings?document_id=" + claim["document"]["id"] + "&checkpoint_token=" + claim["token"])
                verify(all(status.get(key) is False for key in ("draft_saved", "attempt_saved", "claim_active")),
                       "Checkpoint may be saved or active; preserve the uncertain draft for explicit checkpoint recovery.")
                for original in self.state["draft"]["documents"]:
                    current = self.get_document(original["id"])
                    verify(current["revision"] == original["revision"],
                           "An affected document changed; preserve the uncertain draft for review.")
                self.record("expired-unsaved-draft", {"checkpoint_unsaved": True, "claim_expired": True})
                self.state["phase"] = "released"
                self.state.pop("failed", None)
                self.checkpoint()
                return self.summary()
            if self.state["phase"] == "claim-uncertain":
                # Server leases last 20 minutes. Include request timeout and clock margin.
                require(time.time() >= self.state["claim_started"] + 20*60 + 90 + 120,
                        "Unknown claim may still be active; wait until its maximum lease window has elapsed.")
                self.state["phase"] = "released"
                self.state.pop("failed", None)
                self.checkpoint()
                return self.summary()
            if self.state["phase"] == "pdf-uncertain":
                return self.restore_pdf()
            if self.state["phase"] == "pdf-preparing":
                verify("pdf_intent" not in self.state, "PDF upload intent exists; do not regenerate.")
                self.state["phase"] = "submitted"
                self.state.pop("failed", None)
                self.checkpoint()
                return self.summary()
            if self.state["phase"] == "submit-readback":
                result = self.finish_submit(self.load(self.state["submit_request"]), self.load(self.state["submit_response"]))
            else:
                require(self.state["phase"] == "attestation-uncertain", "No uncertain attestation to reconcile.")
                doc, pdf = self.state["document"], self.state["pdf"]
                current = self.get_document(doc["id"])
                verify(current["pages"] == doc["pages"] and current["pdf"]["sha256"] == pdf["sha256"], "PDF or source pages changed during reconciliation.")
                if current["checks"]["pdf"] and current["reviewedPdfSha256"] == pdf["sha256"]:
                    self.state["document"], self.state["phase"] = current, "complete"
                else:
                    verify(current["revision"] == doc["revision"], "Document changed during attestation reconciliation.")
                    self.state["phase"] = "pdf"
                result = self.summary()
            self.state.pop("failed", None)
            self.checkpoint()
            return self.summary()
        if op == "claim":
            require(self.state["phase"] == "ready", "One claim only per worker process; start no replacement document.")
            require(message.get("viewer_checked") is True, "Open the synthetic image before claiming.")
            previous_state = deepcopy(self.state)
            self.state["phase"] = "claim-uncertain"
            self.state["claim_started"] = time.time()
            self.checkpoint_intent(previous_state)
            result = self.post("claim", {"stage": "small"})
            self.state["claim"] = result["claim"]
            self.state["phase"] = "claimed" if result["claim"] else "empty"
            if result["claim"]:
                self.discover(result["claim"]["document"])
            self.record("claim-response", result)
            return {**clean(result), **self.summary()}
        if op == "document":
            require(self.state["phase"] in {"claimed", "drafted", "submitted", "pdf", "complete"}, "No confirmed document is available.")
            if self.state["phase"] in {"claimed", "drafted"}:
                self.renew_if_needed()
            return clean(self.get_document(message["document_id"]))
        if op in {"context", "originals", "previews", "draft", "prepare", "confirm", "assess", "categories", "category", "submit", "renew"}:
            self.renew_if_needed()
        if op == "renew":
            claim = self.active()
            result = self.post("renew", {"token": claim["token"]})
            claim["expires"] = result["expires"]
            return result
        if op == "context":
            filters = message.get("filters", {})
            require(isinstance(filters, dict) and set(filters) <= {"after_capture", "date", "total_minor", "currency"}, "Unknown receipt context filter.")
            if "after_capture" in filters:
                frontier = self.state.get("lookahead_ids", [])
                require(set(filters) == {"after_capture"} and frontier and filters["after_capture"] == frontier[-1],
                        "Advance chronological context only from the last returned lookahead ID, without candidate-search filters.")
            if "date" in filters:
                require(isinstance(filters["date"], str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", filters["date"]), "Use a source-supported YYYY-MM-DD date.")
                try:
                    datetime.strptime(filters["date"], "%Y-%m-%d")
                except ValueError:
                    raise InputError("Use a real source-supported calendar date.") from None
            if "total_minor" in filters:
                require(type(filters["total_minor"]) is int and abs(filters["total_minor"]) <= 100000000000, "Use signed integer minor units.")
            if "currency" in filters:
                require(isinstance(filters["currency"], str) and re.fullmatch(r"[A-Z]{3}", filters["currency"]), "Use the source currency code.")
            from urllib.parse import urlencode
            context = self.client.get("/api/processing/context?" + urlencode({**filters, "token": self.active()["token"]}))
            self.discover(context["document"])
            for candidate in context.get("candidates", []):
                self.discover(candidate.get("document", candidate))
            for capture in context.get("previous_images", []) + context.get("next_images", []):
                expected = self.state["capture_hashes"].get(capture["id"])
                verify(expected in (None, capture["sha256"]), "Lookahead source hash changed.")
                self.state["capture_hashes"][capture["id"]] = capture["sha256"]
                if capture["id"] not in self.state["capture_ids"]:
                    self.state["capture_ids"].append(capture["id"])
                if capture.get("document_id") and capture["document_id"] not in self.state["document_ids"]:
                    self.state["document_ids"].append(capture["document_id"])
            if not filters:
                self.state["previous_ids"] = [c["id"] for c in context.get("previous_images", [])]
            if not filters or set(filters) == {"after_capture"}:
                ids = [c["id"] for c in context.get("next_images", [])]
                verify(len(ids) == len(set(ids)), "Chronological context repeated a capture; preserve this run for inspection.")
                windows = self.state.setdefault("lookahead_windows", [])
                if "after_capture" in filters:
                    seen = {cid for window in windows for cid in window["capture_ids"]}
                    verify(not seen.intersection(ids), "Chronological context did not advance; preserve this run for inspection.")
                window = {"after_capture": filters.get("after_capture"), "capture_ids": ids}
                if window not in windows:
                    windows.append(window)
                self.state["lookahead_ids"] = ids
            self.record("context", context)
            return clean(context)
        if op in {"originals", "prepare"}:
            ids = message.get("capture_ids", [])
            require(isinstance(ids, list) and 0 < len(ids) <= 100 and set(ids) <= set(self.state["capture_ids"]), "Use capture IDs discovered in the claimed context.")
            values = []
            for cid in dict.fromkeys(ids):
                self.renew_if_needed()
                if op == "originals":
                    source = self.client.original(cid, self.work / "originals")
                    verify(source["sha256"] == self.state["capture_hashes"][cid], "Original differs from the claimed source hash.")
                    self.state["sources"][cid] = source
                    values.append(source)
                else:
                    require(self.state["phase"] == "drafted", "Freeze and inspect the Luna draft before OCR preparation.")
                    require(cid in self.state["sources"], "Fetch and view original pixels before OCR preparation.")
                    retained = {layout["captureId"]: layout for layout in self.state["draft"]["layouts"]}
                    require(cid in retained, "Prepare only pages retained in the frozen Luna draft.")
                    source = self.client.prepare(cid, self.work / "ocr", crop=retained[cid]["crop"], rotation=retained[cid]["rotation"])
                    verify(source["sha256"] == self.state["capture_hashes"][cid], "OCR original differs from the claimed source hash.")
                    source["crop"] = retained[cid]["crop"]
                    self.state["prepared"][cid] = source
                    ocr = json.loads(Path(source["ocr_path"]).read_text(encoding="utf-8"))
                    values.append({**source, "text": ocr.get("text"), "lines": ocr.get("lines")})
                self.checkpoint()
            return values
        if op == "previews":
            require(self.state["phase"] == "claimed", "Review page layouts before freezing the Luna draft.")
            ids = message.get("capture_ids", [])
            overrides = message.get("layouts", {})
            require(set(message) <= {"op", "capture_ids", "layouts"}, "Unknown preview option.")
            require(isinstance(ids, list) and 0 < len(ids) <= 100 and len(ids) == len(set(ids))
                    and set(ids) <= set(self.state["capture_ids"]), "Use unique capture IDs discovered in the claimed context.")
            require(isinstance(overrides, dict) and set(overrides) <= set(ids), "Layout overrides must belong to requested pages.")
            values = []
            self.state.setdefault("layouts", {})
            for cid in ids:
                self.renew_if_needed()
                source = self.client.original(cid, self.work / "originals")
                verify(source["sha256"] == self.state["capture_hashes"][cid], "Original differs from the claimed source hash.")
                self.state["sources"][cid] = source
                page = self.page(cid)
                override = overrides.get(cid)
                if override is not None:
                    require(isinstance(override, dict) and set(override) <= {"crop", "rotation"}, "Unknown page layout option.")
                    rotation = override.get("rotation", page.get("rotation", 0))
                    require(rotation in (0, 90, 180, 270), "Page rotation must be 0, 90, 180 or 270.")
                    layout_page = {**page, "path": source["path"], "rotation": rotation, "quad": source.get("quad")}
                    if "crop" in override:
                        crop = override["crop"]
                        require(crop is None or (isinstance(crop, list) and len(crop) == 4
                                and all(type(v) is int for v in crop) and 0 <= crop[0] < crop[2] and 0 <= crop[1] < crop[3]),
                                "Page crop must be null or four ordered original-pixel integers.")
                        layout_page["crop"] = crop
                    elif page.get("crop") is None:
                        layout_page.pop("crop", None)
                else:
                    layout_page = {**page, "path": source["path"], "rotation": page.get("rotation", 0)}
                    if page.get("crop") is None:
                        layout_page.pop("crop", None)
                    layout_page["quad"] = source.get("quad")
                preview = self.client.image_pdf([layout_page], self.work / "previews")
                layout = preview["layouts"][0]
                verify(layout["captureId"] == cid and layout["sha256"] == source["sha256"], "Preview layout source differs.")
                pixels = layout.get("pixels")
                verify(isinstance(pixels, list) and len(pixels) == 2 and all(type(v) is int and v > 0 for v in pixels),
                       "Preview returned invalid source dimensions.")
                detected = layout.get("crop")
                verify(detected is None or (isinstance(detected, list) and len(detected) == 4
                       and all(type(v) is int for v in detected) and 0 <= detected[0] < detected[2] <= pixels[0]
                       and 0 <= detected[1] < detected[3] <= pixels[1]), "Preview returned invalid crop bounds.")
                require(detected is not None or (override is not None and "crop" in override and override["crop"] is None),
                        "No reliable crop was detected; review the original and explicitly choose crop bounds or raw full-page layout.")
                if override is not None and "crop" in override and override["crop"] is None:
                    layout["crop"] = [0, 0, pixels[0], pixels[1]]
                rendered = self.render_file(preview["path"], 1, 300, "crop-preview")
                self.state["layouts"][cid] = layout
                self.checkpoint()
                values.append({"captureId": cid, "preview": rendered[0], "layout": layout,
                               "pixel_pdf_sha256": preview["sha256"]})
            return values
        if op == "categories":
            return self.client.get("/api/processing/categories")
        if op == "category":
            require(isinstance(message.get("name"), str) and 0 < len(message["name"].strip()) <= 150
                    and isinstance(message.get("description"), str) and 0 < len(message["description"].strip()) <= 2000, "Category needs a bounded name and description.")
            return self.post("categories", {k: message[k] for k in ("name", "description")})
        if op == "validate":
            return self.check("validate", extraction=message["extraction"])
        if op == "draft":
            return self.draft(message)
        if op == "confirm":
            require(set(message)=={"op"} and self.state.get("draft_saved") and not self.state.get("confirmation"), "Confirm one saved initial reading.")
            frozen=self.state["draft"]
            retained={p["captureId"] for p in frozen["target"]["pages"]}
            require(retained <= self.state["prepared"].keys(), "Prepare OCR for every retained page first.")
            if self.confirmation_provider == "ppocr":
                pins = [{"capture_id":p["captureId"], "sha256":self.state["prepared"][p["captureId"]]["ocr_sha256"]}
                        for p in frozen["target"]["pages"]]
                return self.database_checkpoint("confirmation", {"token":self.active()["token"],
                    "provider":"ppocr", "pixel_pdf_sha256":frozen["pixel_pdf"]["sha256"], "artifacts":pins})
            output=self.work/("qwen-raw-"+uuid.uuid4().hex+".json")
            qwen=receipt_qwen.extract(frozen["rendered"], frozen["images"], frozen["pixel_pdf"]["sha256"], output)
            validation=self.check("validate",extraction=qwen["extraction"])
            verify(not validation["errors"],"Qwen extraction is invalid; raw response retained.")
            self.state["qwen_file"]=self.record("qwen-reading",qwen)
            return self.database_checkpoint("confirmation", {"token":self.active()["token"],**qwen})
        if op == "assess":
            require(set(message)-{"category_name"}=={"op","extraction","rationale","confirmation_sha256"} and self.state.get("confirmation") and not self.state.get("assessment"),"Assess the saved findings once, preserving both earlier readings.")
            if message["confirmation_sha256"] != self.state["confirmation"]["sha256"]:
                raise ProtocolInputError("Read the actual confirm result and assess its exact confirmation_sha256.")
            extraction=deepcopy(message["extraction"])
            validation=self.check("validate",extraction=extraction)
            if validation["errors"]: return {"assessed":False,"validation":validation}
            self.check_category(extraction, message.get("category_name"))
            rationale=message["rationale"]
            require(isinstance(rationale,str) and 0<len(rationale.strip())<=20000,"Explain corrections, retained values and unresolved disagreements.")
            initial=self.state["draft"]["extraction"]
            changed=[key for key in initial if initial[key]!=extraction[key]]
            result={"extraction":extraction,"assessment":{"confirmation_sha256":self.state["confirmation"]["sha256"],"rationale":rationale,"changed_fields":changed}}
            self.state["assessment_file"]=self.record("luna-reassessment",result)
            self.state["assessment"]=result
            self.checkpoint()
            return {"assessed":True,"changed_fields":changed,"validation":validation}
        if op == "submit":
            return self.submit(message)
        if op == "pdf":
            require(self.state["phase"] == "submitted", "Generate the PDF once after confirmed submission.")
            doc = self.state["document"]
            if not doc.get("filename") or doc.get("duplicateOf") or doc.get("mergedInto"):
                self.state["phase"] = "complete"
                return {**self.summary(), "pdf_applicable": False}
            previous_state = deepcopy(self.state)
            self.state["phase"] = "pdf-preparing"
            self.checkpoint_intent(previous_state)
            pdf = self.client.pdf(doc["id"], self.work / "pdf",
                                  before_upload=lambda value: self.pdf_intent(value, previous_state))
            require(pdf["revision"] == doc["revision"], "Document changed before PDF generation; reconcile.")
            self.state["pdf"] = pdf
            self.state["phase"] = "pdf"
            self.checkpoint()
            return {"pdf": pdf, **self.render(150)}
        if op == "render":
            return self.render(message.get("dpi", 300))
        if op == "attest":
            require(self.state["phase"] == "pdf" and self.state.get("rendered"), "Render and inspect the PDF before attestation.")
            if message["pdf_sha256"] != self.state["pdf"]["sha256"]:
                raise ProtocolInputError("Inspect the actual final PDF renders and supply their pdf_sha256.")
            evidence = message.get("evidence")
            require(message.get("all_pages_inspected") is True and isinstance(evidence, str)
                    and 0 < len(evidence.strip()) <= 2000, "Record the actual inspection of every PDF page.")
            pdf, doc = self.state["pdf"], self.state["document"]
            current = self.get_document(doc["id"])
            require(current["revision"] == doc["revision"] and current["pdf"]["sha256"] == pdf["sha256"], "Stored PDF changed; reconcile before attesting.")
            require(current["pages"] == doc["pages"] and len(current["pages"]) == pdf["pages"], "Document pages changed; reconcile.")
            require(hashlib.sha256(Path(pdf["path"]).read_bytes()).hexdigest() == pdf["sha256"], "Local PDF changed; reconcile.")
            body = {"document_id": doc["id"], "revision": doc["revision"], "sha256": pdf["sha256"], "evidence": evidence}
            previous_state = deepcopy(self.state)
            try:
                self.record("attestation-request", body)
                self.state["phase"] = "attestation-uncertain"
                self.checkpoint_intent(previous_state)
            except OSError as error:
                self.rollback_pre_request_state(previous_state)
                if isinstance(error, JournalCheckpointError):
                    raise
                raise JournalCheckpointError(error) from None
            response = self.post("pdf-review", body)
            self.record("attestation-response", response)
            final = self.get_document(doc["id"])
            require(final["checks"]["pdf"] and final["reviewedPdfSha256"] == pdf["sha256"] == final["pdf"]["sha256"], "PDF attestation readback differs; reconcile.")
            self.state["document"], self.state["phase"] = final, "complete"
            return {**self.summary(), "pdf_review_attested": True}

    def release(self):
        if self.state["phase"] in {"claimed", "drafted"}:
            result = self.post("release", {"token": self.state["claim"]["token"]})
            require(result.get("released") is True, "Claim release was not confirmed.")
            self.state["phase"] = "released"
            self.record("release", result)
            return result
        return {"released": False, "phase": self.state["phase"]}

    def preflight(self):
        access = self.client.get("/api/processing/access")
        require(access.get("version") == 2 and access.get("queueClaims") is True, "Scanner processing API v2 is required.")
        require(access.get("lunaReassessment") is True, "Deploy the Luna reassessment API before running this workflow.")
        if self.confirmation_provider == "ppocr":
            require(access.get("ppocrConfirmation") is True, "Deploy PP OCR confirmation support before processing.")
        if not (self.resumed and self.state["phase"] in {"draft-uncertain", "confirmation-uncertain"}):
            if self.confirmation_provider == "ppocr":
                self.client.ocr_backend.preflight()
            else:
                receipt_qwen.preflight()
        self.check("validate", extraction={})
        # Verify prepared packages and model assets without fetching/installing anything.
        program = '''await import("pdf-lib"); await import("esbuild");'''
        if self.confirmation_provider == "qwen":
            program += '''import {readFileSync} from "node:fs"; import {createHash} from "node:crypto";
        await import("tesseract.js");
        const assets=JSON.parse(readFileSync("model-assets.json","utf8"));
        for (const lang of ["dan","eng"]) { const name=`ocr/${lang}.traineddata.gz`;
          if(createHash("sha256").update(readFileSync(`public/vendor/${name}`)).digest("hex")!==assets[name].sha256) throw Error("Model checksum mismatch"); }
        console.log("ready");'''
        result = subprocess.run([self.node, "--input-type=module", "-e", program], capture_output=True, cwd=self.repo, env=self.env, timeout=60)
        if result.returncode:
            raise ClientError("Prepared OCR/PDF dependencies are unavailable; no download attempted.")
        result = subprocess.run([self.renderer, "-v"], capture_output=True, timeout=15, env=self.env)
        require(result.returncode == 0, "Prepared PDF renderer is unavailable.")
        return {"ready": True, "origin": self.client.origin, "confirmation_provider": self.confirmation_provider, **self.summary()}

    def handle(self, message):
        op = message.get("op") if isinstance(message, dict) else None
        try:
            self.record("input", message)
            validate_request(message)
            result = self.dispatch(message)
            self.record("result", result)
            return {"ok": True, "op": op, "result": clean(result), "at": datetime.now(timezone.utc).isoformat()}
        except JournalCheckpointError as error:
            diagnostic = error.diagnostic()
            # The journal could not record the failure, but this process must still stop.
            self.state["failed"] = {"operation": op, "error": diagnostic}
            return {"ok": False, "blocking": True, "op": op, "error": diagnostic, **self.summary()}
        except ProtocolInputError as error:
            return {"ok": False, "input_error": str(error), "op": op}
        except InputError as error:
            # If a write was already attempted, this is a workflow failure, not an editable input.
            if self.state["phase"] not in {"draft-uncertain", "confirmation-uncertain", "submit-uncertain", "submit-readback", "submitted", "pdf", "pdf-uncertain", "pdf-preparing", "attestation-uncertain", "claim-uncertain"}:
                return {"ok": False, "input_error": str(error), "op": op}
            return self.failure(op, str(error))
        except ClientError as error:
            return self.failure(op, str(error))
        except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
            return self.failure(op, "Receipt operation failed; private journal retained. No replacement claim allowed.")

    def failure(self, op, error):
        self.state["failed"] = {"operation": op, "error": error}
        self.checkpoint()
        return {"ok": False, "blocking": True, "op": op, "error": error, **self.summary()}

    def heartbeat(self):
        while not self.stop_heartbeat.wait(60):
            with self.mutex:
                if self.state["phase"] in {"claimed", "drafted"} and not self.state.get("failed"):
                    try:
                        self.renew_if_needed()
                    except (ClientError, OSError, ValueError, KeyError, InputError):
                        self.failure("renew", "Automatic claim renewal failed; stop this worker and preserve its state.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--profile", required=True, action=Once)
    parser.add_argument("--resume", action=Once)
    args = parser.parse_args()
    worker = Worker(json.loads(Path(args.profile).read_text(encoding="utf-8")), args.resume, args.profile)
    disable_console_echo()
    print(json.dumps(worker.preflight()), flush=True)
    heartbeat = threading.Thread(target=worker.heartbeat, daemon=True)
    heartbeat.start()
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_INPUT + 1)
            if not line:
                break
            if len(line) > MAX_INPUT:
                print(json.dumps(worker.failure(None, "Protocol input exceeds 512 KiB.")), flush=True)
                break
            try:
                message = json.loads(line)
            except (ValueError, UnicodeError):
                print(json.dumps({"ok": False, "input_error": "Expected one JSON object per line."}), flush=True)
                continue
            with worker.mutex:
                result = worker.handle(message)
            print(json.dumps(result, ensure_ascii=False), flush=True)
            if (isinstance(message, dict) and message.get("op") == "quit"
                    or worker.state["phase"] in {"complete", "empty"}
                    and not worker.state.get("failed") and result.get("ok") is not False):
                # A finished one-document process must release its lock without
                # relying on the model to remember a separate cleanup request.
                break
    finally:
        worker.stop_heartbeat.set()
        heartbeat.join(timeout=95)
        if worker.state["phase"] in {"claimed", "drafted"}:
            try:
                worker.release()
            except (ClientError, OSError, ValueError, InputError):
                worker.failure("release", "Unsubmitted claim could not be released; wait for expiry before resuming.")
        worker.lock.close()


if __name__ == "__main__":
    try:
        main()
    except (InputError, ClientError, OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired):
        print(json.dumps({"ok": False, "blocking": True, "error": "Worker startup or persistence failed; inspect the private profile and journal."}), flush=True)
        sys.exit(1)
