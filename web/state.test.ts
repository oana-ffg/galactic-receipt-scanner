import { expect, it } from "vitest";
import { CaptureState } from "./state";
const clear = {
  ok: true,
  quad: [
    [0.2, 0.1],
    [0.8, 0.1],
    [0.8, 0.9],
    [0.2, 0.9],
  ],
  hands: [],
  reason: "clear",
  motion: 0,
};
it("requires stability, acknowledgement and clearly empty removal", () => {
  const s = new CaptureState();
  s.control("start");
  for (const time of [100, 400, 700]) expect(s.observe(clear, time)).toBeNull();
  const id = s.observe(clear, 1100)!;
  expect(id).toBeTruthy();
  expect(s.value.phase).toBe("amber");
  s.saved(id);
  expect(s.value.phase).toBe("green");
  expect(s.observe(clear, 1600)).toBeNull();
  expect(s.value.armed).toBe(false);
  s.observe({ ...clear, ok: false, empty: false, hands: [[[0.3, 0.4]]] }, 2000);
  expect(s.value.armed).toBe(false);
  s.observe({ ...clear, ok: false, empty: true }, 2200);
  s.observe({ ...clear, ok: false, empty: true }, 2700);
  expect(s.value.armed).toBe(true);
});
it("failure stays red until explicit retry", () => {
  const s = new CaptureState();
  s.control("start");
  s.failed("Storage failed");
  for (const t of [100, 1000, 2000, 3000])
    expect(s.observe(clear, t)).toBeNull();
  expect(s.value.phase).toBe("red");
  s.control("retry");
  expect(s.value.armed).toBe(true);
});
