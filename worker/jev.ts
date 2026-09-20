import type { Env } from "./index";
import type { Capture } from "../web/types";
import {
  newDocument,
  requiredMergeReviewReasons,
  retargetAbsorbedAliases,
  type ReceiptDocument,
} from "../web/documents";
import { ocrTextArtifactMatchesPage, type OcrArtifact } from "../web/ocr-data";
import { documentRoute, storedDocuments } from "./documents";
import { HttpError, json, requireThat } from "./http";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
const MAX_JEV_TEXT = 24_000;
const AUTO_MATCH_PROBABILITY = 0.9;
const AUTO_MATCH_CONFIDENCE = 0.75;
const JEV_ELIGIBILITY_VERSION = 2;
const JEV_PIPELINE_VERSION = 4;

export const pageRoles = [
  "receipt",
  "payment_evidence",
  "account_record",
  "cash_withdrawal",
  "misc",
] as const;
export type PageRole = (typeof pageRoles)[number];

export const documentRoles = [
  "purchase_document",
  "payment_evidence_only",
  "account_record",
  "cash_withdrawal",
  "misc",
] as const;
export type DocumentRole = (typeof documentRoles)[number];

type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
type JevResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

type JevBudget = { remaining: number };

class JevCheckpoint extends Error {}
class JevMutationBusy extends Error {}
type PageHead = {
  capture_id: string;
  source_sha256: string;
  ocr_sha256: string;
  role: PageRole;
  probability: number;
  confidence: number;
  model: string;
  assessment_id: string;
  date_candidates: string | null;
  updated_at: string;
};
export type JevDocumentHead = {
  document_id: string;
  document_revision: number;
  page_fingerprint: string;
  role: DocumentRole;
  role_probability: number;
  role_confidence: number;
  category_id: string | null;
  category_probability: number | null;
  category_confidence: number | null;
  model: string;
  assessment_id: string;
  category_assessment_id: string | null;
  updated_at: string;
};

const scaled = (value: number) => Math.round(value * 1_000_000);
const unscaled = (value: number | null) =>
  value === null ? null : value / 1_000_000;

function normalizedDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    return null;
  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function ocrDateCandidates(text: string) {
  const dates = new Set<string>();
  const add = (year: string, month: string, day: string) => {
    const normalized = normalizedDate(
      Number(year.length === 2 ? `20${year}` : year),
      Number(month),
      Number(day),
    );
    if (normalized) dates.add(normalized);
  };
  for (const match of text.matchAll(
    /\b(20\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\b/g,
  ))
    add(match[1], match[2], match[3]);
  for (const match of text.matchAll(
    /\b(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*((?:20)?\d{2})\b/g,
  ))
    add(match[3], match[2], match[1]);
  return [...dates].sort();
}

async function sha256(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function pageFingerprint(document: ReceiptDocument) {
  return sha256(
    document.pages.map((page) => ({
      capture_id: page.captureId,
      source_sha256: page.sha256,
      crop: page.crop,
      rotation: page.rotation,
    })),
  );
}

export function shouldAutoMerge(answer: ChoiceAnswer) {
  return (
    answer.choice !== "unrelated" &&
    (answer.probabilities[answer.choice] ?? 0) >= AUTO_MATCH_PROBABILITY &&
    answer.confidence >= AUTO_MATCH_CONFIDENCE
  );
}

function validateChoice(
  answer: unknown,
  choices: readonly string[],
): asserts answer is ChoiceAnswer {
  const value = answer as ChoiceAnswer;
  requireThat(
    value?.type === "choice" &&
      choices.includes(value.choice) &&
      value.probabilities &&
      Object.keys(value.probabilities).length === choices.length &&
      choices.every(
        (choice) =>
          typeof value.probabilities[choice] === "number" &&
          value.probabilities[choice] >= 0 &&
          value.probabilities[choice] <= 1,
      ) &&
      typeof value.confidence === "number" &&
      value.confidence >= 0 &&
      value.confidence <= 1,
    503,
    "Jev returned an invalid choice response.",
  );
}

async function callJev(
  env: Env,
  state: unknown,
  questions: Record<
    string,
    { type: "choice"; instructions: string; criteria: Record<string, string> }
  >,
  budget?: JevBudget,
): Promise<JevResponse> {
  if (budget) {
    if (budget.remaining <= 0) throw new JevCheckpoint();
    budget.remaining -= 1;
  }
  requireThat(env.TYPESAFE_API_KEY, 503, "Jev is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      signal: controller.signal,
    });
  } catch {
    throw new HttpError(503, "Jev request failed.");
  } finally {
    clearTimeout(timeout);
  }
  requireThat(response.ok, 503, `Jev request failed (${response.status}).`);
  const result = (await response.json()) as JevResponse;
  requireThat(
    result && typeof result.model === "string" && result.answers,
    503,
    "Jev returned an invalid response.",
  );
  return result;
}

type AssessableResponse =
  JevResponse | { model: string; answers: Record<string, unknown> };

async function assess<T extends AssessableResponse>(
  env: Env,
  task: string,
  input: unknown,
  subject: { id: string; revision?: number },
  candidate: { id: string; revision?: number } | null,
  run: () => Promise<T>,
  validate: (result: T) => void,
) {
  const inputHash = await sha256({ input, subject, candidate });
  const existing = await env.DB.prepare(
    "SELECT id,payload FROM jev_assessments WHERE task=? AND input_sha256=?",
  )
    .bind(task, inputHash)
    .first<{ id: string; payload: string }>();
  if (existing) {
    const result = JSON.parse(existing.payload).response as T;
    validate(result);
    return { id: existing.id, result };
  }
  const result = await run();
  validate(result);
  const id = crypto.randomUUID();
  const redactOcr = (value: unknown, key = ""): unknown => {
    if (key === "ocr" || key === "ocr_text") {
      const text = typeof value === "string" ? value : "";
      return { sha256: inputHash, characters: text.length };
    }
    if (Array.isArray(value)) return value.map((item) => redactOcr(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [
          childKey,
          redactOcr(child, childKey),
        ]),
      );
    return value;
  };
  const payload = JSON.stringify({ input: redactOcr(input), response: result });
  try {
    await env.DB.prepare(
      "INSERT INTO jev_assessments(id,task,subject_id,subject_revision,candidate_id,candidate_revision,model,input_sha256,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        task,
        subject.id,
        subject.revision ?? null,
        candidate?.id ?? null,
        candidate?.revision ?? null,
        result.model,
        inputHash,
        payload,
        new Date().toISOString(),
      )
      .run();
    return { id, result };
  } catch (error) {
    const raced = await env.DB.prepare(
      "SELECT id,payload FROM jev_assessments WHERE task=? AND input_sha256=?",
    )
      .bind(task, inputHash)
      .first<{ id: string; payload: string }>();
    if (!raced) throw error;
    const persisted = JSON.parse(raced.payload).response as T;
    validate(persisted);
    return { id: raced.id, result: persisted };
  }
}

function records(stored: ReceiptDocument[], captures: Capture[]) {
  const assigned = new Set(
    stored.flatMap((document) => document.pages.map((page) => page.captureId)),
  );
  return [
    ...stored,
    ...captures
      .filter(
        (capture) =>
          capture.is_current &&
          !assigned.has(capture.id) &&
          !stored.some((document) => document.id === capture.id),
      )
      .map(newDocument),
  ];
}

async function pinnedPpOcr(
  env: Env,
  page: ReceiptDocument["pages"][number],
  ocrSha256: string,
): Promise<{ sha256: string; value: OcrArtifact } | null> {
  const row = await env.DB.prepare(
    "SELECT key,sha256 FROM artifacts WHERE capture_id=? AND kind='ocr' AND sha256=?",
  )
    .bind(page.captureId, ocrSha256)
    .first<{ key: string; sha256: string }>();
  if (!row) return null;
  const object = await env.BUCKET.get(row.key);
  if (!object) return null;
  const value = await object.json<OcrArtifact>();
  return value?.provenance?.engine === "PP-OCRv6" &&
    value.source?.captureId === page.captureId &&
    value.source?.sha256 === page.sha256 &&
    ocrTextArtifactMatchesPage(value, page) &&
    typeof value.text === "string"
    ? { sha256: row.sha256, value }
    : null;
}

async function documentOcr(
  env: Env,
  document: ReceiptDocument,
  heads: PageHead[],
) {
  const pins: { capture_id: string; ocr_sha256: string; text: string }[] = [];
  for (const [index, page] of document.pages.entries()) {
    const head = heads[index];
    if (!head || head.capture_id !== page.captureId) return null;
    const found = await pinnedPpOcr(env, page, head.ocr_sha256);
    if (!found) return null;
    pins.push({
      capture_id: page.captureId,
      ocr_sha256: found.sha256,
      text: found.value.text,
    });
  }
  return {
    blank: pins.every((pin) => !pin.text.trim()),
    pins: pins.map(({ text: _text, ...pin }) => pin),
    text: pins
      .map((pin, index) => `Page ${index + 1}:\n${pin.text}`)
      .join("\n\n")
      .slice(0, MAX_JEV_TEXT),
  };
}

export async function loadPurchaseCategoryChoices(env: Env) {
  const categories = (
    await env.DB.prepare(
      "SELECT id,name,description FROM purchase_categories WHERE archived_at IS NULL ORDER BY name",
    ).all<{ id: string; name: string; description: string }>()
  ).results;
  const ids = new Map<string, string>();
  const criteria: Record<string, string> = {};
  categories.forEach((category, index) => {
    const key = `category_${index + 1}`;
    ids.set(key, category.id);
    criteria[key] = `${category.name}: ${category.description}`;
  });
  criteria.unresolved =
    "Use only when the OCR text does not support any listed category.";
  return { criteria, ids };
}

async function classifyPage(
  env: Env,
  capture: Capture,
  ocrSha256: string,
  value: OcrArtifact,
  budget: JevBudget,
): Promise<PageHead> {
  const text = value.text.trim();
  const criteria = {
    receipt:
      "A purchase receipt, invoice, credit note, or a continuation page containing purchased items or totals.",
    payment_evidence:
      "A card-terminal slip, payment confirmation, or other payment evidence without the purchased item list.",
    account_record:
      "A bank statement, account statement, balance notice, ledger extract, or similar account record.",
    cash_withdrawal: "An ATM cash-withdrawal receipt or cash-dispenser record.",
    misc: "Anything else, including unreadable, blank, or non-financial material.",
  };
  const input = { ocr_text: text, ocr_sha256: ocrSha256, criteria };
  const saved = await assess(
    env,
    "page-role",
    input,
    { id: capture.id },
    null,
    async () => {
      if (!text)
        return {
          model: "rule:blank-ocr",
          answers: {
            page_role: {
              type: "choice" as const,
              choice: "misc",
              probabilities: {
                receipt: 0,
                payment_evidence: 0,
                account_record: 0,
                cash_withdrawal: 0,
                misc: 1,
              },
              confidence: 1,
            },
          },
        };
      return callJev(
        env,
        { ocr_text: text },
        {
          page_role: {
            type: "choice",
            instructions: "Classify this scanned page.",
            criteria,
          },
        },
        budget,
      );
    },
    (result) => validateChoice(result.answers.page_role, pageRoles),
  );
  const result = saved.result;
  const answer = result.answers.page_role;
  validateChoice(answer, pageRoles);
  const now = new Date().toISOString();
  const dates = JSON.stringify(ocrDateCandidates(text));
  await env.DB.prepare(
    "INSERT INTO jev_page_heads(capture_id,source_sha256,ocr_sha256,role,probability,confidence,model,assessment_id,date_candidates,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_id) DO UPDATE SET source_sha256=excluded.source_sha256,ocr_sha256=excluded.ocr_sha256,role=excluded.role,probability=excluded.probability,confidence=excluded.confidence,model=excluded.model,assessment_id=excluded.assessment_id,date_candidates=excluded.date_candidates,updated_at=excluded.updated_at",
  )
    .bind(
      capture.id,
      capture.sha256,
      ocrSha256,
      answer.choice,
      scaled(answer.probabilities[answer.choice]),
      scaled(answer.confidence),
      result.model,
      saved.id,
      dates,
      now,
    )
    .run();
  return {
    capture_id: capture.id,
    source_sha256: capture.sha256,
    ocr_sha256: ocrSha256,
    role: answer.choice as PageRole,
    probability: scaled(answer.probabilities[answer.choice]),
    confidence: scaled(answer.confidence),
    model: result.model,
    assessment_id: saved.id,
    date_candidates: dates,
    updated_at: now,
  };
}

async function pageHeads(env: Env, document: ReceiptDocument) {
  if (!document.pages.length) return [];
  const rows = await env.DB.prepare(
    `SELECT * FROM jev_page_heads WHERE capture_id IN (${document.pages.map(() => "?").join(",")})`,
  )
    .bind(...document.pages.map((page) => page.captureId))
    .all<PageHead>();
  return document.pages
    .map((page) =>
      rows.results.find((row) => row.capture_id === page.captureId),
    )
    .filter((row): row is PageHead => !!row);
}

export async function documentEvidence(env: Env, document: ReceiptDocument) {
  const heads = await pageHeads(env, document);
  if (heads.length !== document.pages.length) return null;
  const ocr = await documentOcr(env, document, heads);
  if (
    !ocr ||
    document.pages.some((page, index) => {
      const head = heads[index];
      const pin = ocr.pins[index];
      return (
        head.capture_id !== page.captureId ||
        head.source_sha256 !== page.sha256 ||
        pin.capture_id !== page.captureId ||
        head.ocr_sha256 !== pin.ocr_sha256
      );
    })
  )
    return null;
  return { heads, ocr };
}

async function compareDocuments(
  env: Env,
  current: ReceiptDocument,
  candidate: ReceiptDocument,
  budget: JevBudget,
) {
  const currentEvidence = await documentEvidence(env, current);
  const candidateEvidence = await documentEvidence(env, candidate);
  if (!currentEvidence || !candidateEvidence) return null;
  const currentOcr = currentEvidence.ocr;
  const candidateOcr = candidateEvidence.ocr;
  const input = {
    current: {
      document_id: current.id,
      ocr: currentOcr.text,
      pins: currentOcr.pins,
    },
    candidate: {
      document_id: candidate.id,
      ocr: candidateOcr.text,
      pins: candidateOcr.pins,
    },
  };
  const saved = await assess(
    env,
    "document-relationship",
    input,
    { id: current.id },
    { id: candidate.id },
    () =>
      callJev(
        env,
        input,
        {
          relationship: {
            type: "choice",
            instructions:
              "Classify the relationship between these two scanned documents.",
            criteria: {
              continuation:
                "They are different pages or sections of the same receipt or financial document, excluding separate payment evidence.",
              payment_match:
                "One is purchase documentation and the other is payment evidence for the same transaction. Require the merchant/vendor, amount, time, card suffix, terminal, authorization, transaction or reference evidence to be compatible; a shared date alone is not enough, and a material contradiction means unrelated.",
              unrelated:
                "They do not belong to the same transaction or document, including when merchant/vendor, amount, time, card, terminal, authorization, transaction or reference evidence materially conflicts.",
            },
          },
        },
        budget,
      ),
    (result) =>
      validateChoice(result.answers.relationship, [
        "continuation",
        "payment_match",
        "unrelated",
      ]),
  );
  const result = saved.result;
  const answer = result.answers.relationship;
  validateChoice(answer, ["continuation", "payment_match", "unrelated"]);
  return {
    answer,
    assessment_id: saved.id,
    model: result.model,
  };
}

function invalidateProcessing(document: ReceiptDocument) {
  if (document.processing) {
    document.processing.needs_reparse = true;
    document.processing.has_human_review = false;
    document.processing.human_review_revision = null;
    document.processing.large_model_confidence = null;
  }
  document.checks = {
    visual: false,
    transcription: false,
    grouping: false,
    pdf: false,
  };
  document.reviewedPdfSha256 = null;
  document.invoice = null;
}

async function saveDocuments(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  documents: ReceiptDocument[],
) {
  let response: Response | null;
  try {
    response = await documentRoute(
      new Request(new URL("/api/documents", request.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documents }),
      }),
      env,
      loadCaptures,
      { statements: [], trustedProcessing: true },
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 409)
      throw new JevMutationBusy();
    throw error;
  }
  requireThat(response?.ok, 503, "Jev grouping could not be saved.");
  return (await response.json()) as {
    saved: { id: string; revision: number }[];
  };
}

