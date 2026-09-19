import type { Env } from "./index";
import type { Capture } from "../web/types";
import {
  newDocument,
  requiredMergeReviewReasons,
  retargetAbsorbedAliases,
  type ReceiptDocument,
} from "../web/documents";
import { ocrArtifactMatchesPage, type OcrArtifact } from "../web/ocr-data";
import { documentRoute, storedDocuments } from "./documents";
import { HttpError, json, requireThat } from "./http";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
const MAX_JEV_TEXT = 24_000;
const AUTO_MATCH_PROBABILITY = 0.9;
const AUTO_MATCH_CONFIDENCE = 0.75;

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
type PageHead = {
  capture_id: string;
  source_sha256: string;
  ocr_sha256: string;
  role: PageRole;
  probability: number;
  confidence: number;
  model: string;
  assessment_id: string;
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
): Promise<JevResponse> {
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

async function latestPpOcr(
  env: Env,
  page: ReceiptDocument["pages"][number],
): Promise<{ sha256: string; value: OcrArtifact } | null> {
  const rows = await env.DB.prepare(
    "SELECT key,sha256 FROM artifacts WHERE capture_id=? AND kind='ocr' ORDER BY created_at DESC,key DESC",
  )
    .bind(page.captureId)
    .all<{ key: string; sha256: string }>();
  for (const row of rows.results) {
    const object = await env.BUCKET.get(row.key);
    if (!object) continue;
    const value = await object.json<OcrArtifact>();
    if (
      value?.provenance?.engine === "PP-OCRv6" &&
      value.source?.captureId === page.captureId &&
      value.source?.sha256 === page.sha256 &&
      ocrArtifactMatchesPage(value, page) &&
      typeof value.text === "string"
    )
      return { sha256: row.sha256, value };
  }
  return null;
}

async function documentOcr(env: Env, document: ReceiptDocument) {
  const pins: { capture_id: string; ocr_sha256: string; text: string }[] = [];
  for (const page of document.pages) {
    const found = await latestPpOcr(env, page);
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
      );
    },
    (result) => validateChoice(result.answers.page_role, pageRoles),
  );
  const result = saved.result;
  const answer = result.answers.page_role;
  validateChoice(answer, pageRoles);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO jev_page_heads(capture_id,source_sha256,ocr_sha256,role,probability,confidence,model,assessment_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_id) DO UPDATE SET source_sha256=excluded.source_sha256,ocr_sha256=excluded.ocr_sha256,role=excluded.role,probability=excluded.probability,confidence=excluded.confidence,model=excluded.model,assessment_id=excluded.assessment_id,updated_at=excluded.updated_at",
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

async function documentEvidence(env: Env, document: ReceiptDocument) {
  const ocr = await documentOcr(env, document);
  const heads = await pageHeads(env, document);
  if (
    !ocr ||
    heads.length !== document.pages.length ||
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
    { id: current.id, revision: current.revision },
    { id: candidate.id, revision: candidate.revision },
    () =>
      callJev(env, input, {
        relationship: {
          type: "choice",
          instructions:
            "Classify the relationship between these two scanned documents.",
          criteria: {
            continuation:
              "They are different pages or sections of the same receipt or financial document, excluding separate payment evidence.",
            payment_match:
              "One is purchase documentation and the other is payment evidence for that same transaction.",
            unrelated:
              "They do not belong to the same transaction or document.",
          },
        },
      }),
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
  return { answer, assessment_id: saved.id, model: result.model };
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
  const response = await documentRoute(
    new Request(new URL("/api/documents", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents }),
    }),
    env,
    loadCaptures,
    { statements: [], trustedProcessing: true },
  );
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
  const active = await env.DB.prepare(
    `SELECT document_id FROM processing_lock WHERE id=1 AND expires>unixepoch()*1000 AND document_id IN (${documents.map(() => "?").join(",")})`,
  )
    .bind(...documents.map((document) => document.id))
    .first<{ document_id: string }>();
  return !active;
}

