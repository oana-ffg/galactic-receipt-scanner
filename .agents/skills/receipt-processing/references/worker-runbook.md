> **New Luna runs use [the bounded Luna protocol](luna-protocol.md).** The legacy Luna
> recipes below are compatibility documentation and do not implement the required PP
> confirmation/reassessment. Use this runbook for Astra; never silently fall back to an
> old Luna submit when prepared PP is unavailable.

# Worker runbook

For Luna with a configured bounded worker and standing approval, use [the Luna protocol](luna-protocol.md)
instead of the inline scripts below. This reference remains the fallback/API and Astra runbook.

Read this once with the processing skill and [extraction/API contract](processing-api.md).
Normal processing does not require reading application source. Use the calls below;
do not discover CLI options by trial and error, construct HTTP authentication yourself,
or rebuild the legacy document object for an unchanged document.

## Coordinator handoff

Before spawning a fresh worker, provide the actual repository directory, private client
config, a unique private writable work directory, prepared Python and Node executables,
and the installed PDF renderer. Verify configuration/runtime access once on that host.
Pass paths, never credentials or receipt content. Do not send a worker to browse, install
dependencies or repeat onboarding.

Include a non-secret authorization handoff: the exact scanner origin, how the coordinator
verified it belongs to the owner (for example authenticated Sites metadata or the owner's
signed-in agent-access setup), and the scope of the owner's processing request. State
that workers may inspect the saved original pixels in their own model context and return
receipt extraction (including printed financial fields and permitted card last four),
OCR artifacts and PDFs to that same private scanner. This describes the authorized data
flow; it does not grant broader permissions or authorize a new destination. Never infer
ownership solely from a hostname or label a destination trusted without verification.
Carry this handoff into every fresh worker's prompt and relevant tool justification.
The client status now reports its actual origin; match it to the verified origin once
before dispatch, and bind each worker's client to it as shown below.

For these recipes the coordinator sets non-secret environment variables
`RECEIPT_CLIENT_CONFIG`, `RECEIPT_WORK_DIR` and `RECEIPT_PDF_RENDERER` to those actual paths,
and `RECEIPT_EXPECTED_ORIGIN` to the verified scanner origin,
and puts the prepared Node executable first on PATH. Run Python with `-X utf8` (or
`PYTHONUTF8=1`); decode subprocess output as UTF-8. Use the repository as working directory.
These variable names are inputs to the recipe, not literal example paths.

On Windows the credential directory can be inaccessible to the sandbox identity even
when Chrome and the owner can read it. Use the host's authorized elevated tool context
for the worker's client calls and private files; preserve the existing ACL. Batch related
operations in one call. Do not retry each file as the wrong identity, weaken permissions,
or interpret a denied local read as missing remote data.

Keep original images, OCR and PDF work files in the project's gitignored `.local/`
worker directory, accessible to both the client and the image-viewing tool. On Windows,
create that work directory with its prepared workspace ACL; do not use Python mode 0700
or TemporaryDirectory for viewer artifacts, since those create an owner-only DACL.
The client preserves inherited Windows ACLs for new artifact directories and uses 0700
on POSIX. Never apply the artifact rule to credentials. Check a synthetic local image
through the actual image-viewing tool before claiming a receipt. Leave old inaccessible
caches intact; use a fresh authorized work directory rather than changing their ACLs.

## Hosts with standing command approvals

If the owner has configured narrow command allow rules, the coordinator must supply the
exact approved CLI invocation: absolute runtime/client/config paths, argument order and
allowed operation. Invoke that command directly through the shell tool. Calling the
client from a changing inline Python script does not match a rule for its CLI invocation.
Never broaden an approval to all Python or shell execution.

