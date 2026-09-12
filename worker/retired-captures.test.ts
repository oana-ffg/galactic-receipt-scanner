import { expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";

it("rejects a retired test ID before writing bytes, without blocking a new receipt", async () => {
  const id = crypto.randomUUID(),
    mf = await runtime({ retiredCaptureIds: id });
  try {
    const call = (captureId: string) =>
      mf.dispatchFetch(origin + `/api/captures/${captureId}`, {
        method: "POST",
        body: new Uint8Array([255, 216, 255]),
        headers: { ...ownerHeaders, Origin: origin, "X-Scanner-Request": "1" },
      });
    expect((await call(id)).status).toBe(410);
    const bucket = await mf.getR2Bucket("BUCKET");
    expect((await bucket.list()).objects).toHaveLength(0);
    expect((await call(crypto.randomUUID())).status).toBe(200);
  } finally {
    await mf.dispose();
  }
});
