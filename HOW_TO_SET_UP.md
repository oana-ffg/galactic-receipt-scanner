# Set up your private Galactic receipt scanner

Give ChatGPT Work or Codex the public repository URL and ask:

> Set up Galactic receipt scanner as a new private Sites instance for my own account.
> Follow HOW_TO_SET_UP.md, keep every receipt and endpoint owner-only, and verify access
> before giving me the scanning link. Do not reuse anyone else's deployment or storage.

## Installation contract for the agent

1. Clone this repository into the user's chosen directory. Each owner needs a separate
   Site, D1 database and R2 bucket. This is not a shared service with user registration.
2. Read `AGENTS.md`. Use the installed **Sites building** and **Sites hosting** skills.
   Reuse a local `.openai/hosting.json` only when it belongs to this user's intended
   instance. It is deliberately Git-ignored and absent from the public repository.
3. If no instance exists, create exactly one Site. Save its exact returned ID atomically
   in `.openai/hosting.json`, with `d1: "DB"` and `r2: "BUCKET"`. Never commit this file.
   Do not enable public access, add viewers or editors, or invite a workspace.
4. Read back the Site's access policy. Require the current role to be owner, custom
   access, exactly one allowed account (the owner), no external visitors, editors,
   workspace groups or tenant groups. Use a personal account if workspace admins must
   not have administrative access. Hosting providers retain infrastructure access.
5. Configure `OWNER_EMAIL` as a hosted secret using the verified owner's authenticated
   email, and `APP_ORIGIN` as the exact HTTPS origin returned by Sites. Do not guess the
   owner, use first-visitor ownership, or commit account details. Missing configuration
   denies all requests. The server requires both the dispatcher user-ID header and the
   exact owner email; authentication alone does not authorize a different visitor.
6. Create a private TypeSafe API key at `https://console.typesafe.ai/keys` and configure
   it as the hosted secret `TYPESAFE_API_KEY`. Pass it directly from the authenticated
   console to the Site secret store; never put it in source, prompts, logs, Git, local
   environment files or deployment metadata. The backend pins Jev `jev-1.13.0`. Missing
   Jev configuration never blocks capture or PP upload, but leaves retryable Jev jobs and
   keeps those documents out of Luna's queue.
7. Install Node.js 22.13+ (24 recommended), then run:

   ```sh
   npm ci
   npm run build
   npm test
   npm run test:e2e
   npm run format:check
   npm audit
   ```

   The build downloads a checksum-verified MediaPipe hand model and copies locked npm
   WASM assets into ignored `public/vendor/`. Camera images never go to the model host.
   Build artifacts include the Worker, client assets, hosting manifest and generated
   Drizzle migrations. Existing migration files are immutable after deployment.
   The browser test uses installed Google Chrome and synthetic receipts only.

8. Commit the validated source. Keep the public GitHub origin; push the same commit to
   the instance's Sites source repository using its temporary credential only as a
   per-command authorization header. Never put credentials in Git URLs or files.
   Use Sites' build/package helpers and privately deploy the exact saved version.
   Wait for a successful deployment, then re-read the saved owner-only access policy.
9. Verify the deployed root, camera, metadata, previews and file endpoints without
   cookies: no application data may be returned. Test spoofed identity headers too;
   the Sites dispatcher must strip or reject them. Verify the signed-in owner can
   open the dashboard and camera. Check another authenticated identity if available;
   do not claim this live case was tested when only synthetic identity tests ran.
   Never disable an owner check to make a test pass.
10. Verify WebMCP tools in a supported owner-authenticated browser. If unavailable, keep
    ordinary downloads/API access and describe the tool validation gap honestly.
11. Give the owner the private dashboard URL and short phone instructions. Keep all
    real-data testing out of the public repository. Do not make a central shared instance.

**Do not deploy this Worker directly to an unrestricted workers.dev address.** The
application trusts identity headers authenticated and supplied by the Sites dispatcher.
A direct deployment needs a real identity-verification gateway; accepting client-supplied
headers is not authentication. The exact-origin check is defense in depth, not a substitute.

## Scan

For optional direct Codex/Work processing without browser retrieval, follow
[PROCESSING_ACCESS.md](PROCESSING_ACCESS.md) and the
[receipt data access skill](.agents/skills/receipt-data-access/SKILL.md).
This is separate from capture setup; it does not require reloading an active camera.

Open the private Site on the Mac. Scan its QR code with the phone, sign in using the
same owner account, and tap **Enable camera**. Mount the phone over a dark, matte surface.
Keep Safari visible. Scanning starts automatically after **Enable camera**; use **Pause** and **Start scanning** on the Mac when needed. No LAN or certificate setup
is needed; both devices need Internet access.

