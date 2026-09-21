import type { Env } from "./index";
import {
  canAssessReceiptCompleteness,
  type ReceiptDocument,
  type DocumentView,
} from "../web/documents";

export const COMPLETENESS_TASK = "receipt-completeness-v1";

type AssessmentRow = {
  subject_id: string;
  subject_revision: number;
  payload: string;
  created_at: string;
};

type HeadRow = {
  document_id: string;
  document_revision: number;
  page_fingerprint: string;
  role: string;
};
type PageHeadRow = {
  capture_id: string;
  source_sha256: string;
  ocr_sha256: string;
};

export async function loadCompletenessAudits(
  env: Env,
  documents: ReceiptDocument[],
): Promise<{
  audits: Map<string, NonNullable<DocumentView["completenessAudit"]>>;
  roles: Map<string, string>;
}> {
  const [assessments, heads, pageHeads] = await Promise.all([
    env.DB.prepare(
      "SELECT subject_id,subject_revision,payload,created_at FROM jev_assessments WHERE task=? ORDER BY created_at DESC,id DESC",
    )
      .bind(COMPLETENESS_TASK)
      .all<AssessmentRow>(),
    env.DB.prepare(
      "SELECT document_id,document_revision,page_fingerprint,role FROM jev_document_heads",
    ).all<HeadRow>(),
    env.DB.prepare(
      "SELECT capture_id,source_sha256,ocr_sha256 FROM jev_page_heads",
    ).all<PageHeadRow>(),
  ]);
  const current = new Map(documents.map((document) => [document.id, document]));
  const headById = new Map(
    heads.results.map((head) => [head.document_id, head]),
  );
  const pageHeadById = new Map(
    pageHeads.results.map((head) => [head.capture_id, head]),
  );
  const roles = new Map<string, string>();
  for (const document of documents) {
    const head = headById.get(document.id);
    if (head?.document_revision === document.revision)
      roles.set(document.id, head.role);
  }
  const result = new Map<
    string,
    NonNullable<DocumentView["completenessAudit"]>
  >();
  for (const row of assessments.results) {
    if (result.has(row.subject_id)) continue;
    const document = current.get(row.subject_id);
    const head = headById.get(row.subject_id);
    if (
      !document ||
      !head ||
      !canAssessReceiptCompleteness(document.kind) ||
      document.mergedInto ||
      document.duplicateOf ||
      document.revision !== row.subject_revision ||
      head.document_revision !== document.revision ||
      head.role !== "purchase_document"
    )
      continue;
    const payload = JSON.parse(row.payload);
    if (payload.input?.page_fingerprint !== head.page_fingerprint) continue;
    const pins = payload.input?.pins;
    if (
      !Array.isArray(pins) ||
      pins.length !== document.pages.length ||
      !document.pages.every((page, index) => {
        const currentPage = pageHeadById.get(page.captureId);
        const pin = pins[index];
        return (
          currentPage?.source_sha256 === page.sha256 &&
          currentPage?.ocr_sha256 === pin?.ocr_sha256 &&
          pin?.capture_id === page.captureId
        );
      })
    )
      continue;
    const answer = payload.response?.answers?.completeness;
    const issue = payload.response?.answers?.issue;
    if (
      !["yes", "no", "not_receipt"].includes(answer?.choice) ||
      typeof answer.confidence !== "number" ||
      typeof issue?.choice !== "string"
    )
      continue;
    result.set(row.subject_id, {
      result: answer.choice,
      issue: issue.choice,
      confidence: answer.confidence,
      assessedAt: row.created_at,
    });
  }
  return { audits: result, roles };
}
