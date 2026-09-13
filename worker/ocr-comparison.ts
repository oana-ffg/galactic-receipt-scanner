import type { Env } from "./index";
import type { ReceiptDocument } from "../web/documents";
import { financialTypes, type Extraction } from "../web/extraction";
import type { OcrArtifact } from "../web/ocr-data";
export interface OcrComparison {
  status:
    "no-disagreement-detected" | "disagreement" | "missing" | "not-applicable";
  disagreements: string[];
  artifacts: { capture_id: string; sha256: string }[];
  resolution: string | null;
}
function amounts(text: string, digits: number): Set<number> {
  const result = new Set<number>();
  const regex = digits
    ? new RegExp(
        `[-+−]?(?:\\d{1,3}(?:[ .]\\d{3})+|\\d+)(?:[.,]\\d{${digits}}|[.,]-)(?!\\d)`,
        "g",
      )
    : /[-+−]?\d+(?!\d)/g;
  for (const match of text.matchAll(regex)) {
    const raw = match[0]
      .replace("−", "-")
      .replace(/[.,]-$/, "," + "0".repeat(digits));
    const normalized = digits
      ? raw.slice(0, -digits - 1).replace(/[ .,]/g, "") +
        "." +
        raw.slice(-digits)
      : raw;
    const n = Math.round(Number(normalized) * 10 ** digits);
    if (Number.isSafeInteger(n)) result.add(n);
  }
  return result;
}
export function compareOcrNumbers(e: Extraction, text: string): string[] {
  if (!financialTypes.includes(e.type) || !e.currency) return [];
  const digits =
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: e.currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const rows = text
    .split("\n")
    .map((text) => ({ text, amounts: [...amounts(text, digits)] }));
  const problems: string[] = [];
  const check = (
    label: string,
    value: number | null,
    candidates: Set<number>,
  ) => {
    if (value !== null && (candidates.size !== 1 || !candidates.has(value)))
      problems.push(
        `${label}: model read ${value} minor units; plain OCR reads different or unreadable amounts in the corresponding text. Check the original image.`,
      );
  };
  const field = (pattern: RegExp) => {
    const matching = rows.filter(
      (r) => pattern.test(r.text) && r.amounts.length,
    );
    return new Set(matching.map((r) => r.amounts.at(-1)!));
  };
  const totals = field(/\b(total|i alt|at betale|til betaling|amount due)\b/i);
  check("Printed total", e.total_minor, totals);
  const charged = rows.filter(
    (r) =>
      /\b(betalt|charged|paid|dankort|visa|mastercard)\b/i.test(r.text) &&
      r.amounts.length,
  );
  check(
    "Charged total",
    e.charged_total_minor,
    charged.length
      ? new Set(charged.map((r) => r.amounts.at(-1)!))
      : e.charged_total_minor === e.total_minor
        ? totals
        : new Set(),
  );
  check("VAT", e.vat_minor, field(/\b(moms|vat|mva|tax)\b/i));
  const words = (s: string) =>
    new Set(s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  const consumed = new Set<(typeof rows)[number]>();
  for (const [i, line] of e.line_items.entries()) {
    const tokens = words(line.description);
    const matches = rows
      .map((row) => ({
        row,
        score:
          [...tokens].filter((t) => words(row.text).has(t)).length /
          Math.max(1, tokens.size),
      }))
      .filter(
        (r) => r.score >= 0.5 && r.row.amounts.length && !consumed.has(r.row),
      )
      .sort((a, b) => b.score - a.score);
    const aligned = matches
      .filter((m) => m.score === matches[0]?.score)
      .map((m) => m.row);
    if (!aligned.length) {
      problems.push(
        `Line ${i + 1} cannot be aligned with an unused plain OCR row; inspect its description and amounts on the original.`,
      );
      continue;
    }
    const selected = aligned[0];
    consumed.add(selected);
    const best = [selected];
    check(
      `Line ${i + 1} amount`,
      line.amount_minor,
      new Set(best.map((r) => r.amounts.at(-1)!)),
    );
    check(
      `Line ${i + 1} unit price`,
      line.unit_price_minor,
      new Set(
        best[0].amounts.length > 1 ? [best[0].amounts[0]] : best[0].amounts,
      ),
    );
    if (line.quantity !== null && best.length) {
      const quantities = best.flatMap((r) =>
        [...r.text.matchAll(/[-+−]?\d+(?:[.,]\d+)?/g)].map((m) =>
          Number(m[0].replace(",", ".").replace("−", "-")),
        ),
      );
      if (!quantities.includes(line.quantity))
        problems.push(
          `Line ${i + 1} quantity differs from or is absent in plain OCR; inspect the original.`,
        );
    }
  }
  for (const a of [...e.adjustments, ...e.payment_adjustments]) {
    const tokens = words(a.description);
    const matching = rows.filter(
      (r) => [...tokens].some((t) => words(r.text).has(t)) && r.amounts.length,
    );
    check(
      a.description,
      a.amount_minor,
      new Set(matching.map((r) => r.amounts.at(-1)!)),
    );
  }
  return problems;
}
export async function compareStoredOcr(
  env: Env,
  doc: ReceiptDocument,
  e: Extraction,
): Promise<OcrComparison> {
  if (!financialTypes.includes(e.type))
    return {
      status: "not-applicable",
      disagreements: [],
      artifacts: [],
      resolution: null,
    };
  const artifacts: OcrComparison["artifacts"] = [],
    texts: string[] = [],
    missing: string[] = [];
  for (const page of doc.pages) {
    const rows = await env.DB.prepare(
      "SELECT key,sha256 FROM artifacts WHERE capture_id=? AND kind='ocr' ORDER BY created_at DESC,key DESC",
    )
      .bind(page.captureId)
      .all<{ key: string; sha256: string }>();
    let found = false;
    for (const row of rows.results) {
      const object = await env.BUCKET.get(row.key);
      if (!object) continue;
      const value = await object.json<OcrArtifact>();
      if (
        value.source?.captureId !== page.captureId ||
        value.source?.sha256 !== page.sha256 ||
        typeof value.provenance?.engine !== "string" ||
        !value.provenance.engine.startsWith("tesseract.js") ||
        typeof value.text !== "string"
      )
        continue;
      texts.push(value.text);
      artifacts.push({ capture_id: page.captureId, sha256: row.sha256 });
      found = true;
      break;
    }
    if (!found)
      missing.push(
        `Plain OCR is missing for page ${doc.pages.indexOf(page) + 1}; run it before trusting numeric agreement.`,
      );
  }
  const disagreements = [...missing, ...compareOcrNumbers(e, texts.join("\n"))];
  return {
    status: missing.length
      ? "missing"
      : disagreements.length
        ? "disagreement"
        : "no-disagreement-detected",
    disagreements,
    artifacts,
    resolution: null,
  };
}
