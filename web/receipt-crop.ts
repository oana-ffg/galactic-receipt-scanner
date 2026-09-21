import type { Capture } from "./types";

export function detectedReceiptCrop(
  pixels: number[],
  quad?: number[][] | null,
): [number, number, number, number] | null {
  if (
    pixels.length !== 2 ||
    !pixels.every((v) => Number.isSafeInteger(v) && v > 0)
  )
    throw Error("Invalid source dimensions.");
  let rectangle;
  if (
    Array.isArray(quad) &&
    quad.length === 4 &&
    quad.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        point.every(
          (value) => Number.isFinite(value) && value >= 0 && value <= 1,
        ),
    )
  ) {
    const margin = Math.min(...pixels) * 0.01;
    const left = Math.max(
      0,
      Math.floor(Math.min(...quad.map((p) => p[0])) * pixels[0] - margin),
    );
    const top = Math.max(
      0,
      Math.floor(Math.min(...quad.map((p) => p[1])) * pixels[1] - margin),
    );
    const right = Math.min(
      pixels[0],
      Math.ceil(Math.max(...quad.map((p) => p[0])) * pixels[0] + margin),
    );
    const bottom = Math.min(
      pixels[1],
      Math.ceil(Math.max(...quad.map((p) => p[1])) * pixels[1] + margin),
    );
    rectangle = { left, top, width: right - left, height: bottom - top };
  }
  return rectangle && rectangle.width > 0 && rectangle.height > 0
    ? [
        rectangle.left,
        rectangle.top,
        rectangle.left + rectangle.width,
        rectangle.top + rectangle.height,
      ]
    : null;
}

/** The capture's saved outline is the sole crop for OCR, previews and new PDFs. */
export function scanCrop(
  capture: Pick<Capture, "sha256" | "manual_outline" | "metadata">,
  pixels = capture.metadata.sourcePixels,
): [number, number, number, number] {
  if (!pixels) throw Error("Scan has no original pixel dimensions.");
  const manual = capture.manual_outline;
  if (manual && manual.source_sha256 !== capture.sha256)
    throw Error("Scan outline belongs to another original.");
  const quad = manual?.quad ?? capture.metadata.quality?.quad;
  return detectedReceiptCrop(pixels, quad) ?? [0, 0, pixels[0], pixels[1]];
}
