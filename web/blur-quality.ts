/** Capture calibration. Keep preprocessing fixed when comparing saved scores. */
export const BLUR_CONFIG = {
  maxEdge: 600,
  cropMarginPixels: 10,
  filterSize: 11,
  fineBelow: 0.3,
  blurryAbove: 0.38,
} as const;

export interface BlurMeasurement {
  version: "crete-1";
  score: number | null;
  category: "likely-fine" | "uncertain" | "likely-blurry" | "unavailable";
  region: "document-bounds" | "whole-image";
  sourceBounds: [number, number, number, number];
  pixels: [number, number];
  filterSize: number;
  fineBelow: number;
  blurryAbove: number;
}

export function blurCategory(
  score: number | null,
  thresholds: { fineBelow: number; blurryAbove: number } = BLUR_CONFIG,
): BlurMeasurement["category"] {
  if (
    !Number.isFinite(thresholds.fineBelow) ||
    !Number.isFinite(thresholds.blurryAbove) ||
    thresholds.fineBelow < 0 ||
    thresholds.blurryAbove > 1 ||
    thresholds.fineBelow > thresholds.blurryAbove
  )
    throw new Error("Invalid blur thresholds.");
  if (score === null || !Number.isFinite(score) || score < 0 || score > 1)
    return "unavailable";
  if (score < thresholds.fineBelow) return "likely-fine";
  if (score > thresholds.blurryAbove) return "likely-blurry";
  return "uncertain";
}

// scipy.ndimage's half-sample symmetric (reflect) boundary convention.
function reflect(i: number, length: number): number {
  const period = length * 2;
  const wrapped = ((i % period) + period) % period;
  return wrapped < length ? wrapped : period - 1 - wrapped;
}

/**
 * Crété perceptual blur, matching skimage.measure.blur_effect on grayscale:
 * reblur each axis, compare absolute Sobel edges, return the larger axis score.
 * Reference: https://scikit-image.org/docs/stable/api/skimage.measure.html#skimage.measure.blur_effect
 * Higher is blurrier. This does not establish that a document or readable text exists.
 */
export function blurEffect(
  gray: Uint8Array,
  width: number,
  height: number,
  filterSize: number = BLUR_CONFIG.filterSize,
): number | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 4 ||
    height < 4 ||
    gray.length !== width * height ||
    !Number.isInteger(filterSize) ||
    filterSize < 3 ||
    filterSize % 2 !== 1
  )
    return null;
  const source = Float64Array.from(gray, (v) => v / 255);
  const blurred = new Float64Array(gray.length);
  const radius = (filterSize - 1) / 2;
  const edge = (pixels: Float64Array, i: number, vertical: boolean) => {
    const along = vertical ? width : 1;
    const across = vertical ? 1 : width;
    // Only called within the reference's inset, so no boundary lookup is needed.
    const value =
      (pixels[i - along - across] - pixels[i + along - across]) * 0.25 +
      (pixels[i - along] - pixels[i + along]) * 0.5 +
      (pixels[i - along + across] - pixels[i + along + across]) * 0.25;
    return Math.max(Number.EPSILON, Math.abs(value));
  };
  let score = 0;
  for (const vertical of [true, false]) {
    const length = vertical ? height : width;
    const lines = vertical ? width : height;
    const index = (line: number, i: number) =>
      vertical
        ? reflect(i, height) * width + line
        : line * width + reflect(i, width);
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += source[index(line, k)];
      for (let i = 0; i < length; i++) {
        blurred[index(line, i)] = sum / filterSize;
        sum +=
          source[index(line, i + radius + 1)] - source[index(line, i - radius)];
      }
    }
    let originalEdges = 0;
    let lostEdges = 0;
    // Match skimage's slice(2, size - 1) on every axis.
    for (let y = 2; y < height - 1; y++)
      for (let x = 2; x < width - 1; x++) {
        const original = edge(source, y * width + x, vertical);
        originalEdges += original;
        lostEdges += Math.max(
          0,
          original - edge(blurred, y * width + x, vertical),
        );
      }
    score = Math.max(
      score,
      Math.abs(originalEdges - lostEdges) / originalEdges,
    );
  }
  return Number.isFinite(score) ? Math.min(1, score) : null;
}

export function blurDescription(blur: BlurMeasurement): string {
  const label = {
    "likely-fine": "Blur check passed",
    uncertain: "Borderline blur — review later",
    "likely-blurry": "Blur detected — retake needed",
    unavailable: "Blur check unavailable",
  }[blur.category];
  return `${label}${blur.score === null ? "" : ` (${blur.score.toFixed(3)})`}`;
}
