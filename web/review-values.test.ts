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
