# Legacy document records and owner-browser API

For model writes use [claimed processing submissions](processing-api.md), not generic
POST /api/documents. Use the configured [direct API client](../../receipt-data-access/SKILL.md) for agents.
Browser requests instead use same-origin credentials, no-store cache and redirect:error;
browser mutations need the Site Origin and `X-Scanner-Request: 1`. Both paths share validation.

- `GET /api/documents`: `{documents,captures}`; includes saved heads and provisional singleton
  documents for unassigned current captures. Views add status, reasons, filename, scannedAt,
  and `pdf: {sha256,revision}|null`.
- `GET /api/documents?summary=1&limit=50&after=ID&q=TEXT`: compact, searchable summaries;
  follow returned next as after. `list_documents` uses this route.
- `GET /api/documents/{id}`: `{document,captures}` with a full record and only its sources;
  exposed as `read_document`. Use this before editing instead of full-batch text.
- `POST /api/documents`: `{documents:[completeDocument,...]}`; atomically saves 1–100 changes.
  Copy the current revision (0 for new); 409 means reload/reconcile, never guess a revision.
  Transfer pages by including both changed records; emptied sources use `mergedInto` pointing
  directly to the retained destination. Every assigned source must remain accounted for.
- `GET /api/documents/{id}/history`: append-only decision revisions.
- `POST /api/documents/{id}/pdf?revision=N`: upload PDF for the exact revision, max 32 MB.
  In browser/WebMCP workflows, `generate_document_pdf` verifies originals, generates, saves
  and verifies bytes. For direct access, generate locally and use `save-pdf`; retrieve the
  pinned PDF using the client's `file` command and inspect it before recording PDF review.
- `GET /api/documents/{id}/pdf?revision=N&version=SHA`: pin an immutable stored PDF.

Authoritative types: `web/documents.ts`. Copy actual listed records; never invent hashes.
Writable fields: `id`, `revision`; ordered `pages: [{captureId,sha256,rotation}]` (rotation
0/90/180/270; crop comes from the saved scan outline); source-backed nullable
`vendor`, `receiptDate` (YYYY-MM-DD), `reference`; `kind` unknown/receipt/invoice/credit-note;
`text`; `handwriting` unchecked/absent/present/uncertain;
`annotations: [{text,captureId,box,uncertain}]` (legacy optional transcription, original-pixel box);
`handwriting: present` can have an empty annotations array. Detect presence without transcription;
preserve existing annotations rather than replacing them with an empty array;
boolean `checks: {visual,transcription,grouping,pdf}`; `reviewedPdfSha256` (null until
inspection, then the exact observed `pdf.sha256` when confirming PDF); string arrays `uncertainties`, `broken`;
`evidence`; `invoice`; nullable `duplicateOf`, `mergedInto` (no chains or cycles).

Invoice is null or `{currency,lines,adjustments,total,basis,evidence}`. Lines and total use
signed integer minor units. Adjustments are `{label,amount}`. Basis is gross or net-plus-tax.
The server computes the difference; callers cannot submit a precomputed success result.
Existing image/OCR artifacts stay separately versioned under capture artifact routes.

Inspect the exact saved PDF before checking `pdf`. Changing pages or naming fields can
invalidate output. A later retake produces a review reason: reconcile the new source with
the old document and preserve previous decisions/artifacts. Consult capture metadata for
original dimensions before supplying annotation boxes.

For an existing document, save changed page membership with all checks false and invoice
null, then re-inspect and save the new attestations. Order changes require grouping/pdf
checks false. A PDF review is pinned to reviewedPdfSha256; regeneration with a different
hash requires fresh inspection. Empty merged records have no annotations, unchecked
handwriting and cleared checks; earlier source/decision versions remain available.