export function prepareJevMerge(
  current: ReceiptDocument,
  candidate: ReceiptDocument,
  relationship: "continuation" | "payment_match",
  roles: Map<string, PageRole>,
) {
  let target = structuredClone(candidate),
    donor = structuredClone(current);
  if (relationship === "payment_match") {
    const currentHasReceipt = current.pages.some(
      (page) => roles.get(page.captureId) === "receipt",
    );
    if (currentHasReceipt) {
      target = structuredClone(current);
      donor = structuredClone(candidate);
    }
  }
  const donorBeforeMerge = structuredClone(donor);
  const movedCaptureIds = donor.pages.map((page) => page.captureId);
  target.pages = [...target.pages, ...donor.pages];
  target.annotations = [...target.annotations, ...donor.annotations];
  target.handwriting =
    target.handwriting === "present" || donor.handwriting === "present"
      ? "present"
      : target.handwriting === "uncertain" || donor.handwriting === "uncertain"
        ? "uncertain"
        : target.handwriting === "unchecked" ||
            donor.handwriting === "unchecked"
          ? "unchecked"
          : "absent";
  donor.mergedInto = target.id;
  donor.duplicateOf = null;
  const required = requiredMergeReviewReasons(donor, donorBeforeMerge);
  target.uncertainties = [
    ...new Set([...target.uncertainties, ...required.uncertainties]),
  ];
  target.broken = [...new Set([...target.broken, ...required.broken])];
  donor.pages = [];
  donor.annotations = [];
  donor.handwriting = "unchecked";
  invalidateProcessing(target);
  invalidateProcessing(donor);
  target.evidence = [
    target.evidence,
    `Jev grouped pages as ${relationship.replace("_", " ")}; the model decision and confidence are stored separately.`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
  donor.evidence = [donor.evidence, `Merged into ${target.id} by Jev.`]
    .filter(Boolean)
    .join("\n")
    .slice(0, 20_000);
  return { target, donor, movedCaptureIds };
}

export async function mergeDocuments(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  current: ReceiptDocument,
  candidate: ReceiptDocument,
  relationship: "continuation" | "payment_match",
  roles: Map<string, PageRole>,
  allDocuments: ReceiptDocument[],
) {
  const { target, donor, movedCaptureIds } = prepareJevMerge(
    current,
    candidate,
    relationship,
    roles,
  );
  const rejected = (
    await env.DB.prepare(
      "SELECT capture_id FROM rejected_associations WHERE document_id=?",
    )
      .bind(target.id)
      .all<{ capture_id: string }>()
  ).results;
  if (
    movedCaptureIds.some((captureId) =>
      rejected.some((item) => item.capture_id === captureId),
    )
  )
    return null;
  const changed = [target, donor];
  retargetAbsorbedAliases(changed, allDocuments, target.id);
  requireThat(
    changed.length <= 100,
    409,
    "Jev grouping would exceed the bounded relationship update; leave it for explicit review.",
  );
  const result = await saveDocuments(request, env, loadCaptures, changed);
  target.revision = result.saved.find(
    (saved) => saved.id === target.id,
  )!.revision;
  return target;
}

async function documentsAreUnlocked(env: Env, documents: ReceiptDocument[]) {
  if (!documents.length) return true;
  const current = new Map(
    (await storedDocuments(env)).map((document) => [document.id, document]),
  );
  if (
    documents.some((document) => {
      const persisted = current.get(document.id);
      return (persisted?.revision ?? 0) !== document.revision;
    })
  )
    return false;
  if (
    documents.some(
      (document) => current.get(document.id)?.processing ?? document.processing,
    )
  ) {
    const batch = await env.DB.prepare(
      "SELECT 1 AS active FROM processing_batch_lease WHERE id=1 AND expires>unixepoch()*1000",
    ).first<{ active: number }>();
    if (batch) return false;
  }
  const active = await env.DB.prepare(
    "SELECT document_id FROM processing_lock WHERE id=1 AND expires>unixepoch()*1000",
  ).first<{ document_id: string }>();
  return (
    !active || !documents.some((document) => document.id === active.document_id)
  );
}

async function classifyDocument(
  env: Env,
  document: ReceiptDocument,
  budget: JevBudget,
) {
  const evidence = await documentEvidence(env, document);
  if (!evidence) return null;
  const { heads, ocr } = evidence;
  const categoryChoices = await loadPurchaseCategoryChoices(env);
  const roleCriteria = {
    purchase_document:
      "A receipt, invoice, credit note, or multi-page purchase document, with any matching payment evidence included.",
    payment_evidence_only:
      "Only card-terminal slips, payment confirmations, or similar payment evidence, with no purchase receipt attached.",
    account_record:
      "A bank statement, account statement, balance notice, ledger extract, or similar account record.",
    cash_withdrawal: "An ATM cash-withdrawal receipt or cash-dispenser record.",
    misc: "Anything else, including blank or unreadable material.",
  };
  const questions: Parameters<typeof callJev>[2] = {
    document_role: {
      type: "choice",
      instructions: "Classify this document.",
      criteria: roleCriteria,
    },
  };
  const receiptPresent = heads.some((head) => head.role === "receipt");
  if (receiptPresent)
    questions.purchase_category = {
      type: "choice",
      instructions: "Classify this receipt using the category definitions.",
      criteria: categoryChoices.criteria,
    };
  const roleInput = { ocr_text: ocr.text };
  const roleSaved = await assess(
    env,
    "document-classification",
    {
      state: roleInput,
      pins: ocr.pins,
      role_criteria: roleCriteria,
      category_criteria: receiptPresent ? categoryChoices.criteria : null,
      category_ids: receiptPresent
        ? Object.fromEntries(categoryChoices.ids)
        : null,
    },
    { id: document.id, revision: document.revision },
    null,
    async () => {
      if (ocr.blank)
        return {
          model: "rule:blank-ocr",
          answers: {
            document_role: {
              type: "choice" as const,
              choice: "misc",
              probabilities: {
                purchase_document: 0,
                payment_evidence_only: 0,
                account_record: 0,
                cash_withdrawal: 0,
                misc: 1,
              },
              confidence: 1,
            },
          },
        };
      return callJev(env, roleInput, questions, budget);
    },
    (result) => {
      validateChoice(result.answers.document_role, documentRoles);
      if (receiptPresent)
        validateChoice(
          result.answers.purchase_category,
          Object.keys(categoryChoices.criteria),
        );
    },
  );
  const roleResult = roleSaved.result;
  const role = roleResult.answers.document_role;
  validateChoice(role, documentRoles);
  let category: ChoiceAnswer | null = null;
  let categoryAssessmentId: string | null = null;
  if (!ocr.blank && receiptPresent) {
    category = roleResult.answers.purchase_category;
    validateChoice(category, Object.keys(categoryChoices.criteria));
    categoryAssessmentId = roleSaved.id;
  }
  const categoryId =
    category && category.choice !== "unresolved"
      ? (categoryChoices.ids.get(category.choice) ?? null)
      : null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO jev_document_heads(document_id,document_revision,page_fingerprint,role,role_probability,role_confidence,category_id,category_probability,category_confidence,model,assessment_id,category_assessment_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET document_revision=excluded.document_revision,page_fingerprint=excluded.page_fingerprint,role=excluded.role,role_probability=excluded.role_probability,role_confidence=excluded.role_confidence,category_id=excluded.category_id,category_probability=excluded.category_probability,category_confidence=excluded.category_confidence,model=excluded.model,assessment_id=excluded.assessment_id,category_assessment_id=excluded.category_assessment_id,updated_at=excluded.updated_at",
  )
    .bind(
      document.id,
      document.revision,
      await pageFingerprint(document),
      role.choice,
      scaled(role.probabilities[role.choice]),
      scaled(role.confidence),
      categoryId,
      category ? scaled(category.probabilities[category.choice]) : null,
      category ? scaled(category.confidence) : null,
      roleResult.model,
      roleSaved.id,
      categoryAssessmentId,
      now,
    )
    .run();
  return {
    document_id: document.id,
    role: role.choice as DocumentRole,
    role_probability: role.probabilities[role.choice],
    role_confidence: role.confidence,
    category_id: categoryId,
    category_probability: category?.probabilities[category.choice] ?? null,
    category_confidence: category?.confidence ?? null,
    model: roleResult.model,
  };
}

async function currentDocument(
  env: Env,
  captures: Capture[],
  captureId: string,
) {
  const docs = records(await storedDocuments(env), captures);
  return docs.find((document) =>
    document.pages.some((page) => page.captureId === captureId),
  );
}

export async function queueJevJob(
  env: Env,
  captureId: string,
  ocrSha256: string,
) {
  const id = await sha256({ captureId, ocrSha256 });
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO jev_jobs(id,capture_id,ocr_sha256,status,attempts,eligibility_version,ineligible_reason,last_error,created_at,updated_at) VALUES(?,?,?,'pending',0,?,NULL,NULL,?,?)",
  )
    .bind(id, captureId, ocrSha256, JEV_ELIGIBILITY_VERSION, now, now)
    .run();
  return id;
}

async function processJob(
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  job: {
    id: string;
    capture_id: string;
    ocr_sha256: string;
  },
) {
  const captures = await loadCaptures();
  const capture = captures.find((item) => item.id === job.capture_id);
  if (!capture?.is_current)
    return { eligible: false, ineligible_reason: "capture_not_current" };
  const artifact = await env.DB.prepare(
    "SELECT key FROM artifacts WHERE capture_id=? AND kind='ocr' AND sha256=?",
  )
    .bind(job.capture_id, job.ocr_sha256)
    .first<{ key: string }>();
  if (!artifact)
    return { eligible: false, ineligible_reason: "ocr_artifact_missing" };
  const object = await env.BUCKET.get(artifact.key);
  requireThat(object, 503, "OCR artifact is unavailable.");
  const value = await object.json<OcrArtifact>();
  if (value?.provenance?.engine !== "PP-OCRv6")
    return { eligible: false, ineligible_reason: "ppocr_required" };
  if (
    value.source?.captureId !== capture.id ||
    value.source?.sha256 !== capture.sha256
  )
    return { eligible: false, ineligible_reason: "source_mismatch" };
  const initialDocument = await currentDocument(env, captures, capture.id);
  const page = initialDocument?.pages.find(
    (item) => item.captureId === capture.id,
  );
  if (!page) return { eligible: false, ineligible_reason: "page_missing" };
  if (!ocrTextArtifactMatchesPage(value, page))
    return { eligible: false, ineligible_reason: "ocr_region_mismatch" };
  await classifyPage(env, capture, job.ocr_sha256, value, { remaining: 1 });
  return { eligible: true };
}

