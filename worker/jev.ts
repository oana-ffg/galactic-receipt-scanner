import type { Env } from "./index";
import type { Capture } from "../web/types";
import {
  canAssessReceiptCompleteness,
  newDocument,
  requiredMergeReviewReasons,
  retargetAbsorbedAliases,
  type ReceiptDocument,
} from "../web/documents";
import {
  ocrTextArtifactHasValidGeometry,
  type OcrArtifact,
} from "../web/ocr-data";
import {
  documentRoute,
  storedAliasesForTargets,
  storedDocumentById,
  storedDocumentsByIds,
  storedDocuments,
} from "./documents";
import {
  COMPLETENESS_TASK,
  loadCompletenessAudits,
} from "./completeness-state";
import { bodyJson, HttpError, json, requireThat, UUID } from "./http";
import { currentTake } from "./capture-selection";
import {
  hashJson,
  legacyHeadMatches,
  pageFingerprint,
} from "./jev-head-identity";

export { pageFingerprint } from "./jev-head-identity";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
const COMPLETENESS_DECISIONS = {
  yes: "The purchase paper appears to contain every section, continuous line entries, and its own printed total. A separate card slip alone cannot establish the purchase total.",
  missing_total:
    "The purchase paper has no visible printed total or footer; a payment slip does not fill this gap.",
  missing_lines_or_page:
    "Line items, a continuation page, or a section of the purchase paper appears absent or cut off.",
  page_or_slip_mismatch:
    "Included pages or payment evidence may belong to different transactions.",
  unreadable_or_uncertain:
    "The scan or OCR is too unclear to establish that all pages, line entries, and the total are present. Choose this when completeness cannot be established from the evidence.",
  not_receipt:
    "The document was classified as a purchase document in error and contains no purchase receipt, invoice, or credit note.",
} as const;
const MAX_JEV_TEXT = 24_000;
const JEV_ELIGIBILITY_VERSION = 3;
const PAGE_CONTINUITY_PIPELINE_VERSION = 9;
const JEV_PIPELINE_VERSION = 9;
const DETACHED_PAYMENT_TASK = "payment-match-detached-v2";

const detachedPaymentQuestion = {
  relationship: {
    type: "choice" as const,
    instructions:
      "We are matching a separately scanned payment slip to its purchase receipt so the receipt includes its payment proof. Decide whether these are the same purchase.",
    criteria: {
      payment_match: "The payment slip belongs to this receipt",
      unrelated: "The payment slip belongs to a different purchase",
    },
  },
};

const scanRelationshipQuestion = {
  relationship: {
    type: "choice" as const,
    instructions:
      "The user is scanning receipts. Your job is to determine if the next page is likely a new page, part of the same receipt as current, or the first page of a new receipt.",
    criteria: {
      continuation:
        "The next page is part of the same receipt as the one we currently have",
      payment_match: "The next page is a payment slip for the current receipt",
      duplicate:
        "The next page is a duplicate, containing only the exact same information we already have in the current receipt",
      unrelated:
        "The next page is the start of a new receipt, not part of the same transaction as the current one",
    },
  },
};

const relationshipPrompts = {
  baseline: {
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
  evidence: {
    instructions:
      "Decide whether the two OCR-backed page groups add distinct evidence for ONE transaction. First distinguish itemized purchase paper from a card slip, and check whether a second purchase page is a duplicate scan. Compare printed merchant, date and time, receipt number, item overlap, purchase total, card charge, explicit fees, masked card digits and payment references. Compare purchase amount with purchase amount and fee-inclusive charge with fee-inclusive charge. Missing fields are unknown, not matching evidence. Scan order and a shared merchant or date alone do not establish a match. Select the most specific relationship supported by the text.",
    criteria: {
      continuation:
        "Complementary or overlapping sections of the SAME purchase paper. The next page extends the item list or supplies its footer/total; overlapping boundary lines are allowed. Do not call two complete copies a continuation.",
      payment_match:
        "One group is purchase documentation and the other is a separate payment slip for the SAME transaction. Require a compatible printed transaction amount, including any explicit fee reconciliation, plus compatible merchant/date/time or a transaction reference. A conflicting known card suffix, unreconciled amount or different printed transaction is not a match.",
      duplicate:
        "The groups repeat substantially the same purchase paper, line items, total and transaction identifiers; this is a second image of the same page, not an additional page or payment slip.",
      unrelated:
        "Different transactions, a material contradiction, or insufficient affirmative evidence to join. Two complete purchases at the same merchant/date with different totals or references are unrelated.",
    },
  },
  ordered: {
    instructions:
      "Use this decision order on the full OCR of both groups: (1) If the same purchase paper or item list is repeated with the same total/reference, choose duplicate. (2) If one side is a separate card slip, choose payment_match only when its base purchase amount or fee-inclusive charge reconciles with the receipt and merchant/date/time/reference are compatible; a different known card, unexplained amount or separate transaction means unrelated. (3) If both sides are parts of a purchase paper, choose continuation only when their item lists or structure genuinely connect, including a visible overlap at the page break. (4) Otherwise choose unrelated. Do not infer a transaction link from scan adjacency, merchant identity, or date alone. An explicit contradiction outweighs superficial similarity; unreadable fields are unknown.",
    criteria: {
      continuation:
        "Distinct sections of one original purchase paper; the later section contributes new items, a footer or total, possibly repeating a few lines at the scan boundary.",
      payment_match:
        "A purchase paper and its distinct card payment slip for one charge, with reconciled amounts and compatible transaction details.",
      duplicate:
        "A retake or second scan of substantially the same purchase page and transaction, adding no distinct receipt section.",
      unrelated:
        "Separate transactions or insufficient positive evidence for a join, especially conflicting amount, card, date, time or receipt reference.",
    },
  },
} as const;

type RelationshipPrompt = keyof typeof relationshipPrompts;

function relationshipQuestion(variant: RelationshipPrompt) {
  return {
    relationship: { type: "choice" as const, ...relationshipPrompts[variant] },
  };
}

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
  payment_match_index: string | null;
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

type PaymentMatchIndex = { amounts: number[]; terms: string[] };

function paymentMatchIndex(text: string): PaymentMatchIndex {
  const amounts = new Set<number>();
  for (const match of text.matchAll(
    /(?<!\d)(?:\d{1,3}(?:[., ]\d{3})+|\d{1,6})[.,]\d{2}(?!\d)/g,
  )) {
    const digits = match[0].replace(/\D/g, "");
    const value = Number(digits);
    if (value > 0 && value <= 100_000_000) amounts.add(value);
  }
  const common = new Set([
    "BETALING",
    "DANKORT",
    "DEBIT",
    "CREDIT",
    "CARD",
    "KORT",
    "KVITTERING",
    "RECEIPT",
    "TOTAL",
    "MOMS",
    "AMOUNT",
    "TERMINAL",
    "APPROVED",
    "GODKENDT",
    "TRANSACTION",
    "TRANSAKTION",
    "MASTER",
    "VISA",
    "CUSTOMER",
    "KUNDE",
    "THANK",
    "TAK",
    "PURCHASE",
  ]);
  const terms = new Set(
    (text.toLocaleUpperCase().match(/[\p{L}]{4,}/gu) ?? [])
      .filter((term) => !common.has(term))
      .slice(0, 250),
  );
  return {
    amounts: [...amounts].sort((a, b) => a - b),
    terms: [...terms].sort(),
  };
}

function parsedPaymentMatchIndex(value: string | null): PaymentMatchIndex {
  let parsed: PaymentMatchIndex;
  try {
    parsed = JSON.parse(value ?? "null") as PaymentMatchIndex;
  } catch {
    throw new HttpError(503, "Stored payment match index is invalid.");
  }
  requireThat(
    parsed &&
      Array.isArray(parsed.amounts) &&
      parsed.amounts.every(
        (amount) => Number.isSafeInteger(amount) && amount > 0,
      ) &&
      Array.isArray(parsed.terms) &&
      parsed.terms.every((term) => typeof term === "string"),
    503,
    "Stored payment match index is invalid.",
  );
  return parsed;
}

export function shouldAutoMerge(answer: ChoiceAnswer) {
  return answer.choice === "continuation" || answer.choice === "payment_match";
}

function validateChoice(
  answer: unknown,
  choices: readonly string[],
  label = "choice",
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
    `Jev returned an invalid ${label} response.`,
  );
}

