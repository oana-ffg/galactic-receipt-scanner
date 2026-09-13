import { addReceiptPage } from "./receipt-pdf";
import type { OcrArtifact } from "./ocr-data";
import { PDFDocument } from "pdf-lib";
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
  const { ReceiptOcr } = await import("./ocr");
  const engine = new ReceiptOcr();
  try {
    for (const page of doc.pages) {
      const { capture, blob } = await readOriginal(page.captureId);
      if (capture.sha256 !== page.sha256)
        throw Error("Source hash changed; inspect the original.");
      const bitmap = await createImageBitmap(blob);
      const pixels = [bitmap.width, bitmap.height];
      bitmap.close();
      const crop = page.crop ?? [0, 0, ...pixels];
      const matchesRegion = (value: OcrArtifact) => {
        const region = value.source?.region;
        return (
          value.source?.pixels?.[0] === pixels[0] &&
          value.source.pixels[1] === pixels[1] &&
          region?.left === crop[0] &&
          region.top === crop[1] &&
          region.width === crop[2] - crop[0] &&
          region.height === crop[3] - crop[1]
        );
      };
      let ocr: OcrArtifact | null = null;
      const detail = await api<{
        artifacts: { kind: string; sha256: string }[];
      }>(`/api/captures/${page.captureId}`);
      for (const artifact of detail.artifacts.filter((a) => a.kind === "ocr")) {
        const value = await api<OcrArtifact>(
          `/api/files/${page.captureId}/ocr?version=${artifact.sha256}`,
        );
        if (
          value.source?.sha256 === page.sha256 &&
          value.source.captureId === page.captureId &&
          typeof value.provenance?.engine === "string" &&
          value.provenance.engine.startsWith("tesseract.js") &&
          value.text_only_pdf_layers?.length &&
          matchesRegion(value)
        ) {
          ocr = value;
          break;
        }
      }
      if (!ocr) {
        const result = await engine.transcribe(page.captureId, page.crop);
        ocr = await api<OcrArtifact>(
          `/api/files/${page.captureId}/ocr?version=${result.sha256}`,
        );
      }
      if (!matchesRegion(ocr))
        throw Error("OCR does not match the final PDF page region.");
      await addReceiptPage(
        pdf,
        new Uint8Array(await blob.arrayBuffer()),
        blob.type,
        page.rotation,
        page.crop,
        ocr,
      );
    }
  } finally {
    await engine.close();
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
  if (result.revision !== doc.revision)
    throw Error("PDF save revision mismatch.");
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
