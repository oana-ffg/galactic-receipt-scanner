import { resizeGrayArea } from "./area-resize";
import type CV from "@techstark/opencv-js";
import {
  BLUR_CONFIG,
  blurCategory,
  blurEffect,
  type BlurMeasurement,
} from "./blur-quality";

/** Crop in original pixels, convert to gray, then bounded area downsampling. */
export function measureCapturedBlur(
  cv: typeof CV,
  bitmap: ImageBitmap,
  quad: number[][] | null,
): BlurMeasurement {
  const margin = BLUR_CONFIG.cropMarginPixels;
  const x0 = quad
    ? Math.max(
        0,
        Math.floor(Math.min(...quad.map((p) => p[0])) * bitmap.width) - margin,
      )
    : 0;
  const y0 = quad
    ? Math.max(
        0,
        Math.floor(Math.min(...quad.map((p) => p[1])) * bitmap.height) - margin,
      )
    : 0;
  const x1 = quad
    ? Math.min(
        bitmap.width,
        Math.ceil(Math.max(...quad.map((p) => p[0])) * bitmap.width) + margin,
      )
    : bitmap.width;
  const y1 = quad
    ? Math.min(
        bitmap.height,
        Math.ceil(Math.max(...quad.map((p) => p[1])) * bitmap.height) + margin,
      )
    : bitmap.height;
  const width = x1 - x0,
    height = y1 - y0;
  const scale = Math.min(1, BLUR_CONFIG.maxEdge / Math.max(width, height));
  const pixels: [number, number] = [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale)),
  ];
  const frame = new OffscreenCanvas(1, 1);
  const context = frame.getContext("2d", { willReadFrequently: true })!;
  const gray = new cv.Mat();
  try {
    const resized = resizeGrayArea(width, height, ...pixels, (x, y, w, h) => {
      // Never allocate a canvas or Mat at full-photo size (up to 55 MP).
      frame.width = w;
      frame.height = h;
      context.drawImage(bitmap, x0 + x, y0 + y, w, h, 0, 0, w, h);
      const source = cv.matFromImageData(context.getImageData(0, 0, w, h));
      try {
        cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
        return gray.data;
      } finally {
        source.delete();
      }
    });
    const score = blurEffect(resized, ...pixels);
    return {
      version: "crete-1",
      score,
      category: blurCategory(score),
      region: quad ? "document-bounds" : "whole-image",
      sourceBounds: [x0, y0, x1, y1],
      pixels,
      filterSize: BLUR_CONFIG.filterSize,
      fineBelow: BLUR_CONFIG.fineBelow,
      blurryAbove: BLUR_CONFIG.blurryAbove,
    };
  } finally {
    gray.delete();
    frame.width = frame.height = 0;
  }
}
