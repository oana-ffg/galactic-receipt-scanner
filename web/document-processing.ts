import { PDFDocument, degrees } from "pdf-lib";
import { api } from "./api";
import { readOriginal } from "./original";
import { sha256 } from "./checksum";
import type {
  DocumentCatalog,
  DocumentView,
  ReceiptDocument,
} from "./documents";
import type { Capture } from "./types";
import { RequestError } from "./errors";
import { appendProcessingEvidence } from "./documents";

export const readDocuments = () => api<DocumentCatalog>("/api/documents");
export const readDocument = (id: string) =>
  api<{ document: DocumentView; captures: Capture[] }>(
    `/api/documents/${encodeURIComponent(id)}`,
  );
const documentForCapture = (id: string) =>
  api<{ document: DocumentView; captures: Capture[] }>(
    `/api/documents?captureId=${encodeURIComponent(id)}`,
  );
export async function saveDocuments(documents: ReceiptDocument[]) {
  return api<{ saved: { id: string; revision: number }[] }>("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documents }),
  });
}

export async function generateDocumentPdf(doc: ReceiptDocument) {
  const pdf = await PDFDocument.create();
  // Source pixels are never enhanced, thresholded, or downsampled. Crop is opt-in.
  for (const page of doc.pages) {
    const { capture, blob } = await readOriginal(page.captureId);
    if (capture.sha256 !== page.sha256)
      throw new Error("Source hash changed; inspect the original.");
    let imageBytes = await blob.arrayBuffer();
    let type = blob.type;
    if (page.crop) {
      const source = await createImageBitmap(blob);
      try {
        const [left, top, right, bottom] = page.crop;
        if (
          left < 0 ||
          top < 0 ||
          right > source.width ||
          bottom > source.height ||
          right <= left ||
          bottom <= top
        )
          throw new Error("Crop exceeds the original image.");
        const canvas = new OffscreenCanvas(
          Math.ceil(right - left),
          Math.ceil(bottom - top),
        );
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Image rendering unavailable.");
        ctx.drawImage(
          source,
          left,
          top,
          right - left,
          bottom - top,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        imageBytes = await (
          await canvas.convertToBlob({ type: "image/png" })
        ).arrayBuffer();
        type = "image/png";
      } finally {
        source.close();
      }
    }
    const embedded =
      type === "image/png"
        ? await pdf.embedPng(imageBytes)
        : await pdf.embedJpg(imageBytes);
    const scale = Math.min(1, 559 / embedded.width);
    const width = embedded.width * scale,
      height = embedded.height * scale;
    if (height + 36 > 14400)
      throw new Error(
        "Receipt is too long for a standard PDF page; prepare a reviewed split layout.",
      );
    const sheet = pdf.addPage([width + 36, height + 36]);
    sheet.drawImage(embedded, { x: 18, y: 18, width, height });
    sheet.setRotation(degrees(page.rotation));
  }
  const data = await pdf.save();
  if (data.length > 32 * 1024 * 1024)
    throw new Error(
      "PDF exceeds 32 MB. Prepare a lossless optimized output; do not reduce tiny-print resolution.",
    );
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
    type: "application/pdf",
  });
  const result = await api<{
    sha256: string;
    filename: string;
    revision: number;
  }>(`/api/documents/${doc.id}/pdf?revision=${doc.revision}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: blob,
  });
  if (result.sha256 !== (await sha256(data as Uint8Array<ArrayBuffer>)))
    throw new Error("PDF save checksum mismatch.");
  const response = await fetch(
    `/api/documents/${doc.id}/pdf?revision=${result.revision}&version=${result.sha256}`,
    { credentials: "same-origin", cache: "no-store", redirect: "error" },
  );
  if (
    !response.ok ||
    (await sha256(await response.arrayBuffer())) !== result.sha256
  )
    throw new Error("Stored PDF could not be verified.");
  return result;
}

async function saveOcrObservations(
  id: string,
  result: { text: string; uncertainWords: readonly unknown[] },
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { document: fresh } = await documentForCapture(id);
      if (!fresh || fresh.checks.transcription) return;
      if (fresh.pages.length === 1 && !fresh.text) fresh.text = result.text;
      const observations: string[] = [];
      if (result.uncertainWords.length)
        observations.push(
          `OCR processing: ${result.uncertainWords.length} low-confidence words on source ${id}; retry extraction and verify against the original.`,
        );
      if (!result.text.trim())
        observations.push(
          `OCR processing: no readable text on source ${id}; try another reading for faint print, rotation or handwriting.`,
        );
      fresh.evidence = appendProcessingEvidence(fresh.evidence, observations);
      await saveDocuments([fresh]);
      return;
    } catch (error) {
      if (!(
        error instanceof RequestError &&
        error.status === 409 &&
        attempt === 0
      ))
        throw error;
    }
  }
}

export async function processOcr(ids: string[]) {
  const { ReceiptOcr } = await import("./ocr");
  const engine = new ReceiptOcr();
  const results = [];
  try {
    for (const id of ids) {
      try {
        const result = await engine.transcribe(id);
        try {
          await saveOcrObservations(id, result);
          results.push({ ok: true, ...result });
        } catch (error) {
          // The immutable OCR artifact was saved. A document update conflict or
          // network failure does not mean transcription failed.
          results.push({
            ...result,
            ok: false,
            failureRecorded: false,
            error: `OCR was saved, but document processing notes could not be updated. Refresh and retry. ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let recorded = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const { document } = await documentForCapture(id);
            document.broken = [
              ...new Set([...document.broken, `OCR failed: ${message}`]),
            ];
            await saveDocuments([document]);
            recorded = true;
            break;
          } catch (recordingError) {
            if (!(
              recordingError instanceof RequestError &&
              recordingError.status === 409
            ))
              break;
          }
        }
        results.push({
          id,
          ok: false,
          error: message,
          failureRecorded: recorded,
        });
      }
    }
  } finally {
    await engine.close();
  }
  return { results };
}
