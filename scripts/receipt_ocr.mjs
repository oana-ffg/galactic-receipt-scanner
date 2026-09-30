#!/usr/bin/env node
// CPU-only OCR. Input is a private source manifest; credentials remain in the Python client.
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createWorker, OEM } from "tesseract.js";
import { recognizeReceipt } from "../web/ocr-data.ts";
import { detectedReceiptCrop } from "../web/receipt-crop.ts";
import { receiptRectification } from "../web/receipt-rectification.ts";
const [manifestPath, outputPath, mode] = process.argv.slice(2);
if (mode !== undefined && mode !== "--layout-only")
  throw Error("Invalid OCR mode.");
if (!manifestPath || !outputPath)
  throw Error(
    "Usage: node scripts/receipt_ocr.mjs PRIVATE_SOURCE_JSON PRIVATE_OCR_JSON",
  );
const source = JSON.parse(await readFile(manifestPath, "utf8"));
const bytes = await readFile(source.path);
if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
  throw Error("Original checksum mismatch.");
const probe = await PDFDocument.create();
const image =
  bytes[0] === 137 ? await probe.embedPng(bytes) : await probe.embedJpg(bytes);
if (mode === "--layout-only") {
  const pixels = [image.width, image.height];
  const crop = detectedReceiptCrop(pixels, source.quad) ?? [0, 0, ...pixels];
  const rectification = receiptRectification(pixels, source.quad);
  await writeFile(outputPath, JSON.stringify({ pixels, crop, rectification }), {
    mode: 0o600,
    flag: "wx",
  });
  process.exit(0);
}
const pixels = [image.width, image.height];
const crop = source.crop ??
  detectedReceiptCrop(pixels, source.quad) ?? [0, 0, ...pixels];
const rectification = receiptRectification(pixels, source.quad);
let ocrImage;
if (rectification) {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const cv = await (await import("@techstark/opencv-js")).default;
  const input = cv.matFromArray(info.height, info.width, cv.CV_8UC3, data);
  const [width, height] = rectification.outputPixels;
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, rectification.quad.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [
    rectification.marginPixels,
    rectification.marginPixels,
    width - 1 - rectification.marginPixels,
    rectification.marginPixels,
    width - 1 - rectification.marginPixels,
    height - 1 - rectification.marginPixels,
    rectification.marginPixels,
    height - 1 - rectification.marginPixels,
  ]);
  const transform = cv.getPerspectiveTransform(from, to);
  const output = new cv.Mat();
  try {
    cv.warpPerspective(
      input,
      output,
      transform,
      new cv.Size(width, height),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    );
    ocrImage = await sharp(Buffer.from(output.data), {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toBuffer();
  } finally {
    input.delete();
    from.delete();
    to.delete();
    transform.delete();
    output.delete();
  }
} else {
  ocrImage = await sharp(bytes)
    .extract({
      left: crop[0],
      top: crop[1],
      width: crop[2] - crop[0],
      height: crop[3] - crop[1],
    })
    .png()
    .toBuffer();
}
const ocrPixels = rectification?.outputPixels ?? [
  crop[2] - crop[0],
  crop[3] - crop[1],
];
const assets = JSON.parse(await readFile("model-assets.json", "utf8"));
for (const language of ["dan", "eng"]) {
  const model = await readFile(`public/vendor/ocr/${language}.traineddata.gz`);
  if (
    createHash("sha256").update(model).digest("hex") !==
    assets[`ocr/${language}.traineddata.gz`].sha256
  )
    throw Error("OCR model checksum mismatch; run npm run assets.");
}
const worker = await createWorker(["dan", "eng"], OEM.LSTM_ONLY, {
  langPath: "public/vendor/ocr",
  gzip: true,
  cacheMethod: "none",
});
try {
  const result = await recognizeReceipt(
    worker,
    ocrImage,
    {
      captureId: source.capture_id,
      sha256: source.sha256,
      pixels: ocrPixels,
      sourcePixels: pixels,
      sourceCrop: crop,
      rotation: source.rotation ?? 0,
      geometryVersion: 1,
      rectification,
    },
    {
      dan: assets["ocr/dan.traineddata.gz"].sha256,
      eng: assets["ocr/eng.traineddata.gz"].sha256,
    },
  );
  await writeFile(outputPath, JSON.stringify(result), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      path: outputPath,
      characters: result.text.length,
      uncertain_words: result.uncertainties.length,
      searchable_layers: result.text_only_pdf_layers.length,
    }),
  );
} finally {
  await worker.terminate();
}
