# Processing API v2

Use the existing client and [worker runbook](worker-runbook.md) for executable recipes.
All model mutations use scoped machine credentials. Originals, retakes and timestamps
remain immutable. Do not construct authentication or read application code during
routine processing.

## Calls and response shapes

Routes below are relative to the configured origin. POST bodies are JSON except PDF
uploads handled by the client. Never print claim tokens; build query strings in Python.

| Method and route | Request | Response / handling |
| --- | --- | --- |
| GET /api/processing/access | none | Version 2 must advertise queueClaims. |
| POST /api/processing/claim | `{stage:"small"}` or `{stage:"large"}` | `{claim:{token,expires,stage,document:{id,revision,pages},scanned_at}}`, or `{claim:null,reason:"queue-empty"\|"busy-or-changed"}`. Stop on null. |
| POST /api/processing/renew | `{token}` | `{expires}`, epoch milliseconds. |
| POST /api/processing/release | `{token}` | `{released:true}`. Only for an active claim being abandoned. |
| GET /api/processing/context?token=… | Optional after_capture, date, total_minor, currency | `{document,ocr_comparison,independent_parse,next_images,candidates,candidates_truncated,rejected_associations,rejected_associations_truncated}`. |
| GET /api/processing/categories | none | Array of `{id,name,description}`, **no categories wrapper**. |
| POST /api/processing/categories | `{name,description}` | `{id,name,description}`. Name 1–150 characters; description 1–2000. |
| POST /api/processing/draft | `{token,model:"gpt-6-astra",extraction}` | `{saved:true}`; immutable independent checkpoint. |
| POST /api/processing/submit | See Submit below | `{saved:[{id,revision},...],warnings?}`; exact replay may add `replayed:true`. |
| GET /api/documents/ID | none | `{document,captures}`; read `response["document"]`. |
| POST /api/processing/pdf-review | `{document_id,revision,sha256,evidence}` | Read the document back and verify its PDF check/hash; see Outputs. |

One renewable global lease prevents overlapping model work and expires after 20 minutes.
A token assigns ONE document. Claim pages use `captureId`; context `next_images` use
`id`, with `sha256`, `created_at` and `document_id`. Fetching lookahead does not attach it.

Context returns two next images; continue with `after_capture`. Historical candidates use
source-read date, total_minor and currency with a ±3-day and max(2%,100 minor units) window.
This searches previously extracted documents, not every unprocessed scan. Empty results
do not establish no match. At most 50 candidates are returned; respect truncation and
rejected associations, and confirm attachments visually.

Astra must save its draft BEFORE reading context, documents or prior OCR. Before that,
use originals and categories only. Context then exposes the independent parse, Luna's
record and OCR disagreements. See [model workers](model-workers.md).

## Parse

Every field below is required in `extraction`. Unknown nullable values are JSON null,
not empty strings; lists are arrays, even when empty. Do not invent quantities, unit
prices, dates, vendors or categories. All money is signed integer minor units with
absolute value at most 100,000,000,000; quantity is a finite number with absolute value
at most 1,000,000. Never use decimal currency amounts.

| Field | Exact value |
| --- | --- |
| type | unknown, receipt, invoice, credit-note, payment-slip, atm, note, other |
| vendor | null or nonempty string, at most 150 characters |
| receipt_date | null or real YYYY-MM-DD date |
| reference | null or nonempty string, at most 200 characters |
| currency | null or three uppercase letters |
| has_handwriting, has_payment_slip, confirmed_arithmetic_mismatch | Booleans |
| payment_status | approved, declined, unknown, not-applicable |
| card_last_four | null or exactly four digits as a string |
| line_items | At most 1000 objects with description (nonempty string ≤2000), quantity (number or null), unit_price_minor and amount_minor (money or null) |
| adjustments, payment_adjustments | At most 100 objects each, with description (nonempty string ≤2000) and amount_minor (**non-null** money) |
| total_minor, charged_total_minor, vat_minor | Money or null |
| tax_basis | gross, net-plus-tax, unknown |
| completeness | complete, fragment, uncertain |
| category_id | Existing category UUID or null; copy from the registry |
| certainty | low, medium, high |
| uncertainties, broken_reasons | At most 100 nonempty strings each, each ≤2000 characters |
| evidence | Nonempty string, at most 20,000 characters |

`not_invoice` is **server-derived processing state, not an extraction input**.
The server also derives model confidence summaries, human-review flags and OCR comparison.
Do not add IDs, revisions, legacy invoice objects or processing flags to the extraction.

Gross line amounts already include VAT. For net-plus-tax, lines and adjustments are net
and signed vat_minor is added once. Never put included VAT or informational savings into
adjustments. Missing VAT is null; printed zero is valid. Preserve signs on credit notes.
Purchase total and charged total can differ; payment fees belong in payment_adjustments.

