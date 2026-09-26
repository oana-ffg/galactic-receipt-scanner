import { expect, it } from "vitest";
import { reviewValues, type SavedReading } from "./review-values";
import type { DocumentView } from "./documents";
it("shows the current category without changing historical model readings", () => {
  const previous = {
    category_id: "old-category",
    evidence: "Initial model evidence",
  };
  const attempt = {
    revision: 1,
    stage: "small",
    model: "luna",
    sources: [],
    extraction: previous,
  } as unknown as SavedReading;
  const doc = {
    revision: 2,
    pages: [],
    processing: {
      has_human_review: false,
      large_model_confidence: null,
      small_model_certainty: "high",
      extraction: { ...previous, category_id: "current-category" },
    },
  } as unknown as DocumentView;
  const result = reviewValues(doc, [attempt]);
  expect(result.extraction.category_id).toBe("current-category");
  expect(result.luna!.extraction.category_id).toBe("old-category");
  expect(previous.category_id).toBe("old-category");
});

it("uses the latest agent correction in the human review editor after Luna", () => {
  const sources = [{ capture_id: "scan", sha256: "source-hash" }];
  const luna = {
    revision: 1,
    stage: "small",
    model: "luna",
    sources,
    extraction: { total_minor: 1000, category_id: "category" },
  } as unknown as SavedReading;
  const agent = {
    revision: 2,
    stage: "agent",
    model: "agent-correction",
    sources,
    extraction: { total_minor: 1200, category_id: "category" },
  } as unknown as SavedReading;
  const doc = {
    revision: 3,
    pages: [{ captureId: "scan", sha256: "source-hash" }],
    processing: {
      has_human_review: false,
      needs_reparse: false,
      large_model_confidence: null,
      small_model_certainty: null,
      extraction: agent.extraction,
    },
  } as unknown as DocumentView;
  const result = reviewValues(doc, [luna, agent]);
  expect(result.extraction.total_minor).toBe(1200);
  expect(result.source).toBe("saved agent correction");
  expect(result.luna?.extraction.total_minor).toBe(1000);
});

it("keeps newer saved human values after a later check-only save clears review status", () => {
  const sources = [{ capture_id: "scan", sha256: "source-hash" }];
  const agent = {
    revision: 2,
    stage: "agent",
    model: "agent-correction",
    sources,
    extraction: { total_minor: 1200, category_id: null },
  } as unknown as SavedReading;
  const human = {
    revision: 3,
    stage: "human",
    model: "human",
    sources,
    extraction: { total_minor: 1300, category_id: null },
  } as unknown as SavedReading;
  const doc = {
    revision: 4,
    pages: [{ captureId: "scan", sha256: "source-hash" }],
    processing: {
      has_human_review: false,
      needs_reparse: false,
      large_model_confidence: null,
      small_model_certainty: null,
      extraction: human.extraction,
    },
  } as unknown as DocumentView;
  const result = reviewValues(doc, [agent, human]);
  expect(result.extraction.total_minor).toBe(1300);
  expect(result.source).toBe("saved document");
});
