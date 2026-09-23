/** Financial values are signed integer minor units; unknown values stay null. */
export const documentTypes = [
  "unknown",
  "receipt",
  "invoice",
  "credit-note",
  "payment-slip",
  "atm",
  "note",
  "other",
  "not-receipt",
] as const;
export type DocumentType = (typeof documentTypes)[number];
export type Certainty = "low" | "medium" | "high";
export interface Extraction {
  type: DocumentType;
  vendor: string | null;
  receipt_date: string | null;
  reference: string | null;
  currency: string | null;
  /** Null means no visual handwriting assessment was made. */
  has_handwriting: boolean | null;
  has_payment_slip: boolean;
  payment_status: "approved" | "declined" | "unknown" | "not-applicable";
  card_last_four: string | null;
  line_items: {
    description: string;
    quantity: number | null;
    unit_price_minor: number | null;
    amount_minor: number | null;
  }[];
  adjustments: { description: string; amount_minor: number }[];
  total_minor: number | null;
  charged_total_minor: number | null;
  payment_adjustments: { description: string; amount_minor: number }[];
  vat_minor: number | null;
  tax_basis: "gross" | "net-plus-tax" | "unknown";
  completeness: "complete" | "fragment" | "uncertain";
  category_id: string | null;
  certainty: Certainty;
  /** Model request for a person to inspect a concrete source or accounting issue. */
  needs_human_review?: boolean;
  human_review_reasons?: string[];
  uncertainties: string[];
  broken_reasons: string[];
  /** Only true after rereading every component on a complete original. */
  confirmed_arithmetic_mismatch: boolean;
  evidence: string;
}