- Red: read the reason; move hands away, adjust focus, or retry.
- Amber: the label distinguishes stability checks, taking the photo, checking the captured image, and saving the original. Crops and PDFs do not run during capture.
- Green: the original and quality metadata are durably saved and its checksum verified; remove the receipt completely before inserting the next.
  Leave a brief visible gap: clearly empty, hand-free frames can confirm removal after
  150 ms; ambiguous backgrounds need 450 ms. Actual timing also depends on the phone's
  processing speed. A swap without an observed clear gap stays locked to prevent duplicates.
  One borderline, hand-checked frame can preserve an established clear interval;
  a fresh clear frame must follow promptly before removal is confirmed.
- **Retry upload** resends the exact retained bytes and ID after a failed connection.
- The desktop shows the latest saved original with the outline detected in that photo.
  Use **Inspect full size** and **Actual pixels** to check fine print; the outline is an
  overlay and never changes the original. Recent captures show ten per page.
- **Retake** beside an older capture selects that receipt and pauses the phone. Wait for
  the phone to acknowledge the selection, place the same physical receipt in view, then
  choose **Start scanning**. **Cancel retake** returns to normal scanning.
- **Force take** saves a full-resolution original even when automatic checks reject an
  unusual shape. It is explicitly **Saved for review**, never green, and pauses automatic
  scanning because an unusual shape may also confuse removal detection. Force again to
  retake the same receipt, or replace it and choose **Start scanning** for the next. It links to a selected
  retake or the receipt still in view. Remove the previous receipt completely before forcing
  a different one. Forced receipts count once; a forced retake does not supersede an
  accepted take. Review forced photos in capture history before downstream processing.
- Audio starts enabled and remembers the last choice in browser storage. A click or tap
  unlocks browser audio. Success uses one high ding; failure uses three low descending buzzes.
- **Report issue** attaches a screenshot of the visible scanner page to a private report.
  It also includes that device's recent structured diagnostics, captured when the report
  opens: camera settings and observed frame rate, photo API failures and output dimensions,
  capture/save transitions, and preview delivery, encoding and network statistics where
  available. History is bounded to at most two minutes, 180 events and 24 KB, so busy
  sessions may retain less. Report before refreshing; for phone-to-desktop problems,
  reports from both devices provide both sides of the connection.
  Reports and screenshots stay in the instance's D1/R2 storage and can be reviewed under
  **Private issues**. The optional GitHub checkbox starts off and only opens a public draft
  for review; private report details and screenshots are never copied into it.
- **Retake photo** creates a linked, numbered take of the receipt still in view. The latest accepted take is current and counts once; previous originals and derivatives remain available. A rejected retake leaves the previous accepted take current. Remove the receipt completely to start a different receipt.

Inspect the first few originals at full size to calibrate lighting, height, small print
and glare. Browser quality checks are conservative heuristics, not proof of legibility.
Phone IndexedDB holds pending originals and checks until server acknowledgement;
do not clear site data or use private browsing while anything is pending.

## Storage and processing

Use **Review receipts** (`/review`) after capture to inspect originals, identify receipt dates
and vendors, group non-adjacent pages, mark duplicates, check invoice totals and generate
named multi-page PDFs. Unknown readings remain in review; failed processing and inconsistent
totals are broken. Every decision has revision history. Give Work/Codex the project
[receipt-processing skill](.agents/skills/receipt-processing/SKILL.md) to process a batch.
PP-OCR runs on the separately configured OCR host (normally the GPU worker). The hosted
backend uses the owner's private TypeSafe key for Jev page/document classification and
grouping before Luna can claim a receipt. Luna consumes saved PP artifacts and never
installs or invokes an OCR engine on its processing host.

To ask Codex to investigate a parsing mistake, select the receipt and choose
**Copy for Codex**. Paste into your task and describe what looks wrong. The copied
prompt identifies the saved document revision and source pages; **Receipt link**
reopens that document's current saved view, even if the default filters hide it.
These links still require owner access. Unsaved form edits are not included.

D1 stores metadata, hashes, artifact revisions and the current capture-station state.
R2 stores originals (`raw/`), crops (`image/`), PDFs (`pdf/`) and unverified extraction
artifacts (`ocr/`). A direct WebRTC video/data connection is attempted between owner-authenticated devices, using only host ICE candidates and no external STUN/TURN service. One dashboard can hold that connection; additional viewers and dashboards with stalled video request a short fallback lease. Network isolation can prevent a direct connection. The same-origin private preview remains the fallback over the Internet. The `preview/latest` object is overwritten as fallback frames arrive; a stale
preview is inaccessible through the application. It is a private last-frame buffer, not
an accumulating video recording. Receipts are never served through public object URLs.

