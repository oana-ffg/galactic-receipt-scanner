# Galactic Receipt Scanner

**Turn your phone into a hands-free receipt scanning station.**

Deploy your own private instance on **ChatGPT Sites**, capture receipts with your phone,
then ask **ChatGPT Work** to parse the receipts and invoices. Mount the phone above a desk,
watch the desktop preview, and feed the paper through one receipt at a time.

Built for a real volunteer digitisation job, **stress-tested with 800 receipts so far**,
and continuously improved through real-world use. Built and iterated with GPT-6 Astra in Codex.

[Watch the uncut, real-world demo](https://www.youtube.com/watch?v=wbl8-8RVBwY)
· [Set up your instance](HOW_TO_SET_UP.md)
· [Process your receipts](POST_PROCESSING.md)

## From a pile of paper to documents you can review

### 1. Ask ChatGPT Work to deploy it

Give ChatGPT Work or Codex this repository and ask:

> Deploy Galactic Receipt Scanner on ChatGPT Sites for my own account. Follow
> HOW_TO_SET_UP.md, keep the instance and its data owner-only, and verify access before
> giving me the scanning link.

Each owner gets a separate private Site, database and file store. Sign in on your phone
and computer with the same owner account. The repository contains the application code;
your receipt images and data stay in your private instance.

Local setup and processing are developed and verified through Codex. A complete setup
from a cloud-only ChatGPT Work environment is still awaiting end-to-end validation; see
[agent connections](PROCESSING_ACCESS.md) for the current environment requirements.
Let me know if setup gives you trouble, and share if it helps with your mountain of receipts!

### 2. Scan without tapping a shutter

Mount your phone above a dark, matte surface, open the desktop preview, and enable the
camera. Place a receipt in view with all four edges visible and move your hands away.

| Signal    | What to do                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Red**   | Read the reason and adjust the receipt, focus or lighting.                                                                      |
| **Amber** | Hold still while the scanner checks, captures and saves.                                                                        |
| **Green** | The original and quality metadata are saved and the checksum is verified. Remove the receipt completely, then add the next one. |

The operator's job is scanning. OCR, grouping and PDF generation happen afterwards,
away from the capture/save path.

### 3. Ask ChatGPT Work to parse the receipts and invoices

Connect your Work/Codex session to your private instance using the
[agent connection guide](PROCESSING_ACCESS.md), then give it the
[receipt-processing skill](.agents/skills/receipt-processing/SKILL.md) and ask it to process
saved receipts.

The downstream workflow can read printed content, flag handwriting, group pages into
documents, identify vendors and dates, flag duplicates, check invoice totals and create
named multi-page PDFs. The **Review receipts** page keeps originals, OCR/model readings,
uncertainties and revision history together for inspection. Unclear readings remain open
for review; financial values are never silently guessed or corrected.

## Built for the messy parts of real scanning

| Feature                              | Why it helps                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Hands-free capture**               | Paper-edge, focus, motion, print and hand checks guide you while you feed receipts.                                 |
| **Desktop preview and controls**     | See the camera feed, pause scanning and inspect saved originals on a larger screen.                                 |
| **Preserved originals**              | Full-resolution source photos stay immutable, with SHA-256 checksums. Crops, OCR and PDFs are separate derivatives. |
| **Recoverable uploads**              | The phone retains pending originals and retries with the same capture identity after connection problems.           |
| **Linked retakes**                   | Take a better photo of a receipt without losing earlier originals or counting the receipt twice.                    |
| **Manual capture for awkward paper** | Force a photo when automatic checks reject an unusual shape; it stays explicitly marked for review.                 |
| **Source-backed review**             | Compare saved readings with the original, inspect OCR regions and keep a history of decisions.                      |
| **Private agent access**             | Connect Work/Codex with owner-authorized, scoped credentials that you can revoke.                                   |

No OCR or model API runs in the camera loop. Downstream agents use your Work/Codex
session and CPU OCR; the Site does not run a persistent AI worker or embed a paid model
API account.

## Your originals come first

Green confirms a saved capture that passed the implemented image checks. It does not
certify every printed character or verify accounting values. Review the first few
originals at full size to calibrate camera height, lighting, glare and small print.

Use light paper on a dark background, leave a clear margin, and keep bright objects out
of view. Completely remove each receipt before placing the next. Keep the camera page
visible, and do not clear site data while an upload or recovery is pending.

Phone and desktop need Internet access. The same network gives the best chance of a
direct live preview; an authenticated image-preview fallback handles other networks.
Both paths keep original uploads ahead of preview work.

Access is restricted at both the Sites and application layers. There is no public
signup, shared receipt database or public file bucket. Back up originals and metadata
separately; the public repository is not a receipt backup.

## Documentation and development

- [Setup and scanning guide](HOW_TO_SET_UP.md): deploy, scan, inspect and update your instance.
- [Agent connections](PROCESSING_ACCESS.md): provision scoped access for processing or backups.
- [Post-processing workflow](POST_PROCESSING.md): preserve evidence while turning captures into documents.
- [Security model](SECURITY.md): owner access, trusted boundaries and storage protections.
- [Project guidance](AGENTS.md): source integrity, test isolation and contribution requirements.

The app uses a browser camera with OpenCV/MediaPipe checks, a Cloudflare Worker, D1
metadata and private R2 storage, hosted behind ChatGPT Sites.

For local development, follow the [local setup instructions](HOW_TO_SET_UP.md#development-and-updates)
first. Node.js 22.13+ is required; Node 24 and installed Google Chrome are recommended.

```sh
npm ci
npm run build
npm test
npm run test:e2e
npm run format:check
```

Tests use synthetic documents and isolated storage. Never commit real receipts,
extracted financial data, account configuration, secrets, private screenshots, local
databases or downloaded model assets.