export async function runJevJob(
  _request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  id: string,
  pipelineOwned = false,
) {
  type Job = {
    id: string;
    capture_id: string;
    ocr_sha256: string;
    status: string;
    attempts: number;
    run_token: string;
  };
  const runToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = await env.DB.prepare(
    `UPDATE jev_jobs SET status='running',attempts=attempts+1,eligibility_version=?,ineligible_reason=NULL,run_token=?,last_error=NULL,updated_at=? WHERE id=? AND (status='pending' OR (status='failed' AND attempts<3))${pipelineOwned ? "" : " AND NOT EXISTS(SELECT 1 FROM jev_pipeline_runs WHERE phase!='complete')"} RETURNING id,capture_id,ocr_sha256,status,attempts,run_token`,
  )
    .bind(JEV_ELIGIBILITY_VERSION, runToken, now, id)
    .first<Job>();
  if (!job) {
    const current = await env.DB.prepare(
      "SELECT id,capture_id,ocr_sha256,status,attempts,run_token FROM jev_jobs WHERE id=?",
    )
      .bind(id)
      .first<Job>();
    requireThat(current, 404, "Jev job not found.");
    return { id, status: current.status };
  }
  try {
    const result = await processJob(env, loadCaptures, job);
    const status = result.eligible ? "classified" : "ineligible";
    const saved = await env.DB.prepare(
      "UPDATE jev_jobs SET status=?,ineligible_reason=?,association_progress=NULL,run_token=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='running' AND run_token=? RETURNING status",
    )
      .bind(
        status,
        result.eligible ? null : result.ineligible_reason,
        new Date().toISOString(),
        id,
        runToken,
      )
      .first<{ status: string }>();
    if (!saved) {
      const current = await env.DB.prepare(
        "SELECT status FROM jev_jobs WHERE id=?",
      )
        .bind(id)
        .first<{ status: string }>();
      return { id, status: current?.status ?? "failed", superseded: true };
    }
    return { id, status, ...result };
  } catch (error) {
    const message =
      error instanceof HttpError ? error.message : "Jev processing failed.";
    const status = job.attempts >= 3 ? "blocked" : "failed";
    const saved = await env.DB.prepare(
      "UPDATE jev_jobs SET status=?,run_token=NULL,last_error=?,updated_at=? WHERE id=? AND status='running' AND run_token=? RETURNING status",
    )
      .bind(
        status,
        message.slice(0, 500),
        new Date().toISOString(),
        id,
        runToken,
      )
      .first<{ status: string }>();
    if (!saved) {
      const current = await env.DB.prepare(
        "SELECT status FROM jev_jobs WHERE id=?",
      )
        .bind(id)
        .first<{ status: string }>();
      return { id, status: current?.status ?? "failed", superseded: true };
    }
    throw error;
  }
}

type JevPipelinePhase = "pages" | "group" | "dates" | "documents" | "complete";

type JevPipelineRun = {
  id: string;
  version: number;
  phase: JevPipelinePhase;
  snapshot_created_at: string;
  snapshot_capture_id: string;
  cursor: string | null;
  step_token: string | null;
  step_started_at: string | null;
  created_at: string;
  updated_at: string;
};

const captureOrder = (capture: Pick<Capture, "created_at" | "id">) =>
  `${capture.created_at}\u0000${capture.id}`;

function withinPipelineSnapshot(capture: Capture, run: JevPipelineRun) {
  return (
    captureOrder(capture) <=
    `${run.snapshot_created_at}\u0000${run.snapshot_capture_id}`
  );
}

async function activePipelineRun(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM jev_pipeline_runs WHERE phase!='complete' ORDER BY created_at DESC,id DESC LIMIT 1",
  ).first<JevPipelineRun>();
}

async function latestPipelineRun(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM jev_pipeline_runs ORDER BY created_at DESC,id DESC LIMIT 1",
  ).first<JevPipelineRun>();
}

async function currentWaitingCaptureCount(env: Env, captures: Capture[]) {
  const current = new Set(
    captures
      .filter((capture) => capture.is_current)
      .map((capture) => capture.id),
  );
  const waiting = (
    await env.DB.prepare(
      "SELECT DISTINCT capture_id FROM jev_jobs WHERE status='waiting'",
    ).all<{ capture_id: string }>()
  ).results;
  return waiting.filter((job) => current.has(job.capture_id)).length;
}

async function pipelineNeedsRun(
  env: Env,
  current: Capture[],
  latest: JevPipelineRun | null,
) {
  if (!latest) return current.length > 0;
  if (latest.version !== JEV_PIPELINE_VERSION) return current.length > 0;
  const currentIds = new Set(current.map((capture) => capture.id));
  const unfinished = (
    await env.DB.prepare(
      "SELECT capture_id FROM jev_jobs WHERE status IN ('pending','running','failed','classified')",
    ).all<{ capture_id: string }>()
  ).results.some((job) => currentIds.has(job.capture_id));
  if (unfinished) return true;
  const boundary = current.at(-1);
  if (!boundary) return false;
  if (
    captureOrder(boundary) >
    `${latest.snapshot_created_at}\u0000${latest.snapshot_capture_id}`
  )
    return true;
  const probe: JevPipelineRun = {
    ...latest,
    snapshot_created_at: boundary.created_at,
    snapshot_capture_id: boundary.id,
  };
  return (
    (await unqueuedArtifacts(env, current, probe)).length > 0 ||
    (await legacyPageCandidates(env, current, probe)).length > 0
  );
}

async function startPipelineRun(env: Env, current: Capture[]) {
  const boundary = current.at(-1);
  if (!boundary) return null;
  const now = new Date().toISOString();
  const run: JevPipelineRun = {
    id: crypto.randomUUID(),
    version: JEV_PIPELINE_VERSION,
    phase: "pages",
    snapshot_created_at: boundary.created_at,
    snapshot_capture_id: boundary.id,
    cursor: null,
    step_token: null,
    step_started_at: null,
    created_at: now,
    updated_at: now,
  };
  const inserted = await env.DB.prepare(
    "INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,cursor,step_token,step_started_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM jev_pipeline_runs WHERE phase!='complete') RETURNING *",
  )
    .bind(
      run.id,
      run.version,
      run.phase,
      run.snapshot_created_at,
      run.snapshot_capture_id,
      null,
      null,
      null,
      now,
      now,
    )
    .first<JevPipelineRun>();
  return inserted ?? activePipelineRun(env);
}

async function claimPipelineStep(env: Env, run: JevPipelineRun) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(
    "UPDATE jev_pipeline_runs SET step_token=?,step_started_at=?,updated_at=? WHERE id=? AND phase!='complete' AND (phase!='dates' OR NOT EXISTS(SELECT 1 FROM processing_batch_lease WHERE id=1 AND expires>unixepoch()*1000)) AND (step_token IS NULL OR unixepoch(step_started_at)<unixepoch()-300) RETURNING *",
  )
    .bind(token, now, now, run.id)
    .first<JevPipelineRun>();
  return claimed ? { run: claimed, token } : null;
}

async function savePipelineStep(
  env: Env,
  run: JevPipelineRun,
  token: string,
  phase: JevPipelinePhase,
  cursor: string | null,
) {
  const saved = await env.DB.prepare(
    "UPDATE jev_pipeline_runs SET phase=?,cursor=?,step_token=NULL,step_started_at=NULL,updated_at=? WHERE id=? AND step_token=? RETURNING id",
  )
    .bind(phase, cursor, new Date().toISOString(), run.id, token)
    .first<{ id: string }>();
  requireThat(saved, 409, "Jev pipeline ownership changed.");
}

async function releasePipelineStep(
  env: Env,
  run: JevPipelineRun,
  token: string,
) {
  await env.DB.prepare(
    "UPDATE jev_pipeline_runs SET step_token=NULL,step_started_at=NULL,updated_at=? WHERE id=? AND step_token=?",
  )
    .bind(new Date().toISOString(), run.id, token)
    .run();
}

async function pipelineDocuments(
  env: Env,
  captures: Capture[],
  run: JevPipelineRun,
) {
  const allowed = new Set(
    captures
      .filter(
        (capture) => capture.is_current && withinPipelineSnapshot(capture, run),
      )
      .map((capture) => capture.id),
  );
  const order = new Map(
    captures
      .filter((capture) => allowed.has(capture.id))
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      )
      .map((capture, index) => [capture.id, index]),
  );
  const all = records(await storedDocuments(env), captures);
  const active = all
    .filter(
      (document) =>
        !document.mergedInto &&
        !document.duplicateOf &&
        document.pages.length > 0 &&
        document.pages.every((page) => allowed.has(page.captureId)),
    )
    .sort(
      (a, b) =>
        Math.min(
          ...a.pages.map((page) => order.get(page.captureId) ?? Infinity),
        ) -
        Math.min(
          ...b.pages.map((page) => order.get(page.captureId) ?? Infinity),
        ),
    );
  return { all, active };
}

function parsePipelineCursor<T>(run: JevPipelineRun): T | null {
  if (!run.cursor) return null;
  try {
    return JSON.parse(run.cursor) as T;
  } catch {
    throw new HttpError(503, "Stored Jev pipeline cursor is invalid.");
  }
}

export async function jevDocumentHeads(env: Env) {
  return (
    await env.DB.prepare(
      "SELECT * FROM jev_document_heads",
    ).all<JevDocumentHead>()
  ).results;
}

type AssessmentPayload = {
  input?: {
    pins?: { capture_id: string; ocr_sha256: string }[];
    category_ids?: Record<string, string>;
  };
  response?: JevResponse;
};

function parseAssessmentPayload(payload: string): AssessmentPayload | null {
  try {
    return JSON.parse(payload) as AssessmentPayload;
  } catch {
    return null;
  }
}

