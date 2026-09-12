import { expect, it } from "vitest";
import { CaptureState } from "./state";
import type { Quality } from "./types";

const empty: Quality = {
  ok: false,
  empty: true,
  emptyStrong: true,
  quad: null,
  hands: [],
  handsChecked: true,
  reason: "Empty",
};
const paper: Quality = {
  ok: true,
  quad: [
    [0.2, 0.1],
    [0.8, 0.1],
    [0.8, 0.9],
    [0.2, 0.9],
  ],
  hands: [],
  handsChecked: true,
  reason: "Clear",
  motion: 0,
};
function saved() {
  const state = new CaptureState();
  state.control("start");
  state.saved("synthetic-capture");
  return state;
}

it("rearms after a short confirmed gap, then requires full new-paper stability and acknowledgement", () => {
  const state = saved();
  state.observe(empty, 0);
  expect(state.value.armed).toBe(false);
  state.observe(empty, 150);
  expect(state.value).toMatchObject({ armed: true, lastCapture: null });
  for (const now of [300, 600, 900])
    expect(state.observe(paper, now)).toBeNull();
  const id = state.observe(paper, 1200);
  expect(id).toBeTruthy();
  expect(state.value.phase).toBe("amber");
  state.saved(id!);
  for (const now of [1500, 1800, 2400, 5000])
    expect(state.observe(paper, now)).toBeNull();
  expect(state.value).toMatchObject({ armed: false, count: 2 });
});

it.each<[string, Quality]>([
  ["paper movement", { ...paper, motion: 20 }],
  ["outline loss", { ...paper, ok: false, quad: null }],
  ["a hand", { ...empty, hands: [[[0.3, 0.4]]] }],
  ["unchecked hands", { ...empty, handsChecked: false }],
])("does not turn %s or a single empty frame into removal", (_, obstructed) => {
  const state = saved();
  for (const now of [0, 150, 300, 1000]) state.observe(obstructed, now);
  state.observe(empty, 1150);
  state.observe(paper, 1300);
  for (const now of [1450, 1750, 2050, 2350]) state.observe(paper, now);
  expect(state.value).toMatchObject({ armed: false, count: 1 });
});

it("retains the slower confirmation for ambiguous removal evidence", () => {
  const state = saved();
  state.observe(empty, 0);
  for (const now of [150, 300]) {
    state.observe({ ...empty, emptyStrong: false }, now);
    expect(state.value.armed).toBe(false);
  }
  state.observe({ ...empty, emptyStrong: false }, 450);
  expect(state.value.armed).toBe(true);
});

it("requires a new fast interval after weak evidence or a slow frame", () => {
  for (const middle of [
    { q: { ...empty, emptyStrong: false }, at: 100, next: 200 },
    { q: empty, at: 400, next: 410 },
  ]) {
    const state = saved();
    state.observe(empty, 0);
    state.observe(middle.q, middle.at);
    state.observe(empty, middle.next);
    expect(state.value.armed).toBe(false);
  }
});

it("does not count unobserved time or repeated timestamps as continuous removal", () => {
  const state = saved();
  state.observe(empty, 0);
  state.observe(empty, 2000);
  state.observe(empty, 2000);
  expect(state.value.armed).toBe(false);
  state.interrupt();
  state.observe(empty, 2150);
  expect(state.value.armed).toBe(false);
  state.observe(empty, 2300);
  expect(state.value.armed).toBe(true);
});
