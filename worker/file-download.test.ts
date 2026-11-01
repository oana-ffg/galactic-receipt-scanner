import { afterAll, beforeAll, expect, it, vi } from "vitest";
import worker from "./index";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;
const id = "00000000-0000-4000-8000-000000000001";
const source = new Uint8Array([255, 216, 255]);
const sourceHash = "a".repeat(64);
beforeAll(async () => {
  mf = await runtime();
  const db = await mf.getD1Database("DB");
  // Thousands of scans is a normal station backlog. Downloading one must not
  // count or hydrate all of them, even when every capture is accepted.
  await db
    .prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2000)
       INSERT INTO captures(id,receipt_id,created_at,sha256,raw_key,content_type,bytes,status,metadata)
       SELECT printf('00000000-0000-4000-8000-%012d',x),printf('00000000-0000-4000-8000-%012d',x),
         '2026-01-01',?,'synthetic-original','image/jpeg',3,'accepted','{}' FROM n`,
    )
    .bind(sourceHash)
    .run();
  const bucket = await mf.getR2Bucket("BUCKET");
  await bucket.put("synthetic-original", source);
  for (const kind of ["image", "pdf", "ocr"]) {
    for (const [index, hash] of ["b".repeat(64), "c".repeat(64)].entries()) {
      const key = `${kind}/${hash}`;
      await db
        .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?,?)")
        .bind(
          key,
          id,
          kind,
          hash,
          `2026-01-0${index + 1}`,
          "application/octet-stream",
        )
        .run();
      await bucket.put(key, `${kind}-${index}`);
    }
  }
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

async function download(path: string, headers = ownerHeaders) {
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("BUCKET");
  const queries: { sql: string; rows: number }[] = [];
  let objectReads = 0;
  const response = await worker.fetch(new Request(origin + path, { headers }), {
    OWNER_EMAIL: "owner@example.test",
    APP_ORIGIN: origin,
    DB: {
      prepare(sql: string) {
        const wrap = (statement: ReturnType<typeof db.prepare>): unknown => ({
          bind: (...args: unknown[]) => wrap(statement.bind(...args)),
          async first() {
            const result = await statement.all();
            queries.push({ sql, rows: result.meta.rows_read });
            return result.results[0] ?? null;
          },
        });
        return wrap(db.prepare(sql));
      },
    },
    BUCKET: {
      get(key: string) {
        objectReads++;
        return bucket.get(key);
      },
    },
  } as never);
  return { response, queries, objectReads };
}

it("reads only the indexed source row and one object for an original download", async () => {
  for (const suffix of ["", `?version=${sourceHash}`]) {
    const { response, queries, objectReads } = await download(
      `/api/files/${id}/raw${suffix}`,
    );
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(source);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toContain(
      `${id}-raw.jpg`,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(objectReads).toBe(1);
    expect(queries).toHaveLength(1);
    expect(queries[0].rows).toBeLessThanOrEqual(2);
    const db = await mf.getD1Database("DB");
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${queries[0].sql}`)
      .bind(id)
      .all();
    expect(plan.results.map((row) => row.detail).join("\n")).toMatch(
      /SEARCH captures USING INDEX .* \(id=\?\)/,
    );
    expect(plan.results.map((row) => row.detail).join("\n")).not.toMatch(
      /SCAN|TEMP B-TREE/,
    );
  }
});

it("preserves latest and pinned derivative downloads without scanning captures", async () => {
  for (const kind of ["image", "pdf", "ocr"]) {
    for (const [suffix, body] of [
      ["", `${kind}-1`],
      [`?version=${"b".repeat(64)}`, `${kind}-0`],
    ]) {
      const { response, queries, objectReads } = await download(
        `/api/files/${id}/${kind}${suffix}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      expect(objectReads).toBe(1);
      expect(queries).toHaveLength(2);
      expect(
        queries.reduce((sum, query) => sum + query.rows, 0),
      ).toBeLessThanOrEqual(10);
    }
  }
});

it("keeps access, missing-source and version checks ahead of object retrieval", async () => {
  for (const [path, status] of [
    [`/api/files/${id}/raw?version=${"d".repeat(64)}`, 404],
    [`/api/files/${id}/raw?version=invalid`, 400],
    [`/api/files/${id}/pdf?version=${"d".repeat(64)}`, 404],
    ["/api/files/00000000-0000-4000-8000-000000009999/raw", 404],
  ] as const) {
    const result = await download(path);
    expect(result.response.status).toBe(status);
    expect(result.objectReads).toBe(0);
  }
  const denied = await download(`/api/files/${id}/raw`, {
    ...ownerHeaders,
    "oai-authenticated-user-email": "other@example.test",
  });
  expect(denied.response.status).toBe(403);
  expect(denied.queries).toHaveLength(0);
  expect(denied.objectReads).toBe(0);
});

it("correlates download database failures with their dependency, stage and trace", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await worker.fetch(
      new Request(`${origin}/api/files/${id}/raw`, { headers: ownerHeaders }),
      {
        OWNER_EMAIL: "owner@example.test",
        APP_ORIGIN: origin,
        DB: {
          prepare() {
            throw new Error("Synthetic database read failure");
          },
        },
      } as never,
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.detail).toContain("D1 capture-row-read");
    expect(body.detail).toContain(body.traceId);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      dependency: "D1",
      stage: "capture-row-read",
      trace_id: body.traceId,
      status: 503,
    });
  } finally {
    log.mockRestore();
  }
});
