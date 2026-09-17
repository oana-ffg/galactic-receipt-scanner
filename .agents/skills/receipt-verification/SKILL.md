---
name: receipt-verification
description: Review saved low/medium-confidence receipt documents with fresh Astra vision subagents, preserve independent and reconciled readings, and verify saved results and PDFs. Terra is recommended for coordination. Use for second-pass receipt verification, not initial OCR or scanning.
---

# Astra receipt verification

A bare `$receipt-verification` means run a batch of up to **10 oldest eligible documents**.
An explicit count overrides that default. **Terra (`gpt-5.6-terra`) is recommended for
the coordinator**, but the current task remains coordinator regardless of its model;
do not require a model switch or start a replacement task. Each review uses a fresh
**Astra (`gpt-6-astra`) subagent**, one document at a time.

Review low/medium **saved Luna confidence**, not PP's numeric OCR confidence. Default
selection excludes already Astra-reviewed documents (even if Astra remained low/medium),
human-reviewed documents, duplicates, empty documents and documents awaiting a Luna reparse.
Astra's remaining uncertainty belongs in the review queue; do not repeatedly review the
same receipt until a model says high. Explicit owner requests can separately authorize a
named re-review. Creating or invoking this skill does not create a schedule or resume Luna.

## Coordinator

1. Read the repository `AGENTS.md` and
   [receipt-data-access](../receipt-data-access/SKILL.md). Discover this host's prepared
   runtimes and connection from `.local/processing-host.json`; verify the origin against
   owner-authenticated Sites metadata. Keep credentials private. Supply only actual
   paths and non-secret ownership/scope evidence to Astra, never receipt values or OCR.
   Use the owner's subscription-backed managed agents; no paid inference APIs.
2. Hold the existing receipt batch guard for the whole batch using
   [batch coordination](../receipt-processing/references/luna-protocol.md#batch-coordination).
   Keep its live session ID and an ignored coordinator checkpoint. Respect busy/blocked
   state; do not clear an earlier blocked batch merely to start verification. This guard
   serializes Astra with Luna on this host; the server also enforces a global claim.
3. Run the prepared Python executable with
   `scripts/receipt_verification.py --config PRIVATE_CLIENT_CONFIG queue --limit 10`.
   Substitute the requested count when different. The script paginates summaries,
   selects low/medium Luna results and returns only IDs/revisions and operational metadata.
   It makes no claims or writes. Do not fetch full receipt payloads into the coordinator.
4. Before each dispatch, require `phase: active` from the same guard session. Refresh
   the queue to obtain the next current ID/revision, excluding IDs already attempted in
   this batch. Do not rely on the generic large queue: it can contain high-confidence
   documents flagged for unrelated reasons. Supply only the selected ID/revision to Astra,
   not its previous confidence, merchant, dates, amounts or reasons.
5. Spawn one `gpt-6-astra` subagent with `fork_turns: none`. Hand off
   [the Astra flow](references/astra-flow.md), the selected ID/revision, repository and
   unique private work directory, prepared Python/Node/renderer/profile/client-config
   paths, verified destination and authorized read/write scope, and collection conventions.
   State that the coordinator already holds the batch guard. The worker owns its own
   client calls and claim; the coordinator does not forward commands or JSON requests.
6. Wait for that worker's terminal result and closed claim. Then independently run
   `scripts/receipt_verification.py --config PRIVATE_CLIENT_CONFIG verify WORK_DIRECTORY --document-id SELECTED_ID --revision SELECTED_REVISION`.
   Use the ID/revision originally dispatched by the coordinator, not a replacement from
   the worker's narrative. Generic claims and mismatched assignments are rejected.
   Count a review only after `verified: true`; retain this output privately. This checks
   the recorded server draft readback, live extraction/attempt, closed claim, layout and PDF attestation.
   **Do not use Luna's `receipt_batch.py --verify` for Astra**: it expects Luna's journal.
   The Astra worker uses the API runbook, not the small-stage-only `receipt_worker.py`.
7. Continue until the requested count is verified, no eligible documents remain, the
   server reports another active claim, or a real blocking failure occurs. Saved low/
   medium confidence, awaiting-pages and human-review outcomes count as successful
   reviews. Never translate those flags into a failed batch or erase them to continue.
8. Finish the held guard only after all dispatched Astra workers have terminated and
   their claims/results are verified. For a failure, preserve the worker directory,
   exact request/response and guard, stop dispatching, and mark the guard blocked as
   documented. No replacement worker may retry an uncertain write. Reconciliation is
   the primary coordinator's responsibility under owner direction, not a new Terra task.

The legacy Astra API path does not register itself as a bounded Luna worker: the guard's
`finish` alone is therefore not proof that Astra completed. Require the independent
verification above and terminal worker status before sending it.

## Review scope and report

Astra checks **every image in the assembled document**: page membership/order, completeness,
crop/rotation, vendor, date, references, category, printed amounts/VAT/fees and handwriting
presence. Inspect raw originals or neighboring crops when useful. The initial reading
must come from pixels without seeing Luna/PP values. After that checkpoint, compare and
correct from source evidence; agreement alone is not proof. Keep the independent draft,
reconciled Astra values and confidence separate from the preserved Luna and PP attempts.

Use the existing [four supermarket categories](../receipt-processing/references/supermarket-classification.md)
for supermarkets only. Explain category with actual items and any confidence below high
with affected fields and reasons. Unreadable values remain null/uncertain. Detect but do
not transcribe handwriting; do not invent transaction purpose or financial figures.

Report verified document/page counts, corrected versus confirmed outcomes from workers,
final confidence counts and concrete unresolved issues. Distinguish unsuccessful/skipped
targets from completed reviews. Never call model verification human approval. No source
images, receipt text, private IDs or credentials belong in public commits or reports.
