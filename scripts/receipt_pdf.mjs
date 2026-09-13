#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { addReceiptPage } from "../web/receipt-pdf.ts";
const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath)
  throw Error(
    "Usage: node scripts/receipt_pdf.mjs PRIVATE_PAGES_JSON PRIVATE_PDF",
  );
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const pdf = await PDFDocument.create();
for (const page of manifest.pages) {
  const bytes = await readFile(page.path);
  if (createHash("sha256").update(bytes).digest("hex") !== page.sha256)
    throw Error("Original checksum mismatch.");
  const ocr = JSON.parse(await readFile(page.ocr_path, "utf8"));
  if (
    ocr.source?.sha256 !== page.sha256 ||
    ocr.source?.captureId !== page.captureId
  )
    throw Error("OCR belongs to another source.");
  await addReceiptPage(
    pdf,
    bytes,
    bytes[0] === 137 ? "image/png" : "image/jpeg",
    page.rotation,
    page.crop,
    ocr,
  );
}
const bytes = await pdf.save();
if (bytes.length > 32 * 1024 * 1024)
  throw Error(
    "PDF exceeds the upload limit; retain originals and review the layout.",
  );
await writeFile(outputPath, bytes, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    path: outputPath,
    pages: pdf.getPageCount(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    searchable: true,
  }),
);
