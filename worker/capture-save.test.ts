import { afterAll, beforeAll, expect, it } from "vitest";
import worker from "./index";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { digest } from "./http";

let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const source = new Uint8Array([255, 216, 255, 1, 2, 3]);
const metadata = JSON.stringify({
  quality: { ok: true, receiptPixels: [1000, 2000] },
  sourcePixels: [2000, 2400],
});
function upload(id: string, data = source, extra: Record<string, string> = {}) {
  return new Request(`${origin}/api/captures/${id}`, {
    method: "POST",
    body: data,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      "X-Capture-Metadata": metadata,
      "X-Capture-Acknowledgement": "durable-v1",
      ...extra,
    },
  });
}
const send = (request: Request) =>
  mf.dispatchFetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: "half",
  });
const verify = (id: string) =>
  mf.dispatchFetch(`${origin}/api/captures/${id}/verify`, {
    headers: ownerHeaders,
  });

it("acknowledges a fresh source using exactly one checksum-validated object write and one atomic database write", async () => {
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("BUCKET");
  const operations: string[] = [];
  const response = await worker.fetch(upload(crypto.randomUUID()), {
    OWNER_EMAIL: "owner@example.test",
    APP_ORIGIN: origin,
    DB: {
      prepare(sql: string) {
        operations.push(sql);
        return db.prepare(sql);
      },
    },
    BUCKET: {
      async put(...args: Parameters<typeof bucket.put>) {
        operations.push("R2 put");
        return bucket.put(...args);
      },
    },
  } as never);
  expect(response.status).toBe(200);
  const ack = await response.json();
  expect(operations).toHaveLength(2);
  expect(operations[0]).toBe("R2 put");
  expect(operations[1]).toMatch(/^INSERT OR IGNORE.*RETURNING \*$/);
  expect(ack).toMatchObject({
    status: "accepted",
    bytes: source.length,
    sha256: await digest(source),
    metadataSha256: await digest(new TextEncoder().encode(metadata)),
  });
  expect(ack).not.toHaveProperty("acceptedCount");
  expect(await (await verify(ack.id)).json()).toMatchObject({
    ...ack,
    verified: true,
    acceptedCount: 1,
  });
});

it("repairs missing original bytes by idempotent resend without changing source metadata or adding a take", async () => {
  const id = crypto.randomUUID();
  const ack = await (await send(upload(id))).json();
  const db = await mf.getD1Database("DB");
  const before = await db
    .prepare("SELECT * FROM captures WHERE id=?")
    .bind(id)
    .first();
  const bucket = await mf.getR2Bucket("BUCKET");
  // This bucket belongs only to this isolated Miniflare runtime.
  await bucket.delete(before!.raw_key as string);
  expect((await verify(id)).status).toBe(404);
  expect(await (await send(upload(id))).json()).toEqual(ack);
  expect(
    await db.prepare("SELECT * FROM captures WHERE id=?").bind(id).first(),
  ).toEqual(before);
  expect(await (await verify(id)).json()).toMatchObject({
    ...ack,
    verified: true,
  });
});

it("repairs missing metadata from the same source and refuses conflicting bytes and retake identity", async () => {
  const id = crypto.randomUUID();
  const ack = await (await send(upload(id))).json();
  const db = await mf.getD1Database("DB");
  await db.prepare("DELETE FROM captures WHERE id=?").bind(id).run();
  expect((await verify(id)).status).toBe(404);
  expect(
    await (
      await send(
        upload(id, source, { "X-Capture-Recovery": JSON.stringify(ack) }),
      )
    ).json(),
  ).toEqual(ack);
  const other = crypto.randomUUID();
  await send(upload(other));
  expect(
    (await send(upload(id, new Uint8Array([255, 216, 255, 9])))).status,
  ).toBe(409);
  expect(
    (await send(upload(id, source, { "X-Retake-Of": other }))).status,
  ).toBe(409);
  expect(await (await verify(id)).json()).toMatchObject({
    ...ack,
    verified: true,
  });
});

