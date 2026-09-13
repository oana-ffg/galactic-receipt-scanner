import { afterAll, beforeAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const bytes = new Uint8Array([255, 216, 255, 1, 2, 3]);
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
async function upload(id: string, retakeOf?: string, status = "accepted") {
  return request(`/api/captures/${id}`, "POST", bytes, {
    "X-Capture-Status": status,
    "X-Capture-Metadata": JSON.stringify({
      quality: { ok: status === "accepted", receiptPixels: [1200, 1800] },
    }),
    ...(retakeOf ? { "X-Retake-Of": retakeOf } : {}),
  });
}
const read = async (id: string) =>
  (await request(`/api/captures/${id}`)).json();

it("keeps one current take per receipt, including rejected retakes, retry races and old artifacts", async () => {
  const first = crypto.randomUUID(),
    second = crypto.randomUUID(),
    rejected = crypto.randomUUID();
  expect((await upload(first)).status).toBe(200);
  await request(
    `/api/captures/${first}/artifacts/pdf`,
    "POST",
    "%PDF-synthetic",
  );
  expect((await upload(rejected, first, "rejected")).status).toBe(200);
  expect(await read(first)).toMatchObject({
    is_current: true,
    acceptedCount: 1,
  });
  expect(await read(rejected)).toMatchObject({
    receipt_id: first,
    retake_of: first,
    take_number: 2,
    is_current: false,
  });
  const retries = await Promise.all([
    upload(second, rejected),
    upload(second, rejected),
  ]);
  expect(retries.map((r) => r.status)).toEqual([200, 200]);
  expect(await read(second)).toMatchObject({
    receipt_id: first,
    retake_of: rejected,
    take_number: 3,
    is_current: true,
    acceptedCount: 1,
  });
  expect(await read(first)).toMatchObject({
    is_current: false,
    outputs: { pdf: true },
  });
  expect((await request(`/api/files/${first}/pdf`)).status).toBe(200);
  expect(
    new Uint8Array(
      await (await request(`/api/files/${first}/raw`)).arrayBuffer(),
    ),
  ).toEqual(bytes);
  const third = crypto.randomUUID(),
    fourth = crypto.randomUUID();
  expect(
    (await Promise.all([upload(third, second), upload(fourth, second)])).map(
      (r) => r.status,
    ),
  ).toEqual([200, 200]);
  const takes = await Promise.all([read(third), read(fourth)]);
  expect(takes.map((t) => t.take_number).sort()).toEqual([4, 5]);
  expect(takes.filter((t) => t.is_current)).toHaveLength(1);
  const current = await (await request("/api/captures?current=1")).json();
  expect(current.captures).toHaveLength(1);
  expect(current.captures[0].take_number).toBe(5);
  expect((await (await request("/api/station")).json()).count).toBe(1);
  expect((await (await request("/api/captures")).json()).captures).toHaveLength(
    5,
  );
});

it("rejects missing, self and changed retake links before storing another object", async () => {
  const id = crypto.randomUUID(),
    parent = crypto.randomUUID();
  expect((await upload(id, id)).status).toBe(400);
  expect((await upload(id, parent)).status).toBe(404);
  expect((await upload(parent)).status).toBe(200);
  expect((await upload(id, parent)).status).toBe(200);
  const bucket = await mf.getR2Bucket("BUCKET");
  const before = (await bucket.list()).objects.length;
  expect((await upload(id)).status).toBe(409);
  expect((await upload(id, crypto.randomUUID())).status).toBe(404);
  expect((await bucket.list()).objects).toHaveLength(before);
  expect((await read(id)).retake_of).toBe(parent);
});

it("does not supersede an accepted take when original storage fails", async () => {
  const { default: worker } = await import("./index");
  const parent = crypto.randomUUID();
  await upload(parent);
  const response = await worker.fetch(
    new Request(origin + `/api/captures/${crypto.randomUUID()}`, {
      method: "POST",
      body: bytes,
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "X-Retake-Of": parent,
      },
    }),
    {
      OWNER_EMAIL: "owner@example.test",
      APP_ORIGIN: origin,
      DB: await mf.getD1Database("DB"),
      BUCKET: {
        put: async () => {
          throw new Error("Synthetic storage failure");
        },
      },
    } as never,
  );
  expect(response.status).toBe(503);
  expect((await read(parent)).is_current).toBe(true);
});

it("assigns legacy receipt identity without rewriting originals, metadata or artifacts", async () => {
  const { readFile } = await import("node:fs/promises");
  const legacy = await runtime({ migrationLimit: 3 });
  try {
    const db = await legacy.getD1Database("DB"),
      bucket = await legacy.getR2Bucket("BUCKET");
    const id = crypto.randomUUID();
    await bucket.put(`raw/${id}/original`, bytes);
    await db
      .prepare(
        "INSERT INTO captures(id,created_at,sha256,raw_key,content_type,bytes,status,metadata) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        "2026-01-01T00:00:00Z",
        "synthetic-hash",
        `raw/${id}/original`,
        "image/jpeg",
        bytes.length,
        "accepted",
        '{"synthetic":true}',
      )
      .run();
    await db
      .prepare(
        "INSERT INTO artifacts(key,capture_id,kind,sha256,created_at,content_type) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "synthetic-pdf",
        id,
        "pdf",
        "synthetic-pdf-hash",
        "2026-01-01T00:00:00Z",
        "application/pdf",
      )
      .run();
    const original = await db
      .prepare("SELECT * FROM captures WHERE id=?")
      .bind(id)
      .first();
    for (const sql of (
      await readFile("drizzle/0003_oval_black_widow.sql", "utf8")
    ).split("--> statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
    expect(
      await db.prepare("SELECT * FROM captures WHERE id=?").bind(id).first(),
    ).toEqual({
      ...original,
      receipt_id: null,
      retake_of: null,
      take_number: 1,
    });
    expect(
      (await db.prepare("SELECT * FROM artifacts").all()).results,
    ).toHaveLength(1);
    expect(
      new Uint8Array(
        await (await bucket.get(`raw/${id}/original`))!.arrayBuffer(),
      ),
    ).toEqual(bytes);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    // Current read APIs also expose separately stored manual outlines.
    for (const sql of (
      await readFile("drizzle/0011_noisy_vector.sql", "utf8")
    ).split("--> statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
    const migrated = await (
      await legacy.dispatchFetch(origin + `/api/captures/${id}`, {
        headers: ownerHeaders,
      })
    ).json();
    expect(migrated).toMatchObject({
      receipt_id: id,
      is_current: true,
      acceptedCount: 1,
    });
    const replacement = crypto.randomUUID();
    const response = await legacy.dispatchFetch(
      origin + `/api/captures/${replacement}`,
      {
        method: "POST",
        body: bytes,
        headers: {
          ...ownerHeaders,
          Origin: origin,
          "X-Scanner-Request": "1",
          "X-Retake-Of": id,
          "X-Capture-Status": "accepted",
          "X-Capture-Metadata": JSON.stringify({
            quality: { ok: true, receiptPixels: [1000, 1500] },
          }),
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      receipt_id: id,
      retake_of: id,
      take_number: 2,
      is_current: true,
      acceptedCount: 1,
    });
    expect(
      await (
        await legacy.dispatchFetch(origin + `/api/captures/${id}`, {
          headers: ownerHeaders,
        })
      ).json(),
    ).toMatchObject({ is_current: false, current_capture_id: replacement });
  } finally {
    await legacy.dispose();
  }
});