For a covered submit or PDF-review operation, use the recipes below to write the private
request file first, then call `receipt_api.py --config PRIVATE_CLIENT_CONFIG post
PROCESSING_API_PATH PRIVATE_JSON_FILE` with the supplied runtime and exact arguments.
Save the returned JSON privately and continue the recipe's readback checks; do not also
execute its `post_saved` call. The `pdf DOCUMENT_ID` CLI is the corresponding generation
operation and uses the default ignored `.local/receipt-api` cache. Uncovered operations
retain the normal approval flow. Standing approvals are host configuration, not credentials
or a cloud capability to assume. Never put an owner's paths or connection in tracked rules.

## Reuse the existing client

For a later Astra audit on the saved-PP processing host, the coordinator also supplies
`RECEIPT_WORKER_PROFILE`. After constructing `client` in the common prelude, configure
the artifact-only reader before any saved-OCR or PDF call:

```python
profile_path = os.environ["RECEIPT_WORKER_PROFILE"]
client.configure_saved_ppocr(profile_path)
```

This can only reuse saved PP artifacts; the profile contains no inference runtime. An
unconfigured standalone client refuses OCR/PDF generation; Tesseract is never a fallback.

The Python API exposes the same implementation as the CLI, with less shell quoting and
no model copying of tokens/hashes. Keep this prelude in a private worker script/session.
Variables persist only in that script/session; across processes reload the saved JSON
files. Execute each phase deliberately, not the entire sequence again on every retry.

```python
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlencode

sys.path.insert(0, str(Path.cwd() / "scripts"))
from receipt_api import ScannerClient, credentials, write_new_file

work = Path(os.environ["RECEIPT_WORK_DIR"]).resolve()
assert work.is_dir(), "Coordinator must provide a private writable work directory"
client = ScannerClient(credentials(os.environ["RECEIPT_CLIENT_CONFIG"]))
assert client.origin == os.environ["RECEIPT_EXPECTED_ORIGIN"], "Scanner destination differs from verified handoff"

def load(name):
    return json.loads((work / name).read_text(encoding="utf-8"))

def save(name, value):
    write_new_file(work / name, json.dumps(value, ensure_ascii=False).encode("utf-8"))

def post_saved(route, request_name, response_name):
    result = json.loads(client.request(route, (work / request_name).read_bytes()))
    save(response_name, result)
    return result
```

### Pixel-only previews for the fallback path

Use the prepared PDF layout code before any OCR, including Astra's independent reading.
`client.image_pdf(pages, directory)` creates no searchable layer and makes no server write.
Its page inputs contain verified `path`, `captureId`, `sha256`, `rotation`, and the
source's saved `quad`. The preview derives the scan crop from that outline. Keep returned
`layouts` for OCR/PDF verification; do not write a crop into document page records.

```python
def preview_pages(pages, sources, label):
    by_id = {source["capture_id"]: source for source in sources}
    inputs = []
    for page in pages:
        source = by_id[page["captureId"]]
        assert source["sha256"] == page["sha256"]
        item = {**page, "path": source["path"], "quad": source.get("quad")}
        item.pop("crop", None)  # Ignore historical document crop.
        inputs.append(item)
    result = client.image_pdf(inputs, work / label)
    save(label + "-layout.json", result)
    prefix = work / label / "page"
    subprocess.run([os.environ["RECEIPT_PDF_RENDERER"], "-r", "300", "-jpeg",
                    result["path"], str(prefix)], check=True)
    renders = sorted((work / label).glob("page-*.jpg"))
    assert len(renders) == len(pages)
    print(json.dumps({"previews": [str(path) for path in renders]}))
    return result
```

Open every returned scan crop preview by default. Raw `source["path"]` remains available
when a scan crop, grouping or completeness question requires it. For lookahead, construct
provisional page objects from source IDs/hashes with rotation 0; a preview is not a
grouping decision. Report an incorrect scan crop to the owner; do not change it here.

Files are created without overwriting earlier attempts. Use a new attempt filename after
a rejected request. Do not print credentials, the claim token, full OCR JSON (which contains
base64 PDF text layers), or financial payloads into the coordinator's context.

