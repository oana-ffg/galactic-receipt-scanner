# Managed model workers

Read this file in a fresh worker context, with the assigned IDs and direct access instructions.
Keep private run manifests and outputs under ignored `.local/`. No inference API calls.

## Luna: one document

1. Fetch and hash-check the assigned original and next available image. View the actual images.
   Extend only with supported continuation pages, leaving unrelated lookahead available.
2. Classify pages as invoice/receipt, payment slip, ATM, note or other. Retain invoice versus
   till receipt subtype, credit/refund signs, declined-payment status and fragments. A receipt
   image may also contain a still-attached payment slip. Record both facts without altering it.
3. Search existing metadata for detached matches and inspect promising candidates. Record
   page order and the evidence for attachment or an unresolved match. Do not guess a missing page.
4. Independently extract all printed financial fields and line items, then run arithmetic.
   Use `scripts/receipt_extract_schema.json` and `receipt_extraction.py` for the supported
   financial extraction shape/validation. Do not transcribe handwriting; keep the legacy
   `handwritten_notes` array empty when parsing fresh material.
5. Record `small_model_certainty` low/medium/high with concrete reasons. Categorize the whole
   document, not individual line items. Match existing category descriptions before proposing
   a new category name and description. Categories are preliminary, not ownership decisions.
6. Store the unmodified model result separately from normalized corrections and preserve source
   IDs/hashes and document revision. Use an immutable extraction artifact plus the private ledger.
   For the current transport, additional page classification/category/certainty metadata can live
   in an envelope alongside the validated financial result; do not pass unsupported keys to the
   document API or replace its legacy `kind` enum with unsupported values.
7. Return brief IDs, artifact hashes, grouping decisions, certainty and failures to the coordinator.

## Astra: independent full-document parse

Default daily budget: 10 documents selected from new/changed low/medium Luna results or failed
checks. The coordinator can select from Luna metadata, but the fresh Astra worker should receive
original pages, source provenance and grouping assignment **without Luna's extracted values**.

First inspect every page and perform a fresh parse: grouping, classification, vendor/dates,
line items, totals, tax/fees/discounts, whole-document category and handwriting presence.
Save this independent result before reading Luna's extraction. Then compare and reconcile
all differences against the originals, rerunning arithmetic. Do not merely check Luna's
flagged fields and do not assume agreement is proof.

Record `large_model_confidence` low/medium/high with reasons, preserving both model attempts.
Low/medium after reconciliation requires human review. `has_human_review` starts false and
must never become true because Astra reviewed something. Human approval must reference the
exact reviewed revision; later edits or page membership changes invalidate it.

Astra can propose or perform supported versioned page detachments, retaining evidence and
rejected-match history. Do not requeue/revisit the same unchanged exception repeatedly. If
shared queue/review fields are unavailable, record decisions in the private ledger rather
than pretending the Site has persisted those fields.

## Category onboarding

Ask the owner for desired categories and descriptions once during processing onboarding.
Store instance-specific categories privately. Use one document category, including a mixed
category where configured. Reuse equivalent category names; propose a new category only when
existing definitions do not fit. Do not include an owner's private category definitions in
public source or assume one owner's categories apply to all deployments.
