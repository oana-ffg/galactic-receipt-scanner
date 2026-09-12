import { expect, test } from "vitest";
import { DeskReference } from "./desk-reference";
test("desk references reject local paper, scene motion and exposure changes", () => {
  const desk = new Uint8ClampedArray(128 * 128 * 4).fill(80);
  const reference = new DeskReference();
  expect(reference.matches(desk, 128)).toBeUndefined();
  reference.set(desk);
  expect(reference.matches(desk, 128)).toBe(true);
  const noisy = desk.map((v, i) => v + (i % 3) - 1);
  expect(reference.matches(noisy, 128)).toBe(true);
  for (const size of [8, 16, 60]) {
    const paper = desk.slice();
    for (let y = 20; y < 20 + size; y++)
      for (let x = 20; x < 20 + size; x++)
        for (let c = 0; c < 3; c++) paper[(y * 128 + x) * 4 + c] = 200;
    expect(reference.matches(paper, 128)).toBe(false);
  }
  expect(
    reference.matches(
      desk.map((v) => v + 20),
      128,
    ),
  ).toBe(false);
  expect(reference.matches(new Uint8ClampedArray(16), 128)).toBe(false);
});
