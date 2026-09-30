import { hasPlausiblePaperCorners } from "./paper-geometry.ts";

type CanvasSurface = {
  width: number;
  height: number;
  getContext: (kind: string) => {
    drawImage: (...args: unknown[]) => void;
    getImageData: (
      x: number,
      y: number,
      width: number,
      height: number,
    ) => { data: Uint8ClampedArray };
    putImageData: (
      image: { data: Uint8ClampedArray },
      x: number,
      y: number,
    ) => void;
  } | null;
};
type ImageSurface = { width: number; height: number };
const browser = globalThis as unknown as {
  document: {
    createElement: (name: string) => CanvasSurface;
  };
};

/** Version of the saved-quad perspective rectification used by preview, OCR and PDFs. */
export const RECEIPT_GEOMETRY_VERSION = 1;

export interface ReceiptRectification {
  version: number;
  sourcePixels: [number, number];
  outputPixels: [number, number];
  marginPixels: number;
  quad: number[][];
}

export function sameReceiptRectification(
  first: ReceiptRectification | null | undefined,
  second: ReceiptRectification | null | undefined,
) {
  if (first == null || second == null) return first == null && second == null;
  return (
    first.version === second.version &&
    first.marginPixels === second.marginPixels &&
    first.sourcePixels.length === second.sourcePixels.length &&
    first.sourcePixels.every(
      (value, index) => value === second.sourcePixels[index],
    ) &&
    first.outputPixels.length === second.outputPixels.length &&
    first.outputPixels.every(
      (value, index) => value === second.outputPixels[index],
    ) &&
    first.quad.length === second.quad.length &&
    first.quad.every(
      (point, index) =>
        point.length === second.quad[index]?.length &&
        point.every(
          (value, pointIndex) => value === second.quad[index][pointIndex],
        ),
    )
  );
}

/** Resolve exact output dimensions from opposite edge lengths without changing orientation. */
export function receiptRectification(
  pixels: [number, number],
  quad?: number[][] | null,
): ReceiptRectification | null {
  if (
    !quad ||
    quad.length !== 4 ||
    quad.some(
      (point) =>
        point.length !== 2 ||
        !point.every(Number.isFinite) ||
        point.some((value) => value < 0 || value > 1),
    )
  )
    return null;
  const points = quad.map(([x, y]) => [x * pixels[0], y * pixels[1]]);
  if (!hasPlausiblePaperCorners(points)) return null;
  const turns = points.map((point, index) => {
    const next = points[(index + 1) % 4];
    const after = points[(index + 2) % 4];
    return (
      (next[0] - point[0]) * (after[1] - next[1]) -
      (next[1] - point[1]) * (after[0] - next[0])
    );
  });
  if (!turns.every((value) => value > 0)) return null;
  const length = (a: number[], b: number[]) =>
    Math.hypot(b[0] - a[0], b[1] - a[1]);
  const width = Math.round(
    (length(points[0], points[1]) + length(points[3], points[2])) / 2,
  );
  const height = Math.round(
    (length(points[1], points[2]) + length(points[0], points[3])) / 2,
  );
  const marginPixels = Math.max(1, Math.round(Math.min(...pixels) * 0.01));
  const outputWidth = width + 2 * marginPixels;
  const outputHeight = height + 2 * marginPixels;
  if (width < 2 || height < 2 || outputWidth * outputHeight > 80_000_000)
    return null;
  return {
    version: RECEIPT_GEOMETRY_VERSION,
    sourcePixels: pixels,
    outputPixels: [outputWidth, outputHeight],
    marginPixels,
    quad: points,
  };
}

function solve(matrix: number[][], values: number[]) {
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < values.length; column++) {
    let pivot = column;
    for (let row = column + 1; row < rows.length; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column]))
        pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-10)
      throw Error("Receipt outline cannot be rectified.");
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= values.length; item++)
      rows[column][item] /= divisor;
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let item = column; item <= values.length; item++)
        rows[row][item] -= factor * rows[column][item];
    }
  }
  return rows.map((row) => row.at(-1)!);
}

/** Warp the saved quadrilateral into a straight canvas using browser canvas pixels. */
export async function rectifyReceiptCanvas(
  source: ImageSurface,
  layout: ReceiptRectification,
  outputPixels: [number, number] = layout.outputPixels,
): Promise<CanvasSurface> {
  const [width, height] = outputPixels;
  if (
    outputPixels.length !== 2 ||
    outputPixels.some((value) => !Number.isSafeInteger(value) || value < 2)
  )
    throw Error("Invalid rectified receipt dimensions.");
  const sourceCanvas = browser.document.createElement("canvas");
  sourceCanvas.width = layout.sourcePixels[0];
  sourceCanvas.height = layout.sourcePixels[1];
  const sourceContext = sourceCanvas.getContext("2d");
  if (!sourceContext) throw Error("Receipt source canvas is unavailable.");
  sourceContext.drawImage(source, 0, 0);
  const sourcePixels = sourceContext.getImageData(
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
  ).data;
  const canvas = browser.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw Error("Rectified receipt canvas is unavailable.");
  const output = context.getImageData(0, 0, width, height);
  const sourcePoints = layout.quad;
  const scaleX = (width - 1) / (layout.outputPixels[0] - 1);
  const scaleY = (height - 1) / (layout.outputPixels[1] - 1);
  const marginX = layout.marginPixels * scaleX;
  const marginY = layout.marginPixels * scaleY;
  const corners = [
    [marginX, marginY],
    [width - 1 - marginX, marginY],
    [width - 1 - marginX, height - 1 - marginY],
    [marginX, height - 1 - marginY],
  ];
  const matrix: number[][] = [];
  const values: number[] = [];
  for (let index = 0; index < 4; index++) {
    const [x, y] = corners[index];
    const [u, v] = sourcePoints[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }
  const [a, b, c, d, e, f, g, h] = solve(matrix, values);
  try {
    for (let y = 0, offset = 0; y < height; y++)
      for (let x = 0; x < width; x++, offset += 4) {
        const divisor = g * x + h * y + 1;
        const sourceX = Math.max(
          0,
          Math.min(sourceCanvas.width - 1, (a * x + b * y + c) / divisor),
        );
        const sourceY = Math.max(
          0,
          Math.min(sourceCanvas.height - 1, (d * x + e * y + f) / divisor),
        );
        const left = Math.floor(sourceX);
        const top = Math.floor(sourceY);
        const right = Math.min(left + 1, sourceCanvas.width - 1);
        const bottom = Math.min(top + 1, sourceCanvas.height - 1);
        const horizontal = sourceX - left;
        const vertical = sourceY - top;
        for (let channel = 0; channel < 4; channel++) {
          const upper =
            sourcePixels[(top * sourceCanvas.width + left) * 4 + channel] *
              (1 - horizontal) +
            sourcePixels[(top * sourceCanvas.width + right) * 4 + channel] *
              horizontal;
          const lower =
            sourcePixels[(bottom * sourceCanvas.width + left) * 4 + channel] *
              (1 - horizontal) +
            sourcePixels[(bottom * sourceCanvas.width + right) * 4 + channel] *
              horizontal;
          output.data[offset + channel] =
            upper * (1 - vertical) + lower * vertical;
        }
      }
    context.putImageData(output, 0, 0);
    return canvas;
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  } finally {
    sourceCanvas.width = sourceCanvas.height = 0;
  }
}
