# Capture and transcription validation

Validation performed 12 September 2026. Tests use synthetic data only. Generated fixture
prompts and provenance are in `e2e/fixtures/generated/prompts.json`.

## Verified behaviour

- Chrome and WebKit each encoded and decoded 1,000 consecutive 2160 × 3840 photos.
  Every decoded image retained the dimensions and the expected unique pixel marker.
  No blank/stale images or progressive slowdown occurred. Chrome first/last 100 means:
  59/58 ms; WebKit: 83/80 ms. These are desktop engine measurements, not iPhone timings.
- Actual browser capture, private local Worker/R2/D1 persistence, checksum acknowledgement,
  retries after a lost acknowledgement, lease recovery/release, and repeat captures pass.
  The synthetic handheld capture reached saved acknowledgement in 1.8 seconds; direct
  preview delivered 29 frames over approximately two seconds while HTTP preview was delayed.
- Generated photographs cover textured paper, faint creases, an off-centre tilted receipt
  with desk glare, partial fingers, and a Danish receipt with a text-and-leaf logo.
  Separate pixel fixtures cover blank/noisy paper, blur, clipping, two papers, dim light,
  bright white paper, blown highlights, and removal with glare/keyboard clutter remaining.
- Translation, rotation and alternating exposure on textured photographs satisfy the
  stability interval without continually resetting it. A stationary saved receipt stays
  latched; removal rearms. Capture movement after freezing cannot invalidate the saved photo.
- Long errors and connection warnings do not move the preview or controls on mobile or desktop.
- Danish OCR preserves tested æ/ø characters, decimal commas, negative discounts, VAT and
  amount columns. The ØKOHJØRNET text logo is recognized. A leaf symbol misread as `7` is
  flagged as uncertain. Visual-review corrections are saved as separate versions; the
  initial OCR version and unchanged original remain retrievable by their hashes.
- OCR source coordinates, language-model provenance, private model loading and persisted
  extraction are tested. OCR/PDF work is absent from the capture loop.

## Scope of the evidence

The 1,000-photo runs stress encoding and memory lifetime, not 1,000 real camera uploads.
WebKit is the Safari engine on this Mac, not a physical iPhone camera session. Generated
photographs are not native 4K camera samples; full-resolution minimum-size checks remain
enabled. No upscaled fixture is claimed as proof of optical detail.

Quality checks remain heuristics. Partial fingers can evade MediaPipe; the obstructed
fixture is blocked by its paper outline. Blown-highlight checks cannot prove that every
faint character remains readable. OCR confidence does not certify text, logos or accounting.
The downstream workflow visually reviews originals and preserves unresolved uncertainty.

## Reproduce

```sh
npm run build
npm test
npm run test:e2e
npx playwright test --config playwright.webkit.config.ts
npm run format:check
npm audit
```

The build typechecks client and Worker code. Browser tests require Google Chrome and
Playwright WebKit (`npx playwright install webkit`). Tests create isolated synthetic
storage; they never use or delete the owner's receipts.
