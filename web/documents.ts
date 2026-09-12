import type { Capture } from "./types";

export interface DocumentPage {
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
  kind: "unknown" | "receipt" | "invoice" | "credit-note";
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
  status: "ready" | "review" | "broken" | "duplicate" | "merged";
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

export function documentReasons(doc: ReceiptDocument): {
  status: DocumentView["status"];
  reasons: string[];
} {
  if (doc.mergedInto) return { status: "merged", reasons: [] };
  const broken = [...doc.broken];
  if (doc.invoice && invoiceDifference(doc.invoice) !== 0)
    broken.push(
      `Invoice components differ from the printed total by ${invoiceDifference(doc.invoice)} minor units.`,
    );
  const reasons = [...broken, ...doc.uncertainties];
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
  return {
    status: broken.length
      ? "broken"
      : reasons.length
        ? "review"
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
        ...(doc.invoice && invoiceDifference(doc.invoice) !== 0
          ? [
              `Source invoice components differed from the printed total by ${invoiceDifference(doc.invoice)} minor units; reconcile after grouping.`,
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
  return vendor ? `${doc.receiptDate}-${vendor}` : null;
}

export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