async function assessmentPayload(env: Env, id: string | null) {
  if (!id) return null;
  const row = await env.DB.prepare(
    "SELECT payload FROM jev_assessments WHERE id=?",
  )
    .bind(id)
    .first<{ payload: string }>();
  if (!row) return null;
  return parseAssessmentPayload(row.payload);
}

function documentHeadReadyFromEvidence(
  document: ReceiptDocument,
  head: JevDocumentHead | null,
  pages: PageHead[],
  artifactPins: Set<string>,
  assessments: Map<string, AssessmentPayload>,
  fingerprint: string,
) {
  if (
    !head ||
    head.page_fingerprint !== fingerprint ||
    pages.length !== document.pages.length
  )
    return false;
  const pins = document.pages.map((page, index) => ({
    capture_id: page.captureId,
    ocr_sha256: pages[index]?.ocr_sha256,
  }));
  if (
    document.pages.some((page, index) => {
      const item = pages[index];
      return (
        !item ||
        item.capture_id !== page.captureId ||
        item.source_sha256 !== page.sha256 ||
        !artifactPins.has(`${page.captureId}\u0000${item.ocr_sha256}`)
      );
    })
  )
    return false;
  const roleAssessment = assessments.get(head.assessment_id);
  const role = roleAssessment?.response?.answers?.document_role;
  if (
    JSON.stringify(roleAssessment?.input?.pins) !== JSON.stringify(pins) ||
    roleAssessment?.response?.model !== head.model
  )
    return false;
  try {
    validateChoice(role, documentRoles);
  } catch {
    return false;
  }
  if (
    role.choice !== head.role ||
    scaled(role.probabilities[role.choice]) !== head.role_probability ||
    scaled(role.confidence) !== head.role_confidence
  )
    return false;
  const receiptPresent = pages.some((page) => page.role === "receipt");
  if (!receiptPresent) return head.category_assessment_id === null;
  const categoryAssessment = head.category_assessment_id
    ? assessments.get(head.category_assessment_id)
    : null;
  const category = categoryAssessment?.response?.answers?.purchase_category;
  const categoryChoices = categoryAssessment?.input?.category_ids ?? {};
  const categoryId =
    category?.choice === "unresolved"
      ? null
      : (categoryChoices[category?.choice ?? ""] ?? null);
  return (
    JSON.stringify(categoryAssessment?.input?.pins) === JSON.stringify(pins) &&
    !!category &&
    categoryId === head.category_id &&
    scaled(category.probabilities?.[category.choice]) ===
      head.category_probability &&
    scaled(category.confidence) === head.category_confidence
  );
}

async function documentHeadReady(
  env: Env,
  document: ReceiptDocument,
  head: JevDocumentHead | null,
  pages: PageHead[],
  artifacts: { capture_id: string; sha256: string }[],
) {
  const assessments = new Map<string, AssessmentPayload>();
  if (head) {
    const role = await assessmentPayload(env, head.assessment_id);
    if (role) assessments.set(head.assessment_id, role);
    const category = await assessmentPayload(env, head.category_assessment_id);
    if (category && head.category_assessment_id)
      assessments.set(head.category_assessment_id, category);
  }
  return documentHeadReadyFromEvidence(
    document,
    head,
    pages,
    new Set(
      artifacts.map(
        (artifact) => `${artifact.capture_id}\u0000${artifact.sha256}`,
      ),
    ),
    assessments,
    await pageFingerprint(document),
  );
}

