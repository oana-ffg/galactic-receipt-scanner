import type { Env } from "./index";
import { HttpError, requireThat } from "./http";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const JEV_MODEL = "jev-1.13.0";

export const COMPLETENESS_DECISIONS = {
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

export const detachedPaymentQuestion = {
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

export const scanRelationshipQuestion = {
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

export const relationshipPrompts = {
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

export type RelationshipPrompt = keyof typeof relationshipPrompts;

export function relationshipQuestion(variant: RelationshipPrompt) {
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

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevResponse = {
  model: string;
  answers: Record<string, ChoiceAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export type JevBudget = { remaining: number };

class JevCheckpoint extends Error {}

export function shouldAutoMerge(answer: ChoiceAnswer) {
  return answer.choice === "continuation" || answer.choice === "payment_match";
}

export function validateChoice(
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

export async function callJev(
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
