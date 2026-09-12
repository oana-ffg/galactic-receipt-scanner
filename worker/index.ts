/// <reference types="@cloudflare/workers-types" />
import { prelaunchReset } from "./prelaunch-reset";
export interface Env {
  PRELAUNCH_RESET_MANIFEST?: string;
  RETIRED_CAPTURE_IDS?: string;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  OWNER_EMAIL: string;
  APP_ORIGIN: string;
}
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_IMAGE = 24 * 1024 * 1024;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function requireThat(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
export function authorize(
  request: Request,
  env: Pick<Env, "OWNER_EMAIL" | "APP_ORIGIN">,
): void {
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
  // These headers are trusted ONLY behind the Sites dispatcher. Never expose this Worker directly.
  requireThat(
    request.headers.get("oai-authenticated-user-id"),
    401,
    "Sign in with the owner account.",
  );
  requireThat(
    request.headers.get("oai-authenticated-user-email")?.toLowerCase() ===
      env.OWNER_EMAIL.toLowerCase(),
    403,
    "Owner access only.",
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
  if (!["GET", "HEAD"].includes(request.method)) {
    requireThat(
      request.headers.get("x-scanner-request") === "1",
      403,
      "Explicit same-origin request required.",
    );
    requireThat(
      origin === env.APP_ORIGIN,
      403,
      "Same-origin request required.",
    );
  }
}
function secure(response: Response, imageWorker = false): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  // Emscripten's OpenCV bindings generate JS invokers. Permit this only in the
  // isolated image worker, which has no DOM and may connect only to this origin.
  if (imageWorker)
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:",
    );
  headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(), geolocation=()",
  );
  headers.set("Strict-Transport-Security", "max-age=31536000");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
async function bytes(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  requireThat(
    Number(request.headers.get("content-length") || 0) <= limit,
    413,
    "Upload too large.",
  );
  const reader = request.body?.getReader();
  requireThat(reader, 400, "Missing body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      requireThat(size <= limit, 413, "Upload too large.");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  requireThat(size > 0, 400, "Empty upload.");
  return data;
}
const digest = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
function imageType(data: Uint8Array): string {
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
    return "image/png";
  throw new HttpError(415, "Use JPEG or PNG images.");
}
async function bodyJson(
  request: Request,
  limit = 24000,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await bytes(request, limit)),
    );
    requireThat(
      value && typeof value === "object" && !Array.isArray(value),
      400,
      "Expected an object.",
    );
    return value as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON.");
  }
}
interface CaptureRow {
  id: string;
  created_at: string;
  sha256: string;
  status: string;
  raw_key: string;
  metadata: string;
  content_type: string;
  ocr_available?: number;
  image_available?: number;
  pdf_available?: number;
  accepted_count?: number;
}
function publicCapture(row: CaptureRow) {
  return {
    id: row.id,
    acceptedCount: row.accepted_count,
    created_at: row.created_at,
    status: row.status,
    sha256: row.sha256,
    metadata: JSON.parse(row.metadata),
    ocr_status: row.ocr_available ? "unverified" : "awaiting Work",
    ocr_error: null,
    outputs: {
      image: Boolean(row.image_available),
      pdf: Boolean(row.pdf_available),
    },
  };
}
async function captureRow(env: Env, id: string): Promise<CaptureRow> {
  const row = await env.DB.prepare(
    "SELECT *, EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='ocr') AS ocr_available, EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='image') AS image_available, EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='pdf') AS pdf_available, (SELECT COUNT(*) FROM captures WHERE status='accepted') AS accepted_count FROM captures WHERE id = ?",
  )
    .bind(id)
    .first<CaptureRow>();
  requireThat(row, 404, "Capture not found.");
  return row;
}
interface StationRow {
  camera: string | null;
  expires: number;
  sequence: number;
  command: string;
  state: string | null;
  updated: number;
  preview_key: string | null;
  preview_session: string | null;
}
async function stationRow(env: Env): Promise<StationRow> {
  const row = await env.DB.prepare(
    "SELECT * FROM station WHERE id=1",
  ).first<StationRow>();
  if (row) return row;
  await env.DB.prepare("INSERT OR IGNORE INTO station(id) VALUES (1)").run();
  return (await env.DB.prepare(
    "SELECT * FROM station WHERE id=1",
  ).first<StationRow>())!;
}

