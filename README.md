# Galactic receipt scanner

A hands-free receipt capture station for your own private ChatGPT Site. Mount your phone
above a dark desk mat, watch the preview on your computer, and feed receipts one by one.
Red explains a blocking condition; amber means hold still; green confirms saved files.

**Accuracy comes first.** Originals stay immutable, with SHA-256 hashes. Crops and PDFs
are generated afterward as separate derivatives. Image checks cannot certify every character, OCR result or
financial value. The operator scans; their Work/Codex session handles downstream processing.

## Your own instance

Point ChatGPT Work or Codex at this repository and ask it to follow
[HOW_TO_SET_UP.md](HOW_TO_SET_UP.md). Each owner gets a separate private Site, database and
file store. The public repository contains application code, not anyone's receipts.

Both phone and desktop sign in with the owner's ChatGPT account. Sites restricts visitors,
and the server checks the configured owner on every application request. There is no
public signup, shared receipt database, pairing secret or public file bucket.

## What it does

- Browser camera with rear-camera preference, high-resolution stills and a video-frame fallback.
- OpenCV paper edges, focus/print/motion checks and MediaPipe hand detection in a phone worker.
- Direct live video and controls between owner-authenticated devices when the network allows it, with an Internet preview fallback.
- Full-resolution original capture; crops and image PDFs are prepared by Work/Codex after scanning.
- Durable D1 metadata and private R2 objects; retry-safe capture IDs and versioned derivatives.
- Pending-upload recovery on the phone; green only after the original and quality metadata are durably saved and the returned checksum is verified.
- Authenticated downloads and WebMCP tools for the owner's downstream Work/Codex task.

For the smoothest preview, put the phone and desktop on the same network and keep one dashboard open. Direct video uses no external relay service; networks that block it use the slower authenticated image preview.

Use light paper on a dark background. Keep all four edges visible and hands out of view.
Completely remove each receipt before adding the next. Calibrate the first few scans on
the actual phone: partial fingertips, curled paper, glare and faint print can defeat checks.
The minimum 900 pixels across a receipt is a quality gate, not a physical-DPI claim.

OCR, categorisation and reporting belong to the downstream AI workflow. Downstream PDFs start as
image PDFs. Preserve exact values, uncertainties and source evidence when processing them.

## Development

See [setup instructions](HOW_TO_SET_UP.md) for the ignored local manifest and environment.
Node.js 22.12+ is required; Node 24 and installed Google Chrome are recommended.

```sh
npm ci
npm run build
npm test
npm run test:e2e
npm run format:check
```

All tests use synthetic documents. Never commit receipts, account configuration, secrets,
real-data screenshots, local database files or model downloads. See [AGENTS.md](AGENTS.md)
for the accuracy and maintenance contract, and [SECURITY.md](SECURITY.md) for trust boundaries.
