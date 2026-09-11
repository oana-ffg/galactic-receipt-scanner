# Galactic receipt scanner

A local, hands-free receipt scanning station. Mount a phone above a dark, matte surface,
open the desktop dashboard, and feed receipts one by one. Original images stay on your
computer. No receipt data is sent to a cloud service.

**Accuracy comes first.** Red explains a blocking condition. Amber means hold still.
Green means the original was durably saved and the implemented image checks passed.
It does **not** certify OCR text or financial values.

## First-time setup (macOS)

Requires Python 3.12 or 3.13, uv, Node.js 22.12+ (24 recommended), mkcert and Tesseract.
Install those with your preferred package manager. If mkcert has not been used on this
computer before, run `mkcert -install` to create and trust a local development CA.

```sh
python3 scripts/setup.py
python3 scripts/manage.py start
```

Setup installs locked Python/JavaScript dependencies and downloads checksum-verified
MediaPipe hand detection and Danish/English Tesseract model files into `.local/`.
Open the dashboard URL stored in **`.local/launch.json`**. That file contains a private
pairing key; don't publish it. The dashboard shows a QR code for pairing the phone.

On an iPhone that does not already trust this computer's mkcert CA, open the setup
address printed by the start command (`http://<computer-address>:8764`). Install the
public CA profile, then enable full trust under Settings → General → About → Certificate
Trust Settings. This trusts certificates issued by this computer's development CA;
remove the profile later if you no longer need it. The CA private key is never served.

Keep the phone and computer on the same trusted network. Scan the dashboard QR code
and tap **Enable camera** once. Leave Safari visible. On the Mac, choose **Start scanning**.

## Scanning

- Use one light-coloured receipt on a dark, plain, matte background. Keep all edges visible.
- Wait for green before moving the receipt. Completely remove it from the view briefly
  before placing the next; this deliberately prevents repeated automatic captures.
- The first draft waits for at least four stable observations over 0.9 seconds.
- Keep fingers clear. Use even lighting. Paper curls and glare may need physical adjustment.
- **Retry this receipt** rearms after a rejection or intentionally captures another view.
  It creates a new original, never deletes the previous one.
- **Retry upload** asks the phone to resend retained image bytes using their original IDs.
- Images are written to phone IndexedDB before upload and removed there only after an
  accepted/rejected response confirms the original is stored on the computer.
- For long receipts, use overlapping views via Retry this receipt. Grouping/stitching and
  report presentation are later decisions; originals remain independent source images.

```sh
python3 scripts/manage.py status
python3 scripts/manage.py stop
```

The server runs until stopped or the computer shuts down; no startup service is installed.
Keep the computer awake and the external drive connected. On a network-address change,
restart and use the new dashboard link/QR code.

## Data and outputs

Everything under `captures/` and `.local/` is ignored by Git.

| Path                     | Contents                                                         |
| ------------------------ | ---------------------------------------------------------------- |
| `captures/raw/`          | Original uploaded image bytes, immutable                         |
| `captures/index.sqlite3` | Capture IDs, timestamps, checksums, checks and processing status |
| `captures/processed/`    | Perspective-corrected crops, with paper margins, JPEG quality 95 |
| `captures/pdfs/`         | One PDF per accepted capture; searchable after OCR completes     |
| `captures/ocr/`          | Unverified text, TSV coordinates/confidence, engine provenance   |
| `.local/`                | Pairing key, certificates, model files, logs and server PID      |

Rejected but decodable captures retain their originals and a reason. An interrupted
filesystem/database operation never earns green. Uploads with the same ID and identical
bytes are idempotent; conflicting bytes cannot replace an original. Never clean these
directories as part of a build or test. Back up receipt data separately from the public code.

## Implementation

The TypeScript/Vite phone client sends a maximum of eight small preview frames per
second, with one in flight. The desktop displays that feed with paper/hand outlines.
Python/FastAPI runs OpenCV and MediaPipe on one worker; heavy OCR uses another worker.
WebSockets carry previews/commands/status and HTTP carries full-resolution stills.
Preview frames are not recorded. Safari's ImageCapture API is tried first; a full-size
video frame is the explicit fallback, still subject to the same image-quality gates.

Tesseract runs locally with Danish and English models. Searchable PDFs are derivatives;
inspect originals before relying on amounts/dates. This draft does not classify expenses,
verify financial totals, produce the final report, or merge multiple views of a receipt.

## Known limits to calibrate with real receipts

- Contour detection expects light paper on dark background; complex backgrounds, curled
  edges and several overlapping papers can defeat it.
- Hand landmarks can miss partial fingertips. No detector proves the absence of occlusion.
- Blur/contrast/size gates are heuristics; they do not guarantee every character is legible
  or detect every reflection. Inspect a handful of initial scans at original size.
- The default minimum is 900 pixels across the shorter cropped dimension. This is a
  capture gate, not a claim about the receipt's physical DPI or OCR accuracy.
- The server binds to the LAN with HTTPS and a random bearer pairing key. It is a local
  tool, not an internet-facing deployment. Source publication does not publish the service.
- IndexedDB is a recovery buffer, not an archival backup. Don't clear phone site data
  while an upload is pending. Keep originals until acceptance is confirmed.

## Development checks

```sh
uv run ruff check .
uv run pytest
npm test
npm run build
npm run test:e2e
```

The end-to-end test uses installed Google Chrome and the real detector/OCR with a synthetic camera, writing to a temporary data directory.

Synthetic receipt fixtures are generated in tests; real receipts must never enter Git.
See [AGENTS.md](AGENTS.md) for the accuracy, maintainability and public-source contract.
