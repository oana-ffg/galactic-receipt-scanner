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
import { scanCrop } from "./receipt-crop";

export class OcrPendingError extends Error {}

export const readDocuments = () => api<DocumentCatalog>("/api/documents");
export interface DocumentSummary {
  id: string;
  revision: number;
  vendor: string | null;
  receiptDate: string | null;
  reference: string | null;
  kind: ReceiptDocument["kind"];
  jevRole: string | null;
  completenessAudit: DocumentView["completenessAudit"];
  sourceInterventionFine: boolean;
  status: DocumentView["status"];
  reasons: string[];
  pageIds: string[];
  scannedAt: string[];
  processing: null | {
    has_human_review: boolean;
    needs_reparse: boolean;
    luna_needs_human_review: boolean;
    small_model_certainty: string | null;
    large_model_confidence: string | null;
  };
  duplicateOf: string | null;
  filename: string | null;
  pdf: DocumentView["pdf"];
}
export interface DocumentSummaryPage {
  documents: DocumentSummary[];
  next: string | null;
  total?: number;
}
export function readDocumentSummaries(params: URLSearchParams) {
  params.set("summary", "1");
  return api<DocumentSummaryPage>(`/api/documents?${params}`);
}
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

export async function generateDocumentPdf(
  doc: ReceiptDocument,
  allowImageOnly = false,
) {
  const pdf = await PDFDocument.create();
  let imageOnlyPages = 0;
  for (const page of doc.pages) {
    const { capture, blob } = await readOriginal(page.captureId);
    if (capture.sha256 !== page.sha256)
      throw Error("Source hash changed; inspect the original.");
    const bitmap = await createImageBitmap(blob);
    const pixels = [bitmap.width, bitmap.height];
    bitmap.close();
    const crop = scanCrop(capture, pixels);
    const matchesRegion = (value: PdfOcr) => {
      const region = value.source?.region;
      return (
        value.source?.pixels?.[0] === pixels[0] &&
        value.source.pixels[1] === pixels[1] &&
        region &&
        region.left <= crop[0] &&
        region.top <= crop[1] &&
        region.left + region.width >= crop[2] &&
        region.top + region.height >= crop[3]
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
        const value = JSON.parse(new TextDecoder().decode(bytes)) as PdfOcr & {
          provenance?: { engine?: string };
        };
        if (
          value.provenance?.engine === "PP-OCRv6" &&
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
    if (!ocr && (!allowImageOnly || artifactFailure))
      throw new (artifactFailure ? Error : OcrPendingError)(
        `No usable saved OCR matches this page layout. ${allowImageOnly ? "Saved OCR could not be used for this PDF." : "Run the Luna processing flow with PP-OCR before generating the searchable PDF."}${artifactFailure ? ` Saved OCR could not be read: ${artifactFailure}` : ""}`,
      );
    if (!ocr) imageOnlyPages++;
    await addReceiptPage(
      pdf,
      new Uint8Array(await blob.arrayBuffer()),
      blob.type,
      page.rotation,
      crop,
      ocr ?? undefined,
      capture.manual_outline?.quad ?? capture.metadata.quality?.quad,
      !ocr,
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
  return { ...result, imageOnlyPages };
}
