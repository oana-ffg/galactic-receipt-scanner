import { detectedReceiptCrop } from "./receipt-crop.ts";
import { cropPdfImage, type PdfImageCropper } from "./pdf-image.ts";
import {
  PDFDocument,
  JpegEmbedder,
  PngEmbedder,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from "pdf-lib";
/** Saved search-layer contract shared by PP-OCR and historical OCR artifacts. */
export interface PdfOcr {
  source: {
    captureId: string;
    sha256: string;
    pixels: number[];
    rotation?: 0 | 90 | 180 | 270;
    region?: { left: number; top: number; width: number; height: number };
  };
  text_only_pdf_layers: { base64: string; sha256: string }[];
}
/** Embed only the receipt crop; originals remain separate immutable source artifacts. */
export async function addReceiptPage(
  pdf: PDFDocument,
  imageBytes: Uint8Array,
  type: string,
  rotation: 0 | 90 | 180 | 270,
  crop: [number, number, number, number] | null | undefined,
  ocr?: PdfOcr,
  quad?: number[][] | null,
  imageOnly = false,
  cropImage: PdfImageCropper = cropPdfImage,
) {
  if (!imageOnly && !ocr?.text_only_pdf_layers?.length)
    throw Error("Run plain OCR before generating the searchable PDF.");
  if (imageOnly && ocr)
    throw Error("Image-only PDFs must not contain an OCR layer.");
  if (type !== "image/png" && type !== "image/jpeg")
    throw Error("Unsupported PDF source image type.");
  // Inspect dimensions without registering the whole original in the output PDF.
  const sourceImage =
    type === "image/png"
      ? await PngEmbedder.for(imageBytes)
      : await JpegEmbedder.for(Uint8Array.from(imageBytes));
  const pixels: [number, number] = [sourceImage.width, sourceImage.height];
  if (crop === undefined)
    crop = detectedReceiptCrop(pixels, quad) ?? [0, 0, ...pixels];
  if (crop === null) crop = [0, 0, pixels[0], pixels[1]];
  const [left, top, right, bottom] = crop;
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    ![0, 90, 180, 270].includes(rotation) ||
    left < 0 ||
    top < 0 ||
    right > pixels[0] ||
    bottom > pixels[1] ||
    right <= left ||
    bottom <= top
  )
    throw Error("Invalid original-pixel crop.");
  // Round outward so fractional layouts retain every pixel at their edges.
  const imageCrop: [number, number, number, number] = [
    Math.floor(left),
    Math.floor(top),
    Math.ceil(right),
    Math.ceil(bottom),
  ];
  const scale = Math.min(1, 559 / (right - left)),
    width = (right - left) * scale,
    height = (bottom - top) * scale;
  if (height + 36 > 14400)
    throw Error(
      "Receipt is too long for a standard PDF page; prepare a reviewed split layout.",
    );
  const fullSource =
    imageCrop[0] === 0 &&
    imageCrop[1] === 0 &&
    imageCrop[2] === pixels[0] &&
    imageCrop[3] === pixels[1];
  const embeddedBytes = fullSource
    ? imageBytes
    : await cropImage(imageBytes, type, imageCrop);
  const image =
    type === "image/png"
      ? await pdf.embedPng(embeddedBytes)
      : await pdf.embedJpg(Uint8Array.from(embeddedBytes));
  if (
    image.width !== imageCrop[2] - imageCrop[0] ||
    image.height !== imageCrop[3] - imageCrop[1]
  )
    throw Error(
      "PDF image crop dimensions differ from the requested source region.",
    );
  const sheet = pdf.addPage([width + 36, height + 36]);
  sheet.pushOperators(
    pushGraphicsState(),
    rectangle(18, 18, width, height),
    clip(),
    endPath(),
  );
  sheet.drawImage(image, {
    x: 18 - (left - imageCrop[0]) * scale,
    y: 18 - (imageCrop[3] - bottom) * scale,
    width: image.width * scale,
    height: image.height * scale,
  });
  const textPosition = {
    x: 18 - left * scale,
    y: 18 - (pixels[1] - bottom) * scale,
    width: pixels[0] * scale,
    height: pixels[1] * scale,
  };
  for (const layer of (ocr?.text_only_pdf_layers ?? []).slice(0, 1)) {
    const bytes = Uint8Array.from(atob(layer.base64), (c) => c.charCodeAt(0));
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hash !== layer.sha256) throw Error("OCR text layer checksum mismatch.");
    const source = await PDFDocument.load(bytes);
    if (source.getPageCount() !== 1)
      throw Error("Expected one OCR text layer page.");
    const media = source.getPage(0).getSize();
    // Saved text layers use the full original canvas, even for cropped OCR.
    if (
      ocr?.source.pixels[0] !== pixels[0] ||
      ocr.source.pixels[1] !== pixels[1] ||
      Math.abs(media.width / media.height - pixels[0] / pixels[1]) > 0.001
    )
      throw Error("OCR text layer canvas does not match the original image.");
    const [embedded] = await pdf.embedPages([source.getPage(0)]);
    sheet.drawPage(embedded, textPosition);
  }
  sheet.pushOperators(popGraphicsState());
  sheet.setRotation(degrees(rotation));
  return { pixels, crop, rotation };
}
