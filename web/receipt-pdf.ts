import { detectedReceiptCrop } from "./receipt-crop.ts";
import {
  RECEIPT_GEOMETRY_VERSION,
  receiptRectification,
  sameReceiptRectification,
} from "./receipt-rectification.ts";
import {
  cropPdfImage,
  pdfImageSize,
  type PdfImageCropper,
} from "./pdf-image.ts";
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
    sourcePixels?: [number, number];
    sourceCrop?: [number, number, number, number];
    rotation?: 0 | 90 | 180 | 270;
    geometryVersion?: number;
    rectification?:
      import("./receipt-rectification.ts").ReceiptRectification | null;
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
  const rectification = receiptRectification(pixels, quad);
  const outputWidth = rectification?.outputPixels[0] ?? right - left;
  const outputHeight = rectification?.outputPixels[1] ?? bottom - top;
  const scale = Math.min(1, 559 / outputWidth),
    width = outputWidth * scale,
    height = outputHeight * scale;
  if (height + 36 > 14400)
    throw Error(
      "Receipt is too long for a standard PDF page; prepare a reviewed split layout.",
    );
  const cropWidth = imageCrop[2] - imageCrop[0];
  const cropHeight = imageCrop[3] - imageCrop[1];
  const [embeddedWidth, embeddedHeight] = pdfImageSize(
    rectification?.outputPixels[0] ?? cropWidth,
    rectification?.outputPixels[1] ?? cropHeight,
  );
  const embeddedBytes = await cropImage(
    imageBytes,
    type,
    imageCrop,
    rectification,
  );
  const image =
    type === "image/png"
      ? await pdf.embedPng(embeddedBytes)
      : await pdf.embedJpg(Uint8Array.from(embeddedBytes));
  if (image.width !== embeddedWidth || image.height !== embeddedHeight)
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
  sheet.drawImage(image, { x: 18, y: 18, width, height });
  const textPosition =
    !rectification && ocr?.source.geometryVersion !== RECEIPT_GEOMETRY_VERSION
      ? {
          x: 18 - left * scale,
          y: 18 - (pixels[1] - bottom) * scale,
          width: pixels[0] * scale,
          height: pixels[1] * scale,
        }
      : { x: 18, y: 18, width, height };
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
    const currentGeometry =
      ocr?.source.geometryVersion === RECEIPT_GEOMETRY_VERSION;
    const expectedPixels =
      rectification?.outputPixels ??
      (currentGeometry ? [cropWidth, cropHeight] : pixels);
    if (
      ocr?.source.pixels[0] !== expectedPixels[0] ||
      ocr.source.pixels[1] !== expectedPixels[1] ||
      (currentGeometry &&
        (!Array.isArray(ocr.source.sourceCrop) ||
          ocr.source.sourceCrop.length !== 4 ||
          ocr.source.sourceCrop.some(
            (value, index) => value !== imageCrop[index],
          ))) ||
      (currentGeometry &&
        (!ocr.source.sourcePixels ||
          ocr.source.sourcePixels[0] !== pixels[0] ||
          ocr.source.sourcePixels[1] !== pixels[1])) ||
      Math.abs(
        media.width / media.height - expectedPixels[0] / expectedPixels[1],
      ) > 0.001 ||
      (rectification && !currentGeometry) ||
      (currentGeometry &&
        !sameReceiptRectification(ocr?.source.rectification, rectification))
    )
      throw Error("OCR text layer does not match the saved receipt geometry.");
    const [embedded] = await pdf.embedPages([source.getPage(0)]);
    sheet.drawPage(embedded, textPosition);
  }
  sheet.pushOperators(popGraphicsState());
  sheet.setRotation(degrees(rotation));
  return { pixels, crop, rotation };
}
