import { expect, it } from "vitest";
import { StateOrder } from "./state-order";
import { CaptureState } from "./state";

it("accepts newer HTTP or direct state and rejects delayed snapshots from either", () => {
  const order = new StateOrder();
  order.setCamera("camera-a");
  const state = new CaptureState().value;
  const snapshot = (stateRevision: number) => ({
    ...state,
    cameraId: "camera-a",
    stateRevision,
  });
  expect(order.accept(snapshot(10))).toBe(true);
  expect(order.accept({ ...snapshot(12), phase: "green" })).toBe(true);
  expect(order.accept({ ...snapshot(11), phase: "amber" })).toBe(false);
  expect(order.accept(snapshot(13))).toBe(true);
  expect(order.accept(snapshot(12))).toBe(false);
  expect(order.accept(state)).toBe(false);
  order.setCamera("camera-b");
  expect(order.accept(snapshot(100))).toBe(false);
  expect(
    order.accept({ ...state, cameraId: "camera-b", stateRevision: 1 }),
  ).toBe(true);
});

it("supports legacy phone snapshots until a versioned state is received", () => {
  const order = new StateOrder();
  order.setCamera("legacy");
  expect(order.accept(new CaptureState().value)).toBe(true);
});
