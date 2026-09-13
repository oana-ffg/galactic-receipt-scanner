# Local receipt extraction

The local workspace compares extraction engines without changing captures or
promoting experimental output to verified accounting data. It uses standard-library
Python and SQLite. No paid service or model API is built into the workspace.

Every original is registered with its capture ID, SHA-256, scan timestamp and local
path. Results are immutable per source and run. A changed prompt, model or corrected
reading belongs in a new run; identical imports are idempotent. Keep manifests,
databases, model output and real documents under ignored `.local/` or another private
directory. Unit tests contain synthetic documents only.

## Fields and checks

The extraction contract is [receipt_extract_schema.json](scripts/receipt_extract_schema.json)
with [shared reading instructions](scripts/receipt_extract_prompt.txt). It includes
document type, nullable `not_invoice` and `has_handwriting`, vendor, transaction date,
reference, currency, line items, adjustments, printed total and notes. A receipt counts
as an invoice-like financial document for `not_invoice=false`; payment slips and
vouchers have their own types and `not_invoice=true`. `null` means unclassified.

Scan time is never used as a transaction date. Filename reservations use
`YYYY-MM-DD_vendor_name.pdf`, then `_2`, `_3`, etc., without overwriting earlier
reservations in the same run. These are proposed output names; importing an extraction
does not generate a PDF. Different engine runs have separate names for comparison.
Production document grouping and stable final PDF reservations remain in the scanner.

The program sums integer minor-unit line amounts plus signed adjustments for both
receipts and invoices. Included VAT, cash tendered and change are not extra purchased
items. Printed purchase total and charged total are distinct; post-total card fees or
explicit rounding belong in `payment_adjustments`. A payment adjustment without a
readable charged total still needs processing. All fields remain in `payload_json`.

Handwriting notes carry original-pixel boxes. Unknown locations require a null box,
`uncertain=true` and a concrete uncertainty. Copy displayed item amounts and separately
applied item-discount rows; avoid subtracting informational discounts twice. For tables
showing both net and gross line columns, use net lines with explicit VAT. Keep older
prompt runs separate: changes to these conventions can change arithmetic comparisons.

- `extracted`: structured candidate with matching arithmetic; not a verification claim.
- `awaiting_pages`: fragment awaiting another scan; retry matching as the collection grows.
- `needs_processing`: unresolved extraction or arithmetic; not automatically a human task.
- `not_invoice`: classified supporting or unrelated document; original remains retained.

`arithmetic_status` separately records matched, mismatch, incomplete or not applicable.
A model's arithmetic mismatch is evidence for a retry, not proof that the source invoice
is broken. A mismatch confirmed against a complete source belongs in the scanner's
broken queue. Actual unresolved source questions belong in review after bounded attempts.

## Commands

Run `python3 scripts/receipt_extraction.py --help` for the local CLI. Pass an explicit
private database path with `--db`. The commands are:

- `sources MANIFEST`: register `{"samples":[...]}` entries containing `captureId`,
  `sha256`, `scanned_at` (ISO timestamp with timezone), `original` (local path) and
  `source_pixels` (original `[width,height]` positive integer dimensions).
  Each file is hash-checked; conflicting source identity or scan time is rejected.
- `run ID ENGINE MODEL PROMPT_VERSION`: register an engine/prompt version.
- `pending RUN --limit 10`: list sources without a saved result in that run.
- `import RUN RESULTS`: validate and atomically import an array following the extraction
  contract, augmented with exact `source_id` and `sha256` from the source manifest.
- `status RUN`: summarize extraction and arithmetic states, registered/pending counts and
  retained attempts without an imported result (failed or invalid output).
- `export RUN`: emit records with original references, preserved model payloads, worker
  evidence, run configuration and retained raw-attempt paths/hashes, plus the same run
  audit including unsuccessful attempts. Unknown runs are rejected.

For an existing private Ollama server, use `python3 scripts/receipt_ollama.py --help`.
Supply its explicit literal private-IP `--endpoint`, an installed vision `--model`, `--db`, `--run`,
private raw-response `--output` directory and `--limit`. Optional `--source-id` narrows
the sample. Images are sent sequentially using Ollama's native `/api/chat`, with a JSON
schema and original bytes. The client disallows public endpoints, cloud model tags,
redirects and environment proxies. It preserves raw responses, timing, exact model
digest, prompt/schema hash and failed attempts. Preflight and postflight model-tag digest
checks detect ordinary model replacement during a run; they are not cryptographic
attestation of inference. Existing imported raw artifacts are hash-checked on resume.
Resume a run to import retained successful
responses; use a new run/output directory for changed settings or another inference attempt.

## Codex worker flow

Use managed Luna subagents through the user's Codex subscription. Start workers with
no inherited conversation, the shared prompt/schema and a bounded source manifest.
Give each worker its own private output file. No nested Codex CLI or OpenAI API calls
are required. A single coordinator validates/imports results and records completion.
Resume from `pending`; do not repeatedly load all receipt prose into the coordinator.

Keep first-pass answers separate from verifier corrections. Compare a representative
vendor sample and difficult cases against pixels. Measure vendor/date naming, printed
amounts, line arithmetic, handwriting, fragments and duplicate/group evidence separately.
Neither valid JSON nor balanced numbers alone proves a correct reading. Keep ownership
classification and budgeting-app import as later decisions.

Run the synthetic checks with:

```sh
python3 -m unittest discover -s scripts -p 'test_receipt_*.py' -v
```