The local validator in the runbook checks this shape before submission. Arithmetic
compares sum(line amounts) + sum(adjustments) + VAT (net-plus-tax only) against total,
and total + sum(payment_adjustments) against charged total. Missing required components
leave arithmetic incomplete. Set confirmed_arithmetic_mismatch only after rereading all
printed components of a complete financial document and confirming an actual discrepancy.

## Submit

POST `/api/processing/submit` with `{token,model,extraction,documents?,ocr_resolution?}`.
Use the actual model: gpt-5.6-luna for small, gpt-6-astra for large. **Omit documents when
grouping is unchanged**; extraction is not a legacy document record.

The server saves provenance, computes arithmetic and compares numeric readings with saved
plain OCR. Missing OCR or unresolved disagreements cap high certainty at medium. Astra
can supply a concrete pixel-backed `ocr_resolution` string for a resolved discrepancy;
neither OCR nor model digits are automatically substituted.

Successful submit closes the claim. Preserve exact request bytes: replaying them with
the same token is idempotent; a different payload conflicts. For a lost response,
reconcile/replay before claiming anything else. `saved` is an array of IDs/revisions,
not the complete document; GET the retained document afterward.

## Grouping changes

Only use this branch when pages or relationships change. Start from complete current
records returned by context and GET /api/documents/ID, including every affected donor.
Deep-copy those records and carry IDs, revisions, hashes and existing metadata forward
programmatically. Keep the claimed document as the retained target.

1. Move actual page objects into their visually verified order. Pages contain
   `captureId,sha256,rotation,crop,type?`; rotations are 0/90/180/270 and crop is null or
   original-pixel [left,top,right,bottom]. Do not reconstruct source hashes.
2. Transfer each page's existing annotations with it. Preserve unique backs/handwriting;
   detecting handwriting does not authorize transcribing it.
3. For every document whose page membership changes, set all checks
   (`visual,transcription,grouping,pdf`) false, `invoice:null` and
   `reviewedPdfSha256:null`. Preserve protected `processing` state from the read;
   the server performs required invalidation. Do not manufacture it.
4. An emptied donor has `pages:[]`, `annotations:[]`, `handwriting:"unchecked"`,
   cleared checks/invoice/reviewed hash and `mergedInto:target.id`. For a partial
   transfer, retain remaining pages and their annotations; do not mark that donor merged.
   Keep the target's duplicateOf and mergedInto null. No relationship chains/cycles.
5. Supply explicit visual grouping evidence and include the retained target and all
   changed donors in `documents` alongside token/model/extraction. Every old page must
   remain accounted for exactly once. Maximum 20 changed documents, 100 pages per
   document and 512 KiB per processing request. Do not delete old records.

The complete record contains `id,revision,pages,vendor,receiptDate,kind,reference,text,
handwriting,annotations,checks,reviewedPdfSha256,uncertainties,broken,evidence,invoice,
duplicateOf,mergedInto` and existing `processing` when present. These are legacy
**document** fields: receiptDate differs from extraction.receipt_date; invoice differs
from extraction line_items. Copy current records rather than building that shape from
scratch. The retained target's extraction-derived fields are populated by submission.
Consult [legacy fields](api.md) only for a grouping/edit requirement not covered here.

## Outputs and review

Use `client.pdf(document_id,directory)` (or CLI `pdf DOCUMENT_ID`), which prepares
missing OCR, generates ordered searchable original-image pages, uploads for the exact
revision, and downloads/hash-verifies the pinned PDF. It returns
`{sha256,filename,revision,path,pages,searchable}`. Respect the server's filename.
Unknown source date/vendor remains unresolved; do not substitute scan time.

Inspect every rendered page against originals, then POST /api/processing/pdf-review:
document_id and revision from the **current document**, sha256 copied directly from the
verified PDF result, and evidence as a **nonempty string of at most 2000 characters**.
No active model claim may exist during PDF attestation. It increments the document
revision; the PDF artifact's revision may consequently differ. GET the document again:
require checks.pdf true and reviewedPdfSha256 equal to document.pdf.sha256 and the
inspected file hash. A request file alone is not a successful review.

Categories are stable by ID. Equivalent normalized names cannot silently acquire
different descriptions; on conflict read the existing definition or choose a distinct
appropriate category.

POST /api/processing/detach accepts `{document_id,revision,capture_id,reason,token?}`
from the owner browser or claimed Astra after checkpoint. It preserves originals,
records a rejected association, clears affected validation and closes the claim.
Requeue rather than submitting against the old grouping.

Human review is owner-browser-only. A model never sets has_human_review.
Generic machine POST /api/documents is denied; use the processing endpoints.
