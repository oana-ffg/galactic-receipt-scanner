import { afterAll, beforeAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  headers = ownerHeaders,
) =>
  mf.dispatchFetch(origin + path, {
    method,
    headers: {
      ...headers,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
it("versions manual outlines without altering original bytes, capture checks or durable acknowledgements", async () => {
  const id = crypto.randomUUID();
  const image = new Uint8Array([255, 216, 255, 1, 2, 3]);
  const upload = () =>
    mf.dispatchFetch(origin + `/api/captures/${id}`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "X-Capture-Status": "manual-review",
        "X-Capture-Metadata": JSON.stringify({
          manualCapture: true,
          quality: { ok: false, quad: null },
        }),
      },
      body: image,
    });
  expect((await upload()).status).toBe(200);
  const before = (await (await request(`/api/captures/${id}`)).json()) as any;
  const ack = await (await request(`/api/captures/${id}/verify`)).json();
  const correction = {
    id: crypto.randomUUID(),
    source_sha256: before.sha256,
    previous_id: null,
    quad: [
      [0.1, 0.1],
      [0.8, 0.1],
      [0.8, 0.9],
      [0.1, 0.9],
    ],
    note: "Visually inspected synthetic paper edges with margin.",
  };
  const path = `/api/captures/${id}/outlines`;
  expect((await request(path, "POST", correction, {})).status).toBe(401);
  for (const change of [
    { source_sha256: "0".repeat(64) },
    { previous_id: crypto.randomUUID() },
  ])
    expect(
      (await request(path, "POST", { ...correction, ...change })).status,
    ).toBe(409);
  for (const quad of [
    [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ],
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [2, 0],
      [1, 1],
      [0, 1],
    ],
  ])
    expect((await request(path, "POST", { ...correction, quad })).status).toBe(
      400,
    );
  const concurrent = await Promise.all([
    request(path, "POST", correction),
    request(path, "POST", correction),
  ]);
  expect(concurrent.map((r) => r.status).sort()).toEqual([200, 201]);
  expect((await request(path, "POST", correction)).status).toBe(200);
  expect(
    (await request(path, "POST", { ...correction, note: "different" })).status,
  ).toBe(409);
  const second = {
    ...correction,
    id: crypto.randomUUID(),
    previous_id: correction.id,
    note: "Expanded margin after inspection.",
  };
  expect((await request(path, "POST", second)).status).toBe(201);
  expect(
    (await request(path, "POST", { ...correction, id: crypto.randomUUID() }))
      .status,
  ).toBe(409);
  const after = (await (await request(`/api/captures/${id}`)).json()) as any;
  expect(after).toEqual({
    ...before,
    manual_outline: expect.objectContaining({ id: second.id }),
  });
  expect(await (await request(`/api/captures/${id}/verify`)).json()).toEqual(
    ack,
  );
  expect(
    new Uint8Array(await (await request(`/api/files/${id}/raw`)).arrayBuffer()),
  ).toEqual(image);
  expect(((await (await request(path)).json()) as any).outlines).toHaveLength(
    2,
  );
  expect(
    ((await (await request("/api/captures")).json()) as any).captures.find(
      (c: any) => c.id === id,
    ).manual_outline.id,
  ).toBe(second.id);
  const retryUpload = await upload();
  expect(retryUpload.status).toBe(200);
  expect(await retryUpload.json()).not.toHaveProperty("manual_outline");
});