/** Model-facing contract kept beside the validator so prepared tasks need no source lookup. */
export const extractionContract = {
  type: documentTypes,
  vendor: "nonempty string up to 150 characters, or null",
  receipt_date: "real YYYY-MM-DD date, or null",
  reference: "nonempty string up to 200 characters, or null",
  currency: "three uppercase ISO letters, or null",
  has_handwriting:
    "boolean only after every page was visually inspected; otherwise null",
  has_payment_slip: "boolean",
  payment_status: ["approved", "declined", "unknown", "not-applicable"],
  card_last_four: "exactly four digits, or null",
  line_items: {
    max_items: 1000,
    item: {
      description: "nonempty string up to 2000 characters",
      quantity: "finite number between -1000000 and 1000000, or null",
      unit_price_minor: "signed integer minor units, or null",
      amount_minor: "signed integer minor units, or null",
    },
  },
  adjustments: {
    max_items: 100,
    item: {
      description: "nonempty string up to 2000 characters",
      amount_minor: "signed integer minor units",
    },
  },
  total_minor: "signed integer minor units, or null",
  charged_total_minor: "signed integer minor units, or null",
  payment_adjustments: {
    max_items: 100,
    item: {
      description: "nonempty string up to 2000 characters",
      amount_minor: "signed integer minor units",
    },
  },
  vat_minor: "signed integer minor units, or null",
  tax_basis: ["gross", "net-plus-tax", "unknown"],
  completeness: ["complete", "fragment", "uncertain"],
  category_id: "exact id from the supplied active categories, or null",
  certainty: ["low", "medium", "high"],
  needs_human_review:
    "boolean; true for a concrete issue needing human inspection, even when extraction is complete",
  human_review_reasons:
    "up to 100 specific nonempty reasons; required when needs_human_review is true",
  uncertainties: "up to 100 nonempty strings",
  broken_reasons: "up to 100 nonempty strings",
  confirmed_arithmetic_mismatch:
    "boolean; true only after rereading every printed component of a complete financial source",
  evidence: "nonempty source-grounded string up to 20000 characters",
} as const;
export interface ProcessingState {
  extraction: Extraction;
  not_invoice: boolean;
  has_handwriting: boolean | null;
  small_model_certainty: Certainty | null;
  large_model_confidence: Certainty | null;
  has_human_review: boolean;
  human_review_revision: number | null;
  /** A Luna source/accounting concern survives an independent Astra parse. */
  luna_needs_human_review?: boolean;
  luna_human_review_reasons?: string[];
  needs_reparse: boolean;
  seen_capture_count: number;
  jev_assessment?: {
    role: string;
    probability: number;
    confidence: number;
    category_id: string | null;
    category_probability: number | null;
    category_confidence: number | null;
    model: string;
    assessment_id: string;
    category_assessment_id: string | null;
  } | null;
  ocr_comparison?: {
    status:
      | "no-disagreement-detected"
      | "disagreement"
      | "missing"
      | "not-applicable";
    disagreements: string[];
    artifacts: { capture_id: string; sha256: string }[];
    resolution: string | null;
  };
}
export interface PurchaseCategory {
  id: string;
  name: string;
  description: string;
  revision?: number;
  archived_at?: string | null;
}
export const financialTypes: readonly string[] = [
  "receipt",
  "invoice",
  "credit-note",
];
export function extractionErrors(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return ["Expected extraction object."];
  const e = input as Extraction;
  const errors: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) errors.push(message);
  };
  const string = (v: unknown, max = 2000): v is string =>
    typeof v === "string" && v.length <= max;
  const nullableString = (v: unknown, max = 2000) =>
    v === null || (string(v, max) && v.trim().length > 0);
  const money = (v: unknown) =>
    Number.isSafeInteger(v) && Math.abs(v as number) <= 100000000000;
  check(documentTypes.includes(e.type), "Invalid document type.");
  check(
    nullableString(e.vendor, 150) && nullableString(e.reference, 200),
    "Invalid vendor or reference.",
  );
  check(
    e.receipt_date === null ||
      (string(e.receipt_date) &&
        /^\d{4}-\d{2}-\d{2}$/.test(e.receipt_date) &&
        Number.isFinite(Date.parse(e.receipt_date)) &&
        new Date(e.receipt_date).toISOString().slice(0, 10) === e.receipt_date),
    "Invalid receipt date.",
  );
  check(
    e.currency === null ||
      (string(e.currency) && /^[A-Z]{3}$/.test(e.currency)),
    "Invalid currency.",
  );
  check(
    (e.has_handwriting === null || typeof e.has_handwriting === "boolean") &&
      typeof e.has_payment_slip === "boolean" &&
      typeof e.confirmed_arithmetic_mismatch === "boolean",
    "Handwriting must be boolean or null; payment-slip and mismatch flags must be booleans.",
  );
  check(
    ["approved", "declined", "unknown", "not-applicable"].includes(
      e.payment_status,
    ),
    "Invalid payment status.",
  );
  check(
    e.card_last_four === null ||
      (string(e.card_last_four) && /^\d{4}$/.test(e.card_last_four)),
    "Only the final four card digits may be stored.",
  );
  check(
    ["gross", "net-plus-tax", "unknown"].includes(e.tax_basis),
    "Invalid tax basis.",
  );
  check(
    ["complete", "fragment", "uncertain"].includes(e.completeness),
    "Invalid completeness.",
  );
  check(["low", "medium", "high"].includes(e.certainty), "Invalid certainty.");
  check(
    (e.needs_human_review === undefined ||
      typeof e.needs_human_review === "boolean") &&
      (e.human_review_reasons === undefined ||
        (Array.isArray(e.human_review_reasons) &&
          e.human_review_reasons.length <= 100 &&
          e.human_review_reasons.every(
            (reason) => string(reason) && reason.trim().length > 0,
          ))) &&
      (!e.needs_human_review || Boolean(e.human_review_reasons?.length)) &&
      (e.needs_human_review || !e.human_review_reasons?.length),
    "Human review needs a boolean flag and specific reasons when flagged.",
  );
  check(
    e.category_id === null ||
      (string(e.category_id) && /^[0-9a-f-]{36}$/.test(e.category_id)),
    "Invalid category.",
  );
  for (const value of [e.total_minor, e.charged_total_minor, e.vat_minor])
    check(
      value === null || money(value),
      "Amounts must be integer minor units or null.",
    );
  check(
    Array.isArray(e.line_items) &&
      e.line_items.length <= 1000 &&
      e.line_items.every(
        (l) =>
          l &&
          string(l.description) &&
          l.description.trim().length > 0 &&
          (l.quantity === null ||
            (typeof l.quantity === "number" &&
              Number.isFinite(l.quantity) &&
              Math.abs(l.quantity) <= 1000000)) &&
          (l.unit_price_minor === null || money(l.unit_price_minor)) &&
          (l.amount_minor === null || money(l.amount_minor)),
      ),
    "Invalid line items.",
  );
  for (const list of [e.adjustments, e.payment_adjustments])
    check(
      Array.isArray(list) &&
        list.length <= 100 &&
        list.every(
          (a) =>
            a &&
            string(a.description) &&
            a.description.trim().length > 0 &&
            money(a.amount_minor),
        ),
      "Invalid adjustments.",
    );
  for (const list of [e.uncertainties, e.broken_reasons])
    check(
      Array.isArray(list) &&
        list.length <= 100 &&
        list.every((v) => string(v) && v.trim().length > 0),
      "Provide explicit uncertainty/broken reasons.",
    );
  check(
    string(e.evidence, 20000) && e.evidence.trim().length > 0,
    "Source evidence is required.",
  );
  if (!errors.length && e.confirmed_arithmetic_mismatch) {
    const a = arithmetic(e);
    check(
      financialTypes.includes(e.type) &&
        e.completeness === "complete" &&
        (a.status === "mismatch" ||
          (a.paymentDifference !== null && a.paymentDifference !== 0)),
      "A confirmed mismatch requires a complete financial source with a real arithmetic discrepancy.",
    );
  }
  return errors;
}
export function arithmetic(e: Extraction) {
  const financial = financialTypes.includes(e.type);
  const complete = e.completeness === "complete";
  const computable =
    financial &&
    complete &&
    e.currency !== null &&
    e.tax_basis !== "unknown" &&
    (e.tax_basis !== "net-plus-tax" || e.vat_minor !== null) &&
    e.total_minor !== null &&
    e.line_items.length > 0 &&
    e.line_items.every((l) => l.amount_minor !== null);
  const difference = computable
    ? e.line_items.reduce((sum, l) => sum + l.amount_minor!, 0) +
      e.adjustments.reduce((sum, a) => sum + a.amount_minor, 0) +
      (e.tax_basis === "net-plus-tax" ? e.vat_minor! : 0) -
      e.total_minor!
    : null;
  const paymentDifference =
    e.total_minor !== null && e.charged_total_minor !== null
      ? e.total_minor +
        e.payment_adjustments.reduce((sum, a) => sum + a.amount_minor, 0) -
        e.charged_total_minor
      : null;
  return {
    difference,
    paymentDifference,
    status: !financial
      ? "not-applicable"
      : difference === null
        ? "incomplete"
        : difference === 0
          ? "matched"
          : "mismatch",
  };
}
export function extractionProblems(e: Extraction): string[] {
  const reasons = [...(e.human_review_reasons ?? []), ...e.uncertainties];
  if (e.type === "unknown") reasons.push("Document type is uncertain.");
  if (e.completeness === "uncertain")
    reasons.push("Page completeness is uncertain.");
  if (financialTypes.includes(e.type)) {
    if (!e.vendor || !e.receipt_date || !e.currency || e.total_minor === null)
      reasons.push("Purchase identification or total is incomplete.");
    if (!e.category_id) reasons.push("Purchase category needs identification.");
    const a = arithmetic(e);
    if (a.status !== "matched")
      reasons.push(
        a.status === "mismatch"
          ? `Line amounts differ from the printed total by ${a.difference} minor units.`
          : "Printed line amounts cannot yet be fully reconciled.",
      );
    if (a.paymentDifference !== null && a.paymentDifference !== 0)
      reasons.push(
        `Purchase and charged totals differ after payment adjustments by ${a.paymentDifference} minor units.`,
      );
  }
  return reasons;
}
export function processingDisposition(
  p: ProcessingState,
):
  | "processing"
  | "awaiting-pages"
  | "model-review"
  | "review"
  | "broken"
  | "extracted" {
  if (p.needs_reparse) return "processing";
  const e = p.extraction;
  if (
    e.broken_reasons.length ||
    (e.confirmed_arithmetic_mismatch &&
      e.completeness === "complete" &&
      (arithmetic(e).status === "mismatch" ||
        (arithmetic(e).paymentDifference ?? 0) !== 0))
  )
    return "broken";
  if (e.completeness === "fragment") return "awaiting-pages";
  if (p.has_human_review) return "extracted";
  if (
    p.large_model_confidence !== null &&
    (p.luna_needs_human_review ?? e.needs_human_review)
  )
    return "review";
  if (p.large_model_confidence !== null)
    return p.large_model_confidence === "high" && !extractionProblems(e).length
      ? "extracted"
      : "review";
  return p.small_model_certainty === "high" && !extractionProblems(e).length
    ? "extracted"
    : "model-review";
}
