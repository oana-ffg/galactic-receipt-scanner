import { expect, it } from "vitest";
import {
  ocrConfidence,
  ocrTranscript,
  formatOcrConfidence,
} from "./ocr-confidence";

it("preserves zero confidence and treats missing or invalid scores as unavailable", () => {
  for (const value of [undefined, null, "98", -1, 101, NaN, Infinity])
    expect(ocrConfidence(value)).toBeNull();
  expect(formatOcrConfidence(ocrConfidence(0))).toBe("0.0%");
  expect(formatOcrConfidence(ocrConfidence(100))).toBe("100.0%");
  expect(formatOcrConfidence(ocrConfidence(undefined))).toBe("Unavailable");
});

it("keeps repeated lines paired with their own saved scores without needing coordinates", () => {
  expect(
    ocrTranscript("Item 12,00\nItem 12,00\nTOTAL 24,00", [
      { text: "Item 12,00", confidence: 99.2 },
      { text: "Item 12,00", confidence: 0 },
      { text: "TOTAL 24,00" },
    ]),
  ).toEqual([
    { text: "Item 12,00", confidence: 99.2 },
    { text: "Item 12,00", confidence: 0 },
    { text: "TOTAL 24,00", confidence: null },
  ]);
});

it("does not attach scores to different transcript text or drop unmatched text", () => {
  const text = "TOTAL 12,00\nUnknown  \n";
  for (const lines of [
    undefined,
    [null, { text: "TOTAL 72,00", confidence: 99 }],
  ])
    expect(ocrTranscript(text, lines)).toEqual([
      { text: "TOTAL 12,00", confidence: null },
      { text: "Unknown  ", confidence: null },
      { text: "", confidence: null },
    ]);
});