function requireQuality(metadata: Record<string, unknown>) {
  const q = metadata.quality as
    { ok?: unknown; receiptPixels?: unknown } | undefined;
  requireThat(
    q?.ok === true &&
      Array.isArray(q.receiptPixels) &&
      q.receiptPixels.length === 2 &&
      q.receiptPixels.every(
        (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 900,
      ),
    409,
    "Image quality checks did not pass.",
  );
}
async function route(request: Request, env: Env): Promise<Response> {
  if (env.PRELAUNCH_RESET_MANIFEST) return prelaunchReset(request, env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/me" && method === "GET")
    return json({ email: env.OWNER_EMAIL });
  if (path === "/api/captures" && method === "GET") {
    const cursor = (url.searchParams.get("before") ?? "9999|").split("|");
    requireThat(cursor.length === 2, 400, "Invalid cursor.");
    const rows = await env.DB.prepare(
      "SELECT *, EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='ocr') AS ocr_available, EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='image') AS image_available, EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='pdf') AS pdf_available FROM captures WHERE (created_at,id) < (?,?) ORDER BY created_at DESC,id DESC LIMIT 100",
    )
      .bind(cursor[0], cursor[1])
      .all<CaptureRow>();
    return json({
      captures: rows.results.map(publicCapture),
      next:
        rows.results.length === 100
          ? `${rows.results.at(-1)!.created_at}|${rows.results.at(-1)!.id}`
          : null,
    });
  }
  const capture = path.match(/^\/api\/captures\/([^/]+)$/);
  if (capture) {
    const id = capture[1];
    requireThat(UUID.test(id), 400, "Invalid capture ID.");
    if (method === "GET") {
      const row = await captureRow(env, id);
      const versions = await env.DB.prepare(
        "SELECT kind,sha256,created_at FROM artifacts WHERE capture_id=? ORDER BY created_at DESC,sha256 DESC",
      )
        .bind(id)
        .all();
      return json({ ...publicCapture(row), artifacts: versions.results });
    }
    if (method === "POST") {
      requireThat(
        !(env.RETIRED_CAPTURE_IDS ?? "").split(",").includes(id),
        410,
        "This test capture was permanently retired during the authorized pre-production cleanup. Reload the camera page before scanning real receipts.",
      );
      const data = await bytes(request, MAX_IMAGE);
      const type = imageType(data);
      const sha = await digest(data);
      let metadata: Record<string, unknown>;
      try {
        const raw = request.headers.get("x-capture-metadata") ?? "{}";
        requireThat(raw.length < 12000, 400, "Metadata too large.");
        metadata = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "Invalid metadata.");
      }
      requireThat(
        metadata && typeof metadata === "object" && !Array.isArray(metadata),
        400,
        "Invalid metadata.",
      );
      const completed = request.headers.get("x-capture-status");
      requireThat(
        completed === null ||
          completed === "accepted" ||
          completed === "rejected",
        400,
        "Invalid capture result.",
      );
      if (completed === "accepted") requireQuality(metadata);
      // A completed original needs no crop or PDF; those are downstream derivatives.
      const key = `raw/${id}/${sha}`;
      // Conditional object creation + insert-first-wins make retries non-destructive, including races.
      const object = await env.BUCKET.put(key, data, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: type },
        customMetadata: { sha256: sha },
      });
      if (!object)
        requireThat(
          await env.BUCKET.head(key),
          503,
          "Original storage not confirmed.",
        );
      await env.DB.prepare(
        "INSERT OR IGNORE INTO captures(id,created_at,sha256,raw_key,content_type,bytes,status,metadata) VALUES(?,?,?,?,?,?,?,?)",
      )
        .bind(
          id,
          new Date().toISOString(),
          sha,
          key,
          type,
          data.length,
          completed ?? "checking",
          JSON.stringify(metadata),
        )
        .run();
      const row = await captureRow(env, id);
      requireThat(
        row.sha256 === sha,
        409,
        "Capture ID already belongs to different bytes. Original unchanged.",
      );
      requireThat(
        await env.BUCKET.head(row.raw_key),
        503,
        "Original storage not confirmed.",
      );
      return json(publicCapture(row));
    }
  }
  const artifact = path.match(
    /^\/api\/captures\/([^/]+)\/artifacts\/(image|pdf|ocr)$/,
  );
  if (artifact && method === "POST") {
    const [, id, kind] = artifact;
    requireThat(UUID.test(id), 400, "Invalid capture ID.");
    await captureRow(env, id);
    const data = await bytes(request, kind === "ocr" ? 1024 * 1024 : MAX_IMAGE);
    const type =
      kind === "image"
        ? imageType(data)
        : kind === "pdf"
          ? "application/pdf"
          : "application/json";
    if (kind === "pdf")
      requireThat(
        new TextDecoder().decode(data.slice(0, 5)) === "%PDF-",
        415,
        "Expected PDF.",
      );
    if (kind === "ocr") {
      try {
        const value = JSON.parse(new TextDecoder().decode(data));
        requireThat(
          value && typeof value === "object" && !Array.isArray(value),
          400,
          "Expected OCR object.",
        );
      } catch {
        throw new HttpError(400, "Expected JSON object.");
      }
    }
    const sha = await digest(data);
    const key = `${kind}/${id}/${sha}`;
    const stored = await env.BUCKET.put(key, data, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: type },
      customMetadata: { sha256: sha },
    });
    if (!stored)
      requireThat(
        await env.BUCKET.head(key),
        503,
        "Artifact storage not confirmed.",
      );
    await env.DB.prepare(
      "INSERT OR IGNORE INTO artifacts(key,capture_id,kind,sha256,created_at,content_type) VALUES(?,?,?,?,?,?)",
    )
      .bind(key, id, kind, sha, new Date().toISOString(), type)
      .run();
    return json({ id, kind, sha256: sha });
  }
  const finalize = path.match(/^\/api\/captures\/([^/]+)\/finalize$/);
  if (finalize && method === "POST") {
    const id = finalize[1];
    requireThat(UUID.test(id), 400, "Invalid capture ID.");
    const row = await captureRow(env, id);
    const info = await bodyJson(request);
    requireThat(
      ["accepted", "rejected"].includes(String(info.status)),
      400,
      "Invalid result.",
    );
    if (row.status !== "checking") {
      requireThat(
        row.status === info.status,
        409,
        "Capture result is immutable.",
      );
      return json(publicCapture(row));
    }
    if (info.status === "accepted") {
      const metadata = JSON.parse(row.metadata);
      requireQuality(metadata);
    }
    requireThat(
      await env.BUCKET.head(row.raw_key),
      503,
      "Original storage not confirmed.",
    );
    await env.DB.prepare(
      "UPDATE captures SET status=? WHERE id=? AND status='checking'",
    )
      .bind(info.status, id)
      .run();
    return json(publicCapture(await captureRow(env, id)));
  }
  const file = path.match(/^\/api\/files\/([^/]+)\/(raw|image|pdf|ocr)$/);
  if (file && method === "GET") {
    const [, id, kind] = file;
    requireThat(UUID.test(id), 400, "Invalid capture ID.");
    const row = await captureRow(env, id);
    const version = url.searchParams.get("version");
    requireThat(
      version === null || /^[0-9a-f]{64}$/.test(version),
      400,
      "Invalid artifact version.",
    );
    requireThat(
      kind !== "raw" || version === null || version === row.sha256,
      404,
      "File version not available.",
    );
    const artifact =
      kind === "raw"
        ? null
        : await env.DB.prepare(
            "SELECT key,content_type FROM artifacts WHERE capture_id=? AND kind=? AND (? IS NULL OR sha256=?) ORDER BY created_at DESC,sha256 DESC LIMIT 1",
          )
            .bind(id, kind, version, version)
            .first<{ key: string; content_type: string }>();
    const key = kind === "raw" ? row.raw_key : artifact?.key;
    requireThat(key, 404, "File not available.");
    const object = await env.BUCKET.get(key);
    requireThat(object, 404, "File not available.");
    return new Response(object.body, {
      headers: {
        "Content-Type":
          kind === "raw" ? row.content_type : artifact!.content_type,
        "Content-Disposition": `attachment; filename="${id}-${kind}.${kind === "pdf" ? "pdf" : kind === "ocr" ? "json" : (kind === "raw" ? row.content_type : artifact!.content_type) === "image/png" ? "png" : "jpg"}"`,
      },
    });
  }
  if (path === "/api/station" && method === "GET") {
    const row = await stationRow(env);
    const fresh = row.expires > Date.now() && row.updated > Date.now() - 5000;
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM captures WHERE status='accepted'",
    ).first<{ n: number }>();
    return json({
      camera: fresh ? row.camera : null,
      previewSession:
        fresh && row.preview_session ? JSON.parse(row.preview_session) : null,
      state: fresh && row.state ? JSON.parse(row.state) : null,
      sequence: row.sequence,
      command: row.command,
      count: count?.n ?? 0,
      fresh,
    });
  }
  if (path === "/api/station/claim" && method === "POST") {
    const { camera } = await bodyJson(request);
    requireThat(
      typeof camera === "string" && UUID.test(camera),
      400,
      "Invalid camera ID.",
    );
    await stationRow(env);
    await env.DB.prepare(
      "UPDATE station SET camera=?, expires=?, state=NULL, preview_session=NULL, command='pause', sequence=sequence+1, updated=0 WHERE id=1 AND (expires<? OR camera=?)",
    )
      .bind(camera, Date.now() + 10000, Date.now(), camera)
      .run();
    const row = await stationRow(env);
    requireThat(
      row.camera === camera,
      409,
      "Another camera is active. Close it and wait ten seconds.",
    );
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM captures WHERE status='accepted'",
    ).first<{ n: number }>();
    return json({
      count: count?.n ?? 0,
      sequence: row.sequence,
      command: row.command,
      previewSession: row.preview_session
        ? JSON.parse(row.preview_session)
        : null,
    });
  }
  if (path === "/api/station/release" && method === "POST") {
    const { camera } = await bodyJson(request);
    requireThat(
      typeof camera === "string" && UUID.test(camera),
      400,
      "Invalid camera ID.",
    );
    await env.DB.prepare(
      "UPDATE station SET expires=0,updated=0,state=NULL,preview_session=NULL WHERE id=1 AND camera=?",
    )
      .bind(camera)
      .run();
    return json({ ok: true });
  }
  if (path === "/api/station/heartbeat" && method === "POST") {
    const info = await bodyJson(request);
    requireThat(
      info.state && typeof info.state === "object",
      400,
      "Missing state.",
    );
    const row = await env.DB.prepare(
      "UPDATE station SET state=?,updated=?,expires=? WHERE id=1 AND camera=? AND expires>? RETURNING sequence,command,preview_session",
    )
      .bind(
        JSON.stringify(info.state),
        Date.now(),
        Date.now() + 10000,
        String(info.camera),
        Date.now(),
      )
      .first<StationRow>();
    requireThat(row, 409, "Camera lease expired. Enable camera again.");
    return json({
      sequence: row.sequence,
      command: row.command,
      previewSession: row.preview_session
        ? JSON.parse(row.preview_session)
        : null,
    });
  }
  if (path === "/api/station/direct-preview" && method === "POST") {
    const info = await bodyJson(request, 24000);
    requireThat(
      typeof info.id === "string" && UUID.test(info.id),
      400,
      "Invalid preview session.",
    );
    if (info.renew === true) {
      const result = await env.DB.prepare(
        "UPDATE station SET preview_session=json_set(preview_session, '$.expires', ?) WHERE id=1 AND camera=? AND expires>? AND json_extract(preview_session, '$.id')=?",
      )
        .bind(Date.now() + 30000, String(info.camera), Date.now(), info.id)
        .run();
      requireThat(result.meta.changes === 1, 409, "Preview session changed.");
      return json({ ok: true });
    }
    const description = (info.offer ?? info.answer) as
      { type?: unknown; sdp?: unknown } | undefined;
    requireThat(
      description &&
        description.type === (info.offer ? "offer" : "answer") &&
        typeof description.sdp === "string" &&
        description.sdp.length < 20000,
      400,
      "Invalid preview description.",
    );
    let result;
    if (info.offer) {
      result = await env.DB.prepare(
        "UPDATE station SET preview_session=? WHERE id=1 AND camera=? AND expires>? AND (preview_session IS NULL OR json_extract(preview_session, '$.expires')<? OR json_extract(preview_session, '$.id')=?)",
      )
        .bind(
          JSON.stringify({
            id: info.id,
            offer: info.offer,
            expires: Date.now() + 30000,
          }),
          String(info.camera),
          Date.now(),
          Date.now(),
          info.id,
        )
        .run();
    } else {
      result = await env.DB.prepare(
        "UPDATE station SET preview_session=json_set(preview_session, '$.answer', json(?)) WHERE id=1 AND camera=? AND expires>? AND json_extract(preview_session, '$.id')=?",
      )
        .bind(
          JSON.stringify(info.answer),
          String(info.camera),
          Date.now(),
          info.id,
        )
        .run();
    }
    requireThat(
      result.meta.changes === 1,
      409,
      "Preview session changed. Reconnecting.",
    );
    return json({ ok: true });
  }
  if (path === "/api/station/preview") {
    const row = await stationRow(env);
    if (method === "POST") {
      requireThat(
        row.camera === request.headers.get("x-camera-id") &&
          row.expires > Date.now(),
        409,
        "Camera lease expired.",
      );
      const data = await bytes(request, 160000);
      requireThat(
        imageType(data) === "image/jpeg",
        415,
        "Preview must be JPEG.",
      );
      const key = "preview/latest";
      await env.BUCKET.put(key, data, {
        httpMetadata: { contentType: "image/jpeg" },
        customMetadata: {
          camera: String(row.camera),
          capturedAt: String(Date.now()),
        },
      });
      await env.DB.prepare(
        "UPDATE station SET preview_key=? WHERE id=1 AND camera=?",
      )
        .bind(key, row.camera)
        .run();
      return json({ ok: true });
    }
    if (method === "GET") {
      requireThat(
        row.preview_key &&
          row.expires > Date.now() &&
          row.updated > Date.now() - 5000,
        404,
        "No live preview.",
      );
      const image = await env.BUCKET.get(row.preview_key);
      requireThat(
        image &&
          image.customMetadata?.camera === row.camera &&
          Number(image.customMetadata?.capturedAt) > Date.now() - 3000,
        404,
        "Waiting for a fresh preview.",
      );
      return new Response(image.body, {
        headers: { "Content-Type": "image/jpeg" },
      });
    }
  }
  if (path.startsWith("/api/control/") && method === "POST") {
    const command = path.slice("/api/control/".length);
    requireThat(
      ["start", "pause", "retry", "retry-upload"].includes(command),
      400,
      "Unknown command.",
    );
    await stationRow(env);
    await env.DB.prepare(
      "UPDATE station SET command=?,sequence=sequence+1 WHERE id=1",
    )
      .bind(command)
      .run();
    return json({ ok: true });
  }
  if (path.startsWith("/api/")) throw new HttpError(404, "Not found.");
  requireThat(["GET", "HEAD"].includes(method), 405, "Method not allowed.");
  // Assets are fetched only after owner authorisation; no public bucket or asset routes.
  return env.ASSETS.fetch(
    new Request(new URL(path === "/camera" ? "/" : path, url.origin), request),
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      authorize(request, env);
      return secure(
        await route(request, env),
        /^\/assets\/vision\.worker-[\w-]+\.js$/.test(
          new URL(request.url).pathname,
        ),
      );
    } catch (error) {
      return secure(
        json(
          {
            detail:
              error instanceof HttpError
                ? error.message
                : "Storage temporarily unavailable. Your pending capture is retained; retry.",
          },
          error instanceof HttpError ? error.status : 503,
        ),
      );
    }
  },
};
