import { bodyJson, digest, json, requireThat, UUID } from "./http";
import type { Env } from "./index";

function base64(value: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

// The browser and model receive ciphertext only. The worker's private key stays on its host.
async function seal(publicKey: JsonWebKey, value: object) {
  requireThat(
    publicKey?.kty === "RSA" &&
      publicKey.e === "AQAB" &&
      typeof publicKey.n === "string" &&
      publicKey.n.length >= 342 &&
      publicKey.n.length <= 684 &&
      !publicKey.d &&
      !publicKey.p &&
      !publicKey.q,
    400,
    "Supply a 2048–4096-bit RSA public key from the connection helper.",
  );
  let rsa: CryptoKey;
  try {
    rsa = await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
  } catch {
    throw new Error("Invalid connection public key.");
  }
  const aes = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  )) as CryptoKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return {
    algorithm: "RSA-OAEP-256+A256GCM",
    key: base64(
      await crypto.subtle.encrypt(
        "RSA-OAEP",
        rsa,
        (await crypto.subtle.exportKey("raw", aes)) as ArrayBuffer,
      ),
    ),
    iv: base64(iv),
    ciphertext: base64(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        aes,
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
  };
}

export async function connectionRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/connections" && request.method === "GET") {
    const before = new URL(request.url).searchParams.get("before");
    const cursor = before?.split("|");
    requireThat(
      !cursor ||
        (cursor.length === 2 &&
          Number.isSafeInteger(Number(cursor[0])) &&
          UUID.test(cursor[1])),
      400,
      "Invalid connection cursor.",
    );
    const rows = await env.DB.prepare(
      "SELECT id,name,scope,created_at,expires_at,revoked_at,last_used_at FROM agent_connections WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 51",
    )
      .bind(
        cursor ? Number(cursor[0]) : Number.MAX_SAFE_INTEGER,
        cursor?.[1] ?? "~",
      )
      .all<{ id: string; created_at: number }>();
    const page = rows.results.slice(0, 50),
      last = page.at(-1);
    return json({
      connections: page,
      next:
        rows.results.length > 50 && last
          ? `${last.created_at}|${last.id}`
          : null,
      ready: Boolean(env.SITES_GATEWAY_TOKEN),
    });
  }
  if (path === "/api/connections" && request.method === "POST") {
    requireThat(
      env.SITES_GATEWAY_TOKEN,
      503,
      "Agent connections need Sites access configured by the setup agent.",
    );
    const body = (await bodyJson(request, 16384)) as {
      request_id: string;
      name: string;
      scope: string;
      days: number;
      public_key: JsonWebKey;
    };
    requireThat(
      UUID.test(body.request_id ?? ""),
      400,
      "Invalid connection request ID.",
    );
    requireThat(
      typeof body.name === "string" &&
        body.name.trim().length > 0 &&
        body.name.length <= 80,
      400,
      "Connection name must have 1–80 characters.",
    );
    requireThat(
      ["processing", "backup"].includes(body.scope),
      400,
      "Invalid connection scope.",
    );
    requireThat(
      Number.isInteger(body.days) && body.days >= 1 && body.days <= 365,
      400,
      "Connection lifetime must be 1–365 days.",
    );
    const requestHash = await digest(
      new Uint8Array(new TextEncoder().encode(JSON.stringify(body))),
    );
    const existing = await env.DB.prepare(
      "SELECT * FROM agent_connections WHERE id=?",
    )
      .bind(body.request_id)
      .first<{
        request_hash: string;
        envelope: string;
        revoked_at: number | null;
        expires_at: number;
      }>();
    if (existing) {
      requireThat(
        existing.request_hash === requestHash,
        409,
        "Connection request changed; start a new connection.",
      );
      requireThat(
        !existing.revoked_at && existing.expires_at > Date.now(),
        409,
        "Connection expired or revoked; start a new connection.",
      );
      return json(JSON.parse(existing.envelope));
    }
    const token =
      "rsc_" +
      base64(crypto.getRandomValues(new Uint8Array(32)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const created = Date.now(),
      expires = created + body.days * 86400000;
    const envelope = {
      id: body.request_id,
      scope: body.scope,
      expires_at: expires,
      sealed: await seal(body.public_key, {
        origin: env.APP_ORIGIN,
        sites_token: env.SITES_GATEWAY_TOKEN,
        processing_token: token,
        connection_id: body.request_id,
        scope: body.scope,
        expires_at: expires,
      }),
    };
    // Conflicting/retried creation cannot silently replace an existing connection.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agent_connections(id,name,scope,token_sha256,created_at,expires_at,request_hash,envelope) VALUES(?,?,?,?,?,?,?,?)",
    )
      .bind(
        body.request_id,
        body.name.trim(),
        body.scope,
        await digest(new Uint8Array(new TextEncoder().encode(token))),
        created,
        expires,
        requestHash,
        JSON.stringify(envelope),
      )
      .run();
    const saved = await env.DB.prepare(
      "SELECT request_hash,envelope FROM agent_connections WHERE id=?",
    )
      .bind(body.request_id)
      .first<{ request_hash: string; envelope: string }>();
    requireThat(
      saved?.request_hash === requestHash,
      409,
      "Connection request conflicts with an existing request.",
    );
    return json(JSON.parse(saved.envelope));
  }
  const revoke = path.match(/^\/api\/connections\/([^/]+)\/revoke$/);
  if (revoke && request.method === "POST") {
    requireThat(UUID.test(revoke[1]), 400, "Invalid connection ID.");
    const result = await env.DB.prepare(
      "UPDATE agent_connections SET revoked_at=COALESCE(revoked_at,?) WHERE id=? RETURNING id",
    )
      .bind(Date.now(), revoke[1])
      .first();
    requireThat(result, 404, "Connection not found.");
    return json({ revoked: true });
  }
  return null;
}
