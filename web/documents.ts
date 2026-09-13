import {
  processingDisposition,
  extractionProblems,
  type ProcessingState,
  type DocumentType,
} from "./extraction";
import type { Capture } from "./types";

export const DOCUMENT_EVIDENCE_LIMIT = 20000;

export function appendProcessingEvidence(
  evidence: string,
  notes: string[],
): string {
  for (const note of notes) {
    if (evidence.includes(note)) continue;
    const next = [evidence, note].filter(Boolean).join("\n");
    // Full OCR observations remain in their immutable capture artifact.
    if (next.length <= DOCUMENT_EVIDENCE_LIMIT) evidence = next;
  }
  return evidence;
}

export interface DocumentPage {
  type?: DocumentType;
  captureId: string;
  sha256: string;
  rotation: 0 | 90 | 180 | 270;
  /** Optional visually checked rectangle in original pixels. */
  crop: [number, number, number, number] | null;
}
export interface InvoiceCheck {
  currency: string;
  /** Signed minor units; line amounts already include line discounts. */
  lines: number[];
  adjustments: { label: string; amount: number }[];
  total: number;
  basis: "net-plus-tax" | "gross";
  evidence: string;
}
export interface ReceiptDocument {
  id: string;
  revision: number;
  pages: DocumentPage[];
  vendor: string | null;
  receiptDate: string | null;
  kind: DocumentType;
  processing?: ProcessingState;
  reference: string | null;
  text: string;
  handwriting: "unchecked" | "absent" | "present" | "uncertain";
  annotations: {
    text: string | null;
    captureId: string;
    box: [number, number, number, number];
    uncertain: boolean;
  }[];
  checks: {
    visual: boolean;
    transcription: boolean;
    grouping: boolean;
    pdf: boolean;
  };
  reviewedPdfSha256: string | null;
  uncertainties: string[];
  broken: string[];
  evidence: string;
  invoice: InvoiceCheck | null;
  duplicateOf: string | null;
  mergedInto: string | null;
}
export interface DocumentView extends ReceiptDocument {
  filename: string | null;
  status:
    | "ready"
    | "processing"
    | "review"
    | "broken"
    | "duplicate"
    | "merged"
    | "awaiting-pages"
    | "model-review";
  reasons: string[];
  scannedAt: string[];
  pdf: { sha256: string; revision: number } | null;
}
export interface DocumentCatalog {
  documents: DocumentView[];
  captures: Capture[];
}

export function newDocument(capture: Capture): ReceiptDocument {
  return {
    id: capture.id,
    revision: 0,
    pages: [
      {
        captureId: capture.id,
        sha256: capture.sha256,
        rotation: 0,
        crop: null,
      },
    ],
    vendor: null,
    receiptDate: null,
    kind: "unknown",
    reference: null,
    text: "",
    handwriting: "unchecked",
    annotations: [],
    checks: {
      visual: false,
      transcription: false,
      grouping: false,
      pdf: false,
    },
    reviewedPdfSha256: null,
    uncertainties: [],
    broken: [],
    evidence: "",
    invoice: null,
    duplicateOf: null,
    mergedInto: null,
  };
}

export function invoiceDifference(invoice: InvoiceCheck): number {
  return (
    invoice.lines.reduce((sum, n) => sum + n, 0) +
    invoice.adjustments.reduce((sum, item) => sum + item.amount, 0) -
    invoice.total
  );
}

function confirmedInvoiceMismatch(doc: ReceiptDocument): boolean {
  return !!(
    doc.invoice &&
    invoiceDifference(doc.invoice) !== 0 &&
    doc.checks.visual &&
    doc.checks.transcription &&
    doc.checks.grouping
  );
}

