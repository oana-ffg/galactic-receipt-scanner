---
name: receipt-data-access
description: Fetch verified original scans and read or save receipt processing records through this scanner's authenticated API, without browser automation. Use for Luna/Astra processing or private exports.
---

# Receipt data access

Use `scripts/receipt_api.py` from the repository root. It performs no model inference.
Read [API access setup](../../../PROCESSING_ACCESS.md) when provisioning another host.
Load credentials through the configured secret store; never paste them into prompts,
command arguments, logs or source.

Start with `python3 scripts/receipt_api.py status`. The ignored private
`.local/processing-access.json` specifies the exact origin and gopass entry. In Work,
use `--credentials-stdin` only when an authorized secret provider can pipe the credential
JSON securely. Browser password storage is not proof of shell credential access.
A 401/403 is an access failure, not a missing original. Do not spoof identity headers.

## Read data and images

- `captures --limit 100` returns current takes, newest first. Follow `next` using `--before`.
  Enumerate the snapshot and order by `created_at,id` for oldest-first processing. Use
  `get '/api/captures?limit=100'` and its cursors for full take history.
- `get '/api/documents?summary=1&limit=50'` returns compact summaries; follow `next` with
  `after`. Use `get /api/documents/ID` for one full record and its source captures.
- `original ID` downloads into an ignored private cache, checks byte count and SHA-256,
  and returns the absolute local image path. Open that actual image with the host image
  tool. Repeated downloads reuse only verified files. Do not emit base64 as text.
- Read a capture's `artifacts` then use `get '/api/files/ID/ocr?version=SHA'` to retrieve
  a pinned attempt. Latest OCR is not necessarily an approved extraction.

## Process and save

For routine work prefer `prepare CAPTURE_ID`: it verifies the original, reuses source-matched
ordinary OCR or runs the local CPU pass, saves and verifies the OCR artifact, and returns only
paths/hashes. Inspect the original image and read the OCR JSON's text/lines without printing
its embedded PDF base64. `pdf DOCUMENT_ID` prepares missing OCR, generates from the saved page
order, uploads and verifies the searchable PDF, returning its local path and pinned hash.
These deterministic helpers make no model calls. Astra uses `original` alone before its blind
checkpoint; use prepare and read OCR only after the draft is saved.


`post /api/processing/ENDPOINT PRIVATE_JSON_FILE` submits a private JSON body. Read the
[processing contract](../receipt-processing/references/processing-api.md). Model document
changes require claim → inspect → submit. Generic machine document writes are denied;
owner browser edits remain available. Renew a claim before its 20-minute expiry. An
expired/stale claim requires rereading the current assignment, never force-saving it.

`save-ocr CAPTURE_ID PRIVATE_JSON_FILE` stores an immutable ordinary OCR artifact.
`node scripts/receipt_ocr.mjs PRIVATE_SOURCE_JSON PRIVATE_OCR_JSON` runs local Tesseract
with installed Danish/English models and no inference API. The source manifest is the
client's `original` result. Its output path must be new; keep prior artifacts for provenance.
Read back the saved artifact using its hash. Do not print the PDF-layer base64 payload.

`node scripts/receipt_pdf.mjs PRIVATE_PAGES_JSON PRIVATE_PDF` generates a searchable PDF.
The manifest contains ordered `pages` with captureId, sha256, path, rotation, crop and
ocr_path. Generate using the saved document pages; each original and OCR source hash is
checked. `save-pdf DOCUMENT_ID REVISION PRIVATE_PDF` uploads for the exact revision.
Download it using `file '/api/documents/ID/pdf?revision=N&version=SHA' SHA PRIVATE_PATH`,
inspect it, then post document_id, current revision, sha256 and inspection evidence to
`/api/processing/pdf-review`. This attests only the pinned PDF, not human review.

Version 2 exposes shared claims, private categories, model confidences and human review.
Work requires a verified secure credential pipe; a browser password store alone does not
provide shell access. No MCP server is installed by this workflow.
