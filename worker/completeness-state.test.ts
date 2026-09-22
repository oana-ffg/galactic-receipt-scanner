import { expect, it } from "vitest";
import { newDocument } from "../web/documents";
import { loadCompletenessAudits } from "./completeness-state";
import { hashJson, pageFingerprint } from "./jev-head-identity";

it("does not reuse a completeness verdict after PP OCR changes on the same pages", async () => {
  const capture = {
    id: "00000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
  } as any;
  const document = newDocument(capture);
  const fingerprint = await pageFingerprint(document);
  const assessment = {
    subject_id: document.id,
    subject_revision: document.revision,
    created_at: "2026-09-21T00:00:00Z",
    payload: JSON.stringify({
      input: {
        page_fingerprint: fingerprint,
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
    page_fingerprint: fingerprint,
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

it("loads legacy heads in D1-sized batches", async () => {
  const documents = Array.from({ length: 60 }, (_, index) =>
    newDocument({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sha256: "a".repeat(64),
    } as any),
  );
  const heads = await Promise.all(
    documents.map(async (document) => ({
      document_id: document.id,
      document_revision: document.revision,
      page_fingerprint: await hashJson(
        document.pages.map((page) => ({
          capture_id: page.captureId,
          source_sha256: page.sha256,
          crop: null,
          rotation: page.rotation,
        })),
      ),
      role: "purchase_document",
    })),
  );
  const legacyBindCounts: number[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes("WITH wanted"))
              legacyBindCounts.push(values.length);
            return this;
          },
          async all() {
            return {
              results: sql.includes("FROM jev_document_heads") ? heads : [],
            };
          },
        };
      },
    },
  } as any;
  const state = await loadCompletenessAudits(env, documents);
  expect(state.roles.size).toBe(documents.length);
  expect(legacyBindCounts).toEqual([90, 30]);
});
