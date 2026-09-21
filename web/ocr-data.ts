import { detectedReceiptCrop, scanCrop } from "./receipt-crop.ts";
import { PSM, type Worker, type Page, type ImageLike } from "tesseract.js";
import type { DocumentPage } from "./documents";
import type { Capture } from "./types";
function linesOf(data: Page) {
  return (data.blocks ?? []).flatMap((b) =>
    b.paragraphs.flatMap((p) =>
      p.lines.map((l) => ({
        text: l.text,
        confidence: l.confidence,
        box: l.bbox,
        words: l.words.map((w) => ({
          text: w.text,
          confidence: w.confidence,
          box: w.bbox,
        })),
      })),
    ),
  );
}
/** Used by the legacy local CLI; ordinary OCR, with no language-model calls. */
export async function recognizeReceipt(
  worker: Worker,
  image: ImageLike,
  source: { captureId: string; sha256: string; pixels: number[] },
  models: { dan: string; eng: string },
  quad?: number[][] | null,
  reviewedCrop?: [number, number, number, number] | null,
) {
  const crop =
    reviewedCrop === undefined
      ? detectedReceiptCrop(source.pixels, quad)
      : reviewedCrop;
  if (
    crop &&
    (!crop.every(Number.isFinite) ||
      crop[0] < 0 ||
      crop[1] < 0 ||
      crop[2] > source.pixels[0] ||
      crop[3] > source.pixels[1] ||
      crop[2] <= crop[0] ||
      crop[3] <= crop[1])
  )
    throw Error("Invalid OCR crop.");
  const rectangle = crop
    ? {
        left: crop[0],
        top: crop[1],
        width: crop[2] - crop[0],
        height: crop[3] - crop[1],
      }
    : undefined;
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1",
  });
  const { data: layout } = await worker.recognize(
    image,
    { rectangle, pdfTextOnly: true },
    { text: true, blocks: true, pdf: true },
  );
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
  let data: Page;
  try {
    ({ data } = await worker.recognize(
      image,
      { rectangle, pdfTextOnly: true },
      { text: true, blocks: true, pdf: true },
    ));
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
  }
  const body = linesOf(data),
    headings = linesOf(layout);
  const lines = [
    ...body,
    ...headings.filter(
      (l) =>
        !body.some((other) => {
          const a = l.box,
            b = other.box;
          const area =
            Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
            Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
          return area / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0)) > 0.5;
        }),
    ),
  ].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  const layers = [];
  // Tesseract embeds a Unicode text font using invisible PDF text rendering.
  for (const pass of [data, layout]) {
    if (!pass.pdf)
      throw Error("OCR did not produce its searchable text layer.");
    const bytes = new Uint8Array(pass.pdf);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    layers.push({ base64: btoa(binary), sha256: hash });
  }
  return {
    schemaVersion: 2,
    verified: false,
    text: lines.map((l) => l.text.trimEnd()).join("\n"),
    language: ["da", "en"],
    source: {
      ...source,
      coordinates: "original image pixels; top-left origin",
      region: rectangle ?? {
        left: 0,
        top: 0,
        width: source.pixels[0],
        height: source.pixels[1],
      },
    },
    provenance: {
      engine: "tesseract.js 7.0.0",
      tesseractVersion: data.version,
      models,
      pageSegmentation: ["AUTO", "SINGLE_BLOCK"],
      createdAt: new Date().toISOString(),
    },
    confidence: data.confidence,
    lines,
    text_only_pdf_layers: layers,
    uncertainties: lines
      .flatMap((l) => l.words)
      .filter((w) => w.confidence < 85),
    handwriting: { status: "unchecked", method: "requires visual inspection" },
    review: {
      required: true,
      notes: [
        "OCR is unverified search text. Use original pixels to resolve discrepancies, never OCR as ground truth.",
      ],
    },
  };
}
export type OcrArtifact = Awaited<ReturnType<typeof recognizeReceipt>>;

export function ocrArtifactMatchesPage(
  value: OcrArtifact,
  page: DocumentPage,
  capture: Capture,
) {
  const source = value.source as OcrArtifact["source"] & {
    rotation?: number;
    region?: { left: number; top: number; width: number; height: number };
  };
  if (!source || (source.rotation ?? 0) !== page.rotation) return false;
  const region = source.region;
  if (!region || !ocrTextArtifactHasValidGeometry(value, page)) return false;
  if (capture.sha256 !== page.sha256 || capture.id !== page.captureId)
    return false;
  if (
    capture.metadata.sourcePixels?.[0] !== source.pixels[0] ||
    capture.metadata.sourcePixels?.[1] !== source.pixels[1]
  )
    return false;
  const expected = scanCrop(capture, source.pixels);
  return (
    region.left <= expected[0] &&
    region.top <= expected[1] &&
    region.left + region.width >= expected[2] &&
    region.top + region.height >= expected[3]
  );
}

/** Validate OCR geometry and rotation before Jev reads source-verified text. */
export function ocrTextArtifactHasValidGeometry(
  value: OcrArtifact,
  page: DocumentPage,
) {
  const source = value.source as OcrArtifact["source"] & {
    rotation?: number;
    region?: { left: number; top: number; width: number; height: number };
  };
  if (!source || (source.rotation ?? 0) !== page.rotation) return false;
  const pixels = Array.isArray(source.pixels) ? source.pixels : [];
  const [pixelWidth, pixelHeight] = pixels;
  const region = source.region;
  if (
    pixels.length !== 2 ||
    !region ||
    ![
      pixelWidth,
      pixelHeight,
      region.left,
      region.top,
      region.width,
      region.height,
    ].every(Number.isFinite) ||
    pixelWidth <= 0 ||
    pixelHeight <= 0 ||
    region.left < 0 ||
    region.top < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.left + region.width > pixelWidth ||
    region.top + region.height > pixelHeight
  )
    return false;
  return true;
}