async function classifyDocument(env: Env, document: ReceiptDocument) {
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
  const roleQuestions: Parameters<typeof callJev>[2] = {
    document_role: {
      type: "choice",
      instructions: "Classify this document.",
      criteria: roleCriteria,
    },
  };
  const roleInput = { ocr_text: ocr.text };
  const roleSaved = await assess(
    env,
    "document-role",
    { state: roleInput, pins: ocr.pins, criteria: roleCriteria },
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
      return callJev(env, roleInput, roleQuestions);
    },
    (result) => validateChoice(result.answers.document_role, documentRoles),
  );
  const roleResult = roleSaved.result;
  const role = roleResult.answers.document_role;
  validateChoice(role, documentRoles);
  let category: ChoiceAnswer | null = null;
  let categoryAssessmentId: string | null = null;
  if (!ocr.blank && heads.some((head) => head.role === "receipt")) {
    const categoryInput = { ocr_text: ocr.text };
    const categorySaved = await assess(
      env,
      "purchase-category",
      {
        state: categoryInput,
        pins: ocr.pins,
        criteria: categoryChoices.criteria,
        category_ids: Object.fromEntries(categoryChoices.ids),
      },
      { id: document.id, revision: document.revision },
      null,
      () =>
        callJev(env, categoryInput, {
          purchase_category: {
            type: "choice",
            instructions:
              "Classify this receipt using the category definitions.",
            criteria: categoryChoices.criteria,
          },
        }),
      (result) =>
        validateChoice(
          result.answers.purchase_category,
          Object.keys(categoryChoices.criteria),
        ),
    );
    const categoryResult = categorySaved.result;
    category = categoryResult.answers.purchase_category;
    validateChoice(category, Object.keys(categoryChoices.criteria));
    categoryAssessmentId = categorySaved.id;
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

async function tryAssociations(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  captureId: string,
) {
  const captures = await loadCaptures();
  let current = await currentDocument(env, captures, captureId);
  if (!current) return null;
  const ordered = captures
    .filter((capture) => capture.is_current)
    .sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
  const roles = new Map(
    (
      await env.DB.prepare("SELECT capture_id,role FROM jev_page_heads").all<{
        capture_id: string;
        role: PageRole;
      }>()
    ).results.map((row) => [row.capture_id, row.role]),
  );
  const allDocuments = records(await storedDocuments(env), captures);
  const docs = allDocuments.filter(
    (document) => !document.mergedInto && !document.duplicateOf,
  );
  const currentEvidence = await documentEvidence(env, current);
  if (
    !currentEvidence ||
    !currentEvidence.heads.some(
      (head) => head.role === "receipt" || head.role === "payment_evidence",
    )
  )
    return current;
  const currentHeads = currentEvidence.heads;
  const firstIndex = Math.min(
    ...current.pages.map((page) =>
      ordered.findIndex((capture) => capture.id === page.captureId),
    ),
  );
  const previousCapture = [...ordered.slice(0, firstIndex)]
    .reverse()
    .find(
      (capture) =>
        !current!.pages.some((page) => page.captureId === capture.id),
    );
  const previous = previousCapture
    ? docs.find((document) =>
        document.pages.some((page) => page.captureId === previousCapture.id),
      )
    : null;
  if (previous && previous.id !== current.id) {
    const decision = await compareDocuments(env, current, previous);
    if (
      decision &&
      shouldAutoMerge(decision.answer) &&
      (await documentsAreUnlocked(env, [current, previous]))
    ) {
      const merged = await mergeDocuments(
        request,
        env,
        loadCaptures,
        current,
        previous,
        decision.answer.choice as "continuation" | "payment_match",
        roles,
        allDocuments,
      );
      if (merged) return merged;
    }
  }

  const hasReceipt = currentHeads.some((head) => head.role === "receipt");
  const hasPayment = currentHeads.some(
    (head) => head.role === "payment_evidence",
  );
  if (hasReceipt === hasPayment) return current;
  const currentLast = Math.max(
    ...current.pages.map((page) =>
      ordered.findIndex((capture) => capture.id === page.captureId),
    ),
  );
  const candidates: ReceiptDocument[] = [];
  for (const document of docs) {
    if (document.id === current.id) continue;
    const indexes = document.pages.map((page) =>
      ordered.findIndex((capture) => capture.id === page.captureId),
    );
    if (Math.max(...indexes) >= currentLast) continue;
    const evidence = await documentEvidence(env, document);
    if (!evidence) continue;
    const heads = evidence.heads;
    const candidateHasReceipt = heads.some((head) => head.role === "receipt");
    const candidateHasPayment = heads.some(
      (head) => head.role === "payment_evidence",
    );
    if (
      (hasReceipt &&
        !hasPayment &&
        candidateHasPayment &&
        !candidateHasReceipt) ||
      (hasPayment && !hasReceipt && candidateHasReceipt && !candidateHasPayment)
    )
      candidates.push(document);
  }
  candidates.sort((a, b) => {
    const latest = (document: ReceiptDocument) =>
      Math.max(
        ...document.pages.map((page) =>
          ordered.findIndex((capture) => capture.id === page.captureId),
        ),
      );
    return latest(b) - latest(a);
  });
  for (const candidate of candidates.slice(0, 50)) {
    const decision = await compareDocuments(env, current, candidate);
    if (
      decision?.answer.choice === "payment_match" &&
      shouldAutoMerge(decision.answer) &&
      (await documentsAreUnlocked(env, [current, candidate]))
    ) {
      const merged = await mergeDocuments(
        request,
        env,
        loadCaptures,
        current,
        candidate,
        "payment_match",
        roles,
        allDocuments,
      );
      if (merged) {
        current = merged;
        break;
      }
    }
  }
  return current;
}

export async function queueJevJob(
  env: Env,
  captureId: string,
  ocrSha256: string,
) {
  const id = await sha256({ captureId, ocrSha256 });
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO jev_jobs(id,capture_id,ocr_sha256,status,attempts,last_error,created_at,updated_at) VALUES(?,?,?,'pending',0,NULL,?,?)",
  )
    .bind(id, captureId, ocrSha256, now, now)
    .run();
  return id;
}

