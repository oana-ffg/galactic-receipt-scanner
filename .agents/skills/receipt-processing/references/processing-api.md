# Processing API v2

## First-pass PP and Jev gate

Saving exact-layout PP-OCRv6 triggers the backend's pinned Jev page pass. The resumable
backfill freezes a snapshot, finishes page roles, groups adjacent whole documents forward,
matches detached receipt-only/payment-only documents with an identical normalized date,
then performs one final combined document-role/category request for every stable document.
Do not run a separate date pass during normal processing.
Only a current `purchase_document` with both PP and Jev readiness is eligible for Luna.
No document is Luna-ready while any Jev pipeline snapshot or page job is unfinished.
The claim includes the Jev document/category/page decisions and confidence. After saving
the ordinary immutable Luna draft and preparing every frozen region, POST
`/api/processing/confirmation` with `token`, `provider: "ppocr"`, the unchanged
`pixel_pdf_sha256`, and ordered `artifacts: [{capture_id, sha256}]` for all retained
pages. Each pin must resolve to stored PP-OCRv6 evidence with the same source hash,
crop and rotation. The response preserves `ppocr` provenance and `evidence.initial_ocr`
plus initial arithmetic. `assess`/`submit` use the existing confirmation hash and full
reassessment contract. Prior Qwen-format confirmations below remain readable and
supported for explicitly selected legacy/full-audit workflows, not the default pass.

Use the existing client and [worker runbook](worker-runbook.md) for executable recipes.
All model mutations use scoped machine credentials. Originals, retakes and timestamps
remain immutable. Do not construct authentication or read application code during
routine processing.

## Calls and response shapes

Routes below are relative to the configured origin. POST bodies are JSON except PDF
uploads handled by the client. Never print claim tokens; build query strings in Python.

| Method and route                            | Request                                                                                                   | Response / handling                                                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /api/processing/access                  | none                                                                                                      | Version 2 must advertise queueClaims, lunaReassessment and configured Jev with its pinned model.                                                                                                    |
| POST /api/processing/claim                  | `{stage:"small"}` or `{stage:"large"}`                                                                    | `{claim:{token,expires,stage,document:{id,revision,pages},scanned_at,jev}}`, or `{claim:null,reason:"queue-empty"\|"busy-or-changed"}`. Both stages require current exact-layout PP+Jev; large also requires a saved eligible Luna result. Stop on null.          |
| GET /api/jev/status                         | none                                                                                                      | Jev configuration, job counts, ineligible reasons and the latest pipeline phase/snapshot/busy state.                                                                                                |
| POST /api/jev/backfill                      | `{}`                                                                                                      | Advances one resumable page, forward-grouping, shared-date, or final-document step. Follow `remaining` to zero and confirm zero once more so work arriving at the snapshot boundary starts a new run. |
| GET /api/jev/documents?disagreements=1      | none                                                                                                      | Current Jev/Luna document-role and category disagreements with names/confidence; no OCR text.                                                                                                        |
| POST /api/processing/renew                  | `{token}`                                                                                                 | `{expires}`, epoch milliseconds.                                                                                                                                                                    |
| POST /api/processing/release                | `{token}`                                                                                                 | `{released:true}`. Only for an active claim being abandoned.                                                                                                                                        |
| GET /api/processing/context?token=â€¦       | Optional after_capture, date, total_minor, currency                                                       | `{document,ocr_comparison,independent_parse,previous_images,next_images,candidates,candidates_truncated,rejected_associations,rejected_associations_truncated}`.                                    |
| GET /api/processing/categories              | none                                                                                                      | Array of `{id,name,description}`, **no categories wrapper**.                                                                                                                                        |
| POST /api/processing/categories             | `{name,description}`                                                                                      | `{id,name,description}`. Name 1â€“150 characters; description 1â€“2000.                                                                                                                             |
| POST /api/processing/draft                  | `{token,model,extraction}`; small stage also requires frozen `documents,pixel_pdf_sha256,images`          | `{saved:true}`; immutable initial checkpoint. Normal Luna extraction has already read PP.                                                                                                           |
| POST /api/processing/confirmation           | `token` plus provider-specific pinned PP artifacts, or Qwen extraction/provenance for the legacy provider | Immutable `{saved:true,sha256,qwen,evidence}`; initial checkpoint and exact-region OCR required. PP confirmation reuses the initial reading's exact artifacts and is not independent corroboration. |
| GET /api/processing/readings?document_id=ID | Claimed document ID for review                                                                            | Up to 20 latest initial/confirmation/updated records, with models, revisions and timestamps; no claim tokens. Astra must first checkpoint.                                                          |
| POST /api/processing/submit                 | See Submit below                                                                                          | `{saved:[{id,revision},...],warnings?}`; exact replay may add `replayed:true`.                                                                                                                      |
| GET /api/documents/ID                       | none                                                                                                      | `{document,captures}`; read `response["document"]`.                                                                                                                                                 |
| POST /api/processing/pdf-review             | `{document_id,revision,sha256,evidence}`                                                                  | Read the document back and verify its PDF check/hash; see Outputs.                                                                                                                                  |

One renewable global lease prevents overlapping model work and expires after 20 minutes.
A token assigns ONE document. Claim pages use `captureId`; context `next_images` use
`id`, with `sha256`, `created_at` and `document_id`. Fetching lookahead does not attach it.

