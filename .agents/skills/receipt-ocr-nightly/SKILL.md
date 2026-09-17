---
name: receipt-ocr-nightly
description: Run unattended PP-OCRv6 over the previous scan day and unfinished older scans, installing the CPU runtime when needed and uploading verified OCR. Use for nightly OCR or OCR backlog recovery, independently of Luna grouping and extraction.
---

# Nightly receipt OCR

A bare `$receipt-ocr-nightly` means execute now, not explain or make a plan. Process every
current accepted/manual-review scan through the previous calendar day in Europe/Copenhagen,
including older unfinished scans. An explicit date/timezone overrides these defaults.
There is no ten-document limit and no Luna/model pass. Superseded retakes and rejected
captures remain untouched. Saved PP is unverified evidence, not a human-approved reading.

Use the repository scripts; they live outside this skill so you can inspect, repair and
test them when needed. The runner verifies original hashes, uses the saved document outline
(manual correction takes precedence), reuses matching PP artifacts, performs inference
locally, uploads immutable OCR including positions/confidences/search text, and verifies
the uploaded artifact. It does not group pages, alter extracted accounting values or
regenerate document PDFs. Older artifacts and originals are preserved.

## Run

1. Work from the receipt-scanner repository. Read `AGENTS.md` and
   [receipt-data-access](../receipt-data-access/SKILL.md) for authorized connection setup.
   Reuse `.local/processing-host.json` when present; its worker profile identifies the
   existing client config and runtime. Otherwise provision this environment's own connection
   through the owner's signed-in `/agent-access` page. Verify the destination against the
   owner's Site metadata. Never depend on another person's secret store or machine paths.
2. Run `python scripts/receipt_ocr_nightly.py` using the available Python 3.12/3.13 runtime.
   On a fresh host pass `--config` with the actual private client-config path. The script
   installs missing PP packages/models into an ignored isolated environment and defaults
   to CPU there. It can reuse an existing working GPU profile. `--cpu` explicitly selects
   CPU. Setup can also be run separately with `scripts/receipt_ppocr_setup.py`.
   Install compatible Python/Node and project dependencies if absent; use the host's
   available package/runtime tools. No paid or remote model API, Tesseract fallback, or
   dependency on GPU hardware. Model downloads are from Paddle's official host and hash-pinned.
3. Let the command finish. Keep its terminal/session ID and poll it; a tool timeout is
   not process completion. The runner emits per-scan progress, checkpoints successful
   uploads and retains pending OCR so a retry need not repeat inference. Default runs
   are unlimited; do not add `--limit` or silently narrow the day/backlog to finish early.
4. Inspect the final summary and private `last-run.json`/`failures.json` under
   `.local/receipt-ocr-nightly/`. Require `complete: true`, `remaining: 0`, and `limited: false`
   before reporting full completion. Report verified/reused scans and unresolved failures
   separately. An empty OCR reading is preserved honestly and remains reviewable.

## Keep working through failures

You are authorized to diagnose and fix the project OCR/setup scripts and this host's
installation to complete the run. Do not stop at the first error or merely say the script
failed. The script tries every scan, then retries individual failures in subsequent passes.
If it still fails, inspect the private diagnostics, identify the cause, make a targeted
repair, run relevant tests, and rerun the same command; verified successes are reused.
Re-run CPU inference with a larger `ppocr.timeout_seconds` when a slow CPU is demonstrably
making progress. Never interpret a shell timeout as proof that inference failed.

For expired credentials, use the normal authenticated renewal/setup route if available.
Do not bypass access controls or keep sending denied requests. A revoked connection or a
required owner sign-in is a real blocker; report it. A corrupt/unreadable individual source
must not block other scans: preserve it and report its ID and exact failure. Keep working
while a supported repair or retry can make progress; do not spin on an unchanged permanent
failure. Leave all unresolved scans retryable for the next run and provide a concrete
failure report when external access, unavailable resources or execution limits prevent
completion. Partial success is never reported as complete.

Do not resume the separate Luna automation, change Site visibility, delete originals or
weaken hash checks. Follow the repository review rules for script changes. ChatGPT Work
uses this same CPU workflow with its own authorized connection; do not claim Work was
tested unless the run actually executed there.
