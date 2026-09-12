# Processing a saved batch

For document grouping, deduplication, named multi-page PDFs, handwriting and invoice
checks, use the project [receipt-processing skill](.agents/skills/receipt-processing/SKILL.md).
The owner-only **Review receipts** tab at `/review` shows Ready, Needs review, Broken and
Duplicate records, with source images, editable decisions and history. The instructions
below describe the underlying capture/OCR artifacts; document processing adds a separate
versioned layer and never rewrites scan timestamps or source metadata.

This workflow belongs to the owner's Work/Codex session after scanning. The operator
does not need to sort receipts, transcribe text or create PDFs while feeding the camera.

1. Open the private dashboard as the owner. Use `list_receipts` and follow every `next`
   cursor for current takes, including captures marked `manual-review`. Record `receipt_id`, capture ID, take number, source
   SHA-256 and output status. Count each `receipt_id` once. Also list with `history: true`
   to reconcile all previous, forced and rejected takes. Accepted takes are preferred over
   forced retakes. `is_current` identifies the selected take for each receipt; `current_capture_id` links history to it. A receipt with no accepted
   take stays on the review list. Recheck current selection before final reporting.
   Older captures without recorded retake links need visual duplicate review; do not
   infer receipt identity from matching amounts or nearby capture times.
2. Inspect `manual-review` originals directly and keep them on the review list until
   their content is established from the pixels. They are excluded from automatic OCR
   and cropping; use source-backed visual transcription and the versioned artifact API
   for any manually prepared outputs. Do not discard a forced take because an earlier
   accepted take is still current.
3. Call `transcribe_saved_receipts` with up to 20 accepted IDs at a time. This runs
   Danish/English OCR locally in the desktop browser, independently of camera capture.
   One worker is reused within each batch. Inspect every returned result: a failed item
   remains unfinished even if the rest succeeded. Previously saved extraction remains
   available if a later attempt fails.
4. Retrieve and visually inspect each original. Compare its text, amounts and merchant
   heading with both saved OCR passes. The automatic layout pass can miss amount columns;
   the block pass can miss a large logo. Both observations are retained, with word boxes
   in original-image pixels. Confidence scores do not prove correctness.
5. Review Danish characters, decimal commas, minus signs, discounts, dates, VAT and totals
   against the pixels. Do not infer a missing digit from arithmetic. For pictorial logos,
   describe what is visible; do not invent a merchant identity. A leaf or other graphic
   misread as a character is a visual-review finding, not a transaction value.
6. Save the source-backed transcription with `save_receipt_transcription`. Include
   provenance, explicit uncertainties, and regions `{kind, text, box, uncertain}`.
   `box` is `[left, top, right, bottom]` in original pixels; `kind` is `text`, `logo`
   `handwriting` or `unreadable`. Use null text where it cannot be read. Originals and earlier OCR
   versions remain intact. Transcription remains unverified for accounting purposes.
7. Use `prepare_receipt_outputs` for crops and image PDFs only when wanted. Failures
   leave the original intact. Reconcile the final manifest against all captured IDs:
   completed, rejected or explicitly unresolved. Report every unresolved source.

The open dashboard must remain available during browser processing. If interrupted,
resume from saved output status and the manifest. No external OCR account or API key is
required. The engine and pinned language models are served by the private Site.

Recent captures shows the original with its saved outline beside an unsaved PDF draft.
Visible rows are processed one at a time on the desktop, after checking the original's
hash. The draft reruns current checks and uses a rotated crop around the detected paper;
it does not stretch folded corners into a rectangle or flatten physical creases.
The preview shows a thumbnail of the exact image embedded in its downloadable PDF.
Drafts do not change saved artifacts, capture status or which retake is current. A failed
check leaves the original available with an explanation. Review the output before using
`prepare_receipt_outputs` to persist a derivative; old saved PDFs remain separate.

The bundled engine is Tesseract.js 7 with the maintainer's best-integer Danish/English
models. Model hashes are recorded in each extraction. See the upstream
[language-model documentation](https://github.com/naptha/tessdata) and
[Tesseract.js API](https://github.com/naptha/tesseract.js/blob/master/docs/api.md).
