import { describe, expect, it } from "vitest";
import { receiptRectification } from "./receipt-rectification";

describe("saved receipt perspective geometry", () => {
  it("uses opposite edge lengths and keeps the saved reading orientation", () => {
    const layout = receiptRectification(
      [1200, 1600],
      [
        [0.2, 0.12],
        [0.82, 0.18],
        [0.74, 0.88],
        [0.16, 0.81],
      ],
    )!;
    expect(layout.version).toBe(1);
    expect(layout.sourcePixels).toEqual([1200, 1600]);
    expect(layout.outputPixels[0]).toBeGreaterThan(700);
    expect(layout.outputPixels[1]).toBeGreaterThan(900);
    expect(layout.marginPixels).toBe(12);
    expect(layout.quad[0]).toEqual([240, 192]);
  });

  it("keeps the same one-percent paper margin as the scan crop", () => {
    const layout = receiptRectification(
      [1000, 1600],
      [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    )!;
    expect(layout.marginPixels).toBe(10);
    expect(layout.outputPixels).toEqual([820, 1300]);
  });

  it("rejects invalid, unordered, and excessively large geometry", () => {
    expect(receiptRectification([1200, 1600], null)).toBeNull();
    expect(
      receiptRectification(
        [1200, 1600],
        [
          [0.1, 0.1],
          [0.9, 0.9],
          [0.9, 0.1],
          [0.1, 0.9],
        ],
      ),
    ).toBeNull();
    expect(
      receiptRectification(
        [1200, 1600],
        [
          [-0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
      ),
    ).toBeNull();
  });
});
