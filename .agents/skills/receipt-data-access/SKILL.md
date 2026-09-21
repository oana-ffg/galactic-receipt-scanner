---
name: receipt-data-access
description: Fetch verified original scans and read or save receipt processing records through this scanner's authenticated API, without browser automation. Use for Luna/Astra processing or private exports.
---

# Receipt data access

Use `scripts/receipt_api.py` from the repository root. It performs no model inference.
Read [API access setup](../../../PROCESSING_ACCESS.md) when provisioning another host.
Load credentials through the private connection config; never paste them into prompts,
command arguments, logs or source.

Reuse coordinator-supplied paths or the repository's ignored
`.local/processing-host.json` (`python`, `worker_profile`) for the deterministic Luna
controller and Astra processing. The referenced saved-PP consumer profile contains the
owner-verified origin, Node and renderer, but no credential config or OCR engine/models.
OCR production separately uses
`.local/receipt-ocr-host.json`. Keep these descriptors
local to its host; do not commit it or ask the owner to supply paths that it already stores.

Connection setup establishes the owner-verified Site origin. The deterministic controller
loads the protected profile, requires its origin and repository to match the prepared host,
and verifies scoped API capabilities before claiming work. A credential config alone is not
independent proof of ownership. Terra and delegated Luna repeat none of this: Luna reads only
its prepared private task and optional verified preview paths; it does not launch Python,
inspect protected profiles or retrieve keys. The controller receives the fresh batch config
path and loads it without exposing secrets.
The connection helper creates a private config referring to its protected credential file.
There is no gopass dependency. `--credentials-stdin` supports an explicitly authorized
secret provider for optional personal integrations; browser password storage is not
proof of shell credential access.
A 401/403 is an access failure, not a missing original. Do not spoof identity headers.

## Authorize a connection

1. Resolve the Site's exact HTTPS origin. Create a new ignored private directory with
   `node scripts/receipt_connection.mjs init PRIVATE_DIRECTORY SITE_ORIGIN CONNECTION_NAME processing 1`.
   Its output contains only a public-key request and paths. The private key remains on
   this host. On Windows, keep the directory in the user's private profile and ensure
   other users cannot read it; POSIX private file modes are enforced by the helper/client.
2. As the coordinator, open the normal `/agent-access` page in the owner's signed-in browser.
   Invoke its `create_processing_connection` WebMCP tool with the returned `request`
   object unchanged. The normal owner UI also accepts `request.json` when site tools
   are unavailable.
3. Pipe the tool's encrypted JSON result to
   `node scripts/receipt_connection.mjs complete-stdin PRIVATE_DIRECTORY`.
   Only this helper decrypts it. It prints the client config path, connection ID and expiry,
   never keys; no plaintext response file is needed.
4. Pass that config path to the deterministic controller with `--client-config`. The
   controller performs the real access preflight before claiming work. Terra and Luna do not
   duplicate it. All client commands accept `--config` before the subcommand.
5. In a `finally` cleanup for every batch outcome, use the signed-in page's
   `revoke_processing_connection` tool for that exact connection ID. Only after it returns
   `revoked:true`, run `node scripts/receipt_connection.mjs destroy PRIVATE_DIRECTORY`.
   This removes the temporary plaintext credential/config and key material. If revocation
   cannot be confirmed, retain the private directory for exact owner recovery. The one-day
   server expiry is a crash fallback, never the normal lifecycle.

Local Codex is the current test environment. Cloud Work's browser/tool availability and
private-file persistence need later end-to-end validation; do not block local iteration
or claim cloud readiness prematurely. If the page says Sites access is not configured,
follow PROCESSING_ACCESS.md; never export cookies or make the Site public.

For a Luna controller host configured with the bounded worker, follow
[the Luna protocol](../receipt-processing/references/luna-protocol.md) for every processing
operation. The controller uses this client internally and keeps tokens out of model output.

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

For OCR-producer work under the receipt-ocr-nightly skill, `prepare CAPTURE_ID` verifies the
original, reuses source-matched PP-OCRv6 or runs the dedicated prepared PP pass, saves and
verifies the OCR artifact, and returns only paths/hashes. The Luna controller uses the
bounded worker's saved-PP reader instead and never invokes inference. `pdf DOCUMENT_ID` requires matching
saved OCR and generates from the saved page
order, uploads it, and verifies the server-computed hash and acknowledged revision,
returning the generated local path and acknowledged hash without downloading it again.
These deterministic helpers make no model calls. Astra uses `original` alone before its blind
checkpoint; use prepare and read OCR only after the draft is saved.