export function documentReasons(doc: ReceiptDocument): {
  status: DocumentView["status"];
  reasons: string[];
} {
  if (doc.mergedInto) return { status: "merged", reasons: [] };
  if (doc.duplicateOf)
    return {
      status: "duplicate",
      reasons: [
        ...new Set([
          ...doc.broken,
          ...doc.uncertainties,
          ...(doc.handwriting === "uncertain"
            ? ["Handwriting presence is uncertain."]
            : []),
          ...(doc.annotations.some((a) => a.uncertain || a.text === null)
            ? ["Source annotation remains uncertain."]
            : []),
        ]),
      ],
    };
  if (doc.processing) {
    const p = doc.processing;
    const disposition = processingDisposition(p);
    const reasons = [
      ...new Set([
        ...doc.broken,
        ...doc.uncertainties,
        ...p.extraction.broken_reasons,
        ...extractionProblems(p.extraction),
        ...(p.ocr_comparison?.resolution
          ? []
          : (p.ocr_comparison?.disagreements ?? [])),
      ]),
    ];
    if (doc.broken.length) return { status: "broken", reasons };
    if (doc.uncertainties.length && disposition === "extracted")
      return { status: "review", reasons };
    if (disposition === "awaiting-pages")
      reasons.unshift("Waiting for remaining pages or a matching receipt.");
    if (disposition === "processing")
      reasons.unshift("Document changed; a fresh parse is required.");
    if (disposition === "model-review")
      reasons.unshift("Queued for an independent full parse by Astra.");
    return {
      status:
        disposition === "extracted"
          ? doc.checks.pdf
            ? "ready"
            : "processing"
          : disposition,
      reasons,
    };
  }
  const broken = [...doc.broken];
  if (confirmedInvoiceMismatch(doc))
    broken.push(
      `Invoice components differ from the printed total by ${invoiceDifference(doc.invoice!)} minor units.`,
    );
  const reasons = [...broken, ...doc.uncertainties];
  if (
    doc.invoice &&
    invoiceDifference(doc.invoice) !== 0 &&
    !confirmedInvoiceMismatch(doc)
  )
    reasons.push(
      "Extracted amounts do not balance; reread the source and check page completeness before treating the document as broken.",
    );
  if (!doc.vendor) reasons.push("Vendor needs identification.");
  if (!doc.receiptDate)
    reasons.push("Receipt date needs identification; scan date is separate.");
  if (doc.kind === "unknown")
    reasons.push("Document type needs identification.");
  if (!doc.checks.visual)
    reasons.push(
      "Inspect every original, including faint text and handwritten notes.",
    );
  if (!doc.checks.transcription)
    reasons.push(
      "Check OCR against every original, including omitted text and amounts.",
    );
  if (!doc.checks.grouping)
    reasons.push(
      "Check for missing, misplaced or duplicate pages across the whole batch.",
    );
  if (!doc.checks.pdf && !doc.duplicateOf)
    reasons.push(
      "Inspect the generated PDF for clipping, order and legibility.",
    );
  if (doc.handwriting === "unchecked" || doc.handwriting === "uncertain")
    reasons.push("Handwriting needs visual attention.");
  if (doc.annotations.some((a) => a.uncertain || a.text === null))
    reasons.push("Handwritten annotation needs human review.");
  if ((doc.kind === "invoice" || doc.kind === "credit-note") && !doc.invoice)
    reasons.push("Invoice arithmetic has not been checked.");
  const needsHumanReview =
    doc.uncertainties.length > 0 ||
    doc.handwriting === "uncertain" ||
    doc.annotations.some((a) => a.uncertain || a.text === null);
  return {
    status: broken.length
      ? "broken"
      : needsHumanReview
        ? "review"
        : reasons.length
          ? "processing"
          : doc.duplicateOf
            ? "duplicate"
            : "ready",
    reasons,
  };
}

export function mergeReviewReasons(doc: ReceiptDocument): {
  broken: string[];
  uncertainties: string[];
} {
  return {
    uncertainties: [...doc.uncertainties],
    broken: [
      ...new Set([
        ...doc.broken,
        ...(confirmedInvoiceMismatch(doc)
          ? [
              `Source invoice components differed from the printed total by ${invoiceDifference(doc.invoice!)} minor units; reconcile after grouping.`,
            ]
          : []),
      ]),
    ],
  };
}

export function filenameBase(doc: ReceiptDocument): string | null {
  if (!doc.receiptDate || !doc.vendor) return null;
  const vendor = doc.vendor
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return vendor ? `${doc.receiptDate}_${vendor}` : null;
}

export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
