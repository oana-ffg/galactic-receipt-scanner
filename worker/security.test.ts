import worker, { authorize } from "./index";
import { beforeAll, afterAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
function request(
  path: string,
  method = "GET",
  body?: BodyInit,
  extra: Record<string, string> = {},
) {
  return mf.dispatchFetch(origin + path, {
    method,
    body,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...extra,
    },
  });
}
it("rejects anonymous, other-user and cross-origin requests on all sensitive routes", async () => {
  for (const path of [
    "/",
    "/camera",
    "/api/me",
    "/api/captures",
    "/api/station",
    "/api/station/preview",
    "/api/station/preview-request",
    "/api/station/direct-preview",
    "/api/station/release",
    "/vendor/ocr/worker.min.js",
    "/vendor/opencv.js",
    "/api/files/00000000-0000-4000-8000-000000000001/raw",
  ]) {
    const anonymous = await mf.dispatchFetch(origin + path);
    expect(anonymous.status, path).toBe(401);
    expect(anonymous.headers.get("cache-control")).toContain("no-store");
    expect(
      (
        await request(path, "GET", undefined, {
          "oai-authenticated-user-email": "intruder@example.test",
        })
      ).status,
      path,
    ).toBe(403);
    expect(
      (
        await request(path, "GET", undefined, {
          Origin: "https://attacker.example",
        })
      ).status,
      path,
    ).toBe(403);
  }
  expect(
    (
      await request("/api/control/start", "POST", undefined, {
        "X-Scanner-Request": "",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/captures", "GET", undefined, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await mf.dispatchFetch("https://direct-worker.example/api/me", {
        headers: ownerHeaders,
      })
    ).status,
  ).toBe(403);
});
it("allows owner navigation from external links only to app pages", async () => {
  // Invoke the Worker with a browser-shaped Request: the test transport uses
  // fetch(), which supplies its own Sec-Fetch-Mode rather than navigation mode.
  const navigate = (
    path: string,
    method = "GET",
    headers: Record<string, string> = ownerHeaders,
  ) =>
    worker.fetch(new Request(origin + path, { method, headers }), {
      OWNER_EMAIL: "owner@example.test",
      APP_ORIGIN: origin,
      ASSETS: { fetch: async () => new Response("Synthetic app page") },
    } as never);
  const navigation = {
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  for (const path of ["/", "/camera", "/issues", "/review"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await navigate(path, method, {
        ...ownerHeaders,
        ...navigation,
      });
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect((await navigate(path, "GET", navigation)).status).toBe(401);
    for (const extra of [
      { "oai-authenticated-user-email": "intruder@example.test" },
      { Origin: "https://attacker.example" },
      { "sec-fetch-mode": "cors" },
      { "sec-fetch-mode": "no-cors" },
      { "sec-fetch-dest": "image" },
      { "sec-fetch-dest": "" },
    ]) {
      expect(
        (
          await navigate(path, "GET", {
            ...ownerHeaders,
            ...navigation,
            ...extra,
          })
        ).status,
        path,
      ).toBe(403);
    }
    expect(
      (
        await navigate(path, "POST", {
          ...ownerHeaders,
          ...navigation,
          Origin: origin,
          "X-Scanner-Request": "1",
        })
      ).status,
    ).toBe(403);
  }
  for (const path of [
    "/api/me",
    "/api/documents",
    "/api/files/00000000-0000-4000-8000-000000000001/raw",
    "/assets/app.js",
    "/vendor/ocr/worker.min.js",
    "/unknown",
    "/review/",
  ]) {
    expect(
      (await navigate(path, "GET", { ...ownerHeaders, ...navigation })).status,
      path,
    ).toBe(403);
  }
});

it("preserves source bytes through retries and conflicts; accepts originals without waiting for derivatives", async () => {
  const id = crypto.randomUUID();
  const data = new Uint8Array([255, 216, 255, 1, 2, 3]);
  const metadata = {
    quality: { ok: true, receiptPixels: [1000, 2000] },
    sourcePixels: [2000, 2400],
  };
  const upload = () =>
    request(`/api/captures/${id}`, "POST", data, {
      "x-capture-metadata": JSON.stringify(metadata),
    });
  const first = await upload();
  expect(first.status).toBe(200);
  expect((await first.json()).status).toBe("checking");
  expect((await upload()).status).toBe(200);
  expect(
    (
      await request(
        `/api/captures/${id}`,
        "POST",
        new Uint8Array([255, 216, 255, 9]),
      )
    ).status,
  ).toBe(409);
  const final = () =>
    request(
      `/api/captures/${id}/finalize`,
      "POST",
      JSON.stringify({ status: "accepted" }),
    );
  expect((await final()).status).toBe(200);
  expect((await request(`/api/files/${id}/pdf`)).status).toBe(404);
  expect(
    (await request(`/api/captures/${id}/artifacts/image`, "POST", data)).status,
  ).toBe(200);
  expect(
    (await request(`/api/captures/${id}/artifacts/pdf`, "POST", "%PDF-test"))
      .status,
  ).toBe(200);
  expect((await final()).status).toBe(200);
  expect(
    new Uint8Array(await (await request(`/api/files/${id}/raw`)).arrayBuffer()),
  ).toEqual(data);
  expect((await (await request(`/api/captures/${id}`)).json()).status).toBe(
    "accepted",
  );
});
it("rejects missing quality, unsafe payload formats, traversal and competing camera leases", async () => {
  const id = crypto.randomUUID();
  expect(
    (await request(`/api/captures/${id}`, "POST", "<svg onload=alert(1)>"))
      .status,
  ).toBe(415);
  expect((await request("/api/files/not-a-uuid/raw")).status).toBe(400);
  expect((await request("/api/captures/../../.env")).status).not.toBe(200);
  expect(
    (
      await request(
        "/api/station/claim",
        "POST",
        JSON.stringify({ camera: id }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        "/api/station/claim",
        "POST",
        JSON.stringify({ camera: crypto.randomUUID() }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/api/station/heartbeat",
        "POST",
        JSON.stringify({ camera: crypto.randomUUID(), state: {} }),
      )
    ).status,
  ).toBe(409);
  await request(
    "/api/station/release",
    "POST",
    JSON.stringify({ camera: crypto.randomUUID() }),
  );
  expect(
    (
      await request(
        "/api/station/heartbeat",
        "POST",
        JSON.stringify({ camera: id, state: {} }),
      )
    ).status,
  ).toBe(200);
  await request("/api/station/release", "POST", JSON.stringify({ camera: id }));
  expect(
    (
      await request(
        "/api/station/heartbeat",
        "POST",
        JSON.stringify({ camera: id, state: {} }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/api/station/claim",
        "POST",
        JSON.stringify({ camera: crypto.randomUUID() }),
      )
    ).status,
  ).toBe(200);
});

it("fails closed without owner configuration and never acknowledges a failed object write", async () => {
  const req = new Request(origin + "/api/me", { headers: ownerHeaders });
  expect(() => authorize(req, { OWNER_EMAIL: "", APP_ORIGIN: origin })).toThrow(
    "not configured",
  );
  expect(() =>
    authorize(req, { OWNER_EMAIL: "owner@example.test", APP_ORIGIN: "" }),
  ).toThrow("not configured");
  const request = new Request(origin + "/api/captures/" + crypto.randomUUID(), {
    method: "POST",
    headers: { ...ownerHeaders, Origin: origin, "X-Scanner-Request": "1" },
    body: new Uint8Array([255, 216, 255, 1]),
  });
  const response = await worker.fetch(request, {
    OWNER_EMAIL: "owner@example.test",
    APP_ORIGIN: origin,
    BUCKET: {
      put: async () => {
        throw new Error("Storage unavailable");
      },
    },
  } as never);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("accepted");
});

it("cannot accept an original with missing quality or a failed original write", async () => {
  for (const quality of [
    undefined,
    { ok: true, receiptPixels: [] },
    { ok: true, receiptPixels: [449, 1500] },
    { ok: false, receiptPixels: [1200, 1500] },
  ]) {
    const id = crypto.randomUUID();
    const response = await request(
      `/api/captures/${id}`,
      "POST",
      new Uint8Array([255, 216, 255, 1]),
      {
        "x-capture-status": "accepted",
        "x-capture-metadata": JSON.stringify({ quality }),
      },
    );
    expect(response.status).toBe(409);
    expect((await request(`/api/captures/${id}`)).status).toBe(404);
  }
});

it("identifies fresh HTTP preview frames and rejects stale ones", async () => {
  const db = await mf.getD1Database("DB");
  const row = await db
    .prepare("SELECT camera FROM station WHERE id=1")
    .first<{ camera: string }>();
  const camera = row!.camera;
  await request(
    "/api/station/heartbeat",
    "POST",
    JSON.stringify({ camera, state: {} }),
  );
  const before = Date.now();
  const posted = await request(
    "/api/station/preview",
    "POST",
    new Uint8Array([255, 216, 255, 1]),
    { "x-camera-id": camera },
  );
  expect(posted.status).toBe(200);
  const first = await request("/api/station/preview");
  expect(first.status).toBe(200);
  const received = first.headers.get("X-Preview-Received-At");
  expect(Number(received)).toBeGreaterThanOrEqual(before);
  expect(Number(received)).toBeLessThanOrEqual(Date.now());
  expect(Number(first.headers.get("X-Preview-Age-Ms"))).toBeGreaterThanOrEqual(
    0,
  );
  expect(first.headers.get("cache-control")).toContain("no-store");
  const repeated = await request("/api/station/preview");
  expect(repeated.headers.get("X-Preview-Received-At")).toBe(received);
  const bucket = await mf.getR2Bucket("BUCKET");
  await bucket.put("preview/latest", new Uint8Array([255, 216, 255, 1]), {
    customMetadata: { camera, capturedAt: String(Date.now() - 4000) },
  });
  expect((await request("/api/station/preview")).status).toBe(404);
});

it("binds direct preview signalling to the active camera and one viewer session", async () => {
  const db = await mf.getD1Database("DB");
  const row = await db
    .prepare("SELECT camera FROM station WHERE id=1")
    .first<{ camera: string }>();
  const camera = row!.camera;
  await request(
    "/api/station/heartbeat",
    "POST",
    JSON.stringify({ camera, state: {} }),
  );
  const id = crypto.randomUUID();
  const signal = (body: object, extra: Record<string, string> = {}) =>
    request("/api/station/direct-preview", "POST", JSON.stringify(body), extra);
  const offer = { type: "offer", sdp: "synthetic-offer" };
  const answer = { type: "answer", sdp: "synthetic-answer" };
  expect(
    (await signal({ camera: crypto.randomUUID(), id, offer })).status,
  ).toBe(409);
  expect(
    (
      await signal(
        { camera, id, offer },
        { "oai-authenticated-user-email": "intruder@example.test" },
      )
    ).status,
  ).toBe(403);
  expect((await signal({ camera, id, offer })).status).toBe(200);
  expect(
    (await signal({ camera, id: crypto.randomUUID(), offer })).status,
  ).toBe(409);
  expect(
    (await signal({ camera, id: crypto.randomUUID(), answer })).status,
  ).toBe(409);
  expect((await signal({ camera, id, answer })).status).toBe(200);
  expect((await signal({ camera, id, renew: true })).status).toBe(200);
  const station = await (await request("/api/station")).json();
  expect(station.previewSession).toMatchObject({ id, offer, answer });
  expect(
    (await signal({ camera, id, answer: { type: "offer", sdp: "wrong" } }))
      .status,
  ).toBe(400);
});

it("leases fallback demand without stealing direct preview or carrying it to another camera", async () => {
  const db = await mf.getD1Database("DB");
  const { camera, preview_session } = (await db
    .prepare("SELECT camera,preview_session FROM station WHERE id=1")
    .first())!;
  const demand = (id: unknown) =>
    request(
      "/api/station/preview-request",
      "POST",
      JSON.stringify({ camera: id }),
    );
  const heartbeat = async () =>
    (
      await request(
        "/api/station/heartbeat",
        "POST",
        JSON.stringify({ camera, state: {} }),
      )
    ).json();
  expect((await demand("invalid")).status).toBe(400);
  expect((await demand(crypto.randomUUID())).status).toBe(409);
  expect((await demand(camera)).status).toBe(200);
  const state = await heartbeat();
  expect(state.previewRequestedForMs).toBeGreaterThan(0);
  expect(state.previewRequestedForMs).toBeLessThanOrEqual(5000);
  expect(state.previewSession).toEqual(JSON.parse(String(preview_session)));
  await db
    .prepare("UPDATE station SET preview_requested_until=? WHERE id=1")
    .bind(Date.now() - 1)
    .run();
  expect((await heartbeat()).previewRequestedForMs).toBe(0);
  await demand(camera);
  expect(
    (await request("/api/station/release", "POST", JSON.stringify({ camera })))
      .status,
  ).toBe(200);
  expect((await demand(camera)).status).toBe(409);
  const replacement = crypto.randomUUID();
  expect(
    (
      await request(
        "/api/station/claim",
        "POST",
        JSON.stringify({ camera: replacement }),
      )
    ).status,
  ).toBe(200);
  expect(
    (await db
      .prepare("SELECT preview_requested_until FROM station WHERE id=1")
      .first())!.preview_requested_until,
  ).toBe(0);
  expect((await demand(camera)).status).toBe(409);
});