Put working images and derivatives under a gitignored `.local/` directory with the
prepared workspace's access permissions, separate from protected credentials. New
Windows artifact directories inherit their parent's ACL so the sandbox image viewer can
read them; POSIX artifact directories remain owner-only. Verify the parent is private
and authorized for processing, and preflight image viewing before taking a queue claim.

`post /api/processing/ENDPOINT PRIVATE_JSON_FILE` submits a private JSON body. Read the
[processing contract](../receipt-processing/references/processing-api.md). Model document
changes require claim → inspect → submit. Generic machine document writes are denied;
owner browser edits remain available. Renew a claim before its 20-minute expiry. An
expired/stale claim requires rereading the current assignment, never force-saving it.

`save-ocr CAPTURE_ID PRIVATE_JSON_FILE` stores an immutable ordinary OCR artifact.
PP-OCRv6 is the standard for all new OCR and searchable PDFs. `prepare` and `pdf`
use distinct profiles: `prepare` discovers `.local/receipt-ocr-host.json` and may infer;
`pdf` discovers `.local/processing-host.json` and can only consume saved PP. Python OCR
producers call `client.configure_ppocr(profile_path)`; Luna controllers call
`client.configure_saved_ppocr(profile_path)`. Missing matching PP is an OCR-queue item,
never permission to fall back to Tesseract or install an engine during a receipt run.
Retain older Tesseract artifacts as historical evidence. Browser PDF
generation only reads matching saved PP and reports pending when PP has not run.
Only the dedicated OCR host produces new OCR; there is no browser OCR button or tool.
Read back the saved artifact using its hash. Do not print the PDF-layer base64 payload.

`node scripts/receipt_pdf.mjs PRIVATE_PAGES_JSON PRIVATE_PDF` generates a searchable PDF.
The manifest contains ordered `pages` with captureId, sha256, path, rotation, crop and
ocr_path. Generate using the saved document pages; each original and OCR source hash is
checked. `save-pdf DOCUMENT_ID REVISION PRIVATE_PDF` uploads for the exact revision.
Compare the upload response hash with the local PDF and require the acknowledged revision
to match, inspect that same local file, then post document_id, current revision, sha256 and inspection evidence to
`/api/processing/pdf-review`. This attests only that PDF hash, not human review.
Use `file '/api/documents/ID/pdf?revision=N&version=SHA' SHA PRIVATE_PATH` for an
explicit retrieval check or when the verified local PDF is unavailable.

Version 2 exposes shared claims, private categories, model confidences and human review.
The encrypted browser handoff provides API credentials independently of browser password
storage. No remote MCP server installation is needed for this WebMCP workflow.

## Exact command forms

Use the coordinator-provided Python executable with `-X utf8` on Windows. All forms
below follow `scripts/receipt_api.py --config PRIVATE_CLIENT_CONFIG`; uppercase names
denote actual supplied paths/IDs, never values to invent. The global --config option
goes **before** the subcommand.

| Subcommand                                          | Result / constraint                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                            | Connection capabilities; the deterministic controller preflight verifies them once per run.                                                  |
| `get API_PATH`                                      | Parsed JSON; construct token-bearing paths inside Python instead of shell arguments.                                                         |
| `post PROCESSING_API_PATH PRIVATE_JSON_FILE`        | POSTs the saved JSON bytes; use /api/processing/ routes.                                                                                     |
| `original CAPTURE_ID --directory PRIVATE_DIRECTORY` | Verified original path/hash; --directory is optional here.                                                                                   |
| `prepare CAPTURE_ID`                                | OCR-host operation: verified original and stored OCR paths/hashes, using `receipt-ocr-host.json`. **No --directory CLI option.**             |
| `pdf DOCUMENT_ID`                                   | Saved-PP consumer operation: generated local PDF with server-acknowledged hash/revision; it never infers OCR. **No --directory CLI option.** |
| `file API_PATH SHA256 PRIVATE_DESTINATION`          | Hash-verified bytes for a pinned artifact.                                                                                                   |
| `save-ocr CAPTURE_ID PRIVATE_JSON_FILE`             | Advanced manual upload; prepare already does this.                                                                                           |
| `save-pdf DOCUMENT_ID REVISION PRIVATE_PDF`         | Advanced manual upload; pdf already does this.                                                                                               |

There are no claim/context/categories CLI subcommands; use get/post or the existing
Python client. For per-worker cache directories, Python `client.prepare(id,directory)`
and `client.pdf(id,directory)` accept that argument. Follow the
[worker runbook](../receipt-processing/references/worker-runbook.md) for copying IDs,
tokens, revisions and hashes programmatically, local extraction validation, PDF
inspection/attestation and bounded error recovery.
