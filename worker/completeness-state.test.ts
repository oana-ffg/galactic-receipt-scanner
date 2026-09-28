import { expect, it } from "vitest";
import { newDocument } from "../web/documents";
import { loadCompletenessAudits } from "./completeness-state";
import { hashJson, pageFingerprint } from "./jev-head-identity";

async function assessedPurchase() {
  const document = newDocument({
    id: "00000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
  } as any);
  document.pages.push({
    captureId: "00000000-0000-4000-8000-000000000002",
    sha256: "b".repeat(64),
    rotation: 0,
  });
  const head = {
    document_id: document.id,
    document_revision: document.revision,
    page_fingerprint: await pageFingerprint(document),
    role: "purchase_document",
  };
  const pageHeads = document.pages.map((page) => ({
    capture_id: page.captureId,
    source_sha256: page.sha256,
    ocr_sha256: `ocr-${page.captureId}`,
  }));
  const assessment = {
    id: "00000000-0000-4000-8000-000000000003",
    subject_id: document.id,
    subject_revision: document.revision,
    created_at: "2026-01-01T00:00:00Z",
    payload: JSON.stringify({
      input: {
        page_fingerprint: head.page_fingerprint,
        pins: pageHeads.map((page) => ({
          capture_id: page.capture_id,
          ocr_sha256: page.ocr_sha256,
        })),
      },
      response: {
        answers: {
          completeness: { choice: "yes", confidence: 0.63 },
          issue: { choice: "none" },
        },
      },
    }),
  };
  const queries: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        queries.push(sql);
        return {
          bind() {
            return this;
          },
          async all() {
            return {
              results: sql.includes("FROM jev_assessments")
                ? [assessment]
                : sql.includes("FROM jev_document_heads")
                  ? [head]
                  : sql.includes("FROM jev_page_heads")
                    ? pageHeads
                    : sql.includes("FROM source_review_decisions") &&
                        JSON.parse(assessment.payload).response.answers
                          .completeness.choice === "no"
                      ? [{ assessment_id: assessment.id, decision: "fine" }]
                      : [],
            };
          },
        };
      },
    },
  } as any;
  return { document, head, pageHeads, assessment, queries, env };
}

it.each(["yes", "no", "not_receipt"])(
  "retains the same %s verdict after metadata revisions",
  async (outcome) => {
    const { document, assessment, queries, env } = await assessedPurchase();
    const payload = JSON.parse(assessment.payload);
    payload.response.answers.completeness.choice = outcome;
    payload.response.answers.issue.choice = {
      yes: "none",
      no: "missing_total",
      not_receipt: "not_receipt",
    }[outcome];
    assessment.payload = JSON.stringify(payload);
    document.revision += 2;
    document.vendor = "Synthetic shop";
    document.kind = "receipt";
    document.evidence = "Synthetic extracted fields and PDF inspection.";
    const state = await loadCompletenessAudits(env, [document]);
    expect(state.roles.get(document.id)).toBe("purchase_document");
    expect(state.audits.get(document.id)).toMatchObject({
      assessmentId: assessment.id,
      result: outcome,
      confidence: 0.63,
      assessedAt: assessment.created_at,
    });
    expect(state.sourceDecisions.get(assessment.id)).toBe(
      outcome === "no" ? true : undefined,
    );
    expect(queries.some((sql) => sql.includes("document_versions"))).toBe(
      false,
    );
  },
);

it.each([
  "page added",
  "page removed",
  "page reordered",
  "original replaced",
  "rotation changed",
  "OCR replaced",
  "page head missing",
  "role changed",
  "duplicate",
  "merged",
  "non-purchase kind",
])("rejects the previous verdict when %s", async (change) => {
  const { document, head, pageHeads, env } = await assessedPurchase();
  document.revision++;
  switch (change) {
    case "page added":
      document.pages.push({
        ...document.pages[0],
        captureId: "00000000-0000-4000-8000-000000000004",
      });
      break;
    case "page removed":
      document.pages.pop();
      break;
    case "page reordered":
      document.pages.reverse();
      break;
    case "original replaced":
      document.pages[0].sha256 = "c".repeat(64);
      break;
    case "rotation changed":
      document.pages[0].rotation = 90;
      break;
    case "OCR replaced":
      pageHeads[0].ocr_sha256 = "new-ocr";
      break;
    case "page head missing":
      pageHeads.pop();
      break;
    case "role changed":
      head.role = "payment_evidence_only";
      break;
    case "duplicate":
      document.duplicateOf = "00000000-0000-4000-8000-000000000004";
      break;
    case "merged":
      document.mergedInto = "00000000-0000-4000-8000-000000000004";
      break;
    case "non-purchase kind":
      document.kind = "other";
      break;
  }
  expect((await loadCompletenessAudits(env, [document])).audits.size).toBe(0);
});

it("does not reuse a completeness verdict after PP OCR changes on the same pages", async () => {
  const capture = {
    id: "00000000-0000-4000-8000-000000000001",
    sha256: "a".repeat(64),
  } as any;
  const document = newDocument(capture);
  const fingerprint = await pageFingerprint(document);
  const assessment = {
    id: "00000000-0000-4000-8000-000000000002",
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
