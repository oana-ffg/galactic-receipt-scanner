import { expect, it, vi } from "vitest";
import { HandChecks } from "./hand-checks";
import { CaptureState } from "./state";
import type { Quality } from "./types";

const paper = (): Quality => ({
  ok: true,
  quad: [
    [0.2, 0.1],
    [0.8, 0.1],
    [0.8, 0.9],
    [0.2, 0.9],
  ],
  hands: [],
  reason: "Image checks passed.",
  motion: 0,
});
const empty = (): Quality => ({
  ok: false,
  empty: true,
  quad: null,
  hands: [],
  reason: "Empty",
});
const capture = { capture: true, removal: false };
const removal = { capture: false, removal: true };
const scene = () => new Uint8ClampedArray(32 * 32 * 4);
const hand = [[[0.3, 0.4]]];

it("runs no ML on an idle, paused, invalid or already-saved receipt", () => {
  for (const [options, quality] of [
    [capture, empty],
    [{ capture: false, removal: false }, paper],
    [removal, paper],
    [capture, () => ({ ...paper(), ok: false, reason: "Blurred" })],
  ] as const) {
    const checks = new HandChecks();
    const detect = vi.fn(() => []);
    for (let now = 0; now < 10000; now += 150) {
      const result = checks.apply(quality(), options, now, scene, detect);
      expect(result.ok).toBe(false);
      expect(result.handsChecked).toBe(false);
    }
    expect(detect).not.toHaveBeenCalled();
  }
});

it("fits candidate ML into the existing stability window and checks the actual photo afresh", () => {
  const checks = new HandChecks();
  const state = new CaptureState();
  const detect = vi.fn(() => []);
  state.control("start");
  for (const now of [0, 150, 300, 450, 600, 750]) {
    const q = checks.apply(paper(), state.previewChecks, now, scene, detect);
    expect(state.observe(q, now)).toBeNull();
  }
  expect(detect).toHaveBeenCalledTimes(1);
  const q = checks.apply(paper(), state.previewChecks, 900, scene, detect);
  expect(state.observe(q, 900)).toBeTruthy();
  expect(detect).toHaveBeenCalledTimes(2);
  const photo = checks.apply(paper(), undefined, 901, scene, () => hand);
  expect(photo).toMatchObject({ ok: false, handsChecked: true, hands: hand });
});

it("does not count broken cheap checks as continuous candidate readiness", () => {
  const checks = new HandChecks();
  const detect = vi.fn(() => []);
  checks.apply(paper(), capture, 0, scene, detect);
  checks.apply(empty(), capture, 700, scene, detect);
  checks.apply(paper(), capture, 750, scene, detect);
  expect(detect).not.toHaveBeenCalled();
  checks.apply(paper(), capture, 1500, scene, detect);
  expect(detect).toHaveBeenCalledTimes(1);
});

it("throttles stationary hand rejections but promptly retries a changed scene", () => {
  const checks = new HandChecks();
  const detect = vi.fn(() => hand);
  checks.apply(paper(), capture, 0, scene, detect);
  expect(checks.apply(paper(), capture, 750, scene, detect).ok).toBe(false);
  const waiting = checks.apply(paper(), capture, 900, scene, detect);
  expect(waiting).toMatchObject({
    ok: false,
    handsChecked: false,
    candidateReady: false,
  });
  expect(detect).toHaveBeenCalledTimes(1);
  const moved = () => new Uint8ClampedArray(32 * 32 * 4).fill(30);
  const clear = vi.fn(() => []);
  expect(checks.apply(paper(), capture, 1050, moved, clear).ok).toBe(true);
  expect(clear).toHaveBeenCalledTimes(1);
});

it("retries a blocked scene within 750ms even if tiny movements escape the thumbnail", () => {
  const checks = new HandChecks();
  const detect = vi.fn(() => hand);
  checks.apply(empty(), removal, 0, scene, detect);
  checks.apply(empty(), removal, 600, scene, detect);
  expect(detect).toHaveBeenCalledTimes(1);
  checks.apply(empty(), removal, 750, scene, detect);
  expect(detect).toHaveBeenCalledTimes(2);
});

it("requires fresh hand-free removal evidence and stops ML once rearmed", () => {
  const checks = new HandChecks();
  const state = new CaptureState();
  state.control("start");
  state.saved("synthetic-capture");
  const detect = vi.fn(() => []);
  for (const now of [100, 250, 400, 550])
    state.observe(
      checks.apply(empty(), state.previewChecks, now, scene, detect),
      now,
    );
  expect(state.value.armed).toBe(true);
  expect(detect).toHaveBeenCalledTimes(4);
  state.observe(
    checks.apply(empty(), state.previewChecks, 700, scene, detect),
    700,
  );
  expect(detect).toHaveBeenCalledTimes(4);
});

it("never treats missing ML as clear for capture or removal", () => {
  const state = new CaptureState();
  state.control("start");
  for (const now of [100, 400, 700, 1100, 2000])
    expect(
      state.observe(
        { ...paper(), candidateReady: true, handsChecked: false },
        now,
      ),
    ).toBeNull();
  state.saved("synthetic-capture");
  for (const now of [2100, 2700, 3300])
    state.observe({ ...empty(), handsChecked: false }, now);
  expect(state.value.armed).toBe(false);
});

it("blocks removal on hands and cannot borrow clear time across an obstruction", () => {
  const checks = new HandChecks();
  const state = new CaptureState();
  state.control("start");
  state.saved("synthetic-capture");
  state.observe(
    checks.apply(empty(), removal, 100, scene, () => []),
    100,
  );
  state.observe(
    checks.apply(empty(), removal, 400, scene, () => hand),
    400,
  );
  state.observe(
    checks.apply(empty(), removal, 550, scene, () => []),
    550,
  );
  expect(state.value.armed).toBe(false);
  state.observe(
    checks.apply(empty(), removal, 1150, scene, () => []),
    1150,
  );
  expect(state.value.armed).toBe(false);
  state.observe(
    checks.apply(empty(), removal, 1600, scene, () => []),
    1600,
  );
  expect(state.value.armed).toBe(true);
});

it("checks independent failed/manual photos regardless of preview cooldown", () => {
  const checks = new HandChecks();
  checks.apply(empty(), removal, 0, scene, () => hand);
  const detect = vi.fn(() => hand);
  const photo = checks.apply(
    { ...paper(), ok: false, reason: "Blurred" },
    undefined,
    1,
    scene,
    detect,
  );
  expect(detect).toHaveBeenCalledTimes(1);
  expect(photo).toMatchObject({ ok: false, handsChecked: true, hands: hand });
});
