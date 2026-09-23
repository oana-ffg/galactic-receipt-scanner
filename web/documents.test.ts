import { describe, expect, it } from "vitest";
import {
  appendProcessingEvidence,
  canAssessReceiptCompleteness,
  completenessUncertain,
  DOCUMENT_EVIDENCE_LIMIT,
  documentReasons,
  filenameBase,
  invoiceDifference,
  mergeReviewReasons,
  needsSourceIntervention,
  newDocument,
  retargetAbsorbedAliases,
  validDate,
} from "./documents";
import type { Capture } from "./types";
const source = {
  id: "00000000-0000-4000-8000-000000000001",
  sha256: "a".repeat(64),
} as Capture;
it("screens purchase kinds and unknown documents without treating explicit non-receipts as receipts", () => {
  for (const kind of ["unknown", "receipt", "invoice", "credit-note"] as const)
    expect(canAssessReceiptCompleteness(kind)).toBe(true);
  for (const kind of [
    "payment-slip",
    "atm",
    "note",
    "other",
    "not-receipt",
  ] as const)
    expect(canAssessReceiptCompleteness(kind)).toBe(false);
});
it("separates missing-source findings from uncertain completeness", () => {
  const audit = (
    result: "yes" | "no" | "not_receipt",
    confidence: number,
    issue = result === "no" ? "missing_total" : "none",
  ) => ({
    completenessAudit: {
      result,
      issue,
      confidence,
      assessedAt: "2026-09-21T00:00:00Z",
    },
  });
  expect(needsSourceIntervention(audit("no", 1))).toBe(true);
  expect(needsSourceIntervention(audit("yes", 0.6))).toBe(false);
  expect(needsSourceIntervention(audit("yes", 0.9))).toBe(false);
  expect(needsSourceIntervention(audit("not_receipt", 1))).toBe(false);
  expect(
    needsSourceIntervention(audit("no", 1, "unreadable_or_uncertain")),
  ).toBe(false);
  expect(needsSourceIntervention(audit("no", 1, "evidence_too_long"))).toBe(
    false,
  );
  expect(completenessUncertain(audit("yes", 0.6))).toBe(true);
  expect(completenessUncertain(audit("yes", 0.9))).toBe(false);
  expect(completenessUncertain(audit("no", 0.6))).toBe(false);
  expect(completenessUncertain(audit("no", 1, "evidence_too_long"))).toBe(true);
});
describe("source-backed processing", () => {
  it("retains bounded processing evidence without changing existing notes", () => {
    expect(
      appendProcessingEvidence("Existing check", [
        "OCR pending",
        "OCR pending",
      ]),
    ).toBe("Existing check\nOCR pending");
    const full = "x".repeat(DOCUMENT_EVIDENCE_LIMIT);
    expect(appendProcessingEvidence(full, ["OCR pending"])).toBe(full);
  });
  it("keeps missing vendor/date, OCR and handwriting visible", () => {
    const d = newDocument(source);
    expect(documentReasons(d).status).toBe("processing");
    expect(filenameBase(d)).toBeNull();
    expect(documentReasons(d).reasons.join(" ")).toContain("Handwriting");
    expect(validDate("2026-02-30")).toBe(false);
    expect(validDate("2024-02-29")).toBe(true);
  });
  it("keeps concrete questions and source failures above pending machine work", () => {
    const d = newDocument(source);
    d.uncertainties = [
      "The transaction date remains unreadable after two OCR attempts.",
    ];
    expect(documentReasons(d).status).toBe("review");
    d.broken = ["The only saved page is clipped before the printed total."];
    expect(documentReasons(d).status).toBe("broken");
    d.broken = [];
    d.uncertainties = [];
    d.handwriting = "uncertain";
    expect(documentReasons(d).status).toBe("review");
  });
  it("checks signed invoice lines and explicit tax, credits and rounding exactly", () => {
    const d = newDocument(source);
    d.invoice = {
      currency: "DKK",
      lines: [10000, 5000],
      adjustments: [
        { label: "Discount", amount: -1000 },
        { label: "Tax", amount: 3500 },
      ],
      total: 17500,
      basis: "net-plus-tax",
      evidence: "Synthetic invoice printed components",
    };
    expect(invoiceDifference(d.invoice)).toBe(0);
    d.invoice.total = 17501;
    expect(documentReasons(d).status).toBe("processing");
    expect(mergeReviewReasons(d).broken).toEqual([]);
    d.checks.visual = d.checks.transcription = true;
    expect(documentReasons(d).status).toBe("processing");
    d.checks.grouping = true;
    expect(documentReasons(d).status).toBe("broken");
    expect(mergeReviewReasons(d).broken).toHaveLength(1);
    d.invoice.lines = [-10000];
    d.invoice.adjustments = [{ label: "Tax credit", amount: -2500 }];
    d.invoice.total = -12500;
    expect(invoiceDifference(d.invoice)).toBe(0);
  });
  it("preserves uncertainty despite a successful OCR/PDF check", () => {
    const d = newDocument(source);
    d.vendor = "Example & Søns / shop";
    d.receiptDate = "2026-09-01";
    d.kind = "receipt";
    d.checks = { visual: true, transcription: true, grouping: true, pdf: true };
    d.handwriting = "present";
    d.annotations = [
      {
        captureId: source.id,
        box: [1, 1, 20, 20],
        text: null,
        uncertain: true,
      },
    ];
    expect(documentReasons(d).status).toBe("review");
    expect(filenameBase(d)).toBe("2026-09-01_example_søns_shop");
  });
});
it("keeps an explicit duplicate out of the processing queue while retaining source reasons", () => {
  const doc = newDocument(source);
  doc.duplicateOf = "00000000-0000-4000-8000-000000000002";
  doc.uncertainties = ["Synthetic unresolved annotation."];
  expect(documentReasons(doc)).toMatchObject({
    status: "duplicate",
    reasons: ["Synthetic unresolved annotation."],
  });
});
it("retargets inherited aliases when the review page absorbs a document", () => {
  const retained = newDocument(source);
  const absorbed = newDocument(source);
  absorbed.id = "00000000-0000-4000-8000-000000000002";
  absorbed.mergedInto = retained.id;
  absorbed.pages = [];
  const oldSlip = newDocument(source);
  oldSlip.id = "00000000-0000-4000-8000-000000000003";
  oldSlip.mergedInto = absorbed.id;
  oldSlip.pages = [];
  oldSlip.uncertainties = ["Synthetic payment needs review."];
  const oldDuplicate = newDocument(source);
  oldDuplicate.id = "00000000-0000-4000-8000-000000000004";
  oldDuplicate.duplicateOf = absorbed.id;
  const changes = [absorbed, retained];
  retargetAbsorbedAliases(changes, [oldSlip, oldDuplicate], retained.id);
  expect(changes).toHaveLength(4);
  expect(changes.find((d) => d.id === oldSlip.id)?.mergedInto).toBe(
    retained.id,
  );
  expect(changes.find((d) => d.id === oldDuplicate.id)?.duplicateOf).toBe(
    retained.id,
  );
  expect(retained.uncertainties).toContain("Synthetic payment needs review.");
  expect(oldSlip.mergedInto).toBe(absorbed.id);
});
