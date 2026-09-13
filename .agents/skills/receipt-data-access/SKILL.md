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

## Save results

Read [the document contract](../receipt-processing/references/api.md) before editing.
`save-documents PRIVATE_JSON_FILE` accepts `{documents:[...]}` with complete records
and current revisions. A 409 requires rereading and reconciling. Page transfers include
both changed documents atomically. Original uploads and camera controls are not permitted.

`save-extraction CAPTURE_ID PRIVATE_JSON_FILE` stores immutable extraction JSON and returns
its hash. Record that hash in the private run manifest and read back the pinned artifact.
Include model, schema version, source IDs/hashes, document revision, certainty and extraction.
This stores unverified evidence; it does not promote a record to reviewed accounting data.

`save-pdf DOCUMENT_ID REVISION PRIVATE_PDF_FILE` uploads a generated PDF for that revision.
Follow the processing skill for generation and visual verification. Download a pinned PDF
with `file /api/documents/ID/pdf?revision=N&version=SHA SHA PRIVATE_DESTINATION`
(quote the API path in the shell). The client verifies its expected SHA and never overwrites
a different existing artifact.

Check `status` capabilities. Version 1 has no database queue claims or category registry.
Do not invent endpoints or enable overlapping scheduled runs. A single assigned batch can
use the private extraction ledger. Shared queue and review rollout are separate.