it("never accepts a corrupted existing object even when its custom checksum metadata claims the expected hash", async () => {
  const id = crypto.randomUUID();
  const sha = await digest(source);
  const bucket = await mf.getR2Bucket("BUCKET");
  const corrupt = new Uint8Array([255, 216, 255, 9, 9, 9]);
  await bucket.put(`raw/${id}/${sha}`, corrupt, {
    customMetadata: { sha256: sha },
  });
  expect((await send(upload(id))).status).toBe(409);
  expect(
    new Uint8Array(await (await bucket.get(`raw/${id}/${sha}`))!.arrayBuffer()),
  ).toEqual(corrupt);
  expect(
    await (
      await mf.getD1Database("DB")
    )
      .prepare("SELECT id FROM captures WHERE id=?")
      .bind(id)
      .first(),
  ).toBeNull();
});

it("restores acknowledged timestamps and retake order without promoting an older take", async () => {
  const parent = crypto.randomUUID(),
    older = crypto.randomUUID(),
    newer = crypto.randomUUID();
  await send(upload(parent));
  const ack = await (
    await send(upload(older, source, { "X-Retake-Of": parent }))
  ).json();
  await send(upload(newer, source, { "X-Retake-Of": parent }));
  const db = await mf.getD1Database("DB");
  const before = await db
    .prepare("SELECT * FROM captures WHERE id=?")
    .bind(older)
    .first();
  await db.prepare("DELETE FROM captures WHERE id=?").bind(older).run();
  const restored = await send(
    upload(older, source, {
      "X-Retake-Of": parent,
      "X-Capture-Recovery": JSON.stringify(ack),
    }),
  );
  expect(restored.status).toBe(200);
  expect(await restored.json()).toEqual(ack);
  expect(
    await db.prepare("SELECT * FROM captures WHERE id=?").bind(older).first(),
  ).toEqual(before);
  const selected = await mf.dispatchFetch(`${origin}/api/captures/${newer}`, {
    headers: ownerHeaders,
  });
  expect(await selected.json()).toMatchObject({
    is_current: true,
    take_number: 3,
  });
});

it("preserves immutable conflict bytes separately without changing the canonical source or multiplying identical retries", async () => {
  const id = crypto.randomUUID();
  await send(upload(id));
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("BUCKET");
  const before = await db
    .prepare("SELECT * FROM captures WHERE id=?")
    .bind(id)
    .first();
  const conflicting = new Uint8Array([255, 216, 255, 8]);
  expect((await send(upload(id, conflicting))).status).toBe(409);
  expect(
    await db.prepare("SELECT * FROM captures WHERE id=?").bind(id).first(),
  ).toEqual(before);
  expect(
    new Uint8Array(
      await (await bucket.get(before!.raw_key as string))!.arrayBuffer(),
    ),
  ).toEqual(source);
  expect(
    new Uint8Array(
      await (await bucket.get(
        `raw/${id}/${await digest(conflicting)}`,
      ))!.arrayBuffer(),
    ),
  ).toEqual(conflicting);
  expect((await bucket.list({ prefix: `raw/${id}/` })).objects).toHaveLength(2);
  expect((await send(upload(id))).status).toBe(200);
  expect((await bucket.list({ prefix: `raw/${id}/` })).objects).toHaveLength(2);
});

it("does not acknowledge a database failure, and a retry safely completes the retained original", async () => {
  const id = crypto.randomUUID();
  const response = await worker.fetch(upload(id), {
    OWNER_EMAIL: "owner@example.test",
    APP_ORIGIN: origin,
    BUCKET: await mf.getR2Bucket("BUCKET"),
    DB: {
      prepare() {
        throw new Error("Synthetic write interruption");
      },
    },
  } as never);
  expect(response.status).toBe(503);
  expect((await send(upload(id))).status).toBe(200);
  expect(await (await verify(id)).json()).toMatchObject({ id, verified: true });
});

it("preserves legacy response fields and rejects unauthenticated verification", async () => {
  const response = await send(
    upload(crypto.randomUUID(), source, { "X-Capture-Acknowledgement": "" }),
  );
  const capture = await response.json();
  expect(capture).toMatchObject({
    status: "accepted",
    is_current: true,
    outputs: { image: false, pdf: false },
  });
  expect(capture.acceptedCount).toBeGreaterThan(0);
  expect(
    (await mf.dispatchFetch(`${origin}/api/captures/${capture.id}/verify`))
      .status,
  ).toBe(401);
});
