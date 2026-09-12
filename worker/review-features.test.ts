import { afterAll, beforeAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const image = new Uint8Array([255, 216, 255, 1, 2, 3]);
const request = (path: string, method = "GET", body?: BodyInit, headers = {}) =>
  mf.dispatchFetch(origin + path, {
    method,
    body,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...headers,
    },
  });
const upload = (id: string, status: string, parent?: string) =>
  request(`/api/captures/${id}`, "POST", image, {
    "X-Capture-Status": status,
    "X-Capture-Metadata": JSON.stringify({
      manualCapture: status === "manual-review",
      quality: { ok: status === "accepted", receiptPixels: [1200, 1800] },
    }),
    ...(parent ? { "X-Retake-Of": parent } : {}),
  });
it("counts forced receipts once, preserves accepted current takes and keeps forced originals", async () => {
  const first = crypto.randomUUID(),
    retake = crypto.randomUUID(),
    good = crypto.randomUUID(),
    forced = crypto.randomUUID();
  expect((await upload(first, "manual-review")).status).toBe(200);
  expect(
    await (await upload(retake, "manual-review", first)).json(),
  ).toMatchObject({
    acceptedCount: 1,
    is_current: true,
    receipt_id: first,
    status: "manual-review",
  });
  expect(await (await upload(good, "accepted", retake)).json()).toMatchObject({
    acceptedCount: 1,
    is_current: true,
  });
  expect(
    await (await upload(forced, "manual-review", good)).json(),
  ).toMatchObject({
    acceptedCount: 1,
    is_current: false,
    current_capture_id: good,
  });
  expect(
    await (await upload(forced, "manual-review", good)).json(),
  ).toMatchObject({ take_number: 4 });
  expect(
    (await (await request("/api/captures?current=1")).json()).captures.map(
      (c: { id: string }) => c.id,
    ),
  ).toEqual([good]);
  expect((await request(`/api/files/${first}/raw`)).status).toBe(200);
  expect(
    (
      await request(`/api/captures/${crypto.randomUUID()}`, "POST", image, {
        "X-Capture-Status": "manual-review",
      })
    ).status,
  ).toBe(400);
});
it("paginates without missing or repeating captures and validates limits", async () => {
  for (let i = 0; i < 12; i++) await upload(crypto.randomUUID(), "accepted");
  const first = await (await request("/api/captures?limit=10")).json();
  const second = await (
    await request(
      `/api/captures?limit=10&before=${encodeURIComponent(first.next)}`,
    )
  ).json();
  expect(first.captures).toHaveLength(10);
  expect(second.captures).toHaveLength(6);
  expect(second.next).toBeNull();
  expect(
    new Set([...first.captures, ...second.captures].map((c) => c.id)).size,
  ).toBe(16);
  for (const limit of ["0", "101", "NaN", "1.5"])
    expect((await request(`/api/captures?limit=${limit}`)).status).toBe(400);
});
it("keeps private issue screenshot and original report immutable across retries and status updates", async () => {
  const id = crypto.randomUUID();
  const headers = {
    "X-Issue-Metadata": encodeURIComponent(
      JSON.stringify({
        title: "Synthetic glare report",
        description: "Only synthetic test data",
        context: { phase: "red" },
      }),
    ),
  };
  expect(
    (await request(`/api/issues/${id}`, "POST", image, headers)).status,
  ).toBe(201);
  expect(
    (await request(`/api/issues/${id}`, "POST", image, headers)).status,
  ).toBe(200);
  expect(
    (
      await request(
        `/api/issues/${id}`,
        "POST",
        new Uint8Array([255, 216, 255, 9]),
        headers,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/api/issues/${id}`,
        "PATCH",
        JSON.stringify({
          status: "resolved",
          note: "Verified with synthetic fixture.",
        }),
      )
    ).status,
  ).toBe(200);
  const issue = await (await request(`/api/issues/${id}`)).json();
  expect(issue).toMatchObject({
    status: "resolved",
    description: "Only synthetic test data",
    updates: [{ status: "resolved", note: "Verified with synthetic fixture." }],
  });
  expect(
    new Uint8Array(await (await request(issue.screenshot)).arrayBuffer()),
  ).toEqual(image);
  for (const path of ["/api/issues", `/api/issues/${id}`, issue.screenshot]) {
    expect((await mf.dispatchFetch(origin + path)).status).toBe(401);
    expect(
      (
        await mf.dispatchFetch(origin + path, {
          headers: {
            ...ownerHeaders,
            "oai-authenticated-user-email": "other@example.test",
          },
        })
      ).status,
    ).toBe(403);
  }
  expect((await request(`/api/issues/${id}`, "DELETE")).status).toBe(405);
});
it("offers a friendly wrong-account page without granting API access", async () => {
  const response = await mf.dispatchFetch(origin + "/", {
    headers: {
      ...ownerHeaders,
      "oai-authenticated-user-email": "other@example.test",
    },
  });
  expect(response.status).toBe(403);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("This scanner belongs to another account");
  expect(html).toContain("github.com/oana-ffg/galactic-receipt-scanner");
  expect(html).not.toContain("owner@example.test");
});
it("rejects raw targeted commands and unsupported camera clients", async () => {
  expect(
    (await request(`/api/control/retake:${crypto.randomUUID()}`, "POST"))
      .status,
  ).toBe(400);
  expect((await request("/api/control/force", "POST")).status).toBe(409);
});

it("accepts narrow sharp captures and rejects insufficient source dimensions", async () => {
  for (const pixels of [
    [450, 900],
    [900, 450],
    [594, 2034],
    [449, 2000],
    [800, 800],
  ]) {
    const response = await request(
      `/api/captures/${crypto.randomUUID()}`,
      "POST",
      image,
      {
        "X-Capture-Status": "accepted",
        "X-Capture-Metadata": JSON.stringify({
          quality: { ok: true, receiptPixels: pixels },
        }),
      },
    );
    expect(response.status).toBe(
      Math.min(...pixels) >= 450 && Math.max(...pixels) >= 900 ? 200 : 409,
    );
  }
});

it("queues targeted retakes when a saved acknowledgement is newer than the stored heartbeat", async () => {
  const id = crypto.randomUUID();
  await upload(id, "accepted");
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "UPDATE station SET camera=?,expires=?,updated=?,state=? WHERE id=1",
    )
    .bind(
      crypto.randomUUID(),
      Date.now() + 10000,
      Date.now(),
      JSON.stringify({
        supportsTargetedRetake: true,
        activeId: id,
        recovery: "upload",
      }),
    )
    .run();
  expect(
    (
      await request(
        "/api/control/retake",
        "POST",
        JSON.stringify({ captureId: id }),
      )
    ).status,
  ).toBe(200);
  expect(
    await db.prepare("SELECT command FROM station WHERE id=1").first(),
  ).toEqual({ command: `retake:${id}` });
});