Raw bytes are immutable and checked against a SHA-256 returned to the phone. The accepted status means the original passed the implemented checks and is saved; it does not require derivative files. Metadata reports which outputs exist. Derivative
versions have their own hashes. No deletion endpoint is exposed. Back up original images,
metadata and final reports separately; a public Git repository is not a data backup.

After scanning, ask your Work/Codex session to inspect and process the batch. Capture itself performs no PDF creation, OCR or organisation. The Site
exposes authenticated paginated metadata at `GET /api/captures`, capture metadata at
`GET /api/captures/{id}`, and files at `GET /api/files/{id}/{raw|image|pdf|ocr}`.
Browser requests use the owner's authenticated session. For non-browser processing, configure
the platform access token and scoped scanner credential through [PROCESSING_ACCESS.md](PROCESSING_ACCESS.md).
An ordinary URL is not a file credential; keep downloads private and credentials in secret storage.

Where supported, the open dashboard exposes these WebMCP tools:

- `list_receipts`: list current takes (accepted or marked `manual-review`), one per receipt; follow the returned cursor. Set `history: true` to inspect rejected and previous takes.
- `read_receipt`: get one capture and authenticated file URLs for inspecting the sources.
- `prepare_receipt_outputs`: after scanning, verify an original against its hash and create its crop and image PDF. Run one receipt at a time; failed derivative generation never changes the saved original.
- `save_receipt_transcription`: save source-backed text, provenance, explicit uncertainties and original-pixel regions after visual inspection.

OCR runs through PP-OCR outside the browser. Saving exact-layout PP triggers the hosted
Jev page-role pass; blank OCR is classified as misc without an external call. At the end
of the nightly OCR run, the same deterministic runner drains Jev's serialized grouping,
detached-payment and final-document pipeline to two stable zero-work responses. The review
page displays saved OCR and model readings; PDF generation reuses saved OCR matching the
current page layout.

Follow [POST_PROCESSING.md](POST_PROCESSING.md) for batch processing and source reconciliation.

Image bytes must actually be retrieved and inspected; a file URL alone is not visual
inspection. Extraction and reporting run in the user's Work/Codex task. The hosted Site
calls Jev only after PP-OCR upload and never from the capture/save path; Luna and Astra
remain subscription-backed managed agents. PDFs generated after scanning
contain a crop derived from the preserved original; searchable PDFs and reports are downstream derivatives.
Authenticated clients may upload versioned PDF, image or OCR artifacts with
`POST /api/captures/{id}/artifacts/{pdf|image|ocr}`. Use `Origin` equal to the Site origin
and `X-Scanner-Request: 1` on every mutation. Preserve uncertainties and source references.
Capture detail includes artifact hashes; append `?version=<sha256>` to an artifact download
to retrieve an earlier revision without replacing the latest one.

## Development and updates

`npm run build` requires a local hosting manifest, even when testing. For synthetic local
work, create `.openai/hosting.json` containing only `{"d1":"DB","r2":"BUCKET"}`; no
remote Site is needed. `npm run dev` runs the isolated loopback-only synthetic dispatcher
and in-memory D1/R2 used by the browser tests. It serves test identity only, never real
receipt data, and is not included in deployment output. Restarting it clears test data.

Apply updates to the existing instance ID, preserving runtime secrets and data. Generate
new schema migrations with `npm run db:generate`, validate them locally, and follow the
same private publish and access-verification steps. Do not clone a fresh instance as an
update strategy or copy somebody else's hosting manifest. The original LAN implementation
is retained in Git history before the Sites migration; ignored local captures remain intact.

Retake tracking applies to new captures after this update. Existing captures retain their
own receipt IDs because their earlier retake relationships were never recorded. Review
possible earlier duplicates against the originals before accounting; never merge them by
timestamp alone. Reload the dashboard and camera after updating so both use linked retakes.

Updates keep existing clients running; reload the desktop and phone after a saved acknowledgement
when ready to activate new controls. Do not reload during an upload. The issue-report migration
only adds separate tables; it does not rewrite receipts. The friendlier wrong-account page
applies when the application handles access denial. The Sites sign-in/access gateway may
intercept a visitor before the application can display its page.

### Manual outline corrections

After inspecting a saved original, `save_receipt_outline` records a separate manual
outline with an inspection note. The normalized corners run clockwise around all paper
edges, including protruding folds, with a margin. Corrections are append-only and tied
to the original checksum; capture status, quality checks and original pixels stay intact.
Saved-photo viewers show the corrected outline. This does not regenerate derivatives
or certify financial content.

Owner-session clients can read correction history at `GET /api/captures/{id}/outlines`
and append with `POST` using `id` (a new UUID reused for retries), `source_sha256`,
`previous_id` (latest correction ID or null), `quad` and `note`. Concurrent edits return
409 and require rereading. Scoped processing connections cannot write these owner edits.
