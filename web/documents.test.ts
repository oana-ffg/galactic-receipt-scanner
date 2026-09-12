import { describe, expect, it } from "vitest";
import {
  documentReasons,
  filenameBase,
  invoiceDifference,
  newDocument,
  validDate,
} from "./documents";
import type { Capture } from "./types";
const source = {
  id: "00000000-0000-4000-8000-000000000001",
  sha256: "a".repeat(64),
} as Capture;
describe("source-backed processing", () => {
  it("keeps missing vendor/date, OCR and handwriting visible", () => {
    const d = newDocument(source);
    expect(documentReasons(d).status).toBe("review");
    expect(filenameBase(d)).toBeNull();
    expect(documentReasons(d).reasons.join(" ")).toContain("Handwriting");
    expect(validDate("2026-02-30")).toBe(false);
    expect(validDate("2024-02-29")).toBe(true);
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
    expect(documentReasons(d).status).toBe("broken");
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
    expect(filenameBase(d)).toBe("2026-09-01-example_søns_shop");
  });
});
