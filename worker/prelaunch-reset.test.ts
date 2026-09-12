import { expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";

it("clears only a reviewed synthetic inventory, blocks writes and refuses changed inventories", async () => {
  const id = crypto.randomUUID(),
    sha = "a".repeat(64);
  const mf = await runtime({
    maintenanceManifest: JSON.stringify({
      expires: Date.now() + 60000,
      cutoff: Date.now() + 60000,
      captures: [{ id, sha256: sha }],
    }),
  });
  try {
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("BUCKET");
    await db
      .prepare(
        "INSERT INTO captures(id,created_at,sha256,raw_key,content_type,bytes,status,metadata) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        new Date().toISOString(),
        sha,
        `raw/${id}/${sha}`,
        "image/jpeg",
        3,
        "accepted",
        "{}",
      )
      .run();
    await db.prepare("INSERT INTO station(id) VALUES(1)").run();
    await bucket.put(`raw/${id}/${sha}`, new Uint8Array([255, 216, 255]));
    await bucket.put("preview/latest", new Uint8Array([255, 216, 255]));
    const call = (path: string, method = "GET", body?: string) =>
      mf.dispatchFetch(origin + path, {
        method,
        body,
        headers: {
          ...ownerHeaders,
          Origin: origin,
          "X-Scanner-Request": "1",
          "Content-Type": "application/json",
        },
      });
    expect((await mf.dispatchFetch(origin + "/__prelaunch-reset")).status).toBe(
      401,
    );
    expect(
      (await call(`/api/captures/${crypto.randomUUID()}`, "POST", "new data"))
        .status,
    ).toBe(503);
    const html = await (await call("/__prelaunch-reset")).text();
    const hash = html.match(/data-inventory="([a-f0-9]+)"/)![1];
    await bucket.put("preview/latest", "changed");
    expect(
      (
        await call(
          "/__prelaunch-reset",
          "POST",
          JSON.stringify({ inventory: hash }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM captures")
        .first<{ n: number }>())!.n,
    ).toBe(1);
    const next = await (await call("/__prelaunch-reset")).text();
    const result = await call(
      "/__prelaunch-reset",
      "POST",
      JSON.stringify({
        inventory: next.match(/data-inventory="([a-f0-9]+)"/)![1],
      }),
    );
    expect(await result.json()).toEqual({
      captures: 0,
      artifacts: 0,
      objects: 0,
      station: 0,
      complete: true,
    });
    expect((await bucket.list()).objects).toHaveLength(0);
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM captures")
        .first<{ n: number }>())!.n,
    ).toBe(0);
  } finally {
    await mf.dispose();
  }
});

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