Normal Luna does not use context for grouping: the completed backend pipeline has already
matched chronological continuations and detached shared-date payment evidence with Jev
before the claim. The context and grouping routes below remain for explicit Astra
repair/legacy maintenance only.

Context returns two next images in chronological order; continue with `after_capture`.
It also returns `previous_images`: up to two current captures before the earliest page
of the claimed document, nearest first, with the same metadata as `next_images`.
These previous images do not change when advancing the lookahead cursor. Inspect the
nearest previous crop for an orphan payment slip or fragment before freezing a draft.

Historical candidates use source-read date, total_minor and currency. When a candidate
has both date and currency, matching uses a ±3-day and max(2%,100 minor units) window.
A candidate missing date or currency requires an exact amount match; any known date
must still be within three days and any known currency must agree. Missing fields can
be resolved by a slip, but never imply a match by themselves. This searches previously
extracted documents, not every unprocessed scan. Empty results do not establish no
match. At most 50 candidates are returned; respect truncation and rejected associations,
and confirm attachments visually.

For an owner-requested repair of a specific processed document, Astra may claim with
`{stage:"large", document_id, revision}` using the current document ID and revision.
This can revisit an awaiting-pages result; it never falls back to another queued
document. Stale, merged, duplicate and human-reviewed targets are rejected, and the
same exclusive processing lease applies. Routine Luna batches use the normal queue.
An explicit targeted claim remains available when exact PP is missing so an AI can
investigate the document. The automatic Astra queue excludes it, and submission cannot
save an Astra confidence result until exact-layout PP and Jev are ready.
If the repair agent already saw previous readings, explicitly describe the draft and
final evidence as reconciliation with prior context, not an independent blind review.

Astra must save its draft BEFORE reading context, documents or prior OCR. Before that,
use originals and categories only. Context then exposes the independent parse, Luna's
record and OCR disagreements. See [model workers](model-workers.md).

## Parse

Every field below is required in `extraction`. Unknown nullable values are JSON null,
not empty strings; lists are arrays, even when empty. Do not invent quantities, unit
prices, dates, vendors or categories. All money is signed integer minor units with
absolute value at most 100,000,000,000; quantity is a finite number with absolute value
at most 1,000,000. Never use decimal currency amounts.

| Field                                                            | Exact value                                                                                                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| type                                                             | unknown, receipt, invoice, credit-note, payment-slip, atm, note, other                                                                        |
| vendor                                                           | null or nonempty string, at most 150 characters                                                                                               |
| receipt_date                                                     | null or real YYYY-MM-DD date                                                                                                                  |
| reference                                                        | null or nonempty string, at most 200 characters                                                                                               |
| currency                                                         | null or three uppercase letters                                                                                                               |
| has_handwriting, has_payment_slip, confirmed_arithmetic_mismatch | Booleans                                                                                                                                      |
| payment_status                                                   | approved, declined, unknown, not-applicable                                                                                                   |
| card_last_four                                                   | null or exactly four digits as a string                                                                                                       |
| line_items                                                       | At most 1000 objects with description (nonempty string â‰¤2000), quantity (number or null), unit_price_minor and amount_minor (money or null) |
| adjustments, payment_adjustments                                 | At most 100 objects each, with description (nonempty string â‰¤2000) and amount_minor (**non-null** money)                                    |
| total_minor, charged_total_minor, vat_minor                      | Money or null                                                                                                                                 |
| tax_basis                                                        | gross, net-plus-tax, unknown                                                                                                                  |
| completeness                                                     | complete, fragment, uncertain                                                                                                                 |
| category_id                                                      | Existing category UUID or null; copy from the registry                                                                                        |
| certainty                                                        | low, medium, high                                                                                                                             |
| uncertainties, broken_reasons                                    | At most 100 nonempty strings each, each â‰¤2000 characters                                                                                    |
| evidence                                                         | Nonempty string, at most 20,000 characters                                                                                                    |

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

POST `/api/processing/submit` with `{token,model,extraction,documents?,ocr_resolution?,assessment?}`.
After a small-stage draft, confirmation is mandatory and `documents` must exactly match
the frozen snapshot. `assessment` contains the saved `confirmation_sha256`, a nonempty
`rationale` (≤20,000 characters), and `changed_fields` listing every changed top-level
extraction field exactly once. Submit stores the updated reading in `processing_attempts`;
initial Luna remains in `processing_drafts`, Qwen/evidence in `processing_confirmations`.
Legacy no-draft clients remain compatible but are not the new skill flow.
Use the actual model: gpt-5.6-luna for small, gpt-6-astra for large. **Omit documents when
grouping and page layout are unchanged**; include copied document records when saving
new crop/rotation bounds. Extraction is not a legacy document record.

The server saves provenance, computes arithmetic and compares numeric readings with exact
PP-OCR. Missing PP is rejected at submission rather than converted into a confidence result;
this does not prevent an explicitly targeted read-only investigation.
Luna disagreement with PP or Jev is always low. Astra disagreement with PP is always low,
even when Astra and Luna agree; an `ocr_resolution` preserves its explanation but does not
raise confidence. When Astra agrees with PP, Astra may choose confidence. Neither OCR nor
model digits are automatically substituted.

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
revision, and verifies the server-computed upload hash against the generated local PDF.
It does not download the PDF again. It returns
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
