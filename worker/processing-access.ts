import { digest, requireThat } from "./http";

// Explicit allowlist: new application routes never acquire machine access implicitly.
export function processingRouteAllowed(method: string, path: string): boolean {
  const id =
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  if (method === "GET")
    return (
      ["/api/processing/access", "/api/captures", "/api/documents"].includes(
        path,
      ) ||
      new RegExp(`^/api/captures/${id}$`).test(path) ||
      new RegExp(`^/api/files/${id}/(raw|image|pdf|ocr)$`).test(path) ||
      new RegExp(`^/api/documents/${id}(/(history|pdf))?$`).test(path)
    );
  return (
    method === "POST" &&
    (path === "/api/documents" ||
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
    /^[0-9a-f]{64}$/.test(env.PROCESSING_TOKEN_SHA256 ?? ""),
    401,
    "Processing access is disabled.",
  );
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (rsc_[A-Za-z0-9_-]{43})$/)?.[1];
  requireThat(token, 401, "Processing credential required.");
  const actual = await digest(new Uint8Array(new TextEncoder().encode(token)));
  let different = 0;
  for (let i = 0; i < actual.length; i++)
    different |=
      actual.charCodeAt(i) ^ env.PROCESSING_TOKEN_SHA256!.charCodeAt(i);
  requireThat(different === 0, 401, "Invalid processing credential.");
  requireThat(
    processingRouteAllowed(request.method, new URL(request.url).pathname),
    403,
    "Route is outside processing access.",
  );
}