async function documentAssessmentPayloads(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT a.id,a.payload FROM jev_assessments a
     JOIN (
       SELECT assessment_id AS id FROM jev_document_heads
       UNION
       SELECT category_assessment_id AS id FROM jev_document_heads WHERE category_assessment_id IS NOT NULL
     ) referenced ON referenced.id=a.id`,
  ).all<{ id: string; payload: string }>();
  const result = new Map<string, AssessmentPayload>();
  for (const row of rows.results) {
    const payload = parseAssessmentPayload(row.payload);
    if (payload) result.set(row.id, payload);
  }
  return result;
}

export async function jevReadyDocuments(
  env: Env,
  documents: ReceiptDocument[],
  captures: Capture[] = [],
) {
  const [heads, artifactRows, pageRows, assessments] = await Promise.all([
    jevDocumentHeads(env),
    env.DB.prepare(
      "SELECT capture_id,sha256 FROM artifacts WHERE kind='ocr'",
    ).all<{ capture_id: string; sha256: string }>(),
    env.DB.prepare("SELECT * FROM jev_page_heads").all<PageHead>(),
    documentAssessmentPayloads(env),
  ]);
  const pageHeadRows = pageRows.results;
  const headsByDocument = new Map(
    heads.map((head) => [head.document_id, head]),
  );
  const pageHeadsByCapture = new Map(
    pageHeadRows.map((head) => [head.capture_id, head]),
  );
  const artifactPins = new Set(
    artifactRows.results.map(
      (artifact) => `${artifact.capture_id}\u0000${artifact.sha256}`,
    ),
  );
  const ready = new Map<string, JevDocumentHead>();
  for (const document of documents) {
    const head = headsByDocument.get(document.id) ?? null;
    const pages = document.pages
      .map((page) => pageHeadsByCapture.get(page.captureId))
      .filter((page): page is PageHead => !!page);
    if (
      head?.role === "purchase_document" &&
      documentHeadReadyFromEvidence(
        document,
        head,
        pages,
        artifactPins,
        assessments,
        await pageFingerprint(document),
      )
    )
      ready.set(document.id, head);
  }
  if (captures.length) {
    const completed = await env.DB.prepare(
      "SELECT snapshot_created_at,snapshot_capture_id FROM jev_pipeline_runs WHERE version=? AND phase='complete' ORDER BY created_at DESC,id DESC LIMIT 1",
    )
      .bind(JEV_PIPELINE_VERSION)
      .first<{
        snapshot_created_at: string;
        snapshot_capture_id: string;
      }>();
    const current = captures
      .filter((capture) => capture.is_current)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    const boundary = completed
      ? `${completed.snapshot_created_at}\u0000${completed.snapshot_capture_id}`
      : null;
    const newStart = boundary
      ? current.findIndex((capture) => captureOrder(capture) > boundary)
      : 0;
    if (newStart >= 0) {
      const headByCapture = new Map(
        pageHeadRows.map((head) => [head.capture_id, head]),
      );
      const missingIndex = current.findIndex((capture, index) => {
        if (index < newStart) return false;
        const head = headByCapture.get(capture.id);
        return !head || head.source_sha256 !== capture.sha256;
      });
      if (missingIndex > 0) {
        const precedingCaptureId = current[missingIndex - 1].id;
        const openTail = documents.find((document) =>
          document.pages.some((page) => page.captureId === precedingCaptureId),
        );
        if (openTail) ready.delete(openTail.id);
      }
    }
  }
  return ready;
}

export async function jevSummary(env: Env, document: ReceiptDocument) {
  const head =
    (await env.DB.prepare(
      "SELECT * FROM jev_document_heads WHERE document_id=?",
    )
      .bind(document.id)
      .first<JevDocumentHead>()) ?? null;
  const pages = await pageHeads(env, document);
  const artifacts = (
    await env.DB.prepare(
      "SELECT capture_id,sha256 FROM artifacts WHERE kind='ocr'",
    ).all<{ capture_id: string; sha256: string }>()
  ).results;
  const ready = await documentHeadReady(env, document, head, pages, artifacts);
  return {
    ready,
    document: head
      ? {
          role: head.role,
          probability: head.role_probability / 1_000_000,
          confidence: head.role_confidence / 1_000_000,
          category_id: head.category_id,
          category_probability: unscaled(head.category_probability),
          category_confidence: unscaled(head.category_confidence),
          model: head.model,
          assessment_id: head.assessment_id,
          category_assessment_id: head.category_assessment_id,
        }
      : null,
    pages: pages.map((page) => ({
      capture_id: page.capture_id,
      role: page.role,
      probability: unscaled(page.probability),
      confidence: unscaled(page.confidence),
      model: page.model,
      assessment_id: page.assessment_id,
    })),
  };
}

async function unqueuedArtifacts(
  env: Env,
  current: Capture[],
  run: JevPipelineRun,
) {
  const captureIds = new Set(
    current
      .filter((capture) => withinPipelineSnapshot(capture, run))
      .map((capture) => capture.id),
  );
  if (!captureIds.size) return [];
  const artifacts = (
    await env.DB.prepare(
      "SELECT artifact.capture_id,artifact.sha256 FROM artifacts artifact WHERE artifact.kind='ocr' AND NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.capture_id=artifact.capture_id AND newer.kind='ocr' AND (newer.created_at>artifact.created_at OR (newer.created_at=artifact.created_at AND newer.key>artifact.key))) AND NOT EXISTS (SELECT 1 FROM jev_jobs job WHERE job.capture_id=artifact.capture_id AND job.ocr_sha256=artifact.sha256) ORDER BY artifact.created_at,artifact.key",
    ).all<{ capture_id: string; sha256: string }>()
  ).results;
  return artifacts.filter((artifact) => captureIds.has(artifact.capture_id));
}

async function legacyPageCandidates(
  env: Env,
  current: Capture[],
  run: JevPipelineRun,
) {
  const allowed = new Set(
    current
      .filter((capture) => withinPipelineSnapshot(capture, run))
      .map((capture) => capture.id),
  );
  const rows = (
    await env.DB.prepare(
      "SELECT candidate.id,candidate.capture_id FROM jev_jobs candidate JOIN artifacts artifact ON artifact.capture_id=candidate.capture_id AND artifact.kind='ocr' AND artifact.sha256=candidate.ocr_sha256 JOIN captures capture ON capture.id=candidate.capture_id WHERE candidate.status='ineligible' AND candidate.eligibility_version<? AND NOT EXISTS (SELECT 1 FROM jev_jobs completed WHERE completed.capture_id=candidate.capture_id AND completed.status IN ('classified','complete')) AND NOT EXISTS (SELECT 1 FROM jev_jobs sibling JOIN artifacts sibling_artifact ON sibling_artifact.capture_id=sibling.capture_id AND sibling_artifact.kind='ocr' AND sibling_artifact.sha256=sibling.ocr_sha256 WHERE sibling.capture_id=candidate.capture_id AND sibling.status='ineligible' AND sibling.eligibility_version<? AND (sibling_artifact.created_at>artifact.created_at OR (sibling_artifact.created_at=artifact.created_at AND sibling_artifact.key>artifact.key))) ORDER BY capture.created_at,capture.id",
    )
      .bind(JEV_ELIGIBILITY_VERSION, JEV_ELIGIBILITY_VERSION)
      .all<{ id: string; capture_id: string }>()
  ).results;
  return rows.filter((row) => allowed.has(row.capture_id));
}

async function pagePipelineStep(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  current: Capture[],
  run: JevPipelineRun,
) {
  const allowed = new Set(
    current
      .filter((capture) => withinPipelineSnapshot(capture, run))
      .map((capture) => capture.id),
  );
  await env.DB.prepare(
    "UPDATE jev_jobs SET status='failed',attempts=CASE WHEN attempts>0 THEN attempts-1 ELSE 0 END,run_token=NULL,last_error='Interrupted Jev run; safe to retry.',updated_at=? WHERE status='running' AND unixepoch(updated_at)<unixepoch()-300",
  )
    .bind(new Date().toISOString())
    .run();
  await env.DB.prepare(
    "UPDATE jev_jobs SET status='failed',attempts=2,run_token=NULL,updated_at=? WHERE status='blocked' AND last_error='Interrupted Jev run; safe to retry.'",
  )
    .bind(new Date().toISOString())
    .run();
  await env.DB.prepare(
    "UPDATE jev_jobs SET status='blocked',run_token=NULL WHERE status='failed' AND attempts>=3",
  ).run();
  const retryable = (
    await env.DB.prepare(
      "SELECT id,capture_id FROM jev_jobs WHERE status='pending' OR (status='failed' AND attempts<3) ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,attempts,updated_at,created_at,id",
    ).all<{ id: string; capture_id: string }>()
  ).results.find((job) => allowed.has(job.capture_id));
  const running = (
    await env.DB.prepare(
      "SELECT capture_id FROM jev_jobs WHERE status='running'",
    ).all<{ capture_id: string }>()
  ).results.some((job) => allowed.has(job.capture_id));
  if (running) return { remaining: 1, busy: true, result: null };
  let jobId = retryable?.id ?? null;
  if (!jobId) {
    const legacy = (await legacyPageCandidates(env, current, run))[0];
    if (legacy) {
      const activated = await env.DB.prepare(
        "UPDATE jev_jobs SET status='pending',attempts=0,eligibility_version=?,ineligible_reason=NULL,run_token=NULL,last_error=NULL,association_progress=NULL,updated_at=? WHERE id=? AND status='ineligible' AND eligibility_version<? RETURNING id",
      )
        .bind(
          JEV_ELIGIBILITY_VERSION,
          new Date().toISOString(),
          legacy.id,
          JEV_ELIGIBILITY_VERSION,
        )
        .first<{ id: string }>();
      jobId = activated?.id ?? null;
    }
  }
  if (!jobId) {
    const candidate = (await unqueuedArtifacts(env, current, run))[0];
    if (candidate)
      jobId = await queueJevJob(env, candidate.capture_id, candidate.sha256);
  }
  if (!jobId) return { remaining: 0, busy: false, result: null };
  const result = await runJevJob(request, env, loadCaptures, jobId, true);
  return { remaining: 1, busy: false, result };
}

async function groupPipelineStep(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  captures: Capture[],
  run: JevPipelineRun,
) {
  const { all, active } = await pipelineDocuments(env, captures, run);
  if (!active.length)
    return { phase: "dates" as const, cursor: null, result: null };
  const saved = parsePipelineCursor<{
    active_id?: unknown;
    finalize_id?: unknown;
    next_id?: unknown;
    terminal?: unknown;
  }>(run);
  if (typeof saved?.finalize_id === "string") {
    const document = active.find((item) => item.id === saved.finalize_id);
    if (!document)
      return {
        phase: "group" as const,
        cursor: JSON.stringify({ active_id: active[0].id }),
        result: { status: "cursor-reset" },
      };
    if (!(await documentsAreUnlocked(env, [document])))
      return {
        phase: "group" as const,
        cursor: run.cursor,
        result: { status: "busy" },
        busy: true,
      };
    const result = await finalizePipelineDocument(env, document);
    if (saved.terminal === true)
      return { phase: "dates" as const, cursor: null, result };
    const nextId =
      typeof saved.next_id === "string" ? saved.next_id : active[0].id;
    return {
      phase: "group" as const,
      cursor: JSON.stringify({ active_id: nextId }),
      result,
    };
  }
  const activeId =
    typeof saved?.active_id === "string" ? saved.active_id : active[0].id;
  const original = all.find((document) => document.id === activeId);
  const resolvedId = original?.mergedInto ?? activeId;
  const index = active.findIndex((document) => document.id === resolvedId);
  if (index < 0)
    return {
      phase: "group" as const,
      cursor: JSON.stringify({ active_id: active[0].id }),
      result: { status: "cursor-reset" },
    };
  const current = active[index];
  const next = active[index + 1];
  if (!next) {
    const currentIds = new Set(current.pages.map((page) => page.captureId));
    const order = captures
      .filter((capture) => capture.is_current)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    const lastIndex = Math.max(
      ...current.pages.map((page) =>
        order.findIndex((capture) => capture.id === page.captureId),
      ),
    );
    const later = order
      .slice(lastIndex + 1)
      .find((capture) => !currentIds.has(capture.id));
    if (later) {
      if (!(await markDocumentsWaitingForOcr(env, active.slice(index))))
        return {
          phase: "group" as const,
          cursor: run.cursor,
          result: { status: "busy" },
          busy: true,
        };
      return {
        phase: "complete" as const,
        cursor: null,
        result: { status: "waiting-for-ocr" },
        waiting: true,
      };
    }
    return {
      phase: "group" as const,
      cursor: JSON.stringify({
        finalize_id: current.id,
        terminal: true,
      }),
      result: { status: "boundary" },
    };
  }
  const currentEvidence = await documentEvidence(env, current);
  const nextEvidence = await documentEvidence(env, next);
  if (!currentEvidence || !nextEvidence) {
    if (!(await markDocumentsWaitingForOcr(env, active.slice(index))))
      return {
        phase: "group" as const,
        cursor: run.cursor,
        result: { status: "busy" },
        busy: true,
      };
    return {
      phase: "complete" as const,
      cursor: null,
      result: { status: "waiting-for-ocr" },
      waiting: true,
    };
  }
  const relevant = (evidence: Awaited<ReturnType<typeof documentEvidence>>) =>
    evidence?.heads.some(
      (head) => head.role === "receipt" || head.role === "payment_evidence",
    ) ?? false;
  if (!relevant(currentEvidence) || !relevant(nextEvidence))
    return {
      phase: "group" as const,
      cursor: JSON.stringify({
        finalize_id: current.id,
        next_id: next.id,
      }),
      result: { status: "boundary" },
    };
  const decision = await compareDocuments(env, next, current, { remaining: 1 });
  if (decision && shouldAutoMerge(decision.answer)) {
    if (!(await documentsAreUnlocked(env, [current, next])))
      return {
        phase: "group" as const,
        cursor: run.cursor,
        result: { status: "busy" },
        busy: true,
      };
    const roles = new Map(
      (
        await env.DB.prepare("SELECT * FROM jev_page_heads").all<PageHead>()
      ).results.map((head) => [head.capture_id, head.role]),
    );
    let merged: ReceiptDocument | null;
    try {
      merged = await mergeDocuments(
        request,
        env,
        loadCaptures,
        next,
        current,
        decision.answer.choice as "continuation" | "payment_match",
        roles,
        all,
      );
    } catch (error) {
      if (error instanceof JevMutationBusy)
        return {
          phase: "group" as const,
          cursor: run.cursor,
          result: { status: "busy" },
          busy: true,
        };
      throw error;
    }
    if (merged)
      return {
        phase: "group" as const,
        cursor: JSON.stringify({ active_id: merged.id }),
        result: { status: "merged" },
      };
  }
  return {
    phase: "group" as const,
    cursor: JSON.stringify({
      finalize_id: current.id,
      next_id: next.id,
    }),
    result: { status: "boundary" },
  };
}

async function markDocumentsWaitingForOcr(
  env: Env,
  documents: ReceiptDocument[],
) {
  const captureIds = [
    ...new Set(
      documents.flatMap((document) =>
        document.pages.map((page) => page.captureId),
      ),
    ),
  ];
  if (!captureIds.length) return true;
  if (!(await documentsAreUnlocked(env, documents))) return false;
  const now = new Date().toISOString();
  for (let index = 0; index < captureIds.length; index += 99) {
    const chunk = captureIds.slice(index, index + 99);
    await env.DB.prepare(
      `UPDATE jev_jobs
       SET status='waiting',updated_at=?
       WHERE status IN ('classified','complete')
         AND capture_id IN (${chunk.map(() => "?").join(",")})
         AND EXISTS (
           SELECT 1
           FROM jev_page_heads head
           WHERE head.capture_id=jev_jobs.capture_id
             AND head.ocr_sha256=jev_jobs.ocr_sha256
         )`,
    )
      .bind(now, ...chunk)
      .run();
  }
  const documentIds = documents.map((document) => document.id);
  for (let index = 0; index < documentIds.length; index += 100) {
    const chunk = documentIds.slice(index, index + 100);
    await env.DB.prepare(
      `DELETE FROM jev_document_heads WHERE document_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .run();
  }
  return true;
}

