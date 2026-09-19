import { afterAll, beforeAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const bytes = new Uint8Array([255, 216, 255, 5, 6, 7]);
function request(path: string, method = "GET", body?: BodyInit, headers = {}) {
  return mf.dispatchFetch(origin + path, {
    method,
    body,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...headers,
    },
  });
}
async function upload(id: string, retakeOf?: string, status = "rejected") {
  return request(`/api/captures/${id}`, "POST", bytes, {
    "X-Capture-Status": status,
    "X-Capture-Acknowledgement": "durable-v1",
    "X-Capture-Metadata": JSON.stringify({
      quality: {
        ok: status === "accepted",
        reason: "Synthetic faded print",
        receiptPixels: [1200, 1800],
      },
    }),
    ...(retakeOf ? { "X-Retake-Of": retakeOf } : {}),
  });
}
async function read(id: string) {
  return (await request(`/api/captures/${id}`)).json();
}
it("keeps warnings and immutable upload acknowledgements while counting best-available once", async () => {
  const id = crypto.randomUUID();
  const ack = await (await upload(id)).json();
  expect(
    (
      await request(
        `/api/captures/${id}/keep`,
        "POST",
        JSON.stringify({ reason: "best-available", sha256: "bad" }),
      )
    ).status,
  ).toBe(400);
  const keep = () =>
    request(
      `/api/captures/${id}/keep`,
      "POST",
      JSON.stringify({ reason: "best-available", sha256: ack.sha256 }),
    );
  expect((await keep()).status).toBe(200);
  const first = await read(id);
  expect(first).toMatchObject({
    status: "manual-review",
    source_status: "rejected",
    is_current: true,
    acceptedCount: 1,
    metadata: { quality: { ok: false } },
    kept: { source_sha256: ack.sha256, reason: "best-available" },
  });
  expect((await keep()).status).toBe(200);
  expect((await read(id)).kept).toEqual(first.kept);
  expect(await (await upload(id)).json()).toEqual(ack);
  expect(
    await (await request(`/api/captures/${id}/verify`)).json(),
  ).toMatchObject(ack);
  const docs = await (await request("/api/documents")).json();
  expect(
    docs.documents.find((d: { id: string }) => d.id === id).reasons.join(" "),
  ).toContain("best available");
  const better = crypto.randomUUID();
  await upload(better, id, "accepted");
  expect(await read(id)).toMatchObject({
    is_current: false,
    current_capture_id: better,
    acceptedCount: 1,
  });
  expect(
    (
      await request(
        `/api/captures/${better}/keep`,
        "POST",
        JSON.stringify({ reason: "best-available", sha256: ack.sha256 }),
      )
    ).status,
  ).toBe(409);
  const db = await mf.getD1Database("DB");
  expect(
    await db.prepare("SELECT status FROM captures WHERE id=?").bind(id).first(),
  ).toEqual({ status: "rejected" });
});
it("requires owner auth and refuses an unpersisted original", async () => {
  const id = crypto.randomUUID();
  const ack = await (await upload(id)).json();
  expect(
    (
      await mf.dispatchFetch(origin + `/api/captures/${id}/keep`, {
        method: "POST",
      })
    ).status,
  ).toBe(401);
  const db = await mf.getD1Database("DB");
  const row = await db
    .prepare("SELECT raw_key FROM captures WHERE id=?")
    .bind(id)
    .first<{ raw_key: string }>();
  await (await mf.getR2Bucket("BUCKET")).delete(row!.raw_key);
  expect(
    (
      await request(
        `/api/captures/${id}/keep`,
        "POST",
        JSON.stringify({ reason: "best-available", sha256: ack.sha256 }),
      )
    ).status,
  ).toBe(404);
  expect((await read(id)).kept).toBeNull();
});
