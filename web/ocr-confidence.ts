/** Saved OCR scores use a 0–100 scale; absent/invalid scores stay unknown. */
export function ocrConfidence(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

export const formatOcrConfidence = (value: number | null) =>
  value === null ? "Unavailable" : `${value.toFixed(1)}%`;

/** Attach scores only when the saved lines reproduce the verbatim transcript. */
export function ocrTranscript(text: string, savedLines: unknown) {
  const lines: { text: string; confidence: number | null }[] = [];
  if (Array.isArray(savedLines)) {
    for (const line of savedLines) {
      if (!line || typeof line.text !== "string") continue;
      lines.push({
        text: line.text.trimEnd(),
        confidence: ocrConfidence(line.confidence),
      });
    }
  }
  if (lines.map((line) => line.text).join("\n") === text) return lines;
  return text.split("\n").map((text) => ({ text, confidence: null }));
}