### 1. Claim once, then get context and categories (Luna)

```python
save("claim-request.json", {"stage": "small"})
result = post_saved("/api/processing/claim", "claim-request.json", "claim-response.json")
claim = result["claim"]
if claim is None:
    print(json.dumps({"stopped": result["reason"]}))
    raise SystemExit(0)
context = client.get("/api/processing/context?" + urlencode({"token": claim["token"]}))
save("context-response.json", context)
save("categories.json", client.get("/api/processing/categories"))
```

The assignment is `claim["document"]`; its pages use `captureId`, not `capture_id`.
Context returns `document`, `next_images`, `candidates`, rejected associations and
truncation flags. Category listing is a JSON array, not an object with a `categories` key.
Stop on a null claim. Never obtain a second claim to check the first one's status.

### 2. Verify sources and inspect crop previews

```python
claim = load("claim-response.json")["claim"]
context = load("context-response.json")
capture_ids = list(dict.fromkeys(
    [p["captureId"] for p in claim["document"]["pages"]]
    + [p["id"] for p in context["next_images"]]
))
sources = [client.original(cid, work / "originals") for cid in capture_ids]
save("originals.json", sources)
```

Call `preview_pages` for the claimed pages and discovered lookahead, then inspect the
returned crop images using your own vision. Original results verify source size/hash
and include `scanned_at`; loading them privately does not require viewing full photos.
Lookahead is inspection only; fetching an image does not attach or consume it. Inspect
related candidates as required by the grouping rules; leave unrelated pages unconsumed.

After visual grouping and saving `extraction-first-reading.json`, call `preview_pages`
on exactly the retained ordered pages to freeze the image-only document PDF. Save its
layouts for verification, without changing document page records. Only then run
`client.prepare(capture_id, work / "ocr",
rotation=final_page["rotation"], allow_inference=False)` for every retained page and save
the returned metadata. This reuses only source/region-matched saved PP-OCRv6 and verifies
its readback. Read only the OCR `text`/`lines` needed for comparison, never dump
`text_only_pdf_layers`. Missing exact-layout PP stops the review and returns the claim to
the queue; the dedicated OCR host handles it separately. No OCR inference, installation
or model download is part of this phase.

For more lookahead, use `urlencode` with the existing token and `after_capture`.
For historical candidates add source-read `date`, `total_minor`, `currency`.
Copy IDs and page records from the returned objects. Candidate matching is limited to
previously extracted documents; an empty result does not prove that no unprocessed match
exists. Preserve uncertainty and truncation warnings.

### 3. Write and validate extraction, then submit

