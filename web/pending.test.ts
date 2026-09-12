import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
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
