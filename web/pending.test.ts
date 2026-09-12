import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { acknowledge, pendingCaptures, savePending } from "./pending";

describe("phone upload recovery buffer", () => {
  it("retains exact bytes across connections until the backend acknowledges them", async () => {
    const blob = new Blob(["source-image-bytes"], { type: "image/jpeg" });
    await savePending({
      id: "capture-one",
      retakeOf: "previous-take",
      blob,
      method: "still",
      sourcePixels: [2000, 2400],
      quality: { ok: false, quad: null, hands: [], reason: "test" },
    });
    const reloaded = await pendingCaptures();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].retakeOf).toBe("previous-take");
    expect(await reloaded[0].blob.text()).toBe("source-image-bytes");
    // An attempted upload alone never deletes the pending image.
    expect(await pendingCaptures()).toHaveLength(1);
    await acknowledge("capture-one");
    expect(await pendingCaptures()).toHaveLength(0);
  });
});

it("reports the original request error and preserves data when a storage transaction fails", async () => {
  const capture = {
    id: "synthetic-conflict",
    blob: new Blob(["original bytes"], { type: "image/jpeg" }),
    method: "still",
    sourcePixels: [2000, 2400],
    quality: { ok: false, quad: null, hands: [], reason: "test" },
  };
  await savePending(capture);
  // Force a real asynchronous constraint failure, before tx.error is set.
  const put = vi
    .spyOn(IDBObjectStore.prototype, "put")
    .mockImplementation(function (this: IDBObjectStore, value) {
      return this.add(value);
    });
  try {
    await expect(
      savePending({ ...capture, blob: new Blob(["different bytes"]) }),
    ).rejects.toMatchObject({ name: "ConstraintError" });
    expect(await (await pendingCaptures())[0].blob.text()).toBe(
      "original bytes",
    );
  } finally {
    put.mockRestore();
    await acknowledge(capture.id);
  }
});