async function processJob(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  job: { id: string; capture_id: string; ocr_sha256: string },
) {
  const captures = await loadCaptures();
  const capture = captures.find((item) => item.id === job.capture_id);
  if (!capture?.is_current) return { eligible: false };
  const artifact = await env.DB.prepare(
    "SELECT key FROM artifacts WHERE capture_id=? AND kind='ocr' AND sha256=?",
  )
    .bind(job.capture_id, job.ocr_sha256)
    .first<{ key: string }>();
  if (!artifact) return { eligible: false };
  const object = await env.BUCKET.get(artifact.key);
  requireThat(object, 503, "OCR artifact is unavailable.");
  const value = await object.json<OcrArtifact>();
  if (value?.provenance?.engine !== "PP-OCRv6") return { eligible: false };
  if (
    value.source?.captureId !== capture.id ||
    value.source?.sha256 !== capture.sha256
  )
    return { eligible: false };
  const initialDocument = await currentDocument(env, captures, capture.id);
  const page = initialDocument?.pages.find(
    (item) => item.captureId === capture.id,
  );
  if (!page || !ocrArtifactMatchesPage(value, page)) return { eligible: false };
  await classifyPage(env, capture, job.ocr_sha256, value);
  const document = await tryAssociations(
    request,
    env,
    loadCaptures,
    capture.id,
  );
  if (!document) return { eligible: false };
  const classification = await classifyDocument(env, document);
  return {
    eligible: true,
    document: classification,
    awaiting_document: classification === null,
  };
}

export async function runJevJob(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  id: string,
) {
  type Job = {
    id: string;
    capture_id: string;
    ocr_sha256: string;
    status: string;
    attempts: number;
  };
  const runToken = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = await env.DB.prepare(
    "UPDATE jev_jobs SET status='running',attempts=attempts+1,run_token=?,last_error=NULL,updated_at=? WHERE id=? AND (status='pending' OR (status='failed' AND attempts<3)) RETURNING id,capture_id,ocr_sha256,status,attempts",
  )
    .bind(runToken, now, id)
    .first<Job>();
  if (!job) {
    const current = await env.DB.prepare(
      "SELECT id,capture_id,ocr_sha256,status,attempts FROM jev_jobs WHERE id=?",
    )
      .bind(id)
      .first<Job>();
    requireThat(current, 404, "Jev job not found.");
    return { id, status: current.status };
  }
  try {
    const result = await processJob(request, env, loadCaptures, job);
    const status = result.eligible ? "complete" : "ineligible";
    const saved = await env.DB.prepare(
      "UPDATE jev_jobs SET status=?,run_token=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='running' AND run_token=? RETURNING status",
    )
      .bind(status, new Date().toISOString(), id, runToken)
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

export async function jevDocumentHeads(env: Env) {
  return (
    await env.DB.prepare(
      "SELECT * FROM jev_document_heads",
    ).all<JevDocumentHead>()
  ).results;
}

async function assessmentPayload(env: Env, id: string | null) {
  if (!id) return null;
  const row = await env.DB.prepare(
    "SELECT payload FROM jev_assessments WHERE id=?",
  )
    .bind(id)
    .first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as {
      input?: {
        pins?: { capture_id: string; ocr_sha256: string }[];
        category_ids?: Record<string, string>;
      };
      response?: JevResponse;
    };
  } catch {
    return null;
  }
}

async function documentHeadReady(
  env: Env,
  document: ReceiptDocument,
  head: JevDocumentHead | null,
  pages: PageHead[],
  artifacts: { capture_id: string; sha256: string }[],
) {
  if (
    !head ||
    head.page_fingerprint !== (await pageFingerprint(document)) ||
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
        !artifacts.some(
          (artifact) =>
            artifact.capture_id === page.captureId &&
            artifact.sha256 === item.ocr_sha256,
        )
      );
    })
  )
    return false;
  const roleAssessment = await assessmentPayload(env, head.assessment_id);
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
  const categoryAssessment = await assessmentPayload(
    env,
    head.category_assessment_id,
  );
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

