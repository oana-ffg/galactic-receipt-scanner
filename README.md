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
  Preview hand detection runs near the end of the stability window after the other
  checks pass, and when confirming removal. Every captured photo is checked afresh.
  Removal uses a 150 ms confirmation for consecutive hand-free frames where the last
  paper area is clear at the most inclusive segmentation threshold and substantially
  darker than the paper. Ambiguous backgrounds keep the 450 ms confirmation. Saved
  paper skips print analysis; motion or outline loss alone never re-arms capture.
  Idle or paused previews skip capture ML; pause still leaves the camera and preview on.
- Direct live video and controls between owner-authenticated devices when the network allows it, with an Internet preview fallback.
- Full-resolution original capture; crops and image PDFs are prepared by Work/Codex after scanning.
- Recent captures compares the saved original and outline with an unsaved, downloadable PDF draft, prepared on the desktop as rows become visible.
- Durable D1 metadata and private R2 objects; retry-safe capture IDs and versioned derivatives.
- Retakes are numbered takes of one receipt: the latest accepted take is current, previous originals stay available, and the receipt is counted once.
- Pending-upload recovery on the phone; green only after the original and quality metadata are durably saved and the returned checksum is verified.
- Private Danish/English OCR after scanning, with two layout passes, source coordinates and flagged uncertainties for downstream visual review.
- Authenticated downloads and WebMCP tools for the owner's downstream Work/Codex task.

For the smoothest preview, put the phone and desktop on the same network. One dashboard owns the direct video connection; additional dashboards use the authenticated image preview. A dashboard with stalled or missing video requests fallback images for five seconds at a time. The phone stops that extra encoding and uploading when requests expire, and original uploads still take priority. Direct video uses no external relay service; networks that block it use the same fallback.

Phone states carry a camera ID and increasing revision so the desktop can use the newest status from either connection without reverting to an older colour. Already-open older clients remain compatible; reload both pages after a saved acknowledgement to activate these improvements. Before the saved count loads, the counter shows a dash rather than an unverified zero.

Use light paper on a dark background. Keep all four edges visible and hands out of view.
Leave a dark gap around the paper and keep keyboards and other bright objects away from it.
Completely remove each receipt before adding the next. Calibrate the first few scans on
the actual phone: partial fingertips, curled paper, glare and faint print can defeat checks.
The source must cover at least 450 pixels on the receipt’s short side and 900 on its long
side, in either orientation. This allows narrow receipts while retaining focus, contrast
and glare checks. These are heuristic quality gates, not a physical-DPI or legibility guarantee.

OCR, categorisation and reporting belong to the downstream AI workflow. Downstream PDFs start as
image PDFs. Follow [the post-processing workflow](POST_PROCESSING.md). Preserve exact values, uncertainties and source evidence when processing them.

## Development

See [setup instructions](HOW_TO_SET_UP.md) for the ignored local manifest and environment.
Node.js 22.13+ is required; Node 24 and installed Google Chrome are recommended.

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
