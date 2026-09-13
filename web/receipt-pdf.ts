import { detectedReceiptCrop } from "./receipt-crop.ts";
import {
  PDFDocument,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath,
} from "pdf-lib";
import type { OcrArtifact } from "./ocr-data";
/** Preserve uploaded image pixels. Search text comes only from the independent OCR artifact. */
export async function addReceiptPage(
  pdf: PDFDocument,
  imageBytes: Uint8Array,
  type: string,
  rotation: 0 | 90 | 180 | 270,
  crop: [number, number, number, number] | null | undefined,
  ocr?: OcrArtifact,
  quad?: number[][] | null,
  imageOnly = false,
) {
  if (!imageOnly && !ocr?.text_only_pdf_layers?.length)
    throw Error("Run plain OCR before generating the searchable PDF.");
  if (imageOnly && ocr)
    throw Error("Image-only PDFs must not contain an OCR layer.");
  const image =
    type === "image/png"
      ? await pdf.embedPng(imageBytes)
      : await pdf.embedJpg(imageBytes);
  if (crop === undefined)
    crop = detectedReceiptCrop([image.width, image.height], quad);
  const [left, top, right, bottom] = crop ?? [0, 0, image.width, image.height];
  if (
    ![left, top, right, bottom].every(Number.isFinite) ||
    ![0, 90, 180, 270].includes(rotation) ||
    left < 0 ||
    top < 0 ||
    right > image.width ||
    bottom > image.height ||
    right <= left ||
    bottom <= top
  )
    throw Error("Invalid original-pixel crop.");
  const scale = Math.min(1, 559 / (right - left)),
    width = (right - left) * scale,
    height = (bottom - top) * scale;
  if (height + 36 > 14400)
    throw Error(
      "Receipt is too long for a standard PDF page; prepare a reviewed split layout.",
    );
  const sheet = pdf.addPage([width + 36, height + 36]);
  sheet.pushOperators(
    pushGraphicsState(),
    rectangle(18, 18, width, height),
    clip(),
    endPath(),
  );
  const position = {
    x: 18 - left * scale,
    y: 18 - (image.height - bottom) * scale,
    width: image.width * scale,
    height: image.height * scale,
  };
  sheet.drawImage(image, position);
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
    // Tesseract's rectangle restricts recognition, while its PDF canvas remains
    // the complete original image at the engine's DPI. Reject other canvases.
    if (
      ocr?.source.pixels[0] !== image.width ||
      ocr.source.pixels[1] !== image.height ||
      Math.abs(media.width / media.height - image.width / image.height) > 0.001
    )
      throw Error("OCR text layer canvas does not match the original image.");
    const [embedded] = await pdf.embedPages([source.getPage(0)]);
    sheet.drawPage(embedded, position);
  }
  sheet.pushOperators(popGraphicsState());
  sheet.setRotation(degrees(rotation));
  return { pixels: [image.width, image.height], crop, rotation };
}
