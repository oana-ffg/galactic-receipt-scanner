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
  handsChecked: true,
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
  s.observe({ ...clear, ok: false, empty: true }, 3100);
  expect(s.value.message).toBe("Ready for the next receipt.");
});
it("failure stays red until explicit retry", () => {
  const s = new CaptureState();
  s.control("start");
  s.failed("Photo failed", "retake");
  for (const t of [100, 1000, 2000, 3000])
    expect(s.observe(clear, t)).toBeNull();
  expect(s.value.phase).toBe("red");
  s.control("retry");
  expect(s.value.armed).toBe(true);
});

it("connection gaps require fresh stability without clearing capture failures", () => {
  const s = new CaptureState();
  s.control("start");
  for (const t of [100, 400, 700]) s.observe(clear, t);
  s.interrupt();
  expect(s.observe(clear, 4000)).toBeNull();
  s.failed("An original still needs uploading.");
  s.interrupt();
  for (const t of [5000, 5400, 5800, 6200])
    expect(s.observe(clear, t)).toBeNull();
  expect(s.value.needsAttention).toBe(true);
});

it("a connection gap cannot count as continuously observed receipt removal", () => {
  const s = new CaptureState();
  s.control("start");
  s.saved("saved-id");
  const empty = { ...clear, ok: false, empty: true };
  s.observe(empty, 100);
  s.interrupt();
  s.observe(empty, 4000);
  expect(s.value.armed).toBe(false);
  s.observe(empty, 4500);
  expect(s.value.armed).toBe(true);
});

it("uses the confirmed server count when recovering a save already counted at startup", () => {
  const s = new CaptureState();
  s.value.count = 8;
  s.saved("recovered", 8);
  expect(s.value.count).toBe(8);
  s.saved("recovered", 8);
  expect(s.value.count).toBe(8);
});

it("allows handheld translation while requiring stable paper content", () => {
  const s = new CaptureState();
  s.control("start");
  let capture: string | null = null;
  for (const time of [100, 400, 700, 1100]) {
    const offset = time % 3 === 1 ? 0.035 : -0.025;
    capture = s.observe(
      { ...clear, quad: clear.quad.map(([x, y]) => [x + offset, y]) },
      time,
    );
  }
  expect(capture).toBeTruthy();
});

it("dampens brief feedback flicker without allowing a failed check to capture", () => {
  const s = new CaptureState();
  s.control("start");
  s.observe(clear, 100);
  s.observe(clear, 400);
  expect(s.value.phase).toBe("amber");
  const bad = { ...clear, ok: false, reason: "Blurred" };
  expect(s.observe(bad, 550)).toBeNull();
  expect(s.value.phase).toBe("amber");
  expect(s.observe(clear, 700)).toBeNull();
  expect(s.observe(clear, 1000)).toBeNull();
  expect(s.observe(bad, 1100)).toBeNull();
  expect(s.observe(bad, 1400)).toBeNull();
  expect(s.value.phase).toBe("red");
  expect(s.value.message).toBe("Blurred");
  expect(s.value.activeId).toBeNull();
});

it("links repeated retakes to the current paper and clears identity after removal", () => {
  const s = new CaptureState();
  s.control("start");
  s.saved("first", 1);
  s.control("retry");
  expect(s.value.retakeOf).toBe("first");
  for (const t of [100, 400, 700, 1100]) s.observe(clear, t);
  expect(s.value.activeId).toBeTruthy();
  s.saved("second", 1);
  expect(s.value.count).toBe(1);
  s.control("retry");
  expect(s.value.retakeOf).toBe("second");
  const empty = { ...clear, ok: false, empty: true };
  s.observe(empty, 2000);
  s.observe(empty, 2500);
  expect(s.value.lastCapture).toBeNull();
  expect(s.value.retakeOf).toBeNull();
});

it("retakes a rejected source and does not attach the next receipt to it", () => {
  const s = new CaptureState();
  s.control("start");
  s.failed("Blurred", "retake", "rejected");
  s.control("retry");
  expect(s.value.retakeOf).toBe("rejected");
  s.failed("Blurred", "retake", "rejected-again");
  const empty = { ...clear, ok: false, empty: true };
  s.observe(empty, 100);
  s.observe(empty, 700);
  s.control("retry");
  expect(s.value.retakeOf).toBeNull();
});

it("cannot bypass a pending upload using either remote Start or Retake", () => {
  const s = new CaptureState();
  s.saved("first", 1);
  s.failed("Upload interrupted", "upload");
  for (const action of ["retry", "start"]) {
    s.control(action);
    expect(s.value.recovery).toBe("upload");
    expect(s.value.armed).toBe(false);
    expect(s.observe(clear, 2000)).toBeNull();
  }
});

it("ignores Retake when there is no current receipt or failed photo", () => {
  const s = new CaptureState();
  s.control("retry");
  expect(s.value.paused).toBe(true);
  expect(s.value.retakeOf).toBeNull();
});

it("forces a retained review take without green and cannot override an upload", () => {
  const state = new CaptureState();
  state.value.detectorReady = true;
  const first = crypto.randomUUID();
  state.saved(first, 1);
  const forced = state.force();
  expect(forced).toBeTruthy();
  expect(state.value.retakeOf).toBe(first);
  state.saved(forced!, 1, true);
  expect(state.value).toMatchObject({
    phase: "amber",
    manualReview: true,
    armed: false,
    count: 1,
  });
  for (const now of [100, 1000, 2000])
    state.observe(
      {
        ok: false,
        empty: true,
        quad: null,
        hands: [],
        handsChecked: true,
        reason: "Odd shape is invisible to detector",
      },
      now,
    );
  expect(state.value).toMatchObject({
    lastCapture: forced,
    armed: false,
    paused: true,
    manualReview: true,
  });
  state.control("start");
  expect(state.value).toMatchObject({
    lastCapture: null,
    retakeOf: null,
    armed: true,
    paused: false,
    manualReview: false,
  });
  state.failed("Upload pending", "upload");
  expect(state.force()).toBeNull();
});

it("keeps an explicitly selected old retake across an empty desk until started", () => {
  const state = new CaptureState();
  const target = crypto.randomUUID();
  state.control(`retake:${target}`);
  for (const now of [100, 500, 1000])
    state.observe(
      { ok: false, empty: true, quad: null, hands: [], reason: "Empty" },
      now,
    );
  expect(state.value).toMatchObject({
    retakeOf: target,
    paused: true,
    selectedRetake: true,
  });
  state.control("start");
  expect(state.value.retakeOf).toBe(target);
  state.control("cancel-retake");
  expect(state.value).toMatchObject({
    retakeOf: null,
    paused: true,
    selectedRetake: false,
  });
});

it("an explicit retake of a forced shape retains identity when no outline is detectable", () => {
  const state = new CaptureState();
  const id = crypto.randomUUID();
  state.saved(id, 1, true);
  state.control("retry");
  for (const now of [100, 1000, 2000])
    state.observe(
      { ok: false, empty: true, quad: null, hands: [], reason: "No outline" },
      now,
    );
  expect(state.value).toMatchObject({
    retakeOf: id,
    selectedRetake: true,
    paused: true,
  });
});
