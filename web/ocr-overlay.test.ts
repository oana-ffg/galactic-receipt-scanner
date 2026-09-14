import { expect, it } from "vitest";
import { positionedOcr, projectOcrBox } from "./ocr-overlay";
const source = {
  coordinates: "original image pixels; top-left origin",
  pixels: [800, 2000],
};
it("uses word boxes, falls back to line boxes, and rejects unanchored geometry", () => {
  const line = {
    text: "Whole line",
    confidence: 90,
    box: { x0: 100, y0: 200, x1: 200, y1: 250 },
    words: [
      {
        text: "Word",
        confidence: 70,
        box: { x0: 100, y0: 200, x1: 150, y1: 250 },
      },
    ],
  };
  expect(positionedOcr({ source, lines: [line] })?.items).toEqual([
    { text: "Word", confidence: 70, box: [100, 200, 150, 250] },
  ]);
  expect(
    positionedOcr({ source, lines: [{ ...line, words: [] }] })?.items[0].text,
  ).toBe("Whole line");
  expect(
    positionedOcr({
      source: { ...source, coordinates: "crop pixels" },
      lines: [line],
    }),
  ).toBeNull();
  expect(
    positionedOcr({
      source,
      lines: [{ text: "Invalid", box: { x0: -10, y0: 0, x1: 100, y1: 20 } }],
    })?.skipped,
  ).toBe(1);
});
it("maps original boxes through crop and all supported rotations", () => {
  const box: [number, number, number, number] = [110, 220, 150, 240],
    crop: [number, number, number, number] = [100, 200, 300, 600];
  expect(projectOcrBox(box, crop, 0)).toEqual([10, 20, 50, 40]);
  expect(projectOcrBox(box, crop, 90)).toEqual([360, 10, 380, 50]);
  expect(projectOcrBox(box, crop, 180)).toEqual([150, 360, 190, 380]);
  expect(projectOcrBox(box, crop, 270)).toEqual([20, 150, 40, 190]);
});
