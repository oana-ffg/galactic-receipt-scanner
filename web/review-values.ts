import type { DocumentView } from "./documents";
import type { Extraction } from "./extraction";

export interface SavedReading {
  revision: number;
  stage: string;
  model: string;
  created_at: string;
  extraction: Extraction;
  sources: { capture_id: string; sha256: string }[];
}
export interface ReviewReadings {
  attempts: SavedReading[];
  readings: {
    revision: number;
    model: string;
    created_at: string;
    initial: unknown;
    confirmation: unknown;
    updated: unknown;
  }[];
}
export function reviewValues(doc: DocumentView, attempts: SavedReading[]) {
  const current = attempts
    .filter(
      (a) =>
        a.revision <= doc.revision &&
        a.sources?.length === doc.pages.length &&
        a.sources.every(
          (s, i) =>
            s.capture_id === doc.pages[i].captureId &&
            s.sha256 === doc.pages[i].sha256,
        ),
    )
    .sort((a, b) => b.revision - a.revision);
  const models = current.filter(
    (a, index) => current.findIndex((b) => b.model === a.model) === index,
  );
  const luna = current.find((a) => a.stage === "small");
  const astra = current.find((a) => a.stage === "large");
  const human = current.find((a) => a.stage === "human");
  const p = doc.processing!;
  // Reprocessing invalidates older model reviews even when the pages are unchanged.
  const selected = p.has_human_review
    ? human
    : p.large_model_confidence !== null
      ? astra
      : p.small_model_certainty !== null
        ? luna
        : undefined;
  return {
    models,
    luna,
    astra,
    human,
    extraction: {
      ...(selected?.extraction ?? p.extraction),
      category_id:
        p.extraction.category_id ?? selected?.extraction.category_id ?? null,
    },
    source: selected
      ? selected.stage === "large"
        ? "Astra"
        : selected.stage === "small"
          ? "Luna"
          : "saved human review"
      : p.has_human_review
        ? "saved human review"
        : p.large_model_confidence !== null
          ? "Astra (saved document)"
          : p.small_model_certainty !== null
            ? "Luna (saved document)"
            : "saved document",
  };
}
export function matchesReviewFilters(
  doc: DocumentView,
  confidence: string,
  model: string,
  human: string,
) {
  const p = doc.processing;
  if (human === "pending" && p?.has_human_review) return false;
  if (human === "reviewed" && !p?.has_human_review) return false;
  if (model === "astra" && p?.large_model_confidence == null) return false;
  if (model === "luna" && p?.small_model_certainty == null) return false;
  if (
    model === "luna-only" &&
    (p?.small_model_certainty == null || p.large_model_confidence !== null)
  )
    return false;
  if (
    model === "none" &&
    (p?.small_model_certainty != null || p?.large_model_confidence != null)
  )
    return false;
  const certainty =
    model === "luna" || model === "luna-only"
      ? p?.small_model_certainty
      : (p?.large_model_confidence ?? p?.small_model_certainty);
  return (
    confidence === "all" ||
    (confidence === "low-medium"
      ? certainty === "low" || certainty === "medium"
      : confidence === "unknown"
        ? certainty == null
        : certainty === confidence)
  );
}
