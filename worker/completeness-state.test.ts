import { expect, it } from "vitest";
import { newDocument } from "../web/documents";
import { loadCompletenessAudits } from "./completeness-state";

it("does not reuse a completeness verdict after PP OCR changes on the same pages", async () => {
  const capture = {
    id: "00000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
  } as any;
  const document = newDocument(capture);
  const assessment = {
    subject_id: document.id,
    subject_revision: document.revision,
    created_at: "2026-09-21T00:00:00Z",
    payload: JSON.stringify({
      input: {
        page_fingerprint: "same-layout",
        pins: [{ capture_id: capture.id, ocr_sha256: "old-ocr" }],
      },
      response: {
        answers: {
          completeness: { choice: "yes", confidence: 1 },
          issue: { choice: "none" },
        },
      },
    }),
  };
  const documentHead = {
    document_id: document.id,
    document_revision: document.revision,
    page_fingerprint: "same-layout",
    role: "purchase_document",
  };
  const pageHead = {
    capture_id: capture.id,
    source_sha256: capture.sha256,
    ocr_sha256: "old-ocr",
  };
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async all() {
            return {
              results: sql.includes("FROM jev_assessments")
                ? [assessment]
                : sql.includes("FROM jev_document_heads")
                  ? [documentHead]
                  : [pageHead],
            };
          },
        };
      },
    },
  } as any;
  expect(
    (await loadCompletenessAudits(env, [document])).audits.get(document.id),
  ).toMatchObject({ result: "yes" });
  pageHead.ocr_sha256 = "new-ocr";
  expect(
    (await loadCompletenessAudits(env, [document])).audits.has(document.id),
  ).toBe(false);
  pageHead.ocr_sha256 = "old-ocr";
  document.kind = "other";
  expect(
    (await loadCompletenessAudits(env, [document])).audits.has(document.id),
  ).toBe(false);
});