export function normalizeCompletenessDecision(answer: ChoiceAnswer) {
  validateChoice(
    answer,
    Object.keys(COMPLETENESS_DECISIONS),
    "completeness decision",
  );
  const probabilities = answer.probabilities;
  const result =
    answer.choice === "yes"
      ? "yes"
      : answer.choice === "not_receipt"
        ? "not_receipt"
        : "no";
  const issue = answer.choice === "yes" ? "none" : answer.choice;
  return {
    completeness: {
      type: "choice" as const,
      choice: result,
      probabilities: {
        yes: probabilities.yes,
        no: Math.min(
          1,
          probabilities.missing_total +
            probabilities.missing_lines_or_page +
            probabilities.page_or_slip_mismatch +
            probabilities.unreadable_or_uncertain,
        ),
        not_receipt: probabilities.not_receipt,
      },
      confidence: answer.confidence,
    },
    issue: {
      type: "choice" as const,
      choice: issue,
      probabilities: {
        none: probabilities.yes,
        missing_total: probabilities.missing_total,
        missing_lines_or_page: probabilities.missing_lines_or_page,
        page_or_slip_mismatch: probabilities.page_or_slip_mismatch,
        unreadable_or_uncertain: probabilities.unreadable_or_uncertain,
        evidence_too_long: 0,
        not_receipt: probabilities.not_receipt,
      },
      confidence: answer.confidence,
    },
  };
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
  const inputHash = await hashJson({ input, subject, candidate });
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
  const storedIds = new Set(stored.map((document) => document.id));
  return [
    ...stored,
    ...captures
      .filter(
        (capture) =>
          capture.is_current &&
          !assigned.has(capture.id) &&
          !storedIds.has(capture.id),
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
    ocrTextArtifactHasValidGeometry(value, page) &&
    typeof value.text === "string"
    ? { sha256: row.sha256, value }
    : null;
}

export function summarizeDocumentOcr(pins: { text: string }[]) {
  const text = pins
    .map((pin, index) => `Page ${index + 1}:\n${pin.text}`)
    .join("\n\n");
  return {
    blank: pins.every((pin) => !pin.text.trim()),
    text: text.slice(0, MAX_JEV_TEXT),
    characters: text.length,
    truncated: text.length > MAX_JEV_TEXT,
  };
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
    ...summarizeDocumentOcr(pins),
    pins: pins.map(({ text: _text, ...pin }) => pin),
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
  const matchIndex = JSON.stringify(paymentMatchIndex(text));
  await env.DB.prepare(
    "INSERT INTO jev_page_heads(capture_id,source_sha256,ocr_sha256,role,probability,confidence,model,assessment_id,date_candidates,payment_match_index,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_id) DO UPDATE SET source_sha256=excluded.source_sha256,ocr_sha256=excluded.ocr_sha256,role=excluded.role,probability=excluded.probability,confidence=excluded.confidence,model=excluded.model,assessment_id=excluded.assessment_id,date_candidates=excluded.date_candidates,payment_match_index=excluded.payment_match_index,updated_at=excluded.updated_at",
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
      matchIndex,
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
    payment_match_index: matchIndex,
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
  assessmentTask = "document-relationship-scan-v1",
  suppliedEvidence?: {
    current: NonNullable<Awaited<ReturnType<typeof documentEvidence>>>;
    candidate: NonNullable<Awaited<ReturnType<typeof documentEvidence>>>;
  },
  prompt: "scan" | "payment" = "scan",
) {
  const currentEvidence =
    suppliedEvidence?.current ?? (await documentEvidence(env, current));
  const candidateEvidence =
    suppliedEvidence?.candidate ?? (await documentEvidence(env, candidate));
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
    assessmentTask,
    input,
    { id: current.id },
    { id: candidate.id },
    () =>
      callJev(
        env,
        prompt === "scan"
          ? { current: candidateOcr.text, next: currentOcr.text }
          : input,
        prompt === "scan" ? scanRelationshipQuestion : detachedPaymentQuestion,
        budget,
      ),
    (result) =>
      validateChoice(
        result.answers.relationship,
        prompt === "payment"
          ? ["payment_match", "unrelated"]
          : [
              "continuation",
              "payment_match",
              ...(prompt === "scan" ? ["duplicate"] : []),
              "unrelated",
            ],
      ),
  );
  const result = saved.result;
  const answer = result.answers.relationship;
  validateChoice(
    answer,
    prompt === "payment"
      ? ["payment_match", "unrelated"]
      : [
          "continuation",
          "payment_match",
          ...(prompt === "scan" ? ["duplicate"] : []),
          "unrelated",
        ],
  );
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
  statements: D1PreparedStatement[] = [],
  loadCapture?: (id: string) => Promise<Capture | null>,
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
      { statements, trustedProcessing: true },
      loadCapture,
      loadCapture
        ? async (ids) => {
            const captures = await Promise.all(ids.map(loadCapture));
            return captures.filter(
              (capture): capture is Capture => capture !== null,
            );
          }
        : undefined,
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
  captureOrderById: Map<string, string>,
) {
  let target = structuredClone(candidate),
    donor = structuredClone(current);
  let prependDonor = false;
  if (relationship === "payment_match") {
    const currentHasReceipt = current.pages.some(
      (page) => roles.get(page.captureId) === "receipt",
    );
    if (currentHasReceipt) {
      target = structuredClone(current);
      donor = structuredClone(candidate);
      const donorHasReceipt = donor.pages.some(
        (page) => roles.get(page.captureId) === "receipt",
      );
      if (donorHasReceipt) {
        const firstReceiptOrder = (document: ReceiptDocument) => {
          const orders = document.pages
            .filter((page) => roles.get(page.captureId) === "receipt")
            .map((page) => captureOrderById.get(page.captureId));
          requireThat(
            orders.every(Boolean),
            503,
            "Scan order is unavailable for a Jev merge.",
          );
          return orders.sort()[0]!;
        };
        prependDonor = firstReceiptOrder(donor) < firstReceiptOrder(target);
      }
    }
  }
  const donorBeforeMerge = structuredClone(donor);
  const movedCaptureIds = donor.pages.map((page) => page.captureId);
  target.pages = prependDonor
    ? [...donor.pages, ...target.pages]
    : [...target.pages, ...donor.pages];
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
  captures: Capture[] | null,
  current: ReceiptDocument,
  candidate: ReceiptDocument,
  relationship: "continuation" | "payment_match",
  roles: Map<string, PageRole>,
  allDocuments: ReceiptDocument[] | null,
  loadCapture?: (id: string) => Promise<Capture | null>,
) {
  const sourceIds = [
    ...new Set(
      [...current.pages, ...candidate.pages].map((page) => page.captureId),
    ),
  ];
  const sources =
    captures ??
    (
      await env.DB.prepare(
        `SELECT id,created_at FROM captures WHERE id IN (${sourceIds.map(() => "?").join(",")})`,
      )
        .bind(...sourceIds)
        .all<Pick<Capture, "id" | "created_at">>()
    ).results;
  const captureOrderById = new Map(
    sources.map((capture) => [capture.id, captureOrder(capture)]),
  );
  const { target, donor, movedCaptureIds } = prepareJevMerge(
    current,
    candidate,
    relationship,
    roles,
    captureOrderById,
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
  retargetAbsorbedAliases(
    changed,
    allDocuments ?? (await storedAliasesForTargets(env, [donor.id])),
    target.id,
  );
  requireThat(
    changed.length <= 100,
    409,
    "Jev grouping would exceed the bounded relationship update; leave it for explicit review.",
  );
  const updateJobs: D1PreparedStatement[] = [];
  const ids = target.pages.map((page) => page.captureId);
  for (let index = 0; index < ids.length; index += 99) {
    const chunk = ids.slice(index, index + 99);
    updateJobs.push(
      env.DB.prepare(
        `UPDATE jev_jobs SET status='classified',updated_at=?
         WHERE status='complete' AND capture_id IN (${chunk.map(() => "?").join(",")})`,
      ).bind(new Date().toISOString(), ...chunk),
    );
  }
  const result = await saveDocuments(
    request,
    env,
    loadCaptures,
    changed,
    updateJobs,
    loadCapture,
  );
  target.revision = result.saved.find(
    (saved) => saved.id === target.id,
  )!.revision;
  return target;
}

async function documentsAreUnlocked(env: Env, documents: ReceiptDocument[]) {
  if (!documents.length) return true;
  const current = new Map(
    (
      await Promise.all(
        documents.map((document) => storedDocumentById(env, document.id)),
      )
    )
      .filter((document): document is ReceiptDocument => document !== null)
      .map((document) => [document.id, document]),
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
      "SELECT 1 AS active FROM processing_batch_lease WHERE expires>unixepoch()*1000",
    ).first<{ active: number }>();
    if (batch) return false;
  }
  const active = await env.DB.prepare(
    "SELECT document_id FROM processing_lock WHERE expires>unixepoch()*1000",
  ).all<{ document_id: string }>();
  return !documents.some((document) =>
    active.results.some((lock) => lock.document_id === document.id),
  );
}

async function classifyDocument(
  env: Env,
  document: ReceiptDocument,
  budget: JevBudget,
  expectedSavedRevision: number | null = null,
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
  const guard =
    expectedSavedRevision === null
      ? "WHERE 1=1"
      : `WHERE EXISTS (SELECT 1 FROM document_heads WHERE id=? AND revision=?)
         AND NOT EXISTS (
           SELECT 1 FROM document_pages p JOIN captures ON captures.id=p.capture_id
           WHERE p.document_id=? AND NOT (${currentTake})
         )`;
  const published = await env.DB.prepare(
    `INSERT INTO jev_document_heads(document_id,document_revision,page_fingerprint,role,role_probability,role_confidence,category_id,category_probability,category_confidence,model,assessment_id,category_assessment_id,updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? ${guard}
     ON CONFLICT(document_id) DO UPDATE SET document_revision=excluded.document_revision,page_fingerprint=excluded.page_fingerprint,role=excluded.role,role_probability=excluded.role_probability,role_confidence=excluded.role_confidence,category_id=excluded.category_id,category_probability=excluded.category_probability,category_confidence=excluded.category_confidence,model=excluded.model,assessment_id=excluded.assessment_id,category_assessment_id=excluded.category_assessment_id,updated_at=excluded.updated_at`,
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
      ...(expectedSavedRevision === null
        ? []
        : [document.id, expectedSavedRevision, document.id]),
    )
    .run();
  if (expectedSavedRevision !== null)
    requireThat(
      published.meta.changes === 1,
      409,
      "Document changed during Jev classification.",
    );
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

export async function queueJevJob(
  env: Env,
  captureId: string,
  ocrSha256: string,
) {
  const id = await hashJson({ captureId, ocrSha256 });
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
  loadCapture: (id: string) => Promise<Capture | null>,
  job: {
    id: string;
    capture_id: string;
    ocr_sha256: string;
  },
) {
  const capture = await loadCapture(job.capture_id);
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
  const initialDocument = await documentForCapture(env, capture);
  const page = initialDocument?.pages.find(
    (item) => item.captureId === capture.id,
  );
  if (!page) return { eligible: false, ineligible_reason: "page_missing" };
  if (!ocrTextArtifactHasValidGeometry(value, page))
    return {
      eligible: false,
      ineligible_reason: "ocr_source_geometry_invalid",
    };
  await classifyPage(env, capture, job.ocr_sha256, value, { remaining: 1 });
  return { eligible: true };
}

export async function runJevJob(
  _request: Request,
  env: Env,
  loadCapture: (id: string) => Promise<Capture | null>,
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
    const result = await processJob(env, loadCapture, job);
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

async function latestCompletedPipelineRun(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM jev_pipeline_runs WHERE phase='complete' ORDER BY created_at DESC,id DESC LIMIT 1",
  ).first<JevPipelineRun>();
}

async function currentBoundary(env: Env): Promise<OrderedCapture | null> {
  return env.DB.prepare(
    `SELECT captures.id,captures.created_at,captures.sha256 FROM captures
     WHERE (${currentTake}) ORDER BY captures.created_at DESC,captures.id DESC LIMIT 1`,
  ).first<OrderedCapture>();
}

async function hasCurrentWaitingCapture(env: Env) {
  return !!(await env.DB.prepare(
    `SELECT 1 AS found FROM jev_jobs job JOIN captures ON captures.id=job.capture_id
     WHERE job.status='waiting' AND (${currentTake}) LIMIT 1`,
  ).first<{ found: number }>());
}

async function pipelineNeedsRun(
  env: Env,
  boundary: OrderedCapture | null,
  latest: JevPipelineRun | null,
) {
  if (!latest) return boundary !== null;
  const unfinished = await env.DB.prepare(
    `SELECT 1 AS found FROM jev_jobs job JOIN captures ON captures.id=job.capture_id
     WHERE job.status IN ('pending','running','failed','classified')
       AND (${currentTake}) LIMIT 1`,
  ).first<{ found: number }>();
  if (unfinished) return true;
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
    (await firstUnqueuedArtifact(env, probe)) !== null ||
    (await firstLegacyPageCandidate(env, probe)) !== null
  );
}

async function startPipelineRun(env: Env, boundary: OrderedCapture | null) {
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
    "UPDATE jev_pipeline_runs SET step_token=?,step_started_at=?,updated_at=? WHERE id=? AND phase!='complete' AND (phase!='dates' OR NOT EXISTS(SELECT 1 FROM processing_batch_lease WHERE expires>unixepoch()*1000)) AND (step_token IS NULL OR unixepoch(step_started_at)<unixepoch()-300) RETURNING *",
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
  fingerprintMatches: boolean,
) {
  if (!head || !fingerprintMatches || pages.length !== document.pages.length)
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
  const fingerprint = await pageFingerprint(document);
  const oldVersion =
    head && head.page_fingerprint !== fingerprint
      ? await env.DB.prepare(
          "SELECT payload FROM document_versions WHERE document_id=? AND revision=?",
        )
          .bind(document.id, head.document_revision)
          .first<{ payload: string }>()
      : null;
  const fingerprintMatches = Boolean(
    head &&
    (head.page_fingerprint === fingerprint ||
      (await legacyHeadMatches(document, head, oldVersion?.payload))),
  );
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
    fingerprintMatches,
  );
}

export async function jevOpenTailDocumentId(env: Env): Promise<string | null> {
  const completed = await env.DB.prepare(
    "SELECT snapshot_created_at,snapshot_capture_id FROM jev_pipeline_runs WHERE version=? AND phase='complete' ORDER BY created_at DESC,id DESC LIMIT 1",
  )
    .bind(JEV_PIPELINE_VERSION)
    .first<{ snapshot_created_at: string; snapshot_capture_id: string }>();
  if (completed) {
    const newest = await env.DB.prepare(
      `SELECT captures.created_at,captures.id FROM captures WHERE (${currentTake})
       ORDER BY captures.created_at DESC,captures.id DESC LIMIT 1`,
    ).first<{ created_at: string; id: string }>();
    if (
      !newest ||
      `${newest.created_at}\u0000${newest.id}` <=
        `${completed.snapshot_created_at}\u0000${completed.snapshot_capture_id}`
    )
      return null;
  }
  const missing = await env.DB.prepare(
    `SELECT captures.created_at,captures.id FROM captures
     LEFT JOIN jev_page_heads head ON head.capture_id=captures.id
     WHERE (${currentTake}) AND (captures.created_at,captures.id)>(?,?)
       AND (head.capture_id IS NULL OR head.source_sha256!=captures.sha256)
     ORDER BY captures.created_at,captures.id LIMIT 1`,
  )
    .bind(
      completed?.snapshot_created_at ?? "",
      completed?.snapshot_capture_id ?? "",
    )
    .first<{ created_at: string; id: string }>();
  if (!missing) return null;
  const preceding = await env.DB.prepare(
    `SELECT captures.id FROM captures WHERE (${currentTake})
     AND (captures.created_at,captures.id)<(?,?)
     ORDER BY captures.created_at DESC,captures.id DESC LIMIT 1`,
  )
    .bind(missing.created_at, missing.id)
    .first<{ id: string }>();
  if (!preceding) return null;
  const page = await env.DB.prepare(
    "SELECT document_id FROM document_pages WHERE capture_id=?",
  )
    .bind(preceding.id)
    .first<{ document_id: string }>();
  return page?.document_id ?? preceding.id;
}

async function documentOcrArtifactPins(env: Env, document: ReceiptDocument) {
  const artifacts: { capture_id: string; sha256: string }[] = [];
  const captureIds = document.pages.map((page) => page.captureId);
  for (let index = 0; index < captureIds.length; index += 99) {
    const chunk = captureIds.slice(index, index + 99);
    const rows = await env.DB.prepare(
      `SELECT capture_id,sha256 FROM artifacts WHERE kind='ocr' AND capture_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ capture_id: string; sha256: string }>();
    artifacts.push(...rows.results);
  }
  return artifacts;
}

export async function jevSummary(env: Env, document: ReceiptDocument) {
  const head =
    (await env.DB.prepare(
      "SELECT * FROM jev_document_heads WHERE document_id=?",
    )
      .bind(document.id)
      .first<JevDocumentHead>()) ?? null;
  const pages = await pageHeads(env, document);
  const artifacts = await documentOcrArtifactPins(env, document);
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

async function firstUnqueuedArtifact(env: Env, run: JevPipelineRun) {
  return env.DB.prepare(
    `SELECT artifact.capture_id,artifact.sha256
     FROM artifacts artifact JOIN captures ON captures.id=artifact.capture_id
     WHERE artifact.kind='ocr' AND (${currentTake})
       AND (captures.created_at,captures.id)<=(?,?)
       AND NOT EXISTS (
         SELECT 1 FROM artifacts newer WHERE newer.capture_id=artifact.capture_id
           AND newer.kind='ocr' AND (newer.created_at>artifact.created_at
             OR (newer.created_at=artifact.created_at AND newer.key>artifact.key)))
       AND NOT EXISTS (
         SELECT 1 FROM jev_jobs job WHERE job.capture_id=artifact.capture_id
           AND job.ocr_sha256=artifact.sha256)
     ORDER BY artifact.created_at,artifact.key LIMIT 1`,
  )
    .bind(run.snapshot_created_at, run.snapshot_capture_id)
    .first<{ capture_id: string; sha256: string }>();
}

async function firstLegacyPageCandidate(env: Env, run: JevPipelineRun) {
  return env.DB.prepare(
    `SELECT candidate.id,candidate.capture_id
     FROM jev_jobs candidate
     JOIN artifacts artifact ON artifact.capture_id=candidate.capture_id
       AND artifact.kind='ocr' AND artifact.sha256=candidate.ocr_sha256
     JOIN captures ON captures.id=candidate.capture_id
     WHERE candidate.status='ineligible' AND candidate.eligibility_version<?
       AND (${currentTake}) AND (captures.created_at,captures.id)<=(?,?)
       AND NOT EXISTS (SELECT 1 FROM jev_jobs completed
         WHERE completed.capture_id=candidate.capture_id
           AND completed.status IN ('classified','complete'))
       AND NOT EXISTS (
         SELECT 1 FROM jev_jobs sibling
         JOIN artifacts sibling_artifact ON sibling_artifact.capture_id=sibling.capture_id
           AND sibling_artifact.kind='ocr' AND sibling_artifact.sha256=sibling.ocr_sha256
         WHERE sibling.capture_id=candidate.capture_id AND sibling.status='ineligible'
           AND sibling.eligibility_version<?
           AND (sibling_artifact.created_at>artifact.created_at
             OR (sibling_artifact.created_at=artifact.created_at
               AND sibling_artifact.key>artifact.key)))
     ORDER BY captures.created_at,captures.id LIMIT 1`,
  )
    .bind(
      JEV_ELIGIBILITY_VERSION,
      run.snapshot_created_at,
      run.snapshot_capture_id,
      JEV_ELIGIBILITY_VERSION,
    )
    .first<{ id: string; capture_id: string }>();
}

async function pagePipelineStep(
  request: Request,
  env: Env,
  loadCapture: (id: string) => Promise<Capture | null>,
  run: JevPipelineRun,
) {
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
  const retryable = await env.DB.prepare(
    `SELECT job.id,job.capture_id FROM jev_jobs job
     JOIN captures ON captures.id=job.capture_id
     WHERE (job.status='pending' OR (job.status='failed' AND job.attempts<3))
       AND (${currentTake}) AND (captures.created_at,captures.id)<=(?,?)
     ORDER BY CASE job.status WHEN 'pending' THEN 0 ELSE 1 END,
       job.attempts,job.updated_at,job.created_at,job.id LIMIT 1`,
  )
    .bind(run.snapshot_created_at, run.snapshot_capture_id)
    .first<{ id: string; capture_id: string }>();
  const running = await env.DB.prepare(
    `SELECT 1 AS active FROM jev_jobs job JOIN captures ON captures.id=job.capture_id
     WHERE job.status='running' AND (${currentTake})
       AND (captures.created_at,captures.id)<=(?,?) LIMIT 1`,
  )
    .bind(run.snapshot_created_at, run.snapshot_capture_id)
    .first<{ active: number }>();
  if (running) return { remaining: 1, busy: true, result: null };
  let jobId = retryable?.id ?? null;
  if (!jobId) {
    const legacy = await firstLegacyPageCandidate(env, run);
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
    const candidate = await firstUnqueuedArtifact(env, run);
    if (candidate)
      jobId = await queueJevJob(env, candidate.capture_id, candidate.sha256);
  }
  if (!jobId) return { remaining: 0, busy: false, result: null };
  const result = await runJevJob(request, env, loadCapture, jobId, true);
  return { remaining: 1, busy: false, result };
}

async function legacyGroupPipelineStep(
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
  if (currentEvidence.ocr.truncated || nextEvidence.ocr.truncated) {
    return {
      phase: "group" as const,
      cursor: JSON.stringify({
        finalize_id: current.id,
        next_id: next.id,
      }),
      result: {
        status: "ocr-too-long",
        current_document_id: current.id,
        next_document_id: next.id,
        current_characters: currentEvidence.ocr.characters,
        next_characters: nextEvidence.ocr.characters,
      },
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
    // Earlier Luna group boundaries remain the source of truth until the owner
    // reviews Jev's differing answer. Keep the model assessment for the audit.
    if (current.processing || next.processing)
      return {
        phase: "group" as const,
        cursor: JSON.stringify({
          finalize_id: current.id,
          next_id: next.id,
        }),
        result: {
          status: "luna-disagreement",
          current_document_id: current.id,
          next_document_id: next.id,
          relationship: decision.answer.choice,
          probability: decision.answer.probabilities[decision.answer.choice],
          confidence: decision.answer.confidence,
          assessment_id: decision.assessment_id,
        },
      };
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
        captures,
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
        result: {
          status: "merged",
          document_id: merged.id,
          previous_document_id: current.id,
          next_document_id: next.id,
          relationship: decision.answer.choice,
          assessment_id: decision.assessment_id,
        },
      };
  }
  return {
    phase: "group" as const,
    cursor: JSON.stringify({
      finalize_id: current.id,
      next_id: next.id,
    }),
    result: decision
      ? {
          status:
            decision.answer.choice === "duplicate"
              ? "duplicate-suggested"
              : "boundary",
          current_document_id: current.id,
          next_document_id: next.id,
          relationship: decision.answer.choice,
          probability: decision.answer.probabilities[decision.answer.choice],
          confidence: decision.answer.confidence,
          assessment_id: decision.assessment_id,
        }
      : { status: "boundary" },
  };
}

type OrderedCapture = { id: string; created_at: string; sha256: string };
type ContinuityCursor = { last_created_at: string; last_capture_id: string };

async function orderedCapture(
  env: Env,
  comparison: "<" | ">",
  createdAt: string,
  id: string,
  run?: JevPipelineRun,
): Promise<OrderedCapture | null> {
  const snapshot = run ? "AND (captures.created_at,captures.id)<=(?,?)" : "";
  const order = comparison === "<" ? "DESC" : "ASC";
  return env.DB.prepare(
    `SELECT captures.id,captures.created_at,captures.sha256 FROM captures
     WHERE (${currentTake}) AND (captures.created_at,captures.id)${comparison}(?,?)
       ${snapshot}
     ORDER BY captures.created_at ${order},captures.id ${order} LIMIT 1`,
  )
    .bind(
      createdAt,
      id,
      ...(run ? [run.snapshot_created_at, run.snapshot_capture_id] : []),
    )
    .first<OrderedCapture>();
}

async function seedCompletedContinuity(
  env: Env,
  completed: JevPipelineRun | null,
  repair?: { cutoff?: string; captureIds?: string[] },
) {
  if (!completed || completed.phase !== "complete") return 0;
  if (!repair) {
    const existing = await env.DB.prepare(
      "SELECT 1 AS found FROM jev_continuity_edges LIMIT 1",
    ).first<{ found: number }>();
    if (existing) return 0;
  }
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO jev_continuity_edges(
       capture_id,scan_created_at,source_sha256,ocr_sha256,
       previous_capture_id,previous_source_sha256,previous_ocr_sha256,
       relationship,assessment_id,processed_at)
     SELECT id,created_at,sha256,ocr_sha256,previous_id,previous_sha256,
       previous_ocr_sha256,'verified-history',NULL,?
     FROM (
       SELECT captures.id,captures.created_at,captures.sha256,
         CASE WHEN role.id IS NOT NULL THEN head.ocr_sha256 END AS ocr_sha256,
         LAG(captures.id) OVER scan_order AS previous_id,
         LAG(captures.sha256) OVER scan_order AS previous_sha256,
         LAG(CASE WHEN role.id IS NOT NULL THEN head.ocr_sha256 END)
           OVER scan_order AS previous_ocr_sha256
       FROM captures LEFT JOIN jev_page_heads head
         ON head.capture_id=captures.id AND head.source_sha256=captures.sha256
       LEFT JOIN jev_assessments role
         ON role.id=head.assessment_id AND role.task='page-role'
         AND role.subject_id=captures.id AND role.created_at<=?
         AND json_extract(role.payload,'$.input.ocr_sha256')=head.ocr_sha256
       WHERE (${currentTake}) AND (captures.created_at,captures.id)<=(?,?)
       WINDOW scan_order AS (ORDER BY captures.created_at,captures.id)
     ) ordered
     WHERE ocr_sha256 IS NOT NULL
       AND (previous_id IS NULL OR previous_ocr_sha256 IS NOT NULL)
       AND EXISTS (
       SELECT 1 FROM jev_jobs job WHERE job.capture_id=ordered.id
         AND job.ocr_sha256=ordered.ocr_sha256
         AND job.status IN ('complete','classified')
     )${repair?.captureIds ? ` AND ordered.id IN (${repair.captureIds.map(() => "?").join(",")})` : ""}`,
  )
    .bind(
      new Date().toISOString(),
      repair?.cutoff ?? completed.updated_at,
      completed.snapshot_created_at,
      completed.snapshot_capture_id,
      ...(repair?.captureIds ?? []),
    )
    .run();
  return result.meta.changes;
}

async function nextContinuityCapture(
  env: Env,
  run: JevPipelineRun,
): Promise<OrderedCapture | null> {
  const cursor = parsePipelineCursor<ContinuityCursor>(run);
  return env.DB.prepare(
    `SELECT captures.id,captures.created_at,captures.sha256
     FROM captures
     LEFT JOIN jev_page_heads head ON head.capture_id=captures.id
     LEFT JOIN jev_continuity_edges edge ON edge.capture_id=captures.id
     WHERE (${currentTake}) AND (captures.created_at,captures.id)<=(?,?)
       AND (captures.created_at,captures.id)>(?,?)
       AND (edge.capture_id IS NULL OR head.capture_id IS NULL
         OR edge.source_sha256!=captures.sha256
         OR edge.ocr_sha256!=head.ocr_sha256
         OR (edge.previous_capture_id IS NOT NULL
           AND edge.previous_source_sha256 IS NULL))
     ORDER BY captures.created_at,captures.id LIMIT 1`,
  )
    .bind(
      run.snapshot_created_at,
      run.snapshot_capture_id,
      cursor?.last_created_at ?? "",
      cursor?.last_capture_id ?? "",
    )
    .first<OrderedCapture>();
}

async function documentForCapture(
  env: Env,
  capture: Capture,
): Promise<ReceiptDocument> {
  const page = await env.DB.prepare(
    "SELECT document_id FROM document_pages WHERE capture_id=?",
  )
    .bind(capture.id)
    .first<{ document_id: string }>();
  if (page) {
    const saved = await storedDocumentById(env, page.document_id);
    if (saved) return saved;
  }
  const singleton = await storedDocumentById(env, capture.id);
  return singleton?.pages.some((item) => item.captureId === capture.id)
    ? singleton
    : newDocument(capture);
}

async function documentById(
  env: Env,
  id: string,
  loadCapture: (id: string) => Promise<Capture | null>,
): Promise<ReceiptDocument | null> {
  const saved = await storedDocumentById(env, id);
  if (saved) return saved;
  const capture = await loadCapture(id);
  if (!capture?.is_current) return null;
  const document = await documentForCapture(env, capture);
  return document.id === id ? document : null;
}

async function activeDocumentForCapture(
  env: Env,
  capture: Capture,
  run: JevPipelineRun,
  loadCapture: (id: string) => Promise<Capture | null>,
): Promise<ReceiptDocument | null> {
  const document = await documentForCapture(env, capture);
  if (document.mergedInto || document.duplicateOf || !document.pages.length)
    return null;
  for (const page of document.pages) {
    const source = await loadCapture(page.captureId);
    if (
      !source?.is_current ||
      !withinPipelineSnapshot(source, run) ||
      source.sha256 !== page.sha256
    )
      return null;
  }
  return document;
}

async function precedingActivePage(
  env: Env,
  before: Capture,
  run: JevPipelineRun,
  loadCapture: (id: string) => Promise<Capture | null>,
  receiptOnly = false,
) {
  let cursor = before;
  while (true) {
    const row = await orderedCapture(env, "<", cursor.created_at, cursor.id);
    if (!row) return null;
    const capture = await loadCapture(row.id);
    requireThat(capture?.is_current, 503, "Previous Jev scan changed.");
    cursor = capture;
    const document = await activeDocumentForCapture(
      env,
      capture,
      run,
      loadCapture,
    );
    if (!document) continue;
    const head = await env.DB.prepare(
      "SELECT * FROM jev_page_heads WHERE capture_id=?",
    )
      .bind(capture.id)
      .first<PageHead>();
    if (receiptOnly && head?.role !== "receipt") continue;
    return { capture, document, head };
  }
}

async function recordContinuityEdge(
  env: Env,
  capture: Capture,
  head: PageHead,
  previous: Capture | null,
  previousHead: PageHead | null,
  relationship: string,
  assessmentId: string | null,
  membershipChanged = false,
) {
  const prior = await env.DB.prepare(
    "SELECT source_sha256,ocr_sha256,previous_capture_id FROM jev_continuity_edges WHERE capture_id=?",
  )
    .bind(capture.id)
    .first<{
      source_sha256: string;
      ocr_sha256: string;
      previous_capture_id: string | null;
    }>();
  await env.DB.prepare(
    `INSERT INTO jev_continuity_edges(capture_id,scan_created_at,source_sha256,ocr_sha256,previous_capture_id,previous_source_sha256,previous_ocr_sha256,relationship,assessment_id,processed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(capture_id) DO UPDATE SET
       scan_created_at=excluded.scan_created_at,source_sha256=excluded.source_sha256,
       ocr_sha256=excluded.ocr_sha256,previous_capture_id=excluded.previous_capture_id,
       previous_source_sha256=excluded.previous_source_sha256,
       previous_ocr_sha256=excluded.previous_ocr_sha256,relationship=excluded.relationship,
       assessment_id=excluded.assessment_id,processed_at=excluded.processed_at`,
  )
    .bind(
      capture.id,
      capture.created_at,
      capture.sha256,
      head.ocr_sha256,
      previous?.id ?? null,
      previous?.sha256 ?? null,
      previousHead?.ocr_sha256 ?? null,
      relationship,
      assessmentId,
      new Date().toISOString(),
    )
    .run();
  if (
    !prior ||
    membershipChanged ||
    prior.source_sha256 !== capture.sha256 ||
    prior.ocr_sha256 !== head.ocr_sha256 ||
    prior.previous_capture_id !== (previous?.id ?? null)
  )
    await env.DB.prepare(
      "UPDATE jev_continuity_edges SET previous_source_sha256=NULL,previous_ocr_sha256=NULL WHERE previous_capture_id=?",
    )
      .bind(capture.id)
      .run();
}

async function pageGroupPipelineStep(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  loadCapture: (id: string) => Promise<Capture | null>,
  run: JevPipelineRun,
) {
  const next = await nextContinuityCapture(env, run);
  if (!next) {
    const last = await env.DB.prepare(
      `SELECT captures.id,captures.created_at,captures.sha256 FROM captures
       WHERE (${currentTake}) AND (captures.created_at,captures.id)<=(?,?)
       ORDER BY captures.created_at DESC,captures.id DESC LIMIT 1`,
    )
      .bind(run.snapshot_created_at, run.snapshot_capture_id)
      .first<OrderedCapture>();
    if (!last) return { phase: "dates" as const, cursor: null, result: null };
    const lastCapture = await loadCapture(last.id);
    requireThat(lastCapture?.is_current, 503, "Final Jev scan changed.");
    const document =
      (await activeDocumentForCapture(env, lastCapture, run, loadCapture)) ??
      (await precedingActivePage(env, lastCapture, run, loadCapture))?.document;
    if (!document)
      return { phase: "dates" as const, cursor: null, result: null };
    const later = await orderedCapture(env, ">", last.created_at, last.id);
    if (later) {
      if (!(await markDocumentsWaitingForOcr(env, [document])))
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
    if (!(await documentsAreUnlocked(env, [document])))
      return {
        phase: "group" as const,
        cursor: run.cursor,
        result: { status: "busy" },
        busy: true,
      };
    return {
      phase: "dates" as const,
      cursor: null,
      result: await finalizePipelineDocument(env, document),
    };
  }
  const capture = await loadCapture(next.id);
  requireThat(capture?.is_current, 503, "Jev scan changed during grouping.");
  const currentDocument = await activeDocumentForCapture(
    env,
    capture,
    run,
    loadCapture,
  );
  const previous = await precedingActivePage(env, capture, run, loadCapture);
  const previousCapture = previous?.capture ?? null;
  const [head, previousHead] = await Promise.all([
    env.DB.prepare("SELECT * FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first<PageHead>(),
    Promise.resolve(previous?.head ?? null),
  ]);
  if (
    !head ||
    head.source_sha256 !== capture.sha256 ||
    (previousCapture &&
      (!previousHead || previousHead.source_sha256 !== previousCapture.sha256))
  ) {
    if (previousCapture) {
      const document = await documentForCapture(env, previousCapture);
      if (!(await markDocumentsWaitingForOcr(env, [document])))
        return {
          phase: "group" as const,
          cursor: run.cursor,
          result: { status: "busy" },
          busy: true,
        };
    }
    return {
      phase: "complete" as const,
      cursor: null,
      result: { status: "waiting-for-ocr" },
      waiting: true,
    };
  }
  const cursor = JSON.stringify({
    last_created_at: capture.created_at,
    last_capture_id: capture.id,
  });
  let relationship = previousCapture ? "unrelated" : "first-page";
  let assessmentId: string | null = null;
  let result: Record<string, unknown> = {
    status: "boundary",
    current_document_id: capture.id,
  };
  if (!currentDocument) {
    await recordContinuityEdge(
      env,
      capture,
      head,
      previousCapture,
      previousHead,
      "excluded",
      null,
    );
    return { phase: "group" as const, cursor, result: { status: "excluded" } };
  }
  if (previousCapture) {
    const immediateDocument = previous!.document;
    let precedingDocument = immediateDocument;
    if (head.role === "receipt" && previousHead!.role === "payment_evidence") {
      const earlier = await precedingActivePage(
        env,
        previousCapture,
        run,
        loadCapture,
        true,
      );
      if (earlier) {
        const receiptDocument = earlier.document;
        if (receiptDocument.id !== immediateDocument.id) {
          if (!(await documentsAreUnlocked(env, [immediateDocument])))
            return {
              phase: "group" as const,
              cursor: run.cursor,
              result: { status: "busy" },
              busy: true,
            };
          await finalizePipelineDocument(env, immediateDocument);
          precedingDocument = receiptDocument;
        }
      }
    }
    if (currentDocument.id === precedingDocument.id) {
      relationship = "already-grouped";
      result = { status: "verified", document_id: currentDocument.id };
    } else {
      let decision: Awaited<ReturnType<typeof compareDocuments>> = null;
      if (
        ["receipt", "payment_evidence"].includes(head.role) &&
        ["receipt", "payment_evidence"].includes(previousHead!.role)
      ) {
        const [currentEvidence, precedingEvidence] = await Promise.all([
          documentEvidence(env, currentDocument),
          documentEvidence(env, precedingDocument),
        ]);
        if (!currentEvidence || !precedingEvidence) {
          if (
            !(await markDocumentsWaitingForOcr(env, [
              currentDocument,
              precedingDocument,
            ]))
          )
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
        if (currentEvidence.ocr.truncated || precedingEvidence.ocr.truncated) {
          relationship = "unresolved-ocr-too-long";
          result = {
            status: "ocr-too-long",
            current_document_id: precedingDocument.id,
            next_document_id: currentDocument.id,
          };
        } else
          decision = await compareDocuments(
            env,
            currentDocument,
            precedingDocument,
            { remaining: 1 },
            "document-relationship-scan-v1",
            { current: currentEvidence, candidate: precedingEvidence },
          );
      }
      relationship = decision?.answer.choice ?? relationship;
      assessmentId = decision?.assessment_id ?? null;
      if (decision && shouldAutoMerge(decision.answer)) {
        if (currentDocument.processing || precedingDocument.processing)
          result = {
            status: "luna-disagreement",
            current_document_id: precedingDocument.id,
            next_document_id: currentDocument.id,
            relationship,
            assessment_id: assessmentId,
          };
        else if (
          !(await documentsAreUnlocked(env, [
            currentDocument,
            precedingDocument,
          ]))
        )
          return {
            phase: "group" as const,
            cursor: run.cursor,
            result: { status: "busy" },
            busy: true,
          };
        else {
          const relevantIds = [
            ...new Set(
              [...currentDocument.pages, ...precedingDocument.pages].map(
                (page) => page.captureId,
              ),
            ),
          ];
          const roles = new Map(
            (
              await env.DB.prepare(
                `SELECT capture_id,role FROM jev_page_heads WHERE capture_id IN (${relevantIds.map(() => "?").join(",")})`,
              )
                .bind(...relevantIds)
                .all<Pick<PageHead, "capture_id" | "role">>()
            ).results.map((page) => [page.capture_id, page.role]),
          );
          let merged: ReceiptDocument | null;
          try {
            merged = await mergeDocuments(
              request,
              env,
              loadCaptures,
              null,
              currentDocument,
              precedingDocument,
              decision.answer.choice as "continuation" | "payment_match",
              roles,
              null,
              loadCapture,
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
            result = {
              status: "merged",
              document_id: merged.id,
              previous_document_id: precedingDocument.id,
              next_document_id: currentDocument.id,
              relationship,
              assessment_id: assessmentId,
            };
        }
      } else if (decision)
        result = {
          status:
            decision.answer.choice === "duplicate"
              ? "duplicate-suggested"
              : "boundary",
          current_document_id: precedingDocument.id,
          next_document_id: currentDocument.id,
          relationship,
          probability: decision.answer.probabilities[decision.answer.choice],
          confidence: decision.answer.confidence,
          assessment_id: assessmentId,
        };
      if (result.status !== "merged") {
        if (!(await documentsAreUnlocked(env, [precedingDocument])))
          return {
            phase: "group" as const,
            cursor: run.cursor,
            result: { status: "busy" },
            busy: true,
          };
        await finalizePipelineDocument(env, precedingDocument);
      }
    }
  }
  await recordContinuityEdge(
    env,
    capture,
    head,
    previousCapture,
    previousHead,
    relationship,
    assessmentId,
    result.status === "merged",
  );
  return { phase: "group" as const, cursor, result };
}

async function groupPipelineStep(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  loadCapture: (id: string) => Promise<Capture | null>,
  run: JevPipelineRun,
) {
  const cursor = parsePipelineCursor<{
    active_id?: string;
    finalize_id?: string;
  }>(run);
  if (run.version < PAGE_CONTINUITY_PIPELINE_VERSION) {
    const completed = await latestCompletedPipelineRun(env);
    if (
      completed &&
      completed.snapshot_created_at === run.snapshot_created_at &&
      completed.snapshot_capture_id === run.snapshot_capture_id &&
      !(await nextContinuityCapture(env, { ...run, cursor: null }))
    )
      return {
        phase: "dates" as const,
        cursor: null,
        result: { status: "continuity-verified" },
        busy: false,
      };
  }
  if (
    run.version < PAGE_CONTINUITY_PIPELINE_VERSION ||
    cursor?.active_id ||
    cursor?.finalize_id
  )
    return legacyGroupPipelineStep(
      request,
      env,
      loadCaptures,
      await loadCaptures(),
      run,
    );
  return pageGroupPipelineStep(request, env, loadCaptures, loadCapture, run);
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

async function ensureDocumentClassification(
  env: Env,
  document: ReceiptDocument,
  evidence: NonNullable<Awaited<ReturnType<typeof documentEvidence>>>,
  expectedSavedRevision: number | null = null,
) {
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
  const artifacts = await documentOcrArtifactPins(env, document);
  const alreadyCurrent =
    assessment?.task === "document-classification" &&
    (await documentHeadReady(env, document, head, evidence.heads, artifacts));
  if (!alreadyCurrent) {
    const classification = await classifyDocument(
      env,
      document,
      { remaining: 1 },
      expectedSavedRevision,
    );
    requireThat(
      classification,
      503,
      "Final Jev document evidence is unavailable.",
    );
  }
  return alreadyCurrent ? "verified" : "classified";
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
  const status = await ensureDocumentClassification(env, document, evidence);
  for (const page of document.pages)
    await env.DB.prepare(
      "UPDATE jev_jobs SET status='complete',ineligible_reason=NULL,updated_at=? WHERE capture_id=? AND status IN ('classified','waiting')",
    )
      .bind(new Date().toISOString(), page.captureId)
      .run();
  return {
    status,
    document_id: document.id,
  };
}

async function documentPipelineStep(
  env: Env,
  loadCapture: (id: string) => Promise<Capture | null>,
  run: JevPipelineRun,
) {
  const next = await env.DB.prepare(
    `SELECT job.capture_id FROM jev_jobs job
     LEFT JOIN captures ON captures.id=job.capture_id
     WHERE job.status='classified' AND
       (captures.id IS NULL OR (captures.created_at,captures.id)<=(?,?))
     ORDER BY job.created_at,job.id LIMIT 1`,
  )
    .bind(run.snapshot_created_at, run.snapshot_capture_id)
    .first<{ capture_id: string }>();
  if (!next) return { remaining: 0, cursor: null, result: null };
  const capture = await loadCapture(next.capture_id);
  const document = capture?.is_current
    ? await activeDocumentForCapture(env, capture, run, loadCapture)
    : null;
  if (!document) {
    const reason = capture?.is_current
      ? "document_not_active"
      : "capture_not_current";
    await env.DB.prepare(
      "UPDATE jev_jobs SET status='ineligible',ineligible_reason=?,updated_at=? WHERE capture_id=? AND status='classified'",
    )
      .bind(reason, new Date().toISOString(), next.capture_id)
      .run();
    return {
      remaining: 1,
      cursor: null,
      result: { status: "ineligible", reason },
    };
  }
  if (!(await documentsAreUnlocked(env, [document])))
    return {
      remaining: 1,
      cursor: null,
      result: null,
      busy: true,
    };
  const result = await finalizePipelineDocument(env, document);
  return {
    remaining: 1,
    cursor: null,
    result,
  };
}

async function buildDetachedPaymentCandidates(
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
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
  const pageHeadRows = (
    await env.DB.prepare("SELECT * FROM jev_page_heads").all<PageHead>()
  ).results;
  const pageHeadsByCapture = new Map(
    pageHeadRows.map((row) => [row.capture_id, row]),
  );
  type RankedDocument = {
    document: ReceiptDocument;
    dates: Set<string>;
    amounts: Set<number>;
    terms: Set<string>;
  };
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
    const amounts = new Set<number>();
    const terms = new Set<string>();
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
      const matchIndex = parsedPaymentMatchIndex(head!.payment_match_index);
      matchIndex.amounts.forEach((amount) => amounts.add(amount));
      matchIndex.terms.forEach((term) => terms.add(term));
    }
    if (hasReceipt && !hasPayment)
      purchases.push({ document, dates, amounts, terms });
    if (hasPayment && !hasReceipt)
      payments.push({ document, dates, amounts, terms });
  }
  purchases.sort((a, b) => a.document.id.localeCompare(b.document.id));
  payments.sort((a, b) => a.document.id.localeCompare(b.document.id));
  const index: DetachedPaymentIndex = {
    documentCount: documents.length,
    purchases: purchases.map(({ document, dates, amounts, terms }) => ({
      id: document.id,
      dates: [...dates],
      amounts: [...amounts],
      terms: [...terms],
    })),
    payments: payments.map(({ document, dates, amounts, terms }) => ({
      id: document.id,
      dates: [...dates],
      amounts: [...amounts],
      terms: [...terms],
    })),
  };
  await env.DB.prepare(
    "DELETE FROM jev_payment_index_chunks WHERE pipeline_run_id=?",
  )
    .bind(pipelineRun.id)
    .run();
  for (const kind of ["purchases", "payments"] as const) {
    const items = index[kind];
    for (let offset = 0; offset < items.length; offset += 50) {
      await env.DB.prepare(
        "INSERT INTO jev_payment_index_chunks(pipeline_run_id,kind,chunk_index,payload) VALUES(?,?,?,?)",
      )
        .bind(
          pipelineRun.id,
          kind,
          offset / 50,
          JSON.stringify(items.slice(offset, offset + 50)),
        )
        .run();
    }
  }
  await env.DB.prepare(
    "INSERT INTO jev_payment_candidate_runs(pipeline_run_id,document_count,purchase_count,payment_count,next_payment_index,built_at) VALUES(?,?,?,?,0,NULL)",
  )
    .bind(
      pipelineRun.id,
      index.documentCount,
      index.purchases.length,
      index.payments.length,
    )
    .run();
  return { purchases: index.purchases.length, payments: index.payments.length };
}

type DetachedPaymentIndex = {
  documentCount: number;
  purchases: {
    id: string;
    dates: string[];
    amounts: number[];
    terms: string[];
  }[];
  payments: {
    id: string;
    dates: string[];
    amounts: number[];
    terms: string[];
  }[];
};

type PaymentCandidateRun = {
  document_count: number;
  purchase_count: number;
  payment_count: number;
  next_payment_index: number;
  built_at: string | null;
};

async function loadDetachedPaymentIndex(
  env: Env,
  runId: string,
  saved: PaymentCandidateRun,
): Promise<DetachedPaymentIndex> {
  const rows = (
    await env.DB.prepare(
      "SELECT kind,chunk_index,payload FROM jev_payment_index_chunks WHERE pipeline_run_id=? ORDER BY kind,chunk_index",
    )
      .bind(runId)
      .all<{ kind: string; chunk_index: number; payload: string }>()
  ).results;
  const index: DetachedPaymentIndex = {
    documentCount: saved.document_count,
    purchases: [],
    payments: [],
  };
  const expected = { purchases: 0, payments: 0 };
  for (const row of rows) {
    requireThat(
      row.kind === "purchases" || row.kind === "payments",
      503,
      "Stored payment index is invalid.",
    );
    requireThat(
      row.chunk_index === expected[row.kind]++,
      503,
      "Stored payment index has a missing chunk.",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      throw new HttpError(503, "Stored payment index is invalid.");
    }
    requireThat(
      Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 50,
      503,
      "Stored payment index is invalid.",
    );
    index[row.kind].push(...(parsed as DetachedPaymentIndex[typeof row.kind]));
  }
  requireThat(
    index.purchases.length === saved.purchase_count &&
      index.payments.length === saved.payment_count,
    503,
    "Stored payment index is incomplete.",
  );
  return index;
}

async function enqueueDetachedPaymentCandidates(
  env: Env,
  run: JevPipelineRun,
  saved: PaymentCandidateRun,
) {
  const index = await loadDetachedPaymentIndex(env, run.id, saved);
  const purchaseCount = index.purchases.length;
  const paymentCount = index.payments.length;
  requireThat(
    Number.isSafeInteger(saved.next_payment_index) &&
      saved.next_payment_index >= 0 &&
      saved.next_payment_index <= paymentCount,
    503,
    "Stored payment candidate progress is invalid.",
  );
  const end = Math.min(paymentCount, saved.next_payment_index + 5);
  const termFrequency = new Map<string, number>();
  for (const document of [...index.purchases, ...index.payments])
    for (const term of document.terms)
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  const candidates: {
    rank: number;
    pass: string;
    paymentId: string;
    purchaseId: string;
  }[] = [];
  for (
    let paymentIndex = saved.next_payment_index;
    paymentIndex < end;
    paymentIndex++
  ) {
    const payment = index.payments[paymentIndex];
    const paymentDates = new Set(payment.dates);
    const paymentAmounts = new Set(payment.amounts);
    const paymentTerms = new Set(payment.terms);
    const likely = index.purchases.flatMap((purchase) => {
      if (
        purchase.dates.some((date) => paymentDates.has(date)) ||
        purchase.amounts.some((amount) => paymentAmounts.has(amount))
      )
        return [];
      const sharedTerms = purchase.terms.filter(
        (term) =>
          paymentTerms.has(term) &&
          (termFrequency.get(term) ?? 0) <=
            Math.max(5, Math.ceil(index.documentCount * 0.1)),
      );
      const nearbyAmounts = payment.amounts.some((amount) =>
        purchase.amounts.some(
          (other) =>
            Math.abs(amount - other) <=
            Math.max(100, Math.round(amount * 0.05)),
        ),
      );
      if (!sharedTerms.length && !nearbyAmounts) return [];
      return [
        {
          id: purchase.id,
          score: sharedTerms.length * 2 + Number(nearbyAmounts),
        },
      ];
    });
    likely.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const likelyIds = new Set(
      likely.slice(0, 12).map((candidate) => candidate.id),
    );
    for (
      let purchaseIndex = 0;
      purchaseIndex < purchaseCount;
      purchaseIndex++
    ) {
      const purchase = index.purchases[purchaseIndex];
      const pass = purchase.dates.some((date) => paymentDates.has(date))
        ? 0
        : purchase.amounts.some((amount) => paymentAmounts.has(amount))
          ? 1
          : 2;
      if (pass === 2 && !likelyIds.has(purchase.id)) continue;
      candidates.push({
        rank:
          pass * paymentCount * purchaseCount +
          paymentIndex * purchaseCount +
          purchaseIndex +
          1,
        pass: ["date", "amount", "likely"][pass],
        paymentId: payment.id,
        purchaseId: purchase.id,
      });
    }
  }
  let batch: D1PreparedStatement[] = [];
  for (let offset = 0; offset < candidates.length; offset += 20) {
    const chunk = candidates.slice(offset, offset + 20);
    batch.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO jev_payment_candidates(
        pipeline_run_id,rank,pass,payment_document_id,purchase_document_id
      ) VALUES ${chunk.map(() => "(?,?,?,?,?)").join(",")}`,
      ).bind(
        ...chunk.flatMap((candidate) => [
          run.id,
          candidate.rank,
          candidate.pass,
          candidate.paymentId,
          candidate.purchaseId,
        ]),
      ),
    );
    if (batch.length === 20) {
      await env.DB.batch(batch);
      batch = [];
    }
  }
  if (batch.length) await env.DB.batch(batch);
  await env.DB.prepare(
    "UPDATE jev_payment_candidate_runs SET next_payment_index=?,built_at=? WHERE pipeline_run_id=? AND next_payment_index=? AND built_at IS NULL",
  )
    .bind(
      end,
      end === paymentCount ? new Date().toISOString() : null,
      run.id,
      saved.next_payment_index,
    )
    .run();
  return {
    payments: end - saved.next_payment_index,
    candidates: candidates.length,
    complete: end === paymentCount,
  };
}

export function paymentCandidateRank(
  after: string | null,
  index: DetachedPaymentIndex | null,
): number {
  if (after === null) return 0;
  const numeric = Number(after);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  const [pass, paymentId, purchaseId] = after.split("|");
  requireThat(index, 503, "Stored payment candidate index is unavailable.");
  requireThat(
    ["0", "1", "2"].includes(pass) &&
      typeof paymentId === "string" &&
      UUID.test(paymentId) &&
      typeof purchaseId === "string" &&
      UUID.test(purchaseId),
    503,
    "Stored payment candidate cursor is invalid.",
  );
  const paymentIndex = index.payments.findIndex(
    (item) => item.id === paymentId,
  );
  const purchaseIndex = index.purchases.findIndex(
    (item) => item.id === purchaseId,
  );
  return paymentIndex < 0 || purchaseIndex < 0
    ? 0
    : Number(pass) * index.payments.length * index.purchases.length +
        paymentIndex * index.purchases.length +
        purchaseIndex +
        1;
}

async function activePaymentDocument(
  env: Env,
  id: string,
  run: JevPipelineRun,
  loadCapture: (id: string) => Promise<Capture | null>,
): Promise<ReceiptDocument | null> {
  const saved = await storedDocumentById(env, id);
  const first = saved ? null : await loadCapture(id);
  const document = saved ?? (first?.is_current ? newDocument(first) : null);
  if (!document || document.mergedInto || document.duplicateOf) return null;
  for (const page of document.pages) {
    const capture = await loadCapture(page.captureId);
    if (
      !capture?.is_current ||
      !withinPipelineSnapshot(capture, run) ||
      capture.sha256 !== page.sha256
    )
      return null;
  }
  return document;
}

async function reconcileDetachedPayments(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  loadCapture: (id: string) => Promise<Capture | null>,
  after: string | null,
  pipelineRun: JevPipelineRun,
) {
  const unindexed = (
    await env.DB.prepare(
      `SELECT head.* FROM jev_page_heads head
       JOIN captures ON captures.id=head.capture_id
       WHERE (head.date_candidates IS NULL OR head.payment_match_index IS NULL)
         AND head.source_sha256=captures.sha256
         AND (${currentTake})
         AND (captures.created_at,captures.id)<=(?,?)
       ORDER BY head.updated_at,head.capture_id LIMIT 25`,
    )
      .bind(pipelineRun.snapshot_created_at, pipelineRun.snapshot_capture_id)
      .all<PageHead>()
  ).results;
  if (unindexed.length) {
    for (let offset = 0; offset < unindexed.length; offset += 5) {
      const prepared = await Promise.all(
        unindexed.slice(offset, offset + 5).map(async (head) => {
          const capture = await loadCapture(head.capture_id);
          requireThat(
            capture?.is_current && capture.sha256 === head.source_sha256,
            503,
            "Indexed receipt page changed during payment preparation.",
          );
          const document = await documentForCapture(env, capture);
          const page = document.pages.find(
            (item) => item.captureId === head.capture_id,
          );
          requireThat(page, 503, "Indexed receipt page is unavailable.");
          const found = await pinnedPpOcr(env, page, head.ocr_sha256);
          requireThat(
            found,
            503,
            "Pinned PP OCR is unavailable for detached-payment ranking.",
          );
          return env.DB.prepare(
            "UPDATE jev_page_heads SET date_candidates=COALESCE(date_candidates,?),payment_match_index=COALESCE(payment_match_index,?) WHERE capture_id=? AND source_sha256=? AND ocr_sha256=?",
          ).bind(
            JSON.stringify(ocrDateCandidates(found.value.text)),
            JSON.stringify(paymentMatchIndex(found.value.text)),
            head.capture_id,
            head.source_sha256,
            head.ocr_sha256,
          );
        }),
      );
      await env.DB.batch(prepared);
    }
    return {
      result: { status: "indexed", pages: unindexed.length },
      remaining: 1,
      next: after,
    };
  }
  const plan = await env.DB.prepare(
    "SELECT document_count,purchase_count,payment_count,next_payment_index,built_at FROM jev_payment_candidate_runs WHERE pipeline_run_id=?",
  )
    .bind(pipelineRun.id)
    .first<PaymentCandidateRun>();
  if (!plan) {
    const counts = await buildDetachedPaymentCandidates(
      env,
      loadCaptures,
      pipelineRun,
    );
    return {
      result: { status: "payment-index-built", ...counts },
      remaining: 1,
      next: after,
    };
  }
  if (!plan.built_at) {
    const progress = await enqueueDetachedPaymentCandidates(
      env,
      pipelineRun,
      plan,
    );
    return {
      result: { status: "payment-candidates-indexed", ...progress },
      remaining: 1,
      next: after,
    };
  }
  const legacyCursor = after !== null && !/^(0|[1-9]\d*)$/.test(after);
  let lastRank = paymentCandidateRank(
    after,
    legacyCursor
      ? await loadDetachedPaymentIndex(env, pipelineRun.id, plan)
      : null,
  );
  type CandidateRow = {
    rank: number;
    pass: string;
    payment_document_id: string;
    purchase_document_id: string;
  };
  let selected: {
    candidate: CandidateRow;
    purchase: ReceiptDocument;
    payment: ReceiptDocument;
  } | null = null;
  for (let skipped = 0; skipped < 20; skipped++) {
    const candidate = await env.DB.prepare(
      "SELECT rank,pass,payment_document_id,purchase_document_id FROM jev_payment_candidates WHERE pipeline_run_id=? AND rank>? ORDER BY rank LIMIT 1",
    )
      .bind(pipelineRun.id, lastRank)
      .first<CandidateRow>();
    if (!candidate) return { result: null, remaining: 0, next: null };
    const [purchase, payment] = await Promise.all([
      activePaymentDocument(
        env,
        candidate.purchase_document_id,
        pipelineRun,
        loadCapture,
      ),
      activePaymentDocument(
        env,
        candidate.payment_document_id,
        pipelineRun,
        loadCapture,
      ),
    ]);
    if (purchase && payment) {
      selected = { candidate, purchase, payment };
      break;
    }
    lastRank = candidate.rank;
  }
  if (!selected)
    return {
      result: { status: "retired-candidates-skipped" },
      remaining: 1,
      next: String(lastRank),
    };
  const { candidate, purchase, payment } = selected;
  const next = String(candidate.rank);
  const [purchaseEvidence, paymentEvidence] = await Promise.all([
    documentEvidence(env, purchase),
    documentEvidence(env, payment),
  ]);
  if (
    purchaseEvidence?.heads.some((head) => head.role === "payment_evidence") ||
    paymentEvidence?.heads.some((head) => head.role === "receipt")
  )
    return { result: { status: "candidate-retired" }, remaining: 1, next };
  if (purchaseEvidence?.ocr.truncated || paymentEvidence?.ocr.truncated)
    return {
      result: {
        status: "ocr-too-long",
        current_document_id: purchase.id,
        next_document_id: payment.id,
        current_characters: purchaseEvidence?.ocr.characters ?? null,
        next_characters: paymentEvidence?.ocr.characters ?? null,
      },
      remaining: 1,
      next,
    };
  const budget: JevBudget = { remaining: 1 };
  const decision = await compareDocuments(
    env,
    purchase,
    payment,
    budget,
    `${DETACHED_PAYMENT_TASK}-${candidate.pass}`,
    purchaseEvidence && paymentEvidence
      ? { current: purchaseEvidence, candidate: paymentEvidence }
      : undefined,
    "payment",
  );
  if (!decision || !shouldAutoMerge(decision.answer))
    return { result: null, remaining: 1, next };
  if (purchase.processing || payment.processing)
    return {
      result: {
        status: "needs-review",
        current_document_id: purchase.id,
        next_document_id: payment.id,
        relationship: decision.answer.choice,
        probability: decision.answer.probabilities[decision.answer.choice],
        confidence: decision.answer.confidence,
        assessment_id: decision.assessment_id,
        match_pass: candidate.pass,
      },
      remaining: 1,
      next,
    };
  if (!(await documentsAreUnlocked(env, [purchase, payment])))
    return { result: null, remaining: 1, busy: true, next: after };
  const relevantIds = [
    ...new Set(
      [...purchase.pages, ...payment.pages].map((page) => page.captureId),
    ),
  ];
  const roles = new Map(
    (
      await env.DB.prepare(
        `SELECT capture_id,role FROM jev_page_heads WHERE capture_id IN (${relevantIds.map(() => "?").join(",")})`,
      )
        .bind(...relevantIds)
        .all<Pick<PageHead, "capture_id" | "role">>()
    ).results.map((head) => [head.capture_id, head.role]),
  );
  let merged: ReceiptDocument | null;
  try {
    merged = await mergeDocuments(
      request,
      env,
      loadCaptures,
      null,
      purchase,
      payment,
      "payment_match",
      roles,
      null,
      loadCapture,
    );
  } catch (error) {
    if (error instanceof JevMutationBusy)
      return { result: null, remaining: 1, busy: true, next: after };
    throw error;
  }
  if (!merged) return { result: null, remaining: 1, next };
  return {
    result: {
      status: "merged",
      document_id: merged.id,
      payment_document_id: payment.id,
      assessment_id: decision.assessment_id,
      match_pass: candidate.pass,
    },
    remaining: 1,
    next,
  };
}

export async function jevRoute(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  loadCapture: (id: string) => Promise<Capture | null>,
  loadSelectedCaptures?: (ids: string[]) => Promise<Capture[]>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/jev/")) return null;
  requireThat(
    request.headers.has("authorization"),
    403,
    "Jev processing requires scoped machine credentials.",
  );
  if (
    url.pathname === "/api/jev/seed-completed-continuity" &&
    request.method === "POST"
  ) {
    const completed = await latestCompletedPipelineRun(env);
    const input = await bodyJson(request);
    const cutoff = input.replay_completed_at;
    const captureIds = input.capture_ids;
    let repair: { cutoff?: string; captureIds?: string[] } = {};
    // A scan replay may finish while later pipeline phases still run.
    if (cutoff !== undefined || captureIds !== undefined) {
      requireThat(
        typeof cutoff === "string" &&
          !Number.isNaN(Date.parse(cutoff)) &&
          new Date(cutoff).toISOString() === cutoff &&
          completed &&
          cutoff > completed.updated_at &&
          Date.parse(cutoff) <= Date.now() &&
          Array.isArray(captureIds) &&
          captureIds.length > 0 &&
          captureIds.length <= 25 &&
          captureIds.every((id) => typeof id === "string" && UUID.test(id)) &&
          new Set(captureIds).size === captureIds.length,
        400,
        "Provide a later verified replay time and up to 25 capture IDs.",
      );
      const latest = await latestPipelineRun(env);
      requireThat(
        latest &&
          latest.snapshot_created_at === completed.snapshot_created_at &&
          latest.snapshot_capture_id === completed.snapshot_capture_id &&
          cutoff <= latest.updated_at,
        409,
        "Replay snapshot does not match the completed Jev snapshot.",
      );
      repair = { cutoff, captureIds: captureIds as string[] };
    }
    return json({
      seeded: await seedCompletedContinuity(env, completed, repair),
    });
  }
  if (url.pathname === "/api/jev/status" && request.method === "GET") {
    const counts = await env.DB.prepare(
      "SELECT status,COUNT(*) AS count FROM jev_jobs GROUP BY status",
    ).all<{ status: string; count: number }>();
    const ineligibleReasons = await env.DB.prepare(
      "SELECT COALESCE(ineligible_reason,'unspecified') AS reason,COUNT(*) AS count FROM jev_jobs WHERE status='ineligible' GROUP BY COALESCE(ineligible_reason,'unspecified') ORDER BY reason",
    ).all<{ reason: string; count: number }>();
    const pipeline = await latestPipelineRun(env);
    const coverage = await env.DB.prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(head.capture_id IS NULL),0) AS missing_heads,
         COALESCE(SUM(edge.capture_id IS NOT NULL
           AND edge.source_sha256=captures.sha256
           AND edge.ocr_sha256=head.ocr_sha256
           AND (edge.previous_capture_id IS NULL
             OR edge.previous_source_sha256 IS NOT NULL)),0) AS continuity_done
       FROM captures
       LEFT JOIN jev_page_heads head ON head.capture_id=captures.id
         AND head.source_sha256=captures.sha256
       LEFT JOIN jev_continuity_edges edge ON edge.capture_id=captures.id
       WHERE (${currentTake})`,
    ).first<{
      total: number;
      missing_heads: number;
      continuity_done: number;
    }>();
    const waitingCurrentCaptures = await env.DB.prepare(
      `SELECT COUNT(DISTINCT captures.id) AS count FROM jev_jobs job
       JOIN captures ON captures.id=job.capture_id
       WHERE job.status='waiting' AND (${currentTake})`,
    ).first<{ count: number }>();
    const missingPageHeads = await env.DB.prepare(
      `SELECT captures.id FROM captures LEFT JOIN jev_page_heads head
         ON head.capture_id=captures.id AND head.source_sha256=captures.sha256
       WHERE (${currentTake}) AND head.capture_id IS NULL
       ORDER BY captures.created_at,captures.id LIMIT 25`,
    ).all<{ id: string }>();
    const pendingContinuity = await env.DB.prepare(
      `SELECT captures.id AS capture_id,pages.document_id,
         captures.created_at AS scan_created_at,
         role.created_at AS page_role_assessed_at,job.status AS jev_job_status
       FROM captures
       LEFT JOIN document_pages pages ON pages.capture_id=captures.id
       LEFT JOIN jev_page_heads head ON head.capture_id=captures.id
         AND head.source_sha256=captures.sha256
       LEFT JOIN jev_assessments role ON role.id=head.assessment_id
       LEFT JOIN jev_jobs job ON job.capture_id=captures.id
         AND job.ocr_sha256=head.ocr_sha256
       LEFT JOIN jev_continuity_edges edge ON edge.capture_id=captures.id
       WHERE (${currentTake}) AND (edge.capture_id IS NULL
         OR head.capture_id IS NULL
         OR edge.source_sha256!=captures.sha256
         OR edge.ocr_sha256!=head.ocr_sha256
         OR (edge.previous_capture_id IS NOT NULL
           AND edge.previous_source_sha256 IS NULL))
       ORDER BY captures.created_at,captures.id LIMIT 25`,
    ).all<{
      capture_id: string;
      document_id: string | null;
      scan_created_at: string;
      page_role_assessed_at: string | null;
      jev_job_status: string | null;
    }>();
    return json({
      configured: Boolean(env.TYPESAFE_API_KEY),
      jobs: counts.results,
      historical_ineligible_job_reasons: ineligibleReasons.results,
      current_captures_with_waiting_jobs: waitingCurrentCaptures?.count ?? 0,
      current_captures_missing_page_head: coverage?.missing_heads ?? 0,
      missing_page_head_capture_ids: missingPageHeads.results.map(
        (capture) => capture.id,
      ),
      current_captures_continuity_processed: coverage?.continuity_done ?? 0,
      current_captures_continuity_pending:
        (coverage?.total ?? 0) - (coverage?.continuity_done ?? 0),
      pending_continuity: pendingContinuity.results,
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
  if (url.pathname === "/api/jev/group-audit" && request.method === "POST") {
    const input = await bodyJson(request);
    requireThat(
      typeof input.document_id === "string" && UUID.test(input.document_id),
      400,
      "Provide a document ID for group audit.",
    );
    const document = await documentById(env, input.document_id, loadCapture);
    requireThat(
      document && !document.mergedInto && !document.duplicateOf,
      404,
      "Active document not found.",
    );
    requireThat(
      input.revision === document.revision,
      409,
      "Document revision changed before group audit.",
    );
    const index = input.next_page_index;
    requireThat(
      typeof index === "number" &&
        Number.isInteger(index) &&
        index >= 1 &&
        index < document.pages.length,
      400,
      "Choose an existing page after the first page.",
    );
    requireThat(
      input.page_id === document.pages[index].captureId,
      409,
      "Page membership changed before group audit.",
    );
    const fingerprint = await pageFingerprint(document);
    const prior = {
      ...document,
      pages: document.pages.slice(0, index),
    };
    const next = {
      ...document,
      id: document.pages[index].captureId,
      pages: [document.pages[index]],
    };
    const [priorEvidence, nextEvidence] = await Promise.all([
      documentEvidence(env, prior),
      documentEvidence(env, next),
    ]);
    if (!priorEvidence || !nextEvidence)
      return json({
        document_id: document.id,
        revision: document.revision,
        next_page_index: index,
        assessed: false,
        reason: "missing_matching_ocr",
      });
    if (
      priorEvidence.ocr.truncated ||
      nextEvidence.ocr.truncated ||
      priorEvidence.ocr.blank ||
      nextEvidence.ocr.blank
    )
      return json({
        document_id: document.id,
        revision: document.revision,
        next_page_index: index,
        assessed: false,
        reason:
          priorEvidence.ocr.truncated || nextEvidence.ocr.truncated
            ? "ocr_too_long"
            : "blank_ocr",
      });
    const decision = await compareDocuments(
      env,
      next,
      prior,
      { remaining: 1 },
      "document-relationship-audit-scan-v1",
      { current: nextEvidence, candidate: priorEvidence },
    );
    requireThat(decision, 503, "Jev group audit could not be assessed.");
    const current = await documentById(env, document.id, loadCapture);
    requireThat(
      current &&
        current.revision === document.revision &&
        (await pageFingerprint(current)) === fingerprint,
      409,
      "Document changed during group audit; rerun it.",
    );
    const [currentPrior, currentNext] = await Promise.all([
      documentEvidence(env, {
        ...current,
        pages: current.pages.slice(0, index),
      }),
      documentEvidence(env, {
        ...current,
        id: current.pages[index].captureId,
        pages: current.pages.slice(index, index + 1),
      }),
    ]);
    requireThat(
      JSON.stringify(currentPrior?.ocr.pins) ===
        JSON.stringify(priorEvidence.ocr.pins) &&
        JSON.stringify(currentNext?.ocr.pins) ===
          JSON.stringify(nextEvidence.ocr.pins),
      409,
      "OCR evidence changed during group audit; rerun it.",
    );
    return json({
      document_id: document.id,
      revision: document.revision,
      next_page_index: index,
      previous_page_ids: prior.pages.map((page) => page.captureId),
      page_id: next.pages[0].captureId,
      relationship: decision.answer.choice,
      probabilities: decision.answer.probabilities,
      confidence: decision.answer.confidence,
      assessment_id: decision.assessment_id,
      assessed: true,
    });
  }
  if (
    url.pathname === "/api/jev/relationship-benchmark" &&
    request.method === "POST"
  ) {
    const input = await bodyJson(request);
    requireThat(
      typeof input.prompt_variant === "string" &&
        Object.hasOwn(relationshipPrompts, input.prompt_variant),
      400,
      "Choose a supported relationship prompt.",
    );
    const variant = input.prompt_variant as RelationshipPrompt;
    const validIds = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.length >= 1 &&
      value.length <= 4 &&
      value.every((id) => typeof id === "string" && UUID.test(id)) &&
      new Set(value).size === value.length;
    requireThat(
      validIds(input.left_page_ids) &&
        validIds(input.right_page_ids) &&
        new Set([...input.left_page_ids, ...input.right_page_ids]).size ===
          input.left_page_ids.length + input.right_page_ids.length,
      400,
      "Provide two disjoint groups of current page IDs.",
    );
    const requestedIds = [...input.left_page_ids, ...input.right_page_ids];
    const captures = loadSelectedCaptures
      ? await loadSelectedCaptures(requestedIds)
      : await Promise.all(requestedIds.map(loadCapture));
    requireThat(
      captures.length === requestedIds.length &&
        captures.every((capture) => capture?.is_current),
      404,
      "Benchmark page is not a current source page.",
    );
    const captureById = new Map(
      (captures as Capture[]).map((capture) => [capture.id, capture]),
    );
    const currentIds = new Set(requestedIds);
    const documents = await Promise.all(
      requestedIds.map((id) => documentForCapture(env, captureById.get(id)!)),
    );
    const available = new Map(
      requestedIds.flatMap((id, index) => {
        const document = documents[index];
        if (document.mergedInto || document.duplicateOf) return [];
        const page = document.pages.find((item) => item.captureId === id);
        return page ? [[id, { document, page }] as const] : [];
      }),
    );
    const group = (ids: string[]): ReceiptDocument => {
      const first = available.get(ids[0]);
      requireThat(first, 404, "Benchmark page is not in an active document.");
      const pages = ids.map((id) => {
        const selected = available.get(id);
        requireThat(
          selected && currentIds.has(id),
          404,
          "Benchmark page is not a current source page.",
        );
        return selected.page;
      });
      return { ...first.document, id: ids[0], pages };
    };
    const left = group(input.left_page_ids);
    const right = group(input.right_page_ids);
    const [leftEvidence, rightEvidence] = await Promise.all([
      documentEvidence(env, left),
      documentEvidence(env, right),
    ]);
    requireThat(
      leftEvidence &&
        rightEvidence &&
        !leftEvidence.ocr.truncated &&
        !rightEvidence.ocr.truncated &&
        !leftEvidence.ocr.blank &&
        !rightEvidence.ocr.blank,
      409,
      "Benchmark requires complete saved OCR for both page groups.",
    );
    const state = {
      current: {
        document_id: right.id,
        ocr: rightEvidence.ocr.text,
        pins: rightEvidence.ocr.pins,
      },
      candidate: {
        document_id: left.id,
        ocr: leftEvidence.ocr.text,
        pins: leftEvidence.ocr.pins,
      },
    };
    const response = await callJev(env, state, relationshipQuestion(variant), {
      remaining: 1,
    });
    const answer = response.answers.relationship;
    validateChoice(answer, Object.keys(relationshipPrompts[variant].criteria));
    // This is an immutable-evidence experiment, not a current-document finding.
    // A retake or newer OCR during inference does not change what Jev saw.
    return json({
      evidence_scope: "request_snapshot",
      prompt_variant: variant,
      model: response.model,
      relationship: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      left_page_ids: input.left_page_ids,
      right_page_ids: input.right_page_ids,
      ocr_pins: { left: leftEvidence.ocr.pins, right: rightEvidence.ocr.pins },
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
    const selected = await env.DB.prepare(
      `SELECT id,virtual FROM (
         SELECT h.id AS id,0 AS virtual FROM document_heads h
         JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
         WHERE h.id>? AND json_extract(v.payload,'$.mergedInto') IS NULL
           AND json_extract(v.payload,'$.duplicateOf') IS NULL
         UNION ALL
         SELECT captures.id AS id,1 AS virtual FROM captures
         LEFT JOIN document_pages page ON page.capture_id=captures.id
         LEFT JOIN document_heads saved ON saved.id=captures.id
         WHERE captures.id>? AND page.capture_id IS NULL AND saved.id IS NULL
           AND (${currentTake})
       ) ORDER BY id LIMIT ?`,
    )
      .bind(after ?? "", after ?? "", limit + 1)
      .all<{ id: string; virtual: number }>();
    const savedIds = selected.results
      .filter((row) => !row.virtual)
      .map((row) => row.id);
    const virtualIds = selected.results
      .filter((row) => row.virtual)
      .map((row) => row.id);
    const saved = await storedDocumentsByIds(env, savedIds);
    const captures = loadSelectedCaptures
      ? await loadSelectedCaptures(virtualIds)
      : await Promise.all(virtualIds.map(loadCapture));
    requireThat(
      captures.every((capture) => capture !== null),
      503,
      "A selected Jev document page is unavailable.",
    );
    const virtual = new Map(
      (captures as Capture[]).map((capture) => [
        capture.id,
        newDocument(capture),
      ]),
    );
    const candidates = selected.results.map((row) => {
      const document = row.virtual ? virtual.get(row.id) : saved.get(row.id);
      requireThat(document, 503, "A selected Jev document is unavailable.");
      return document;
    });
    const documents = candidates.slice(0, limit);
    const { audits: completenessAudits } = await loadCompletenessAudits(
      env,
      documents,
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
      const evidence = summary.ready
        ? await documentEvidence(env, document)
        : null;
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
        kind: document.kind,
        revision: document.revision,
        ready: summary.ready,
        ocr_characters: evidence?.ocr.characters ?? null,
        ocr_truncated: evidence?.ocr.truncated ?? null,
        completeness_audit: completenessAudits.get(document.id) ?? null,
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
  if (url.pathname === "/api/jev/completeness" && request.method === "POST") {
    const input = await bodyJson(request);
    requireThat(
      typeof input.document_id === "string" && UUID.test(input.document_id),
      400,
      "Provide a document ID for completeness assessment.",
    );
    const document = await documentById(env, input.document_id, loadCapture);
    requireThat(
      document && !document.mergedInto && !document.duplicateOf,
      404,
      "Current document not found.",
    );
    const summary = await jevSummary(env, document);
    if (!summary.ready)
      return json({
        document_id: document.id,
        revision: document.revision,
        result: "not_ready",
        assessed: false,
        reason: "Jev or PP evidence is pending",
      });
    if (
      summary.document?.role !== "purchase_document" ||
      !canAssessReceiptCompleteness(document.kind)
    )
      return json({
        document_id: document.id,
        revision: document.revision,
        result: "not_purchase",
        assessed: false,
        reason: summary.document?.role ?? "Jev classification is pending",
      });
    const evidence = await documentEvidence(env, document);
    requireThat(evidence, 409, "Current PP OCR evidence is incomplete.");
    const fingerprint = await pageFingerprint(document);
    const issueChoices = [
      "none",
      "missing_total",
      "missing_lines_or_page",
      "page_or_slip_mismatch",
      "unreadable_or_uncertain",
      "evidence_too_long",
      "not_receipt",
    ];
    const saved = await assess(
      env,
      COMPLETENESS_TASK,
      {
        ocr_text: evidence.ocr.text,
        truncated: evidence.ocr.truncated,
        pins: evidence.ocr.pins,
        page_fingerprint: fingerprint,
        decision_criteria: COMPLETENESS_DECISIONS,
      },
      { id: document.id, revision: document.revision },
      null,
      () =>
        evidence.ocr.truncated
          ? Promise.resolve({
              model: "rule:oversized-ocr",
              answers: {
                completeness: {
                  type: "choice" as const,
                  choice: "no",
                  probabilities: { yes: 0, no: 1, not_receipt: 0 },
                  confidence: 1,
                },
                issue: {
                  type: "choice" as const,
                  choice: "evidence_too_long",
                  probabilities: Object.fromEntries(
                    issueChoices.map((key) => [
                      key,
                      key === "evidence_too_long" ? 1 : 0,
                    ]),
                  ),
                  confidence: 1,
                },
              },
            })
          : callJev(
              env,
              { ocr_text: evidence.ocr.text },
              {
                decision: {
                  type: "choice",
                  instructions:
                    "Choose one outcome for this purchase paper as a whole. Check all pages, line sections, and its own printed total. Do not use a card slip to supply a missing receipt total. If completeness is uncertain, choose unreadable_or_uncertain.",
                  criteria: COMPLETENESS_DECISIONS,
                },
              },
            ).then((response) => {
              requireThat(
                response.answers.decision,
                503,
                "Jev omitted the completeness decision.",
              );
              return {
                ...response,
                answers: normalizeCompletenessDecision(
                  response.answers.decision,
                ),
              };
            }),
      (result) => {
        validateChoice(
          result.answers.completeness,
          ["yes", "no", "not_receipt"],
          "completeness outcome",
        );
        validateChoice(
          result.answers.issue,
          issueChoices,
          "completeness issue",
        );
        requireThat(
          (result.answers.completeness.choice === "yes") ===
            (result.answers.issue.choice === "none") &&
            (result.answers.completeness.choice === "not_receipt") ===
              (result.answers.issue.choice === "not_receipt"),
          503,
          "Jev returned conflicting completeness answers.",
        );
      },
    );
    const current = await documentById(env, document.id, loadCapture);
    const currentEvidence = current
      ? await documentEvidence(env, current)
      : null;
    requireThat(
      current &&
        current.revision === document.revision &&
        (await pageFingerprint(current)) === fingerprint &&
        JSON.stringify(currentEvidence?.ocr.pins) ===
          JSON.stringify(evidence.ocr.pins),
      409,
      "Document changed during completeness assessment; rerun it.",
    );
    return json({
      document_id: document.id,
      revision: document.revision,
      result: saved.result.answers.completeness.choice,
      issue: saved.result.answers.issue.choice,
      confidence: saved.result.answers.completeness.confidence,
      assessment_id: saved.id,
      assessed: true,
    });
  }
  const refreshDocument =
    request.method === "POST"
      ? url.pathname.match(/^\/api\/jev\/documents\/([0-9a-f-]{36})\/refresh$/)
      : null;
  if (refreshDocument) {
    requireThat(UUID.test(refreshDocument[1]), 400, "Invalid document ID.");
    requireThat(
      !(await activePipelineRun(env)),
      409,
      "Jev pipeline is active.",
    );
    const document = await storedDocumentById(env, refreshDocument[1]);
    requireThat(
      document &&
        !document.mergedInto &&
        !document.duplicateOf &&
        document.pages.length > 0,
      404,
      "Current document not found.",
    );
    const currentSources = async () => {
      for (const page of document.pages) {
        const capture = await loadCapture(page.captureId);
        if (!capture?.is_current || capture.sha256 !== page.sha256)
          return false;
      }
      return true;
    };
    requireThat(
      await currentSources(),
      409,
      "Document contains a superseded scan.",
    );
    const evidence = await documentEvidence(env, document);
    requireThat(evidence, 409, "Current PP OCR evidence is incomplete.");
    requireThat(
      await documentsAreUnlocked(env, [document]),
      409,
      "Document is being edited or processed.",
    );
    const status = await ensureDocumentClassification(
      env,
      document,
      evidence,
      document.revision,
    );
    const current = await storedDocumentById(env, document.id);
    requireThat(
      current?.revision === document.revision &&
        (await currentSources()) &&
        (await jevSummary(env, current)).ready,
      409,
      "Document changed during Jev classification.",
    );
    return json({ status, document_id: document.id });
  }
  if (url.pathname === "/api/jev/backfill" && request.method === "POST") {
    const blocked = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM jev_jobs WHERE status='blocked'",
    ).first<{ count: number }>();
    let loadedCaptures: Capture[] | null = null;
    const capturesForStep = async () =>
      (loadedCaptures ??= await loadCaptures());
    let run = await activePipelineRun(env);
    if (!run) {
      const latest = await latestPipelineRun(env);
      await seedCompletedContinuity(env, await latestCompletedPipelineRun(env));
      const boundary = await currentBoundary(env);
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
        const candidate = await firstUnqueuedArtifact(env, probe);
        if (candidate)
          await queueJevJob(env, candidate.capture_id, candidate.sha256);
      }
      if (!(await pipelineNeedsRun(env, boundary, latest)))
        return json({
          result: null,
          phase: "complete",
          remaining: 0,
          busy: false,
          waiting: await hasCurrentWaitingCapture(env),
          blocked: blocked?.count ?? 0,
        });
      run = await startPipelineRun(env, boundary);
      if (!run)
        return json({
          result: null,
          phase: "complete",
          remaining: 0,
          busy: false,
          waiting: await hasCurrentWaitingCapture(env),
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
        const step = await pagePipelineStep(request, env, loadCapture, run);
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
          capturesForStep,
          loadCapture,
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
          capturesForStep,
          loadCapture,
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
        const step = await documentPipelineStep(env, loadCapture, run);
        const phase = step.remaining === 0 ? "complete" : "documents";
        await savePipelineStep(env, run, token, phase, step.cursor);
        saved = true;
        if (
          phase === "complete" &&
          (await pipelineNeedsRun(env, await currentBoundary(env), run))
        ) {
          const next = await startPipelineRun(env, await currentBoundary(env));
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

export async function paymentMatchesRoute(
  request: Request,
  env: Env,
  loadSelectedCaptures: (ids: string[]) => Promise<Capture[]>,
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/api/payment-matches" ||
    request.method !== "GET"
  )
    return null;
  const rows = (
    await env.DB.prepare(
      `SELECT id,task,subject_id,candidate_id,payload,created_at
       FROM jev_assessments WHERE task LIKE ?
         AND json_extract(payload,'$.response.answers.relationship.choice')='payment_match'
       ORDER BY created_at DESC,id DESC`,
    )
      .bind(`${DETACHED_PAYMENT_TASK}-%`)
      .all<{
        id: string;
        task: string;
        subject_id: string;
        candidate_id: string;
        payload: string;
        created_at: string;
      }>()
  ).results;
  const pinIds = [
    ...new Set(
      rows.flatMap((row) => {
        const payload = JSON.parse(row.payload) as {
          input?: {
            current?: { pins?: unknown };
            candidate?: { pins?: unknown };
          };
        };
        return [payload.input?.current?.pins, payload.input?.candidate?.pins]
          .flatMap((pins) => (Array.isArray(pins) ? pins : []))
          .map((pin) => pin?.capture_id)
          .filter(
            (id): id is string => typeof id === "string" && UUID.test(id),
          );
      }),
    ),
  ];
  const captures = await loadSelectedCaptures(pinIds);
  const captureById = new Map(captures.map((capture) => [capture.id, capture]));
  const assigned = new Map<string, string>();
  for (let offset = 0; offset < pinIds.length; offset += 99) {
    const chunk = pinIds.slice(offset, offset + 99);
    const owners = await env.DB.prepare(
      `SELECT capture_id,document_id FROM document_pages
       WHERE capture_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ capture_id: string; document_id: string }>();
    for (const owner of owners.results)
      assigned.set(owner.capture_id, owner.document_id);
  }
  const saved = await storedDocumentsByIds(env, [
    ...new Set([...assigned.values(), ...pinIds]),
  ]);
  const documents = [
    ...new Map(
      pinIds.flatMap((id) => {
        const capture = captureById.get(id);
        if (!capture?.is_current) return [];
        const document =
          saved.get(assigned.get(id) ?? id) ?? newDocument(capture);
        return document.mergedInto || document.duplicateOf
          ? []
          : [[document.id, document] as const];
      }),
    ).values(),
  ];
  const ownerByPage = new Map(
    documents.flatMap((document) =>
      document.pages.map((page) => [page.captureId, document.id] as const),
    ),
  );
  const documentById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const currentPages = new Map(
    documents.flatMap((document) =>
      document.pages.map((page) => [page.captureId, page] as const),
    ),
  );
  const headsByPage = new Map<
    string,
    Pick<PageHead, "capture_id" | "source_sha256" | "ocr_sha256">
  >();
  for (let offset = 0; offset < pinIds.length; offset += 99) {
    const chunk = pinIds.slice(offset, offset + 99);
    const heads = await env.DB.prepare(
      `SELECT capture_id,source_sha256,ocr_sha256 FROM jev_page_heads
       WHERE capture_id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<Pick<PageHead, "capture_id" | "source_sha256" | "ocr_sha256">>();
    for (const head of heads.results) headsByPage.set(head.capture_id, head);
  }
  const resolvePins = (value: unknown) => {
    if (!Array.isArray(value) || !value.length) return null;
    const pins = value as { capture_id?: string; ocr_sha256?: string }[];
    const owner = ownerByPage.get(pins[0].capture_id ?? "");
    if (
      !owner ||
      !pins.every((pin) => ownerByPage.get(pin.capture_id ?? "") === owner)
    )
      return null;
    return {
      owner,
      sameGroup: documentById.get(owner)?.pages.length === pins.length,
      current: pins.every((pin) => {
        const page = currentPages.get(pin.capture_id ?? "");
        const head = headsByPage.get(pin.capture_id ?? "");
        return Boolean(
          page &&
          head?.source_sha256 === page.sha256 &&
          head.ocr_sha256 === pin.ocr_sha256,
        );
      }),
    };
  };
  const matches = rows.flatMap((row) => {
    const payload = JSON.parse(row.payload) as {
      input?: { current?: { pins?: unknown }; candidate?: { pins?: unknown } };
      response?: JevResponse;
    };
    const answer = payload.response?.answers.relationship;
    if (answer?.choice !== "payment_match") return [];
    const receipt = resolvePins(payload.input?.current?.pins);
    const slip = resolvePins(payload.input?.candidate?.pins);
    const evidenceCurrent = Boolean(receipt?.current && slip?.current);
    const separateGroupsCurrent = Boolean(
      evidenceCurrent && receipt?.sameGroup && slip?.sameGroup,
    );
    return [
      {
        assessment_id: row.id,
        matched_at: row.created_at,
        match_pass: row.task.slice(DETACHED_PAYMENT_TASK.length + 1),
        receipt_document_id: receipt?.owner ?? row.subject_id,
        payment_document_id: slip?.owner ?? row.candidate_id,
        original_receipt_document_id: row.subject_id,
        original_payment_document_id: row.candidate_id,
        status:
          !receipt || !slip
            ? "changed"
            : receipt.owner === slip.owner
              ? "attached"
              : separateGroupsCurrent
                ? "needs-review"
                : "changed",
        evidence_current: evidenceCurrent,
        probability: answer.probabilities.payment_match,
        confidence: answer.confidence,
      },
    ];
  });
  return json({ matches });
}
