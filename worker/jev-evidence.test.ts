import { expect, it } from "vitest";
import { newDocument } from "../web/documents";
import {
  normalizeCompletenessDecision,
  paymentCandidateRank,
  pageFingerprint,
  shouldAutoMerge,
  summarizeDocumentOcr,
} from "./jev";
import {
  ocrArtifactMatchesPage,
  ocrTextArtifactHasValidGeometry,
} from "../web/ocr-data";
import { receiptRectification } from "../web/receipt-rectification";
import { detectedReceiptCrop } from "../web/receipt-crop";

it("translates an existing detached-payment cursor to its saved candidate rank", () => {
  const payments = [crypto.randomUUID(), crypto.randomUUID()];
  const purchases = [crypto.randomUUID(), crypto.randomUUID()];
  const row = (id: string) => ({ id, dates: [], amounts: [], terms: [] });
  const index = {
    documentCount: 4,
    payments: payments.map(row),
    purchases: purchases.map(row),
  };
  expect(paymentCandidateRank(`1|${payments[1]}|${purchases[0]}`, index)).toBe(
    7,
  );
  expect(paymentCandidateRank("7", index)).toBe(7);
  expect(paymentCandidateRank(null, index)).toBe(0);
});

it("derives one consistent completeness result from Jev's single decision", () => {
  const probabilities = {
    yes: 0.05,
    missing_total: 0.7,
    missing_lines_or_page: 0.1,
    page_or_slip_mismatch: 0.05,
    unreadable_or_uncertain: 0.05,
    not_receipt: 0.05,
  };
  expect(
    normalizeCompletenessDecision({
      type: "choice",
      choice: "missing_total",
      probabilities,
      confidence: 0.7,
    }),
  ).toMatchObject({
    completeness: {
      choice: "no",
      probabilities: { no: 0.9 },
    },
    issue: { choice: "missing_total" },
  });
  expect(
    normalizeCompletenessDecision({
      type: "choice",
      choice: "not_receipt",
      probabilities: { ...probabilities, not_receipt: 0.7 },
      confidence: 0.7,
    }),
  ).toMatchObject({
    completeness: { choice: "not_receipt" },
    issue: { choice: "not_receipt" },
  });
});

it("follows Jev's relationship choice without a score gate", () => {
  const answer = (
    choice: "continuation" | "payment_match" | "unrelated",
    probability: number,
    confidence: number,
  ) => ({
    type: "choice" as const,
    choice,
    probabilities: {
      continuation: choice === "continuation" ? probability : 0,
      payment_match: choice === "payment_match" ? probability : 0,
      unrelated: choice === "unrelated" ? probability : 1 - probability,
    },
    confidence,
  });
  expect(shouldAutoMerge(answer("continuation", 0.4, 0.09))).toBe(true);
  expect(shouldAutoMerge(answer("payment_match", 0.5, 0.1))).toBe(true);
  expect(shouldAutoMerge(answer("unrelated", 1, 1))).toBe(false);
});

it("marks combined OCR truncated when a later receipt footer is outside Jev's input", () => {
  const summary = summarizeDocumentOcr([
    { text: "line\n".repeat(5_000) },
    { text: "PRINTED TOTAL 12,34" },
  ]);
  expect(summary.characters).toBeGreaterThan(24_000);
  expect(summary.truncated).toBe(true);
  expect(summary.text).not.toContain("PRINTED TOTAL");
});

it("pins Jev readiness to page order, rotation, and source hash", async () => {
  const capture = {
    id: crypto.randomUUID(),
    sha256: "a".repeat(64),
  } as any;
  const original = newDocument(capture);
  const changed = structuredClone(original);
  changed.pages[0].rotation = 90;
  expect(await pageFingerprint(original)).not.toBe(
    await pageFingerprint(changed),
  );
});

it("accepts OCR covering the scan crop and rejects a smaller region", () => {
  const fullPage = {
    captureId: "capture",
    sha256: "a".repeat(64),
    rotation: 0,
  } as any;
  const capture = {
    id: "capture",
    sha256: "a".repeat(64),
    metadata: { sourcePixels: [1000, 1600], quality: { quad: null } },
  } as any;
  const artifact = {
    source: {
      captureId: "capture",
      sha256: "a".repeat(64),
      pixels: [1000, 1600],
      sourcePixels: [1000, 1600],
      sourceCrop: [0, 0, 1000, 1600],
      geometryVersion: 1,
      rectification: null,
      rotation: 0,
      region: { left: 0, top: 0, width: 1000, height: 1600 },
    },
  } as any;
  expect(ocrArtifactMatchesPage(artifact, fullPage, capture)).toBe(true);
  artifact.source.region = { left: 10, top: 0, width: 990, height: 1600 };
  expect(ocrArtifactMatchesPage(artifact, fullPage, capture)).toBe(false);
  capture.metadata.quality.quad = [
    [0.1, 0.1],
    [0.9, 0.1],
    [0.9, 0.9],
    [0.1, 0.9],
  ];
  const rectification = receiptRectification(
    [1000, 1600],
    capture.metadata.quality.quad,
  )!;
  artifact.source.pixels = rectification.outputPixels;
  artifact.source.sourceCrop = detectedReceiptCrop(
    [1000, 1600],
    capture.metadata.quality.quad,
  );
  artifact.source.rectification = rectification;
  artifact.source.region = {
    left: 0,
    top: 0,
    width: rectification.outputPixels[0],
    height: rectification.outputPixels[1],
  };
  expect(ocrArtifactMatchesPage(artifact, fullPage, capture)).toBe(true);
  artifact.source.region = {
    left: 10,
    top: 0,
    width: rectification.outputPixels[0] - 10,
    height: rectification.outputPixels[1],
  };
  expect(ocrArtifactMatchesPage(artifact, fullPage, capture)).toBe(false);
});

it("accepts Jev text from any valid region of the same rotated source", () => {
  const fullPage = {
    captureId: "capture",
    sha256: "a".repeat(64),
    rotation: 0,
  } as any;
  const capture = {
    id: "capture",
    sha256: "a".repeat(64),
    metadata: { sourcePixels: [1000, 1600], quality: { quad: null } },
  } as any;
  const artifact = {
    source: {
      captureId: "capture",
      sha256: "a".repeat(64),
      pixels: [1000, 1600],
      rotation: 0,
      region: { left: 100, top: 100, width: 800, height: 1300 },
    },
  } as any;
  expect(ocrArtifactMatchesPage(artifact, fullPage, capture)).toBe(false);
  expect(ocrTextArtifactHasValidGeometry(artifact, fullPage)).toBe(true);
  artifact.source.region = { left: 25, top: 100, width: 875, height: 1300 };
  expect(ocrTextArtifactHasValidGeometry(artifact, fullPage)).toBe(true);
  artifact.source.rotation = 90;
  expect(ocrTextArtifactHasValidGeometry(artifact, fullPage)).toBe(false);
  artifact.source.rotation = 0;
  artifact.source.pixels = {};
  expect(ocrTextArtifactHasValidGeometry(artifact, fullPage)).toBe(false);
});
