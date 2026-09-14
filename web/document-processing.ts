import { addReceiptPage } from "./receipt-pdf";
import type { PdfOcr } from "./receipt-pdf";
import { PDFDocument } from "pdf-lib";
import { api } from "./api";
import { readOriginal } from "./original";
import { sha256 } from "./checksum";
import { messageOf } from "./errors";
import type {
  DocumentCatalog,
  DocumentView,
  ReceiptDocument,
} from "./documents";
import type { Capture } from "./types";

export const readDocuments = () => api<DocumentCatalog>("/api/documents");
export const readDocument = (id: string) =>
  api<{ document: DocumentView; captures: Capture[] }>(
    `/api/documents/${encodeURIComponent(id)}`,
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
  for (const page of doc.pages) {
    const { capture, blob } = await readOriginal(page.captureId);
    if (capture.sha256 !== page.sha256)
      throw Error("Source hash changed; inspect the original.");
    const bitmap = await createImageBitmap(blob);
    const pixels = [bitmap.width, bitmap.height];
    bitmap.close();
    const crop = page.crop ?? [0, 0, ...pixels];
    const matchesRegion = (value: PdfOcr) => {
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
    let ocr: PdfOcr | null = null;
    const detail = await api<{
      artifacts: { kind: string; sha256: string }[];
    }>(`/api/captures/${page.captureId}`);
    let artifactFailure = "";
    for (const artifact of detail.artifacts.filter((a) => a.kind === "ocr")) {
      try {
        const response = await fetch(
          `/api/files/${page.captureId}/ocr?version=${artifact.sha256}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(45000),
          },
        );
        if (!response.ok)
          throw Error("Could not load saved OCR. Refresh and retry.");
        const bytes = await response.arrayBuffer();
        if ((await sha256(bytes)) !== artifact.sha256)
          throw Error("Saved OCR checksum mismatch.");
        const value = JSON.parse(new TextDecoder().decode(bytes)) as PdfOcr;
        if (
          value.source?.sha256 === page.sha256 &&
          value.source.captureId === page.captureId &&
          (value.source.rotation ?? 0) === page.rotation &&
          value.text_only_pdf_layers?.length &&
          matchesRegion(value)
        ) {
          ocr = value;
          break;
        }
      } catch (error) {
        artifactFailure ||= messageOf(error);
      }
    }
    if (!ocr)
      throw Error(
        `No usable saved OCR matches this page layout. Run the Luna processing flow with PP-OCR before generating the searchable PDF.${artifactFailure ? ` Saved OCR could not be read: ${artifactFailure}` : ""}`,
      );
    await addReceiptPage(
      pdf,
      new Uint8Array(await blob.arrayBuffer()),
      blob.type,
      page.rotation,
      page.crop,
      ocr,
    );
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
