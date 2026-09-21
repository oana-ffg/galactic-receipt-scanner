import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import { authorizeProcessor } from "./processing-access";

const token = `rsc_${"s".repeat(43)}`;
const hash = createHash("sha256").update(token).digest("hex");
const auth = { Authorization: `Bearer ${token}` };
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime({ processingTokenSha256: hash });
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

it("allows verified originals and immutable OCR but denies unclaimed document writes", async () => {
  const id = crypto.randomUUID();
  const bytes = new Uint8Array([255, 216, 255, 12]);
  const saved = await mf.dispatchFetch(`${origin}/api/captures/${id}`, {
    method: "POST",
    body: bytes,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1400, 2200],
        quality: { ok: true, receiptPixels: [1400, 2200] },
      }),
    },
  });
  expect(saved.status).toBe(200);
  const capture = (await saved.json()) as any;
  const read = (path: string) =>
    mf.dispatchFetch(origin + path, { headers: auth });
  expect((await read("/api/processing/ocr-layouts")).status).toBe(200);
  const raw = await read(`/api/files/${id}/raw`);
  expect(raw.status).toBe(200);
  expect(raw.headers.get("cache-control")).toContain("no-store");
  expect(
    createHash("sha256")
      .update(new Uint8Array(await raw.arrayBuffer()))
      .digest("hex"),
  ).toBe(capture.sha256);
  const doc = newDocument(capture);
  doc.vendor = "Synthetic vendor";
  doc.receiptDate = "2026-01-01";
  doc.handwriting = "present";
  const save = () =>
    mf.dispatchFetch(origin + "/api/documents", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ documents: [doc] }),
    });
  expect((await save()).status).toBe(403);
  expect(
    ((await (await read(`/api/documents/${id}`)).json()) as any).document
      .vendor,
  ).toBeNull();
  const attempt = JSON.stringify({ model: "synthetic", has_handwriting: true });
  const upload = await mf.dispatchFetch(
    `${origin}/api/captures/${id}/artifacts/ocr`,
    { method: "POST", headers: auth, body: attempt },
  );
  expect(upload.status).toBe(200);
  const artifact = (await upload.json()) as any;
  expect(
    await (
      await read(`/api/files/${id}/ocr?version=${artifact.sha256}`)
    ).text(),
  ).toBe(attempt);
  expect(
    ((await (await read(`/api/captures/${id}`)).json()) as any).sha256,
  ).toBe(capture.sha256);
  expect(
    ((await (await read(`/api/captures/${id}`)).json()) as any).created_at,
  ).toBe(capture.created_at);
});

it("denies capture, station, issue and arbitrary routes even with owner headers", async () => {
  const id = crypto.randomUUID();
  for (const [method, path] of [
    ["POST", `/api/captures/${id}`],
    ["POST", `/api/captures/${id}/finalize`],
    ["POST", `/api/captures/${id}/artifacts/image`],
    ["GET", "/api/station"],
    ["POST", "/api/station/claim"],
    ["GET", "/api/issues"],
    ["GET", "/camera"],
    ["DELETE", "/api/documents"],
    ["GET", "/api/documents-extra"],
  ])
    expect(
      (
        await mf.dispatchFetch(origin + path, {
          method,
          headers: {
            ...ownerHeaders,
            ...auth,
            Origin: origin,
            "X-Scanner-Request": "1",
          },
        })
      ).status,
      path,
    ).toBe(403);
});

it("fails closed for disabled, wrong, cross-site and old rotated credentials", async () => {
  const env = {
    OWNER_EMAIL: "owner@example.test",
    APP_ORIGIN: origin,
    PROCESSING_TOKEN_SHA256: hash,
  };
  const check = (headers = auth, config = env, url = origin) =>
    authorizeProcessor(
      new Request(url + "/api/processing/access", { headers }),
      config,
    );
  await expect(check()).resolves.toBeUndefined();
  await expect(
    check(auth, { ...env, PROCESSING_TOKEN_SHA256: "" }),
  ).rejects.toThrow("disabled");
  await expect(
    check(auth, { ...env, PROCESSING_TOKEN_SHA256: "a".repeat(64) }),
  ).rejects.toThrow("Invalid processing");
  await expect(check({ Authorization: "Bearer wrong" })).rejects.toThrow(
    "credential required",
  );
  await expect(
    check({ ...auth, Origin: "https://attacker.example" } as typeof auth),
  ).rejects.toThrow("Cross-origin");
  await expect(
    check({ ...auth, "sec-fetch-site": "cross-site" } as typeof auth),
  ).rejects.toThrow("Cross-site");
  await expect(
    check(auth, env, "https://direct-worker.example"),
  ).rejects.toThrow("Origin denied");
  expect(
    (await mf.dispatchFetch(origin + "/api/processing/access")).status,
  ).toBe(401);
  expect(
    (
      await mf.dispatchFetch(origin + "/api/processing/access", {
        headers: auth,
      })
    ).status,
  ).toBe(200);
});
