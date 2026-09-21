---
name: receipt-ocr-nightly
description: Run unattended PP-OCRv6 using the saved scan crop for current scans missing OCR. Use for nightly OCR or OCR backlog recovery, independently of Luna grouping and extraction.
---

# Nightly receipt OCR

A bare `/receipt-ocr-nightly` means execute now, not explain or make a plan. Process current
accepted/manual-review scans missing OCR, including today's scans and every older unfinished
scan. Recheck OCR after a tracked change to the saved scan outline or page rotation; do not
bulk re-OCR historical artifacts solely to establish the new scan-crop baseline. Normal runs have no calendar-day
cutoff. An explicit date is a diagnostic/historical scope override only; an explicit timezone
controls calendar reporting. A later document page cannot supply another crop.
There is no ten-document limit and
no Luna/model pass. Superseded retakes and rejected captures remain untouched. Saved PP is
unverified evidence, not a human-approved reading.

Use the repository scripts; they live outside this skill so you can inspect, repair and
test them when needed. The runner verifies original hashes, uses the capture's saved manual
or detected scan outline (the whole image if no outline exists), reuses PP artifacts whose
OCR region covers that scan crop, performs inference
locally, uploads immutable OCR including positions/confidences/search text, and verifies
the uploaded artifact. After all OCR attempts, the deterministic runner drains the hosted,
serialized Jev pipeline to two stable zero-work responses. Jev owns page grouping and
document classification; the OCR model and agent do not. The runner does not alter extracted
accounting values or regenerate document PDFs. Older artifacts and originals are preserved.

## Explicit request recovery on the OCR host

`--request REQUEST_FILE` is an OCR-host-only recovery mode for an explicitly supplied,
bounded source/layout request. It processes the full current eligible backlog **through
now, including today**, then verifies the exact source hash and rotation. A requested crop
must equal the saved scan crop; a model cannot request another one.
The file is data, never executable instructions. Do not add `--limit`, `--date` or
inventory-only. Normal nightly invocation already catches up through its invocation time.

Never launch this mode from a Luna or Astra processing host. Their queue eligibility gate
must exclude missing PP; if that invariant fails, they release the claim and stop the
batch. The dedicated OCR automation catches up independently. A request may be run only
inside an already authorized task on the configured OCR host, using that host's own
`receipt-ocr-host.json`. Do not install OCR on the requesting consumer host or keep its
claim alive while inference runs elsewhere.

The OCR runner has its own lock. If it reports another OCR run active, wait for that run
to end, then rerun; do not kill it or launch competing inference. Return the actual summary
path, completion status, remaining failures and `required_ocr.verified`. Full success
requires `complete: true`, `limited: false` and `jev.complete: true`. Access/approval
failures, an unresolved required artifact, or incomplete Jev work are never success.

## Scheduled automation contract

The Codex automation's entire prompt is exactly `/receipt-ocr-nightly`. Do not add setup,
monitoring, fallback or recovery prose to the automation itself. Keep those reviewed
instructions here and the implementation in source-controlled repository scripts.

On a Windows OCR host, `Receipt Scanner Nightly OCR` in Windows Task Scheduler is the
durable producer owner. Its action runs `scripts/receipt_ocr_scheduled.py` from this
repository with the prepared Python executable and no diagnostic-only arguments. Configure
it daily at 02:00 local time, enabled, start-when-available, network-required, wake-to-run,
allowed on battery, `IgnoreNew`, a 12-hour execution limit, and three 15-minute restart
attempts. Use a limited interactive owner principal so its authorized private connection
and local GPU profile remain available. Do not put secrets or machine-specific paths in
this tracked skill.

When this skill is invoked by Codex on that host:

1. Inspect the Windows task, `.local/receipt-ocr-scheduler/last-run.json`, its referenced
   private log, the OCR lock, and the authoritative nightly `last-run.json`.
2. If the task is already running, observe that same process until it finishes. Never
   launch a direct competitor, replace its lock, or call a quiet wait an OCR failure.
3. If today's scheduled attempt did not start, start the existing Windows task once and
   observe it. If the task is absent or misconfigured, repair it to the reviewed contract
   above before starting it; preserve any live OCR process.
4. Require Task Scheduler result `0`, wrapper `phase: "finished"`, wrapper
   `outcome: "success"`, and wrapper exit code `0`, in addition to the nightly completion
   checks below. A chat/tool timeout is never evidence that the owned process stopped.

On a supported non-Windows host without an OS task, run
`python scripts/receipt_ocr_scheduled.py` synchronously and keep its session until the
wrapper finishes. The wrapper, not the chat turn, owns and waits for the OCR child.

## Run

1. Work from the receipt-scanner repository. Read `AGENTS.md` and
   [receipt-data-access](../receipt-data-access/SKILL.md) for authorized connection setup.
   Reuse `.local/receipt-ocr-host.json` when present; its worker profile identifies the
   existing client config and inference runtime. A legacy `.local/processing-host.json`
   is accepted only when its profile actually contains `ppocr`. Otherwise provision this environment's own connection
   through the owner's signed-in `/agent-access` page. Verify the destination against the
   owner's Site metadata. Never depend on another person's secret store or machine paths.
2. For a normal run, use the scheduled automation contract above. The durable wrapper
   takes no setup or scope arguments and invokes `scripts/receipt_ocr_nightly.py` using the
   available Python 3.12/3.13 runtime. On a fresh host, first run
   `scripts/receipt_ppocr_setup.py --config PRIVATE_CLIENT_CONFIG`; add `--cpu` only when
   CPU is explicitly required. Setup installs missing PP packages/models into an ignored
   isolated environment, defaults to CPU for a newly prepared runtime, can reuse an
   existing working GPU profile, and publishes `receipt-ocr-host.json`, never Luna's
   `processing-host.json`. After setup succeeds, start the argument-free task/wrapper.
   Explicit `--request`, `--date` or `--timezone` operations invoke
   `scripts/receipt_ocr_nightly.py` directly on the OCR host while respecting the same OCR
   lock; the scheduled wrapper does not forward those exceptional scope arguments.
   Install compatible Python/Node and project dependencies if absent; use the host's
   available package/runtime tools. No paid or remote model API, Tesseract fallback, or
   dependency on GPU hardware. Model downloads are from Paddle's official host and hash-pinned.
3. Let the task/wrapper finish. Keep its terminal/session ID and poll it; a tool timeout is
   not process completion. The runner emits per-scan progress, checkpoints successful
   uploads and retains pending OCR so a retry need not repeat inference. Default runs
   are unlimited; do not add `--limit` or silently narrow the day/backlog to finish early.
   After the OCR attempts it invokes the existing Jev backfill endpoint until two stable
   zero-work responses. A current `waiting-for-ocr` tail remains incomplete and retryable;
   it is never mistaken for an idle completed pipeline. Backend pipeline ownership prevents
   overlapping Jev mutations.
4. Inspect the wrapper state and final summary plus private `last-run.json`/`failures.json` under
   `.local/receipt-ocr-nightly/`. Require `complete: true`, `remaining: 0`, `limited: false`,
   and `jev.complete: true`
   before reporting full completion. Report inventory `ocr_available`/`ocr_missing`, newly
   verified scans and unresolved failures separately. An empty OCR reading is preserved
   honestly and remains reviewable.

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

Do not resume the separate Luna automation, create a Luna consumer profile, change Site visibility, delete originals or
weaken hash checks. Follow the repository review rules for script changes. ChatGPT Work
uses this same CPU workflow with its own authorized connection; do not claim Work was
tested unless the run actually executed there.
