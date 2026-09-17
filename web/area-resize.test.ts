import { expect, it } from "vitest";
import { AREA_TILE, resizeGrayArea } from "./area-resize";
import reference from "./fixtures/area-reference.json";

for (const c of reference.fixtures)
  it(`matches INTER_AREA at ${c.width}x${c.height} -> ${c.outputWidth}x${c.outputHeight}, across tile seams`, () => {
    const actual = resizeGrayArea(
      c.width,
      c.height,
      c.outputWidth,
      c.outputHeight,
      (x, y, w, h) =>
        Uint8Array.from({ length: w * h }, (_, i) => {
          const sx = x + (i % w),
            sy = y + Math.floor(i / w);
          return (sx * 73 + sy * 137 + sx * sy * 19) % 256;
        }),
    );
    // OpenCV SIMD paths can differ by one 8-bit rounding unit.
    expect(
      Math.max(...actual.map((v, i) => Math.abs(v - c.pixels[i]))),
    ).toBeLessThanOrEqual(1);
  });

it("bounds native tiles for a 55-megapixel input", () => {
  let visited = 0,
    largest = 0;
  const out = resizeGrayArea(11000, 5000, 600, 273, (_x, _y, w, h) => {
    expect(w).toBeLessThanOrEqual(AREA_TILE.width);
    expect(h).toBeLessThanOrEqual(AREA_TILE.height);
    visited += w * h;
    largest = Math.max(largest, w * h);
    return new Uint8Array(w * h).fill(100);
  });
  expect(visited).toBe(55000000);
  expect(largest).toBeLessThanOrEqual(262144);
  expect(out.every((v) => v === 100)).toBe(true);
});
