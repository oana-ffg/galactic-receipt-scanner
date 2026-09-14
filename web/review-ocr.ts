import { api } from "./api";
import { sha256 } from "./checksum";
import { messageOf } from "./errors";
import type { DocumentView } from "./documents";

export interface ReviewOcr {
  engine: string;
  pages: {
    number: number;
    text: string;
    createdAt: string;
    sameRegion: boolean;
    sha256: string;
  }[];
}
/** Load existing artifacts only. Opening comparison never starts OCR. */
export async function readReviewOcr(doc: DocumentView, signal?: AbortSignal) {
  const errors: string[] = [];
  const requestSignal = () =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000);
  const engines = new Map<string, ReviewOcr>();
  for (const [index, page] of doc.pages.entries()) {
    signal?.throwIfAborted();
    let detail;
    try {
      detail = await api<{
        artifacts: { kind: string; sha256: string; created_at: string }[];
      }>(`/api/captures/${page.captureId}`, { signal: requestSignal() });
    } catch (error) {
      signal?.throwIfAborted();
      errors.push(`Page ${index + 1}: ${messageOf(error)}`);
      continue;
    }
    const candidates = new Map<string, ReviewOcr["pages"][number]>();
    for (const artifact of detail.artifacts.filter((a) => a.kind === "ocr")) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(
          `/api/files/${page.captureId}/ocr?version=${encodeURIComponent(artifact.sha256)}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            redirect: "error",
            signal: requestSignal(),
          },
        );
        if (!response.ok)
          throw Error(
            `Could not load saved OCR for page ${index + 1}. Retry to include it in the comparison.`,
          );
        const bytes = await response.arrayBuffer();
        signal?.throwIfAborted();
        if ((await sha256(bytes)) !== artifact.sha256)
          throw Error(`Saved OCR checksum mismatch on page ${index + 1}.`);
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (
          value.source?.captureId !== page.captureId ||
          value.source?.sha256 !== page.sha256
        )
          continue;
        const engine = value.provenance?.engine;
        if (typeof engine !== "string" || typeof value.text !== "string")
          throw Error(
            `Saved OCR on page ${index + 1} has no engine or transcript.`,
          );
        const region = value.source.region;
        const crop = page.crop;
        const sameRegion = Boolean(
          region &&
          (crop
            ? region.left === crop[0] &&
              region.top === crop[1] &&
              region.width === crop[2] - crop[0] &&
              region.height === crop[3] - crop[1]
            : region.left === 0 &&
              region.top === 0 &&
              region.width === value.source.pixels?.[0] &&
              region.height === value.source.pixels?.[1]) &&
          (value.source.rotation ?? 0) === page.rotation,
        );
        // Prefer the current crop; within either region class the API's newest version wins.
        const previous = candidates.get(engine);
        if (previous && (previous.sameRegion || !sameRegion)) continue;
        candidates.set(engine, {
          number: index + 1,
          text: value.text,
          createdAt: artifact.created_at,
          sameRegion,
          sha256: artifact.sha256,
        });
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(
          `Page ${index + 1}, OCR saved ${artifact.created_at}: ${messageOf(error)}`,
        );
      }
    }
    for (const [engine, reading] of candidates) {
      const group = engines.get(engine) ?? { engine, pages: [] };
      group.pages.push(reading);
      engines.set(engine, group);
    }
  }
  signal?.throwIfAborted();
  return { engines: [...engines.values()], errors };
}

/** Verbatim candidate lines, not inferred or normalized OCR field values. */
export function ocrExcerpts(ocr: ReviewOcr, field: string): string[] {
  const patterns: Record<string, RegExp> = {
    receipt_date:
      /\b(?:\d{4}([./-])[\dA-Z]{1,2}\1[\dA-Z]{1,2}|[\dA-Z]{1,2}([./-])[\dA-Z]{1,2}\2\d{2,4})\b/i,
    total_minor: /\b(total|i alt|at betale|til betaling|amount due)\b/i,
    charged_total_minor:
      /\b(betalt|charged|paid|dankort|visa|mastercard|kreditkort)\b/i,
    vat_minor: /\b(moms|vat|mva|tax)\b/i,
    reference:
      /\b(reference|receipt no|invoice no|fakturanr|bilagsnr|bonnr)\b/i,
    currency: /\b(currency|valuta|DKK|EUR|USD|GBP|SEK|NOK|kr)\b/i,
  };
  const pattern = patterns[field];
  if (!pattern) return [];
  return ocr.pages.flatMap((page) =>
    page.text
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => `Page ${page.number}: ${line}`),
  );
}
