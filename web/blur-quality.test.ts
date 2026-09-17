import { describe, expect, it } from "vitest";
import { blurCategory, blurEffect } from "./blur-quality";
import reference from "./fixtures/blur-reference.json";

describe("Crété blur reference parity", () => {
  for (const fixture of reference.fixtures)
    it(`matches scikit-image for ${fixture.name}`, () => {
      expect(
        blurEffect(
          Uint8Array.from(fixture.gray),
          fixture.width,
          fixture.height,
        ),
      ).toBeCloseTo(fixture.score, 12);
    });
  it("distinguishes unavailable input from a passing score", () => {
    expect(blurEffect(new Uint8Array(9), 3, 3)).toBeNull();
    expect(blurEffect(new Uint8Array(24), 5, 5)).toBeNull();
    expect(blurCategory(null)).toBe("unavailable");
    expect(blurCategory(NaN)).toBe("unavailable");
    expect(blurCategory(Infinity)).toBe("unavailable");
  });
  it("retains the inclusive review band and supports calibrated thresholds", () => {
    expect(blurCategory(0.29999)).toBe("likely-fine");
    expect(blurCategory(0.3)).toBe("uncertain");
    expect(blurCategory(0.38)).toBe("uncertain");
    expect(blurCategory(0.38001)).toBe("likely-blurry");
    expect(blurCategory(0.4, { fineBelow: 0.45, blurryAbove: 0.5 })).toBe(
      "likely-fine",
    );
    expect(() =>
      blurCategory(0.4, { fineBelow: 0.5, blurryAbove: 0.3 }),
    ).toThrow();
  });
});
