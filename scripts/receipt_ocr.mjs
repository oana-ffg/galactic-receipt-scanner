#!/usr/bin/env node
// CPU-only OCR. Input is a private source manifest; credentials remain in the Python client.
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { createWorker, OEM } from "tesseract.js";
import { recognizeReceipt } from "../web/ocr-data.ts";
import { detectedReceiptCrop } from "../web/receipt-crop.ts";
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
  await writeFile(outputPath, JSON.stringify({ pixels, crop }), {
    mode: 0o600,
    flag: "wx",
  });
  process.exit(0);
}
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
    bytes,
    {
      captureId: source.capture_id,
      sha256: source.sha256,
      pixels: [image.width, image.height],
    },
    {
      dan: assets["ocr/dan.traineddata.gz"].sha256,
      eng: assets["ocr/eng.traineddata.gz"].sha256,
    },
    source.quad,
    source.crop,
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
