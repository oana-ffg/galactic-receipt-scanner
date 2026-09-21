import { digest, requireThat } from "./http";

// Explicit allowlist: new application routes never acquire machine access implicitly.
export function processingRouteAllowed(method: string, path: string): boolean {
  const id =
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (method === "GET")
    return (
      [
        "/api/processing/access",
        "/api/processing/categories",
        "/api/processing/context",
        "/api/processing/ocr-layouts",
        "/api/processing/readings",
        "/api/jev/status",
        "/api/jev/documents",
        "/api/captures",
        "/api/documents",
      ].includes(path) ||
      new RegExp(`^/api/captures/${id}$`).test(path) ||
      new RegExp(`^/api/files/${id}/(raw|image|pdf|ocr)$`).test(path) ||
      new RegExp(`^/api/documents/${id}(/(history|pdf))?$`).test(path)
    );
  return (
    method === "POST" &&
    ([
      "/api/processing/claim",
      "/api/processing/batch-lease",
      "/api/processing/renew",
      "/api/processing/release",
      "/api/processing/draft",
      "/api/processing/confirmation",
      "/api/processing/submit",
      "/api/processing/detach",
      "/api/processing/categories",
      "/api/processing/pdf-review",
      "/api/processing/reparse",
      "/api/jev/backfill",
      "/api/jev/completeness",
      "/api/jev/group-audit",
      "/api/jev/relationship-benchmark",
    ].includes(path) ||
      new RegExp(`^/api/documents/${id}/pdf$`).test(path) ||
      new RegExp(`^/api/captures/${id}/artifacts/ocr$`).test(path))
  );
}

export async function authorizeProcessor(
  request: Request,
  env: {
    APP_ORIGIN: string;
    OWNER_EMAIL: string;
    PROCESSING_TOKEN_SHA256?: string;
    DB?: D1Database;
  },
): Promise<void> {
  requireThat(
    env.OWNER_EMAIL && env.APP_ORIGIN,
    503,
    "Instance is not configured.",
  );
  requireThat(
    new URL(request.url).origin === env.APP_ORIGIN,
    403,
    "Origin denied.",
  );
  const origin = request.headers.get("origin");
  requireThat(
    !origin || origin === env.APP_ORIGIN,
    403,
    "Cross-origin request denied.",
  );
  requireThat(
    request.headers.get("sec-fetch-site") !== "cross-site",
    403,
    "Cross-site request denied.",
  );
  requireThat(
    env.DB || /^[0-9a-f]{64}$/.test(env.PROCESSING_TOKEN_SHA256 ?? ""),
    401,
    "Processing access is disabled.",
  );
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (rsc_[A-Za-z0-9_-]{43})$/)?.[1];
  requireThat(token, 401, "Processing credential required.");
  const actual = await digest(new Uint8Array(new TextEncoder().encode(token)));
  let different = actual.length ^ (env.PROCESSING_TOKEN_SHA256 ?? "").length;
  for (let i = 0; i < actual.length; i++)
    different |=
      actual.charCodeAt(i) ^ (env.PROCESSING_TOKEN_SHA256 ?? "").charCodeAt(i);
  let scope = "processing";
  if (different !== 0) {
    const row = await env.DB?.prepare(
      "SELECT id,scope,last_used_at FROM agent_connections WHERE token_sha256=? AND revoked_at IS NULL AND expires_at>?",
    )
      .bind(actual, Date.now())
      .first<{ id: string; scope: string; last_used_at: number | null }>();
    requireThat(row, 401, "Invalid processing credential.");
    scope = row.scope;
    if (!row.last_used_at || row.last_used_at < Date.now() - 3600000)
      await env
        .DB!.prepare("UPDATE agent_connections SET last_used_at=? WHERE id=?")
        .bind(Date.now(), row.id)
        .run();
  }
  const path = new URL(request.url).pathname;
  if (scope === "backup") {
    requireThat(
      request.method === "GET" &&
        (["/api/processing/access", "/api/captures"].includes(path) ||
          /^\/api\/captures\/[0-9a-f-]{36}$/.test(path) ||
          /^\/api\/files\/[0-9a-f-]{36}\/raw$/.test(path)),
      403,
      "Route is outside backup read access.",
    );
  } else requireThat(scope === "processing", 403, "Unknown connection scope.");
  requireThat(
    processingRouteAllowed(request.method, new URL(request.url).pathname),
    403,
    "Route is outside processing access.",
  );
}
