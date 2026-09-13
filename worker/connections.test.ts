import { afterAll, beforeAll, expect, it } from "vitest";
import {
  generateKeyPairSync,
  privateDecrypt,
  createDecipheriv,
  constants,
} from "node:crypto";
import { runtime, ownerHeaders } from "../scripts/test-runtime.mjs";

const origin = "https://synthetic.example";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime({
    appOrigin: origin,
    sitesGatewayToken: "synthetic-gateway",
  });
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const headers = { ...ownerHeaders, Origin: origin, "X-Scanner-Request": "1" };
const post = (path: string, body: unknown, auth = headers) =>
  mf.dispatchFetch(origin + path, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
function newRequest(scope = "processing") {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    pair,
    input: {
      request_id: crypto.randomUUID(),
      name: "Synthetic worker",
      scope,
      days: 1,
      public_key: pair.publicKey.export({ format: "jwk" }),
    },
  };
}
function decrypt(envelope: any, pair: ReturnType<typeof generateKeyPairSync>) {
  const aes = privateDecrypt(
    {
      key: pair.privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.sealed.key, "base64"),
  );
  const bytes = Buffer.from(envelope.sealed.ciphertext, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aes,
    Buffer.from(envelope.sealed.iv, "base64"),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(0, -16)),
      decipher.final(),
    ]).toString(),
  );
}

it("issues only owner-authorized encrypted connections and retries idempotently", async () => {
  const { input, pair } = newRequest();
  expect(
    (await post("/api/connections", input, {} as typeof headers)).status,
  ).toBe(401);
  expect(
    (
      await post("/api/connections", input, {
        ...headers,
        Origin: "https://attacker.example",
      })
    ).status,
  ).toBe(403);
  const response = await post("/api/connections", input);
  expect(response.status).toBe(200);
  const envelope = (await response.json()) as any;
  expect(JSON.stringify(envelope)).not.toContain("synthetic-gateway");
  const value = decrypt(envelope, pair);
  expect(value.sites_token).toBe("synthetic-gateway");
  expect(value.connection_id).toBe(input.request_id);
  expect(await (await post("/api/connections", input)).json()).toEqual(
    envelope,
  );
  expect(
    (await post("/api/connections", { ...input, scope: "backup" })).status,
  ).toBe(409);
  const auth = { Authorization: `Bearer ${value.processing_token}` };
  expect(
    (
      await mf.dispatchFetch(origin + "/api/processing/access", {
        headers: auth,
      })
    ).status,
  ).toBe(200);
  expect(
    (await mf.dispatchFetch(origin + "/api/connections", { headers: auth }))
      .status,
  ).toBe(403);
  expect(
    (await post("/api/connections", newRequest().input, auth as typeof headers))
      .status,
  ).toBe(403);
  const catalog = (await (
    await mf.dispatchFetch(origin + "/api/connections", { headers })
  ).json()) as any;
  expect(JSON.stringify(catalog)).not.toContain(value.processing_token);
  expect(JSON.stringify(catalog)).not.toContain("sealed");
  expect(
    catalog.connections.find((c: any) => c.id === input.request_id)
      .last_used_at,
  ).toBeGreaterThan(0);
  expect(
    (await post(`/api/connections/${input.request_id}/revoke`, {})).status,
  ).toBe(200);
  expect(
    (
      await mf.dispatchFetch(origin + "/api/processing/access", {
        headers: auth,
      })
    ).status,
  ).toBe(401);
  expect((await post("/api/connections", input)).status).toBe(409);
});

it("restricts backup keys to originals and metadata and enforces expiry", async () => {
  const { input, pair } = newRequest("backup");
  const value = decrypt(
    await (await post("/api/connections", input)).json(),
    pair,
  );
  const auth = { Authorization: `Bearer ${value.processing_token}` };
  expect(
    (await mf.dispatchFetch(origin + "/api/captures", { headers: auth }))
      .status,
  ).toBe(200);
  for (const [method, path] of [
    ["POST", "/api/processing/claim"],
    ["GET", "/api/issues"],
    ["GET", "/api/documents"],
  ])
    expect(
      (await mf.dispatchFetch(origin + path, { method, headers: auth })).status,
    ).toBe(403);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE agent_connections SET expires_at=1 WHERE id=?")
    .bind(input.request_id)
    .run();
  expect(
    (await mf.dispatchFetch(origin + "/api/captures", { headers: auth }))
      .status,
  ).toBe(401);
});

it("paginates retained connections so older active keys remain discoverable", async () => {
  const db = await mf.getD1Database("DB");
  const ids = Array.from({ length: 55 }, () => crypto.randomUUID());
  await db.batch(
    ids.map((id) =>
      db
        .prepare(
          "INSERT INTO agent_connections(id,name,scope,token_sha256,created_at,expires_at,request_hash,envelope) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          "Synthetic old connection",
          "backup",
          id,
          1,
          Date.now() + 60000,
          id,
          "{}",
        ),
    ),
  );
  const found = new Set<string>();
  let path = "/api/connections",
    pages = 0;
  while (path) {
    const page = (await (
      await mf.dispatchFetch(origin + path, { headers })
    ).json()) as any;
    for (const row of page.connections) {
      expect(found.has(row.id)).toBe(false);
      found.add(row.id);
    }
    pages++;
    path = page.next
      ? "/api/connections?before=" + encodeURIComponent(page.next)
      : "";
  }
  expect(pages).toBeGreaterThan(1);
  expect(ids.every((id) => found.has(id))).toBe(true);
});
