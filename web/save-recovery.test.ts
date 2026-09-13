import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { SaveRecovery } from "./save-recovery";
import {
  acknowledge,
  pendingCaptures,
  retainedCaptures,
  savePending,
  type PendingCapture,
} from "./pending";
import { expectedAcknowledgement, uploadCapture } from "./capture-upload";
import { CaptureState } from "./state";

let recovery: SaveRecovery | undefined;
afterEach(async () => {
  recovery?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const capture of await retainedCaptures()) await acknowledge(capture.id);
});
async function retained(): Promise<PendingCapture> {
  const capture: PendingCapture = {
    id: crypto.randomUUID(),
    blob: new Blob(["exact synthetic original"], { type: "image/jpeg" }),
    method: "synthetic",
    quality: {
      ok: true,
      quad: null,
      hands: [],
      reason: "synthetic",
      receiptPixels: [1000, 2000],
    },
    sourcePixels: [2000, 2400],
  };
  capture.acknowledgement = {
    ...(await expectedAcknowledgement(capture)),
    receipt_id: capture.id,
    take_number: 1,
    created_at: new Date().toISOString(),
  };
  await savePending(capture);
  return capture;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

it("keeps acknowledged originals through delayed readback and only deletes after an exact verification", async () => {
  const capture = await retained();
  let reply!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn(),
    verified = vi.fn();
  recovery = new SaveRecovery(() => true, changed, verified);
  recovery.start();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(await pendingCaptures()).toHaveLength(0);
  expect(await (await retainedCaptures())[0].blob.text()).toBe(
    "exact synthetic original",
  );
  reply(json({ ...capture.acknowledgement, verified: true, acceptedCount: 1 }));
  await vi.waitFor(async () =>
    expect(await retainedCaptures()).toHaveLength(0),
  );
  expect(verified).toHaveBeenCalledWith(capture.id, 1);
});

it("automatically resends the exact retained bytes after a missing-record or missing-object response", async () => {
  const capture = await retained();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({}, 404))
    .mockResolvedValueOnce(json(capture.acknowledgement))
    .mockResolvedValueOnce(
      json({ ...capture.acknowledgement, verified: true, acceptedCount: 1 }),
    );
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  recovery = new SaveRecovery(() => true, changed, vi.fn());
  recovery.start();
  await vi.waitFor(async () =>
    expect(await retainedCaptures()).toHaveLength(0),
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  const final = changed.mock.calls.at(-1)![0];
  expect(final.timing).toMatchObject({
    kind: "verification",
    outcome: "complete",
    requests: [
      expect.objectContaining({ status: 404 }),
      expect.objectContaining({ status: 200 }),
    ],
  });
  expect(final.timing.failedStage).toBeUndefined();
  expect(final.resendTiming).toMatchObject({
    kind: "resend",
    outcome: "complete",
    bytes: capture.blob.size,
    values: { requestMs: expect.any(Number), localHashMs: expect.any(Number) },
  });
  const request = fetch.mock.calls[1];
  expect(request[0]).toBe(`/api/captures/${capture.id}`);
  expect(request[1].method).toBe("POST");
  expect(await request[1].body.text()).toBe(await capture.blob.text());
});

it("retains sources and blocks new scanning when readback metadata or identity conflicts", async () => {
  const capture = await retained();
  const fetch = vi.fn().mockResolvedValue(
    json({
      ...capture.acknowledgement,
      id: crypto.randomUUID(),
      verified: true,
      acceptedCount: 1,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  recovery = new SaveRecovery(() => true, changed, vi.fn());
  recovery.start();
  await vi.waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ blocked: true, pending: 1 }),
    ),
  );
  expect(await retainedCaptures()).toHaveLength(1);
  expect(fetch.mock.calls.every((call) => call[1].method !== "POST")).toBe(
    true,
  );
});

it("resumes verification from IndexedDB after a page restart and transient service failure", async () => {
  const capture = await retained();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 503)));
  const changed = vi.fn();
  recovery = new SaveRecovery(() => true, changed, vi.fn());
  recovery.start();
  await vi.waitFor(() =>
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        blocked: false,
        pending: 1,
        warning: expect.any(String),
      }),
    ),
  );
  recovery.stop();
  expect(await retainedCaptures()).toHaveLength(1);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        json({ ...capture.acknowledgement, verified: true, acceptedCount: 4 }),
      ),
  );
  recovery = new SaveRecovery(() => true, vi.fn(), vi.fn());
  recovery.start();
  await vi.waitFor(async () =>
    expect(await retainedCaptures()).toHaveLength(0),
  );
});

it("bounds the unverified backlog and leaves the active upload alone", async () => {
  for (let i = 0; i < 8; i++) await retained();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const changed = vi.fn();
  recovery = new SaveRecovery(() => false, changed, vi.fn());
  recovery.start();
  await vi.waitFor(() =>
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ pending: 8, blocked: true }),
    ),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("applies backpressure to new acknowledgements while an earlier verification is hung", async () => {
  const first = await retained();
  let reply!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    ),
  );
  const changed = vi.fn();
  recovery = new SaveRecovery(() => true, changed, vi.fn());
  recovery.start();
  await vi.waitFor(() => expect(reply).toBeTypeOf("function"));
  for (let i = 1; i < 8; i++) {
    await retained();
    await recovery.refresh();
    recovery.wake();
  }
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ pending: 8, blocked: true }),
  );
  recovery.stop();
  reply(json({ ...first.acknowledgement, verified: true, acceptedCount: 8 }));
  await vi.waitFor(async () =>
    expect(await retainedCaptures()).toHaveLength(7),
  );
});

it("rejects an acknowledgement for different bytes without removing the pending original", async () => {
  const capture = await retained();
  const ack = capture.acknowledgement!;
  delete capture.acknowledgement;
  await savePending(capture);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(json({ ...ack, sha256: "0".repeat(64) })),
  );
  await expect(uploadCapture(capture)).rejects.toThrow("differs");
  expect(await pendingCaptures()).toHaveLength(1);
  expect(await (await retainedCaptures())[0].blob.text()).toBe(
    "exact synthetic original",
  );
});

it("keeps an acknowledged capture saved but blocks scanning if the inventory check fails, then recovers", async () => {
  const capture = await retained();
  const state = new CaptureState();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        json({ ...capture.acknowledgement, verified: true, acceptedCount: 1 }),
      ),
  );
  recovery = new SaveRecovery(
    () => true,
    (status) => {
      state.value.saveRecovery = status;
    },
    vi.fn(),
  );
  recovery.start();
  const getAll = vi
    .spyOn(IDBObjectStore.prototype, "getAll")
    .mockImplementation(() => {
      throw new Error("Synthetic inventory interruption");
    });
  await expect(recovery.refresh()).resolves.toBeUndefined();
  state.saved(capture.id, 0);
  expect(state.value.lastSaved).toBe(capture.id);
  expect(state.value.recovery).toBeUndefined();
  expect(state.value.saveRecovery?.blocked).toBe(true);
  getAll.mockRestore();
  expect(await retainedCaptures()).toHaveLength(1);
  recovery.wake(true);
  await vi.waitFor(async () =>
    expect(await retainedCaptures()).toHaveLength(0),
  );
  expect(state.value.saveRecovery?.blocked).toBe(false);
  expect(state.value.lastSaved).toBe(capture.id);
});
