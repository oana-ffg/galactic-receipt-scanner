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
capture/removal transitions and clipping. Run Python tests/lint and frontend typecheck,
build and tests before considering changes complete. Browser-test the actual UI; distinguish
synthetic verification from physical phone/receipt calibration.

## Architecture and scope

- Browser-first phone camera plus desktop dashboard; a native iOS capture client is an
  acceptable later fallback if browser camera output is insufficient. Keep capture uploads
  and acknowledgements independent of the client technology.
- Python/FastAPI backend, OpenCV image checks, MediaPipe hand detection, SQLite metadata.
- All runtime data belongs under ignored `captures/` or `.local/`. In particular:
  `captures/raw/`, `captures/processed/`, `captures/pdfs/`, `captures/ocr/`.
- Serve locally with HTTPS and authenticated pairing. No cloud receipt uploads, telemetry,
  hosted inference, or public deployment is part of the initial workflow.
- Report layout, financial classification and a native app are later decisions. The first
  draft must capture safely and supply readable, traceable derivatives for testing.

Do not publish to GitHub or choose a public licence without the owner's direction.
Do not use worktrees. Preserve unrelated changes and any existing capture data.
