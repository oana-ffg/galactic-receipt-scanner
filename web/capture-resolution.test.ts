import { expect, it } from "vitest";
import { hasReceiptResolution } from "./capture-resolution";
it("allows narrow receipts in either orientation while rejecting undersized or invalid sources", () => {
  for (const pixels of [
    [450, 900],
    [900, 450],
    [594, 2034],
    [2034, 594],
    [900, 900],
  ])
    expect(hasReceiptResolution(pixels), String(pixels)).toBe(true);
  for (const pixels of [
    [449, 2000],
    [2000, 449],
    [800, 800],
    [450, 899],
    [NaN, 1000],
    [Infinity, 1000],
    ["450", 900],
    [],
    [900],
    null,
  ])
    expect(hasReceiptResolution(pixels), String(pixels)).toBe(false);
});