Write `extraction.json` from your pixel inspection using every field in
[the extraction contract](processing-api.md#parse). Do not write a legacy document
record or server-derived processing flags into it. Reuse category IDs from the registry;
create a category only when needed through the documented category endpoint.

Run the actual local validator without reading its source. This command uses the
prepared Node executable and the same `RECEIPT_WORK_DIR`:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {join} from "node:path"; import {extractionErrors,arithmetic} from "./web/extraction.ts"; const e=JSON.parse(readFileSync(join(process.env.RECEIPT_WORK_DIR,"extraction.json"),"utf8")); const errors=extractionErrors(e); console.log(JSON.stringify({errors,arithmetic:errors.length?null:arithmetic(e)})); process.exitCode=errors.length?1:0;'
```

Arithmetic output is comparison evidence, not permission to change printed digits.
Correct malformed fields locally before a production POST. Complete the frozen-layout
and OCR sequence above before submission. The abbreviated call below applies only when
grouping AND saved rotation are unchanged. Otherwise include copied document records
with the exact finalized page layouts, as in the grouping recipe, even if no pages move:

```python
claim = load("claim-response.json")["claim"]
save("submit-request.json", {
    "token": claim["token"],
    "model": "gpt-5.6-luna",
    "extraction": load("extraction.json"),
})
result = post_saved("/api/processing/submit", "submit-request.json", "submit-response.json")
assert any(row["id"] == claim["document"]["id"] for row in result["saved"])
doc = client.get("/api/documents/" + claim["document"]["id"])["document"]
save("document-after-submit.json", doc)
```

A successful submit closes the claim. Do not renew/release a completed claim or submit
the extraction again to record PDF review. If grouping changes, follow the complete-record
recipe under [Grouping call recipe](#grouping-call-recipe) and the [grouping contract](processing-api.md#grouping-changes) before creating the request.
Keep exact request bytes for an idempotent retry after an unknown/lost response.

### 4. Generate, inspect and attest the PDF

After submit, only generate if the saved document has a non-null `filename` and is
neither merged nor duplicate. Unknown source date/vendor stays unresolved.

```python
doc = load("document-after-submit.json")
pdf = client.pdf(doc["id"], work / "pdf")
save("pdf-result.json", pdf)
subprocess.run([
    os.environ["RECEIPT_PDF_RENDERER"], "-r", "150", "-png",
    pdf["path"], str(work / "pdf-page"),
], check=True)
```

`client.pdf` already prepares missing OCR, generates in saved page order, uploads, and
checks the server-computed hash and acknowledged revision. The server responds only after
storing the received PDF and its metadata. Its result includes `filename`, `revision`,
`sha256`, `path`, `pages` and `searchable`; `path` is the generated local PDF. Render and
inspect that same file. Do not regenerate or download it again on success. Use the
client's pinned `file` command only for an explicit retrieval-path check or when the
verified local file is unavailable. Rendering uses the already installed Poppler
`pdftoppm`; do not install a renderer inside the worker.

Inspect every rendered page against the originals, increasing resolution/zoom when
necessary to judge small print. Only after inspection, write the actual findings into
private `pdf-inspection.txt`. Evidence must be a nonempty string of at most 2,000
characters, not a JSON object or checklist. Then:

```python
doc = load("document-after-submit.json")
pdf = load("pdf-result.json")
fresh = client.get("/api/documents/" + doc["id"])["document"]
assert fresh["revision"] == doc["revision"], "Document changed; reconcile and re-inspect"
assert fresh["pdf"]["sha256"] == pdf["sha256"], "Stored PDF changed; re-inspect"
assert hashlib.sha256(Path(pdf["path"]).read_bytes()).hexdigest() == pdf["sha256"]
evidence = (work / "pdf-inspection.txt").read_text(encoding="utf-8").strip()
assert 0 < len(evidence) <= 2000
save("pdf-review-request.json", {
    "document_id": fresh["id"], "revision": fresh["revision"],
    "sha256": pdf["sha256"], "evidence": evidence,
})
post_saved("/api/processing/pdf-review", "pdf-review-request.json", "pdf-review-response.json")
final = client.get("/api/documents/" + fresh["id"])["document"]
assert final["checks"]["pdf"] and final["reviewedPdfSha256"] == pdf["sha256"]
save("final-document.json", final)
print(json.dumps({
    "document_id": final["id"], "revision": final["revision"], "status": final["status"],
    "pages": len(final["pages"]), "pdf_review_attested": True,
}, ensure_ascii=True))
```

Use the current document revision for attestation. `document.pdf.revision` identifies
the artifact version and can differ after a later attestation increments the document.
Read/write hashes from JSON variables; never retype one from model text. An attestation
request file alone is not proof of success. Do not start another worker in this batch before this phase finishes. Other batches may
process different documents; a claim or reservation on this document blocks attestation.
Keep the same private client config (including `processing_session`, when supplied) through
claim, PDF upload, attestation and final verification.

## Lease and recovery

A worker failure stops the coordinator's entire batch as specified in the processing
skill. Return the failed operation and safe metadata; do not ask a new worker to retry.
An automatic approval rejection is a blocking error: preserve the request privately,
report the reviewer's non-sensitive stated reason, and stop for owner direction.

Before 20-minute expiry, save a new renewal request with the token loaded from
`claim-response.json`, POST `/api/processing/renew`, and retain the returned `expires`
(epoch milliseconds). Renew only while the claim is still active. If abandoning unused
work, POST `/api/processing/release` with that same token and verify `released:true`.
Do not print the token or embed it in shell arguments; construct context URLs inside Python.

| Result | Next action |
| --- | --- |
| Wrong CLI argument / malformed JSON / HTTP 400 | Check the exact tables and local validator; preserve the rejected request. Fix the concrete field in a new attempt. |
| Local access denied | Use the coordinator-provided authorized execution identity. Preserve ACLs and files; report an unavailable identity instead of looping. |
| HTTP 401/403, including gateway denial | Stop and report access failure. Reuse the configured client; do not switch to ad hoc HTTP headers, browser cookies or new credentials. |
| HTTP 409 while a claim is active | Check saved expiry/current assignment. Do not guess revisions or force a write; return a bounded conflict to the coordinator if reconciliation is unsafe. |
| Submit response lost | Replay the exact saved request with the same token; a changed payload is not an idempotent retry. No new claim. |
| PDF-review HTTP 409 | Check current revision, pinned PDF and whether another worker has a claim. Preserve the PDF; report deferred attestation if busy. Do not create a new claim. |
| Incorrect PDF hash | Reload `pdf-result.json` and compute the local file hash programmatically; never hand-correct a hash string. |
| Missing OCR/renderer/runtime | Report setup failure to the coordinator; do not install a substitute. |
| A second failure without a new diagnosis | Preserve state and return the concrete failed operation to the coordinator; do not start reading broad source files or trying command variants. |

Report short stage updates when requested and at claim, submit and PDF completion,
without receipt contents. Record UTC timestamps at worker start, claim response, submit,
PDF attestation and completion. Do not estimate total runtime from one processing phase.

## Astra differences

Astra uses `stage:"large"` and `model:"gpt-6-astra"`. Before its immutable draft,
download originals only and inspect them with its own vision; do not run prepare, read
prior OCR/document results, or fetch context. Categories are available for the blind parse.
POST `/api/processing/draft` with the loaded token, actual model and independently written
extraction; require `saved:true`. Then fetch context, run/reuse OCR, compare against the
original pixels and submit, supplying a concrete `ocr_resolution` string only when
independently resolved. Follow the same PDF and completion checks. Detailed review and
detach requirements remain in [model-workers.md](model-workers.md).


## Grouping call recipe

For changed grouping, replace the unchanged-grouping submit block with this recipe.
After visual selection, save private `grouping-selection.json` with `donor_ids` and
ordered `retained_capture_ids`, populated programmatically from actual returned records,
plus a nonempty `evidence` string describing the observed match. This is the worker's
grouping decision, not a new API body. Include every donor whose selected pages move.
The recipe supports full and partial transfers; all original target pages remain.
It conservatively carries earlier review reasons using the installed shared validator
and preserves handwriting observations. Resolve carried reasons on the retained document
in a later review; do not discard them during a merge. The prepared repository's existing
esbuild is required for this shared check; no installation is part of a worker run.
For detachment/duplicates instead follow the specific API rules, not this merge recipe.

```python
from copy import deepcopy
claim = load("claim-response.json")["claim"]
selection = load("grouping-selection.json")
target = deepcopy(client.get("/api/documents/" + claim["document"]["id"])["document"])
assert target["revision"] == claim["document"]["revision"]
donor_ids = selection["donor_ids"]
assert donor_ids and len(set(donor_ids)) == len(donor_ids) and target["id"] not in donor_ids
donors = [deepcopy(client.get("/api/documents/" + did)["document"]) for did in donor_ids]
before = deepcopy([target] + donors)
stage = claim["stage"]
model = {"small": "gpt-5.6-luna", "large": "gpt-6-astra"}[stage]
extraction = load("extraction.json" if stage == "small" else "astra-reconciled-extraction.json")
assert all(not d["mergedInto"] and not d["duplicateOf"] for d in before)
pages = {p["captureId"]: p for d in before for p in d["pages"]}
assert len(pages) == sum(len(d["pages"]) for d in before)
selected = selection["retained_capture_ids"]
assert len(selected) == len(set(selected)) and set(selected) <= pages.keys()
assert {p["captureId"] for p in target["pages"]} <= set(selected)
evidence = selection["evidence"]
assert isinstance(evidence, str) and evidence.strip()

target["pages"] = [deepcopy(pages[cid]) for cid in selected]
target["duplicateOf"] = target["mergedInto"] = None
for donor in donors:
    moved = {p["captureId"] for p in donor["pages"]} & set(selected)
    assert moved, "Every supplied donor must contribute selected pages"
    target["annotations"].extend(a for a in donor["annotations"] if a["captureId"] in moved)
    donor["annotations"] = [a for a in donor["annotations"] if a["captureId"] not in moved]
    donor["pages"] = [p for p in donor["pages"] if p["captureId"] not in moved]
    if not donor["pages"]:
        donor["mergedInto"] = target["id"]
        donor["handwriting"] = "unchecked"
    # A partial donor keeps its prior handwriting observation for later reinspection.
for d in [target] + donors:
    d["checks"] = dict(visual=False, transcription=False, grouping=False, pdf=False)
    d["invoice"] = d["reviewedPdfSha256"] = None
    d["evidence"] = "\n".join(filter(None, [d["evidence"], evidence]))
# Use the actual shared reason logic, including legacy invoice mismatch reasons.
reason_program = """
import {build} from "esbuild";
const built = await build({entryPoints:["web/documents.ts"],bundle:true,
  platform:"node",format:"esm",write:false});
const {mergeReviewReasons} = await import(
  "data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
let input=""; for await (const chunk of process.stdin) input+=chunk;
console.log(JSON.stringify(JSON.parse(input).map(mergeReviewReasons)));
"""
reason_result = subprocess.run(["node", "--input-type=module", "-e", reason_program],
    input=json.dumps(before), capture_output=True, text=True, encoding="utf-8", check=True)
reasons = json.loads(reason_result.stdout)
for field, source_field in [("uncertainties", "uncertainties"), ("broken_reasons", "broken")]:
    extraction[field] = list(dict.fromkeys(
        extraction[field] + [r for item in reasons for r in item[source_field]]
    ))
# Submission derives evidence/handwriting/reasons from extraction, overwriting target fields.
extraction["evidence"] = "\n".join(dict.fromkeys([extraction["evidence"], evidence]))
assert 0 < len(extraction["evidence"]) <= 20000
target["evidence"] = extraction["evidence"]
known_present = any(d["handwriting"] == "present" or d["annotations"] for d in before)
assert not known_present or extraction["has_handwriting"], "Reconcile preserved handwriting against originals"
if any(d["handwriting"] in ("uncertain", "unchecked") for d in before):
    note = "Retained source grouping includes an unresolved handwriting-presence observation."
    extraction["uncertainties"] = list(dict.fromkeys(extraction["uncertainties"] + [note]))
    if extraction["certainty"] == "high":
        extraction["certainty"] = "medium"
target["handwriting"] = "present" if extraction["has_handwriting"] else "absent"
target["uncertainties"] = extraction["uncertainties"]
target["broken"] = extraction["broken_reasons"]
assert len(extraction["uncertainties"]) <= 100 and len(extraction["broken_reasons"]) <= 100
changed = [target] + donors
assert len(changed) <= 20 and all(len(d["pages"]) <= 100 for d in changed)
after_ids = [p["captureId"] for d in changed for p in d["pages"]]
assert len(after_ids) == len(set(after_ids)) and set(after_ids) == pages.keys()
request = {"token": claim["token"], "model": model,
           "extraction": extraction, "documents": changed}
resolution_path = work / "ocr-resolution.txt"
if stage == "large" and resolution_path.exists():
    resolution = resolution_path.read_text(encoding="utf-8").strip()
    assert 0 < len(resolution) <= 20000
    request["ocr_resolution"] = resolution
save("submit-request.json", request)
assert (work / "submit-request.json").stat().st_size <= 512 * 1024
result = post_saved("/api/processing/submit", "submit-request.json", "submit-response.json")
if not result.get("replayed"):
    assert {d["id"] for d in changed} <= {r["id"] for r in result["saved"]}
verified = []
for expected in changed:
    saved = client.get("/api/documents/" + expected["id"])["document"]
    assert saved["revision"] == expected["revision"] + 1
    assert saved["pages"] == expected["pages"]
    assert saved["annotations"] == expected["annotations"]
    assert saved["mergedInto"] == expected["mergedInto"]
    verified.append(saved)
save("grouping-readback.json", verified)
save("document-after-submit.json", next(d for d in verified if d["id"] == target["id"]))
```

If any verification fails, preserve the response and stop for reconciliation; never
repeat the grouping against newly incremented revisions. For a lost response replay only
the saved request, then perform readback using the saved request's documents.


### Exact Astra checkpoint and reconciliation calls

Use the common prelude, then this claim block instead of Luna's claim/context block:

```python
save("claim-request.json", {"stage": "large"})
result = post_saved("/api/processing/claim", "claim-request.json", "claim-response.json")
claim = result["claim"]
if claim is None:
    print(json.dumps({"stopped": result["reason"]}))
    raise SystemExit(0)
sources = [client.original(p["captureId"], work / "originals")
           for p in claim["document"]["pages"]]
save("originals.json", sources)
save("categories.json", client.get("/api/processing/categories"))
```

Call `preview_pages(claim["document"]["pages"], sources, "astra-independent")` and
inspect every returned scan crop with your own vision; use raw originals when needed.
Do not fetch context or OCR yet. Keep the scan crop outside the document record.
After the independent visual reading, write `astra-draft-extraction.json` and validate
it with the same local validator, changing only its input filename. Then:

```python
claim = load("claim-response.json")["claim"]
save("draft-request.json", {
    "token": claim["token"], "model": "gpt-6-astra",
    "extraction": load("astra-draft-extraction.json"),
})
draft = post_saved("/api/processing/draft", "draft-request.json", "draft-response.json")
assert draft["saved"] is True
context = client.get("/api/processing/context?" + urlencode({"token": claim["token"]}))
save("context-response.json", context)
```

Now prepare/read OCR and compare context against the originals. Preserve the blind file.
Write and locally validate **astra-reconciled-extraction.json** separately. If resolving
an OCR discrepancy from pixels, write actual findings into `ocr-resolution.txt`;
otherwise leave that file absent. For unchanged grouping:

```python
claim = load("claim-response.json")["claim"]
request = {
    "token": claim["token"], "model": "gpt-6-astra",
    "extraction": load("astra-reconciled-extraction.json"),
}
resolution_path = work / "ocr-resolution.txt"
if resolution_path.exists():
    resolution = resolution_path.read_text(encoding="utf-8").strip()
    assert 0 < len(resolution) <= 20000
    request["ocr_resolution"] = resolution
save("submit-request.json", request)
result = post_saved("/api/processing/submit", "submit-request.json", "submit-response.json")
assert any(row["id"] == claim["document"]["id"] for row in result["saved"])
save("document-after-submit.json",
     client.get("/api/documents/" + claim["document"]["id"])["document"])
```

For a visually justified merge during a claimed review, use the grouping recipe instead
of this submit block; it selects the actual model, reconciled extraction and optional
resolution from claim.stage. A direct owner-requested detach needs no claim; if the
document is already claimed, finish or release that claim before editing. Successful submission continues
with the common PDF generation, inspection and attestation phase.
