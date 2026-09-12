# Galactic receipt scanner

## Purpose and ownership of the work

Build a fast, hands-free receipt capture station. The operator mounts a phone above a
desk and replaces receipts one by one, using a large desktop preview and red/amber/green
feedback. The operator's work ends after scanning. Organisation, OCR review, PDF output
and reporting belong to the downstream processing workflow, not to the operator.

The initial use is volunteer receipt digitisation for Kattekøbing. The source is intended
for a **public GitHub repository**, so others can use it for similar work. Keep the
implementation generic. Never put actual receipts, extracted text, financial information,
local credentials, machine-specific settings, or private organisation details in source,
tests, screenshots, commits, or documentation. Only synthetic documents belong in tests.

## Production data and test isolation

- Synthetic tests must use isolated local test databases and object storage, or a
  separately provisioned test instance. Never save synthetic captures or artifacts in
  the main production database or bucket, including during browser smoke tests.
- The owner authorized exactly one pre-production cleanup on 12 September 2026, before
  real receipt scanning. This is a one-off exception, not a maintenance procedure or
  reusable permission. Once completed, never reset, truncate, bulk-clear or delete
  production receipts to test, debug, repair or prepare another scanning session.
- Preserve real originals, metadata and derivative history. Future verification against
  production is read-only; perform all test writes and destructive tests in isolation.
- Do not add or leave a production reset button, deletion endpoint or automatic cleanup
  job. Record completion of the one-off cleanup here after verifying persisted storage.

## Accuracy is the highest priority

**These are financial source documents. Accuracy outranks throughput and file size.**

- Preserve original uploaded bytes, with SHA-256 hashes and capture provenance. Cropped
  images, OCR and PDFs are reproducible derivatives, never replacements for originals.
- Green means a captured image passed the implemented quality gates AND its original and
  metadata were durably saved. It does not mean OCR/accounting values are verified.
- Never fabricate, guess, generatively restore, silently correct or discard receipt text.
  OCR is unverified transcription. Retain uncertainties, source coordinates and versions.
- Prefer a visible, actionable rejection over false confidence. Hand detection, focus and
  edge checks are heuristics; describe their limits honestly and calibrate on real samples.
- Prevent repeated automatic captures of the same stationary receipt. Retries must be
  idempotent; conflicting bytes under one capture ID must fail without overwriting data.
- Never delete source files to resolve an error. Retakes are separate captures.
- Do not crop off paper edges, downsample tiny print blindly, or use destructive document
  cleanup. Preserve a margin. Do not use lossy JBIG2 or generative image enhancement.

## Engineering priorities

1. Accuracy and recoverability.
2. Clean, maintainable code: explicit state transitions, cohesive modules, shared logic,
   typed boundaries, few dependencies, no dead code, temporary hacks or speculative APIs.
3. Good performance: bounded frame queues, one inference at a time, small preview frames,
   full-resolution stills, no expensive OCR on the capture loop, no accumulating video.
4. Efficient operation: hands-free capture, clear reasons, desktop controls and optional
   audio. Avoid decorative features that compete with the receipt preview.

Test persistence failures, retry conflicts, disconnections, stale frames, hand obstruction,
capture/removal transitions and clipping. Run typechecks, build, unit/integration tests,
browser tests and dependency audit. Distinguish synthetic checks from physical calibration.

## Architecture and scope

- Browser-first phone camera plus desktop dashboard; a native iOS capture client is an
  acceptable later fallback if browser camera output is insufficient. Keep capture uploads
  and acknowledgements independent of the client technology.
- Deploy one private ChatGPT Sites instance per owner; follow [HOW_TO_SET_UP.md](HOW_TO_SET_UP.md)
  for the complete installation, storage, access-verification and update procedure.
- Browser worker: OpenCV/MediaPipe image checks during capture. Crop and PDF creation are downstream only; they must never delay green or the next receipt.
  Hosted Cloudflare Worker: owner-authorized routes, D1 metadata and private R2 storage.
- Public source is generic. Ignore `.openai/hosting.json`, environment files, `captures/`,
  `.local/`, test output and downloaded model assets. Preserve any existing local captures.
- Owner-only access is mandatory at both Sites policy and application layers. No public
  signup, shared SaaS, public bucket/download URLs, bypass credentials, or client-only auth.
  Verify the saved access policy and deployed unauthenticated denial before handoff.
- The hosting gateway supplies identity; never expose the Worker directly with unverified
  identity headers. Missing configuration must fail closed. See SECURITY.md.
- Direct preview uses an owner-authorized WebRTC handshake through the Site, with an authenticated HTTP fallback. Never add a public signalling endpoint or expose originals through the video path.
- OCR/extraction and reporting run in the owner's Work/Codex task after scanning. Preserve
  uncertainty and original source references. Initial PDFs are image PDFs.

Publish only authorized source changes to the configured public repository. Never choose
a licence without the owner's direction. Do not use worktrees or delete original data.