async function finalizePipelineDocument(env: Env, document: ReceiptDocument) {
  const evidence = await documentEvidence(env, document);
  if (!evidence) {
    for (const page of document.pages)
      await env.DB.prepare(
        "UPDATE jev_jobs SET status='ineligible',ineligible_reason='document_evidence_incomplete',updated_at=? WHERE capture_id=? AND status IN ('classified','waiting')",
      )
        .bind(new Date().toISOString(), page.captureId)
        .run();
    return {
      status: "ineligible",
      document_id: document.id,
      reason: "document_evidence_incomplete",
    };
  }
  const head =
    (await env.DB.prepare(
      "SELECT * FROM jev_document_heads WHERE document_id=?",
    )
      .bind(document.id)
      .first<JevDocumentHead>()) ?? null;
  const assessment = head
    ? await env.DB.prepare("SELECT task FROM jev_assessments WHERE id=?")
        .bind(head.assessment_id)
        .first<{ task: string }>()
    : null;
  const artifacts = (
    await env.DB.prepare(
      "SELECT capture_id,sha256 FROM artifacts WHERE kind='ocr'",
    ).all<{ capture_id: string; sha256: string }>()
  ).results;
  const alreadyCurrent =
    head?.page_fingerprint === (await pageFingerprint(document)) &&
    assessment?.task === "document-classification" &&
    (await documentHeadReady(env, document, head, evidence.heads, artifacts));
  if (!alreadyCurrent) {
    const classification = await classifyDocument(env, document, {
      remaining: 1,
    });
    requireThat(
      classification,
      503,
      "Final Jev document evidence is unavailable.",
    );
  }
  for (const page of document.pages)
    await env.DB.prepare(
      "UPDATE jev_jobs SET status='complete',ineligible_reason=NULL,updated_at=? WHERE capture_id=? AND status IN ('classified','waiting')",
    )
      .bind(new Date().toISOString(), page.captureId)
      .run();
  return {
    status: alreadyCurrent ? "verified" : "classified",
    document_id: document.id,
  };
}

async function documentPipelineStep(
  env: Env,
  captures: Capture[],
  run: JevPipelineRun,
) {
  const { active } = await pipelineDocuments(env, captures, run);
  const activeCaptureIds = new Set(
    active.flatMap((document) => document.pages.map((page) => page.captureId)),
  );
  const currentCaptures = new Map(
    captures
      .filter((capture) => capture.is_current)
      .map((capture) => [capture.id, capture]),
  );
  const stranded = (
    await env.DB.prepare(
      "SELECT capture_id FROM jev_jobs WHERE status='classified' ORDER BY updated_at,created_at,id",
    ).all<{ capture_id: string }>()
  ).results.find((job) => {
    const capture = currentCaptures.get(job.capture_id);
    return (
      !capture ||
      (withinPipelineSnapshot(capture, run) &&
        !activeCaptureIds.has(job.capture_id))
    );
  });
  if (stranded) {
    const reason = currentCaptures.has(stranded.capture_id)
      ? "document_not_active"
      : "capture_not_current";
    await env.DB.prepare(
      "UPDATE jev_jobs SET status='ineligible',ineligible_reason=?,updated_at=? WHERE capture_id=? AND status='classified'",
    )
      .bind(reason, new Date().toISOString(), stranded.capture_id)
      .run();
    return {
      remaining: 1,
      cursor: run.cursor,
      result: { status: "ineligible", reason },
    };
  }
  const saved = parsePipelineCursor<{ after_id?: unknown }>(run);
  const afterId = typeof saved?.after_id === "string" ? saved.after_id : null;
  const previousIndex = afterId
    ? active.findIndex((document) => document.id === afterId)
    : -1;
  const document =
    active[(afterId && previousIndex < 0 ? -1 : previousIndex) + 1];
  if (!document) return { remaining: 0, cursor: null, result: null };
  if (!(await documentsAreUnlocked(env, [document])))
    return {
      remaining: 1,
      cursor: run.cursor,
      result: null,
      busy: true,
    };
  const cursor = JSON.stringify({ after_id: document.id });
  const result = await finalizePipelineDocument(env, document);
  return {
    remaining: 1,
    cursor,
    result,
  };
}

