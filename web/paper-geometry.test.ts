import { describe, expect, it } from "vitest";
import { hasPlausiblePaperCorners } from "./paper-geometry";

describe("overhead paper corner plausibility", () => {
  it("allows narrow, rotated and moderately skewed paper in pixel coordinates", () => {
    const rectangle = [
      [0, 0],
      [450, 0],
      [450, 2000],
      [0, 2000],
    ];
    const angle = Math.PI / 3;
    const rotated = rectangle.map(([x, y]) => [
      x * Math.cos(angle) - y * Math.sin(angle),
      x * Math.sin(angle) + y * Math.cos(angle),
    ]);
    for (const points of [
      rectangle,
      rotated,
      [
        [100, 100],
        [900, 200],
        [1000, 1900],
        [200, 2100],
      ],
    ])
      expect(hasPlausiblePaperCorners(points)).toBe(true);
  });

  it("keeps inclusive 45/135 degree corners but rejects more extreme skew", () => {
    const parallelogram = (skew: number) => [
      [0, 0],
      [100, 0],
      [100 + skew, 100],
      [skew, 100],
    ];
    expect(hasPlausiblePaperCorners(parallelogram(100))).toBe(true);
    expect(hasPlausiblePaperCorners(parallelogram(101))).toBe(false);
    expect(
      hasPlausiblePaperCorners([
        [300, 200],
        [1100, 1300],
        [1000, 2150],
        [430, 2250],
      ]),
    ).toBe(false);
  });

  it("rejects malformed coordinates and collapsed edges", () => {
    for (const points of [
      [],
      [
        [0, 0],
        [0, 0],
        [100, 100],
        [0, 100],
      ],
      [
        [0, 0],
        [100, NaN],
        [100, 100],
        [0, 100],
      ],
      [
        [0, 0],
        [100, 0],
        [Infinity, 100],
        [0, 100],
      ],
      [[0], [100, 0], [100, 100], [0, 100]],
    ])
      expect(hasPlausiblePaperCorners(points)).toBe(false);
  });
});
