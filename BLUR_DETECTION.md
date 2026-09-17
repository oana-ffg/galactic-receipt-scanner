# Captured-image blur checks

Automatic captures use a Crété perceptual blur score, implemented in the browser
worker and checked against `skimage.measure.blur_effect` reference values. Higher
scores mean more blur. Variance of Laplacian is not the blur decision; the
Laplacian remains useful for estimating noise in the separate ink-presence check.

The live preview supplies inexpensive geometry, ink, hand and stability evidence.
The blur decision is made on the actual encoded photo before accepted/green is
possible. The worker crops the original to the detected paper's axis-aligned
bounds plus a 10-source-pixel margin, converts to grayscale, and downsizes to a
maximum 600-pixel long edge using area averaging. Native pixels are read in bounded
1024 × 256 tiles; fractional overlaps preserve `INTER_AREA` sampling across tile
seams without allocating a second full-resolution image. Independent OpenCV
reference tests cover non-integer scales with a one-gray-level rounding tolerance.
Missing geometry falls back
to the whole image for scoring; it does not bypass the paper/edge checks.

Calibration lives in `web/blur-quality.ts` (`BLUR_CONFIG`), separate from the metric:

| Score             | Capture behavior                        |
| ----------------- | --------------------------------------- |
| Below 0.30        | Passes the blur check                   |
| 0.30 through 0.38 | Saved normally; nonblocking review flag |
| Above 0.38        | Retake needed; original still preserved |
| Unavailable       | Retake needed; never silently passes    |

Existing explicit manual capture can still save an override for manual review.
The review band does not pause or slow the scanning flow. Saved-picture details
show the score and flag, and document source notes request a visual check until
that document has been visually reviewed. The immutable capture measurement
remains even after review.

Every new full-shot check records `quality.blur`: algorithm/preprocessing version,
raw score, category, actual source bounds, measured pixel dimensions, filter size
and thresholds. Historical captures without this field remain valid; absence is
not a zero score. Calibrating defaults requires a new client build and changes
new capture measurements without rewriting historical metadata. The worker also
checks blur when asked to generate an output from an older original, so that
operation uses the current checker. Already-open camera pages retain their existing
checker until the owner reloads after a durable saved acknowledgement.

## Validation and limits

`web/fixtures/blur-reference.json` contains only synthetic pixel arrays and their
scikit-image 0.26.0 scores, using `h_size=11` and default maximum-axis reduction.
Unit tests compare the browser implementation against those independent values.
Browser quality tests exercise the full worker on synthetic paper, faint ink,
blur, glare and empty scenes. Complete camera-loop tests cover Chromium/WebKit,
saved-original acknowledgement, removal and stationary duplicate protection.

Keep filter size, crop method and scaling fixed when calibrating thresholds.
A rectified crop and a bounding crop can produce different scores. Use varied
real samples privately, including readable thermal print, handwriting, folds,
noise, directional motion and defocus. Inspect the actual source at useful scale;
an aggregate blur metric cannot certify every small character. A sharply imaged
empty desk can score well, so document/ink checks remain necessary. Measure
latency on the actual phone before claiming device performance.

Reference: [scikit-image blur_effect](https://scikit-image.org/docs/stable/api/skimage.measure.html#skimage.measure.blur_effect),
Crété et al., _The blur effect: perception and estimation with a new no-reference
perceptual blur metric_ (2007).