async function reconcileDetachedPayments(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  after: string | null,
  pipelineRun: JevPipelineRun,
) {
  const captures = await loadCaptures();
  const capturesById = new Map(
    captures.map((capture) => [capture.id, capture]),
  );
  const allDocuments = records(await storedDocuments(env), captures);
  const documents = allDocuments.filter(
    (document) =>
      !document.mergedInto &&
      !document.duplicateOf &&
      document.pages.every((page) => {
        const capture = capturesById.get(page.captureId);
        return (
          !!capture &&
          capture.is_current &&
          withinPipelineSnapshot(capture, pipelineRun)
        );
      }),
  );
  const activePages = new Map(
    documents.flatMap((document) =>
      document.pages.map((page) => [page.captureId, page] as const),
    ),
  );
  const unindexed = (
    await env.DB.prepare(
      "SELECT * FROM jev_page_heads WHERE date_candidates IS NULL ORDER BY updated_at,capture_id LIMIT 25",
    ).all<PageHead>()
  ).results;
  if (unindexed.length) {
    for (const head of unindexed) {
      const page = activePages.get(head.capture_id);
      let dates: string[] = [];
      if (page && head.source_sha256 === page.sha256) {
        const found = await pinnedPpOcr(env, page, head.ocr_sha256);
        requireThat(
          found,
          503,
          "Pinned PP OCR is unavailable for detached-payment ranking.",
        );
        dates = ocrDateCandidates(found.value.text);
      }
      await env.DB.prepare(
        "UPDATE jev_page_heads SET date_candidates=? WHERE capture_id=? AND date_candidates IS NULL",
      )
        .bind(JSON.stringify(dates), head.capture_id)
        .run();
    }
    return {
      result: { status: "indexed", pages: unindexed.length },
      remaining: 1,
      next: null,
    };
  }
  const pageHeadRows = (
    await env.DB.prepare("SELECT * FROM jev_page_heads").all<PageHead>()
  ).results;
  const pageHeadsByCapture = new Map(
    pageHeadRows.map((row) => [row.capture_id, row]),
  );
  const roles = new Map(pageHeadRows.map((row) => [row.capture_id, row.role]));
  type RankedDocument = { document: ReceiptDocument; dates: Set<string> };
  const purchases: RankedDocument[] = [];
  const payments: RankedDocument[] = [];
  for (const document of documents) {
    const heads = document.pages.map((page) =>
      pageHeadsByCapture.get(page.captureId),
    );
    if (
      heads.some(
        (head, index) =>
          !head || head.source_sha256 !== document.pages[index].sha256,
      )
    )
      continue;
    const hasReceipt = heads.some((head) => head!.role === "receipt");
    const hasPayment = heads.some((head) => head!.role === "payment_evidence");
    const dates = new Set<string>();
    for (const head of heads) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(head!.date_candidates ?? "[]");
      } catch {
        throw new HttpError(503, "Stored Jev date candidates are invalid.");
      }
      requireThat(
        Array.isArray(parsed) &&
          parsed.every(
            (date) =>
              typeof date === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(date),
          ),
        503,
        "Stored Jev date candidates are invalid.",
      );
      parsed.forEach((date) => dates.add(date));
    }
    if (hasReceipt && !hasPayment) purchases.push({ document, dates });
    if (hasPayment && !hasReceipt) payments.push({ document, dates });
  }
  purchases.sort((a, b) => a.document.id.localeCompare(b.document.id));
  payments.sort((a, b) => a.document.id.localeCompare(b.document.id));
  const budget: JevBudget = { remaining: 1 };
  let cursor = after;
  try {
    for (const dateRank of [0, 1, 2] as const) {
      for (const payment of payments) {
        for (const purchase of purchases) {
          const sharedDate = [...purchase.dates].some((date) =>
            payment.dates.has(date),
          );
          const pairRank = sharedDate
            ? 0
            : purchase.dates.size === 0 || payment.dates.size === 0
              ? 1
              : 2;
          if (pairRank !== dateRank) continue;
          const key = `${dateRank}|${payment.document.id}|${purchase.document.id}`;
          if (after !== null && key <= after) continue;
          const decision = await compareDocuments(
            env,
            purchase.document,
            payment.document,
            budget,
          );
          if (
            decision?.answer.choice !== "payment_match" ||
            !shouldAutoMerge(decision.answer)
          ) {
            cursor = key;
            continue;
          }
          if (
            !(await documentsAreUnlocked(env, [
              purchase.document,
              payment.document,
            ]))
          )
            return { result: null, remaining: 1, busy: true, next: cursor };
          let merged: ReceiptDocument | null;
          try {
            merged = await mergeDocuments(
              request,
              env,
              loadCaptures,
              purchase.document,
              payment.document,
              "payment_match",
              roles,
              allDocuments,
            );
          } catch (error) {
            if (error instanceof JevMutationBusy)
              return { result: null, remaining: 1, busy: true, next: cursor };
            throw error;
          }
          if (!merged) {
            cursor = key;
            continue;
          }
          return {
            result: { status: "merged", document_id: merged.id },
            remaining: 1,
            next: null,
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof JevCheckpoint)
      return { result: null, remaining: 1, next: cursor };
    throw error;
  }
  return { result: null, remaining: 0, next: null };
}

export async function jevRoute(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/jev/")) return null;
  requireThat(
    request.headers.has("authorization"),
    403,
    "Jev processing requires scoped machine credentials.",
  );
  if (url.pathname === "/api/jev/status" && request.method === "GET") {
    const counts = await env.DB.prepare(
      "SELECT status,COUNT(*) AS count FROM jev_jobs GROUP BY status",
    ).all<{ status: string; count: number }>();
    const ineligibleReasons = await env.DB.prepare(
      "SELECT COALESCE(ineligible_reason,'unspecified') AS reason,COUNT(*) AS count FROM jev_jobs WHERE status='ineligible' GROUP BY COALESCE(ineligible_reason,'unspecified') ORDER BY reason",
    ).all<{ reason: string; count: number }>();
    const pipeline = await latestPipelineRun(env);
    const waitingCurrentCaptures = await currentWaitingCaptureCount(
      env,
      await loadCaptures(),
    );
    return json({
      configured: Boolean(env.TYPESAFE_API_KEY),
      jobs: counts.results,
      ineligible_reasons: ineligibleReasons.results,
      waiting_current_captures: waitingCurrentCaptures,
      pipeline: pipeline
        ? {
            version: pipeline.version,
            phase: pipeline.phase,
            snapshot_created_at: pipeline.snapshot_created_at,
            busy: pipeline.step_token !== null,
            updated_at: pipeline.updated_at,
          }
        : null,
    });
  }
  if (url.pathname === "/api/jev/documents" && request.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "25");
    requireThat(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      400,
      "Jev document limit must be an integer from 1 to 100.",
    );
    const after = url.searchParams.get("after");
    requireThat(
      after === null || (after.length > 0 && after.length <= 128),
      400,
      "Invalid Jev document cursor.",
    );
    const captures = await loadCaptures();
    const candidates = records(await storedDocuments(env), captures)
      .filter((document) => !document.mergedInto && !document.duplicateOf)
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((document) => after === null || document.id > after)
      .slice(0, limit + 1);
    const documents = candidates.slice(0, limit);
    const categories = (
      await env.DB.prepare("SELECT id,name FROM purchase_categories").all<{
        id: string;
        name: string;
      }>()
    ).results;
    const categoryName = (id: string | null | undefined) =>
      id ? (categories.find((item) => item.id === id)?.name ?? null) : null;
    const results = [];
    for (const document of documents) {
      const summary = await jevSummary(env, document);
      if (!summary.document) continue;
      const luna = document.processing?.extraction ?? null;
      const disagreements: string[] = [];
      if (luna) {
        const lunaPurchase = ["receipt", "invoice", "credit-note"].includes(
          luna.type,
        );
        if ((summary.document.role === "purchase_document") !== lunaPurchase)
          disagreements.push("document_role");
        if (
          summary.document.category_id !== null &&
          summary.document.category_id !== luna.category_id
        )
          disagreements.push("purchase_category");
      }
      if (
        url.searchParams.get("disagreements") === "1" &&
        !disagreements.length
      )
        continue;
      results.push({
        document_id: document.id,
        revision: document.revision,
        ready: summary.ready,
        disagreements,
        jev: {
          ...summary.document,
          category_name: categoryName(summary.document.category_id),
        },
        luna: luna
          ? {
              type: luna.type,
              category_id: luna.category_id,
              category_name: categoryName(luna.category_id),
              certainty: luna.certainty,
            }
          : null,
      });
    }
    return json({
      documents: results,
      next: candidates.length > limit ? documents.at(-1)!.id : null,
    });
  }
  if (url.pathname === "/api/jev/backfill" && request.method === "POST") {
    const blocked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jev_jobs WHERE status='blocked'",
    ).first<{ count: number }>();
    const captures = await loadCaptures();
    const current = captures
      .filter((capture) => capture.is_current)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    let run = await activePipelineRun(env);
    if (!run) {
      const latest = await latestPipelineRun(env);
      const boundary = current.at(-1);
      if (boundary) {
        const probe: JevPipelineRun = {
          ...(latest ?? {
            id: "probe",
            version: JEV_PIPELINE_VERSION,
            phase: "pages" as const,
            cursor: null,
            step_token: null,
            step_started_at: null,
            created_at: boundary.created_at,
            updated_at: boundary.created_at,
          }),
          snapshot_created_at: boundary.created_at,
          snapshot_capture_id: boundary.id,
        };
        const candidate = (await unqueuedArtifacts(env, current, probe))[0];
        if (candidate)
          await queueJevJob(env, candidate.capture_id, candidate.sha256);
      }
      if (!(await pipelineNeedsRun(env, current, latest)))
        return json({
          result: null,
          phase: "complete",
          remaining: 0,
          busy: false,
          waiting: (await currentWaitingCaptureCount(env, captures)) > 0,
          blocked: blocked?.count ?? 0,
        });
      run = await startPipelineRun(env, current);
      if (!run)
        return json({
          result: null,
          phase: "complete",
          remaining: 0,
          busy: false,
          waiting: (await currentWaitingCaptureCount(env, captures)) > 0,
          blocked: blocked?.count ?? 0,
        });
    }
    const claim = await claimPipelineStep(env, run);
    if (!claim)
      return json({
        result: null,
        phase: run.phase,
        remaining: 1,
        busy: true,
        blocked: blocked?.count ?? 0,
      });
    run = claim.run;
    const token = claim.token;
    let saved = false;
    try {
      if (run.phase === "pages") {
        const step = await pagePipelineStep(
          request,
          env,
          loadCaptures,
          current,
          run,
        );
        const phase = step.remaining === 0 ? "group" : "pages";
        await savePipelineStep(env, run, token, phase, null);
        saved = true;
        return json({
          result: step.result,
          phase,
          remaining: 1,
          busy: step.busy,
          blocked: blocked?.count ?? 0,
        });
      }
      if (run.phase === "group") {
        const step = await groupPipelineStep(
          request,
          env,
          loadCaptures,
          captures,
          run,
        );
        await savePipelineStep(env, run, token, step.phase, step.cursor);
        saved = true;
        return json({
          result: step.result,
          phase: step.phase,
          remaining: step.phase === "complete" ? 0 : 1,
          busy: step.busy ?? false,
          waiting: "waiting" in step && step.waiting === true,
          blocked: blocked?.count ?? 0,
        });
      }
      if (run.phase === "dates") {
        const cursor = parsePipelineCursor<{ after?: unknown }>(run);
        const after = typeof cursor?.after === "string" ? cursor.after : null;
        const step = await reconcileDetachedPayments(
          request,
          env,
          loadCaptures,
          after,
          run,
        );
        const phase = step.remaining === 0 ? "documents" : "dates";
        const next =
          phase === "dates" ? JSON.stringify({ after: step.next }) : null;
        await savePipelineStep(env, run, token, phase, next);
        saved = true;
        return json({
          ...step,
          phase,
          remaining: 1,
          blocked: blocked?.count ?? 0,
        });
      }
      if (run.phase === "documents") {
        const step = await documentPipelineStep(env, captures, run);
        const phase = step.remaining === 0 ? "complete" : "documents";
        await savePipelineStep(env, run, token, phase, step.cursor);
        saved = true;
        if (
          phase === "complete" &&
          (await pipelineNeedsRun(env, current, run))
        ) {
          const next = await startPipelineRun(env, current);
          if (next)
            return json({
              result: step.result,
              phase: next.phase,
              remaining: 1,
              busy: false,
              blocked: blocked?.count ?? 0,
            });
        }
        return json({
          result: step.result,
          phase,
          remaining: step.remaining,
          busy: "busy" in step && step.busy === true,
          blocked: blocked?.count ?? 0,
        });
      }
      await savePipelineStep(env, run, token, "complete", null);
      saved = true;
      return json({
        result: null,
        phase: "complete",
        remaining: 0,
        busy: false,
        blocked: blocked?.count ?? 0,
      });
    } finally {
      if (!saved) await releasePipelineStep(env, run, token);
    }
  }
  throw new HttpError(404, "Jev route not found.");
}
