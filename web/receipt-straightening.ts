import { detectedReceiptCrop } from "./receipt-crop.ts";

/** Rotate containment outlines without treating folded edges as perspective correspondences.
 * PDF image and saved OCR must use this same affine transform.
 */
export function receiptStraightening(
  pixels: [number, number],
  crop: [number, number, number, number],
  quad?: number[][] | null,
) {
  const detected = detectedReceiptCrop(pixels, quad);
  if (!detected || !quad || crop.some((v, i) => v !== detected[i])) return null;
  const points = quad.map(([x, y]) => [x * pixels[0], y * pixels[1]]);
  const turns = points.map(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % 4];
    const [tx, ty] = points[(i + 2) % 4];
    return (nx - x) * (ty - ny) - (ny - y) * (tx - nx);
  });
  if (!turns.every((v) => v > 0)) return null;
  // Saved outlines are ordered top-left, top-right, bottom-right, bottom-left.
  const edgeAngle = (a: number[], b: number[]) =>
    Math.atan2(b[1] - a[1], b[0] - a[0]);
  const top = edgeAngle(points[0], points[1]);
  const bottom = edgeAngle(points[3], points[2]);
  // Conflicting edges do not establish a reliable paper orientation.
  if (Math.abs(top - bottom) > Math.PI / 12) return null;
  const angle = (top + bottom) / 2;
  if (Math.abs(angle) < Math.PI / 360 || Math.abs(angle) > Math.PI / 4)
    return null;
  const cosine = Math.cos(angle),
    sine = Math.sin(angle);
  const rotated = points.map(([x, y]) => {
    const pdfY = pixels[1] - y;
    return [cosine * x - sine * pdfY, sine * x + cosine * pdfY];
  });
  const margin = Math.min(...pixels) * 0.01;
  return {
    cosine,
    sine,
    bounds: [
      Math.min(...rotated.map(([x]) => x)) - margin,
      Math.min(...rotated.map(([, y]) => y)) - margin,
      Math.max(...rotated.map(([x]) => x)) + margin,
      Math.max(...rotated.map(([, y]) => y)) + margin,
    ],
  };
}
