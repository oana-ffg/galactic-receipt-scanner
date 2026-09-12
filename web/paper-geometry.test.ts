import { describe, expect, it } from "vitest";
import {
  enclosePaperContour,
  hasPlausiblePaperCorners,
} from "./paper-geometry";

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

describe("paper boundary enclosure", () => {
  const quad = [
    [0, 0],
    [100, 0],
    [100, 200],
    [0, 200],
  ];

  it("leaves an enclosing quad alone and includes a small protruding fold", () => {
    expect(enclosePaperContour(quad, quad)).toEqual(quad);
    const contour = [...quad, [-6, 80]];
    expect(enclosePaperContour(quad, contour)).toEqual([
      [-6, 0],
      [100, 0],
      [100, 200],
      [-6, 200],
    ]);
  });

  it("encloses every boundary point for either winding and rotated paper", () => {
    const contour = [
      [0, 0],
      [86, 0],
      [100, 12],
      [100, 200],
      [14, 200],
      [0, 188],
    ];
    const inset = [contour[0], contour[2], contour[3], contour[5]];
    const rotate = ([x, y]: number[]) => [
      x * 0.8 - y * 0.6 + 300,
      x * 0.6 + y * 0.8 + 500,
    ];
    for (const [input, boundary] of [
      [inset, contour],
      [[...inset].reverse(), contour],
      [inset.map(rotate), contour.map(rotate)],
    ]) {
      const enclosed = enclosePaperContour(input, boundary)!;
      expect(enclosed).not.toBeNull();
      const center = enclosed.reduce(
        (c, p) => [c[0] + p[0] / 4, c[1] + p[1] / 4],
        [0, 0],
      );
      for (let i = 0; i < 4; i++) {
        const a = enclosed[i],
          b = enclosed[(i + 1) % 4];
        const cross = ([x, y]: number[]) =>
          (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        const winding = Math.sign(cross(center));
        for (const p of boundary)
          expect(cross(p) * winding).toBeGreaterThanOrEqual(-1e-8);
      }
    }
  });

  it("allows combined folded margins and one-edge folds with segmentation jitter", () => {
    for (const jitter of [-0.25, 0, 0.25]) {
      const margin = 9.5 + jitter;
      expect(
        enclosePaperContour(quad, [
          [-margin, -margin],
          [100 + margin, -margin],
          [100 + margin, 200 + margin],
          [-margin, 200 + margin],
        ]),
      ).not.toBeNull();
      expect(
        enclosePaperContour(quad, [...quad, [-17 + jitter, 80]]),
      ).not.toBeNull();
    }
  });

  it("rejects distant outliers and excessive total growth", () => {
    expect(enclosePaperContour(quad, [...quad, [-20, 80]])).not.toBeNull();
    expect(enclosePaperContour(quad, [...quad, [-21, 80]])).toBeNull();
    expect(
      enclosePaperContour(quad, [
        [-11, -11],
        [111, -11],
        [111, 211],
        [-11, 211],
      ]),
    ).toBeNull();
  });

  it("rejects malformed boundaries and degenerate quadrilaterals", () => {
    expect(enclosePaperContour(quad, [])).toBeNull();
    expect(enclosePaperContour(quad, [[NaN, 0]])).toBeNull();
    expect(
      enclosePaperContour(
        [
          [0, 0],
          [0, 0],
          [100, 100],
          [0, 100],
        ],
        quad,
      ),
    ).toBeNull();
  });
});

it("fits long paper edges without letting a folded corner tip tilt the enclosure", async () => {
  const { refinePaperEdges } = await import("./paper-geometry");
  const contour = [
    [0, 0],
    [100, 0],
    [100, 200],
    [12, 200],
    [0, 188],
  ];
  const approximate = [contour[0], contour[1], contour[2], contour[3]];
  const enclosed = enclosePaperContour(
    refinePaperEdges(approximate, contour),
    contour,
  )!;
  expect(enclosed).not.toBeNull();
  expect(enclosed[0][0]).toBeCloseTo(0);
  expect(enclosed[3][0]).toBeCloseTo(0);
  expect(enclosed[3][1]).toBeCloseTo(200);
  for (let i = 0; i < 4; i++) {
    const a = enclosed[i],
      b = enclosed[(i + 1) % 4];
    for (const [x, y] of contour)
      expect(
        (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]),
      ).toBeGreaterThanOrEqual(-1e-8);
  }
});