export async function jevReadyDocuments(
  env: Env,
  documents: ReceiptDocument[],
) {
  const heads = await jevDocumentHeads(env);
  const artifacts = (
    await env.DB.prepare(
      "SELECT capture_id,sha256 FROM artifacts WHERE kind='ocr'",
    ).all<{ capture_id: string; sha256: string }>()
  ).results;
  const ready = new Map<string, JevDocumentHead>();
  for (const document of documents) {
    const head = heads.find((item) => item.document_id === document.id) ?? null;
    const pages = await pageHeads(env, document);
    if (
      head?.role === "purchase_document" &&
      (await documentHeadReady(env, document, head, pages, artifacts))
    )
      ready.set(document.id, head);
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
    return json({
      configured: Boolean(env.TYPESAFE_API_KEY),
      jobs: counts.results,
    });
  }
  if (url.pathname === "/api/jev/documents" && request.method === "GET") {
    const captures = await loadCaptures();
    const documents = records(await storedDocuments(env), captures).filter(
      (document) => !document.mergedInto && !document.duplicateOf,
    );
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
    return json({ documents: results });
  }
  if (url.pathname === "/api/jev/backfill" && request.method === "POST") {
    const captures = await loadCaptures();
    const current = captures
      .filter((capture) => capture.is_current)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    await env.DB.prepare(
      "UPDATE jev_jobs SET status='failed',run_token=NULL,last_error='Interrupted Jev run; safe to retry.',updated_at=? WHERE status='running' AND unixepoch(updated_at)<unixepoch()-300",
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.prepare(
      "UPDATE jev_jobs SET status='blocked',run_token=NULL WHERE status='failed' AND attempts>=3",
    ).run();
    let job = await env.DB.prepare(
      "SELECT id FROM jev_jobs WHERE status='pending' OR (status='failed' AND attempts<3) ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,attempts,updated_at,created_at,id LIMIT 1",
    ).first<{ id: string }>();
    const running = await env.DB.prepare(
      "SELECT 1 AS present FROM jev_jobs WHERE status='running' LIMIT 1",
    ).first<{ present: number }>();
    const backfillCandidates = async () => {
      const artifacts = (
        await env.DB.prepare(
          "SELECT capture_id,sha256 FROM artifacts WHERE kind='ocr' ORDER BY created_at DESC,key DESC",
        ).all<{ capture_id: string; sha256: string }>()
      ).results;
      const jobs = (
        await env.DB.prepare(
          "SELECT capture_id,ocr_sha256,status FROM jev_jobs",
        ).all<{
          capture_id: string;
          ocr_sha256: string;
          status: string;
        }>()
      ).results;
      const jobByArtifact = new Map(
        jobs.map((item) => [
          `${item.capture_id}:${item.ocr_sha256}`,
          item.status,
        ]),
      );
      const artifactsByCapture = new Map<
        string,
        { capture_id: string; sha256: string }[]
      >();
      for (const artifact of artifacts) {
        const rows = artifactsByCapture.get(artifact.capture_id) ?? [];
        rows.push(artifact);
        artifactsByCapture.set(artifact.capture_id, rows);
      }
      const candidates: { capture_id: string; sha256: string }[] = [];
      for (const capture of current) {
        for (const artifact of artifactsByCapture.get(capture.id) ?? []) {
          const status = jobByArtifact.get(
            `${artifact.capture_id}:${artifact.sha256}`,
          );
          if (!status) {
            candidates.push(artifact);
            break;
          }
          if (["complete", "pending", "running", "failed"].includes(status))
            break;
        }
      }
      return candidates;
    };
    if (!job && !running) {
      const candidate = (await backfillCandidates())[0];
      if (candidate) {
        job = {
          id: await queueJevJob(env, candidate.capture_id, candidate.sha256),
        };
      }
    }
    let result: Record<string, unknown> | null = null;
    if (job)
      try {
        result = await runJevJob(request, env, loadCaptures, job.id);
      } catch (error) {
        const saved = await env.DB.prepare(
          "SELECT status FROM jev_jobs WHERE id=?",
        )
          .bind(job.id)
          .first<{ status: string }>();
        result = {
          id: job.id,
          status: saved?.status ?? "failed",
          error:
            error instanceof HttpError
              ? error.message
              : "Jev processing failed.",
        };
      }
    const remainingJobs = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jev_jobs WHERE status IN ('pending','running','failed')",
    ).first<{ count: number }>();
    const candidatesRemaining = await backfillCandidates();
    const blocked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jev_jobs WHERE status='blocked'",
    ).first<{ count: number }>();
    return json({
      result,
      remaining: (remainingJobs?.count ?? 0) + candidatesRemaining.length,
      blocked: blocked?.count ?? 0,
    });
  }
  throw new HttpError(404, "Jev route not found.");
}
