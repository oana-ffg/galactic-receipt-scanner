# Processing API v2

Use `python3 scripts/receipt_api.py post PATH PRIVATE_JSON_FILE` for POST and `get PATH`
for JSON reads. All model mutations use scoped machine credentials. Capture originals,
retakes and timestamps remain immutable. Types and runtime validation: `web/extraction.ts`.

## Assignment

- POST `/api/processing/claim` with `{stage:"small"}` or `{stage:"large"}`. Returns
  `{claim:{token,expires,stage,document:{id,revision,pages},scanned_at}}` or a null claim
  with queue-empty/busy-or-changed. A token is ONE document. One renewable global lease
  prevents overlapping model work; expiry is 20 minutes.
- POST `/api/processing/renew` with `{token}` before expiry. POST `/release` with `{token}`
  abandons an unused claim. Do not wait/spin on a busy queue.
- GET `/api/processing/context?token=TOKEN`: Luna's current complete document, two next
  images and rejected associations. Continue lookahead using `after_capture=CAPTURE_ID`.
  Request historical receipt/slip candidates with `date=YYYY-MM-DD&total_minor=N&currency=ISO`.
  These use a ±3-day/2%-or-100-minor-unit candidate window, NOT proof of attachment.
  At most 50 matches are returned; truncated results need narrower/manual investigation.
- Astra must POST `/api/processing/draft` with `{token,model:"gpt-6-astra",extraction}`
  BEFORE reading context, documents or prior OCR. The checkpoint is immutable. Context
  then exposes its independent parse, Luna's entire record and OCR disagreements.

## Parse

`extraction` contains every field below. Amounts are signed integer minor units or null;
strings such as vendor/date/reference/currency are null when unknown. A financial receipt
uses not_invoice=false; payment slips, ATM slips, notes and other material are non-invoices.
The server derives flags and certainty summaries, not the worker.

- `type`: unknown, receipt, invoice, credit-note, payment-slip, atm, note, other.
- `vendor`, `receipt_date` (real YYYY-MM-DD), `reference`, `currency` (ISO code).
- `has_handwriting`, `has_payment_slip`: booleans. `payment_status`: approved, declined,
  unknown, not-applicable. `card_last_four`: null or exactly four digits.
- `line_items`: `{description,quantity,unit_price_minor,amount_minor}`; unknown numbers null.
- `adjustments`, `payment_adjustments`: `{description,amount_minor}` arrays. Adjustments
  are signed arithmetic components, not informational included VAT or savings.
- `total_minor`, `charged_total_minor`, `vat_minor`: printed values or null.
- `tax_basis`: gross, net-plus-tax, unknown. Gross line amounts already include VAT. For
  net-plus-tax, line amounts and adjustments are pre-tax; the server adds signed vat_minor
  exactly once. Do not also put VAT in adjustments. Missing VAT makes a net parse incomplete;
  printed zero VAT is valid. Preserve signed amounts on credit notes.
  `completeness`: complete, fragment, uncertain.
- `category_id`: existing category UUID or null. `certainty`: low, medium, high.
- `uncertainties`, `broken_reasons`: string arrays. `evidence`: explicit source findings.
- `confirmed_arithmetic_mismatch`: true only after rereading a complete financial document
  and confirming an actual discrepancy in its printed components.

POST `/api/processing/submit` with `{token,model,extraction,documents?,ocr_resolution?}`.
Model is gpt-5.6-luna for small, gpt-6-astra for large. The server records the original request,
independent draft reference, original source hashes and resulting revision. It runs arithmetic
for every receipt/invoice and compares numeric readings with saved plain OCR. Missing OCR or
unresolved discrepancies cap high at medium. Astra can resolve an OCR error using concrete
pixel-backed ocr_resolution; neither OCR nor model values are automatically substituted.

Omit documents for unchanged grouping. Otherwise provide complete current document records
for the retained target and all affected stored sources. Preserve each prior page, transferring
it explicitly and emptying merged sources with mergedInto. Set page `type` when classified.
Clear legacy checks/invoice during membership changes; do not invent source hashes or revisions.
Do not modify another document's protected processing state; the server invalidates it.
Maximum 20 changed documents and 512 KiB per processing request.

A successful submit closes its claim. Exact replay returns the original result; differing
bytes under the used claim conflict. Unknown/lost responses require read-back/replay before
claiming another document. Images and old records are never deleted.

## Review, categories and outputs

- GET/POST `/api/processing/categories`: list or create `{name,description}`. Reuse stable
  IDs; equivalent normalized names cannot silently acquire different descriptions.
- POST `/api/processing/detach`: `{document_id,revision,capture_id,reason,token?}`. Owner
  browser or claimed Astra after its checkpoint. Atomically creates a separate document,
  retains originals and records a rejected association; affected validation is cleared.
- `/api/processing/human-review` is owner-browser-only. It saves a reviewed extraction and
  pins approval to the resulting revision. Any later generic edit invalidates that approval.
- Generate searchable image PDFs with `scripts/receipt_pdf.mjs`, using source-hash-verified
  local OCR. Upload with client save-pdf; read back pinned bytes, inspect each page, then POST
  `/api/processing/pdf-review` with document_id, revision, sha256 and inspection evidence.
- Generic machine POST /api/documents is denied. Browser saves remain versioned and protected.
  [Legacy document API](api.md) documents the existing complete-record shape.
