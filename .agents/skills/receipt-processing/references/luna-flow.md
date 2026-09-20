# Luna: one Jev-ready document

Use this short guide for the normal first pass. The backend has already classified and
grouped the document from exact-layout PP-OCR and Jev before Luna can claim it. Luna's
job is field extraction and confidence assessment, not page matching or first-pass
document classification.

## Assignment and launch

The parent holds the batch guard and supplies the verified origin, authorized processing
scope, and exact tested Python launch command. Reuse that handoff. Do not fetch keys,
read the protected profile, open a browser, or start another guard.

Launch the supplied command in one persistent terminal session. Require `ready: true`,
`confirmation_provider: ppocr`, and Jev support in the server access response. Send one
JSON request at a time with `write_stdin` and await its actual response. Do not resend a
request merely because it is still running.

## Normal sequence: begin, review, finish

1. Send `{"op":"begin"}`. A claim is returned only when every current page has matching
   PP-OCR and the current page layout has a completed Jev assessment. The response contains:

   - ordered PP text and coordinates for every page;
   - Jev's document role, purchase category, page roles, probabilities and confidence;
   - a filled `review` request template;
   - optional crop/original image requests.

   Missing PP or Jev means there is no eligible Luna claim. The dedicated OCR/Jev workers
   catch up independently; this Luna host must not install or invoke OCR, work around the
   gate, or substitute another artifact.

2. Extract the fields from the PP text. Images are permitted but normally unnecessary.
   Open the relevant crop or original when PP confidence is low, text is ambiguous, a
   financial value conflicts, handwriting must be assessed, or the source layout matters.
   Do not look for neighboring pages: the backend already performed chronological and
   detached payment-evidence matching against whole documents.

3. Send the filled `review` request. Keep the claimed page order/layout unchanged in the
   routine flow. Python freezes Luna's initial extraction, pins the exact PP evidence, and
   returns arithmetic/OCR findings plus a `finish` template.

4. Send `finish` with the full reassessed extraction and rationale. Python saves the
   separate reassessment, generates/uploads the searchable PDF, and verifies source hashes,
   layout, revision and upload hash. Wait for the same process to exit zero, then return
   only its completion file, run ID and compact outcome to the parent.

## Extraction and confidence

Fill every field in the returned extraction template. Never invent text, dates, purpose,
or amounts. Money is signed integer minor units; missing VAT is null, not zero. Detect
handwriting only when pixels were inspected, and never transcribe it.

Jev's category is the starting value, not an instruction to rediscover the merchant.
Use the OCR text and active category definitions. Do not perform vendor lookup or add
unrequested merchant research. If the OCR supports a different category, preserve that
disagreement explicitly.

Set Luna confidence using all three signals:

- **low** whenever Luna disagrees with Jev or PP-OCR, regardless of Luna's own certainty;
- **medium** when PP, Jev and Luna agree but Luna is still unsure;
- **high** only when they agree and Luna is sure;
- when Jev reports low confidence, verify the affected role/category before choosing.

PP confidence is not a calibrated probability. Model agreement is not source truth.
Explain concrete uncertainty and affected fields. A visible grouping error is also low:
do not silently regroup in Luna; preserve the current record and route it to Astra/human
review.

## Images and PDF review

Use optional `previews` or `originals` requests only for the concrete reasons above.
Normally leave `all_pages_inspected: false`; this truthfully leaves visual-review flags
unset. Set it true only after inspecting every draft page. If `needs_pdf_review: true`,
open every returned final page before attesting the exact PDF hash.

## Errors

Correct validation errors in the same session. A crash, denied action, lost session, or
uncertain write stops this worker and enters the parent's repair procedure. Saved low or
medium confidence is a successful processing outcome queued for Astra, not a failed run.
Do not start replacement workers or retry uncertain writes independently.
