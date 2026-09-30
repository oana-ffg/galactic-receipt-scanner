import { describe, expect, it } from "vitest";
import { detectedReceiptCrop } from "./receipt-crop";
import { receiptStraightening } from "./receipt-straightening";

function outline(angle: number) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [
    [-200, -400],
    [200, -400],
    [200, 400],
    [-200, 400],
  ].map(([x, y]) => [
    (500 + c * x - s * y) / 1000,
    (700 + s * x + c * y) / 1400,
  ]);
}

describe("receipt straightening", () => {
  for (const angle of [-0.25, 0.25])
    it(`removes ${angle} radians of paper tilt without changing text shape`, () => {
      const quad = outline(angle);
      const crop = detectedReceiptCrop([1000, 1400], quad)!;
      const transform = receiptStraightening([1000, 1400], crop, quad)!;
      expect(transform.cosine).toBeCloseTo(Math.cos(angle));
      expect(transform.sine).toBeCloseTo(Math.sin(angle));
      expect(transform.bounds[2] - transform.bounds[0]).toBeCloseTo(420);
      expect(transform.bounds[3] - transform.bounds[1]).toBeCloseTo(820);
      // Every outline point remains inside the output, with the 10-pixel margin.
      for (const [x, y] of quad) {
        const rx =
          transform.cosine * x * 1000 - transform.sine * (1400 - y * 1400);
        const ry =
          transform.sine * x * 1000 + transform.cosine * (1400 - y * 1400);
        expect(rx).toBeGreaterThanOrEqual(transform.bounds[0] + 9.999);
        expect(ry).toBeGreaterThanOrEqual(transform.bounds[1] + 9.999);
        expect(rx).toBeLessThanOrEqual(transform.bounds[2] - 9.999);
        expect(ry).toBeLessThanOrEqual(transform.bounds[3] - 9.999);
      }
    });
  it("leaves upright, explicit full-image and invalid outlines unchanged", () => {
    for (const quad of [
      outline(0),
      [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      [
        [0, 0],
        [1, 0],
        [0.5, 1],
        [0, 0.3],
      ],
    ]) {
      const crop = detectedReceiptCrop([1000, 1400], quad)!;
      expect(receiptStraightening([1000, 1400], crop, quad)).toBeNull();
    }
    expect(
      receiptStraightening([1000, 1400], [0, 0, 1000, 1400], outline(0.25)),
    ).toBeNull();
  });
});
