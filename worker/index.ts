import { outlineRoute, outlineSelection } from "./outlines";
import { Timing } from "../web/save-timing";
import {
  recoveryProvenance,
  storeOriginal,
  verifyOriginal,
} from "./capture-storage";
import { processingRoute, protectBlindParse } from "./processing";
/// <reference types="@cloudflare/workers-types" />
import { hasReceiptResolution } from "../web/capture-resolution";
import {
  UUID,
  MAX_IMAGE,
  json,
  HttpError,
  requireThat,
  bytes,
  digest,
  imageType,
  bodyJson,
} from "./http";
import { accessPage } from "./access-page";
import { issueRoute } from "./issues";
import { documentRoute } from "./documents";
import { authorizeProcessor } from "./processing-access";
import { connectionRoute } from "./connections";
import { isControlCommand, retakeTarget } from "../web/control-command";
const APP_PAGES = new Set([
  "/",
  "/camera",
  "/issues",
  "/review",
  "/agent-access",
]);
export interface Env {
  PROCESSING_TOKEN_SHA256?: string;
  SITES_GATEWAY_TOKEN?: string;
  RETIRED_CAPTURE_IDS?: string;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  OWNER_EMAIL: string;
  APP_ORIGIN: string;
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
    request.headers.get("sec-fetch-site") !== "cross-site" ||
      (["GET", "HEAD"].includes(request.method) &&
        request.headers.get("sec-fetch-mode") === "navigate" &&
        request.headers.get("sec-fetch-dest") === "document" &&
        APP_PAGES.has(new URL(request.url).pathname)),
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
interface CaptureRow {
  id: string;
  receipt_id: string | null;
  retake_of: string | null;
  take_number: number;
  is_current: number;
  current_capture_id: string | null;
  created_at: string;
  sha256: string;
  status: string;
  raw_key: string;
  metadata: string;
  content_type: string;
  bytes: number;
  ocr_available?: number;
  image_available?: number;
  pdf_available?: number;
  accepted_count?: number;
  manual_outline?: string | null;
}
function publicCapture(row: CaptureRow) {
  return {
    id: row.id,
    receipt_id: row.receipt_id ?? row.id,
    retake_of: row.retake_of,
    take_number: row.take_number,
    is_current: Boolean(row.is_current),
    current_capture_id: row.current_capture_id,
    acceptedCount: row.accepted_count,
    created_at: row.created_at,
    status: row.status,
    sha256: row.sha256,
    bytes: row.bytes,
    content_type: row.content_type,
    metadata: JSON.parse(row.metadata),
    manual_outline:
      row.manual_outline === undefined
        ? undefined
        : row.manual_outline
          ? JSON.parse(row.manual_outline)
          : null,
    ocr_status: row.ocr_available ? "unverified" : "awaiting Work",
    ocr_error: null,
    outputs: {
      image: Boolean(row.image_available),
      pdf: Boolean(row.pdf_available),
    },
  };
}
async function captureAcknowledgement(row: CaptureRow) {
  return {
    id: row.id,
    receipt_id: row.receipt_id ?? row.id,
    take_number: row.take_number,
    created_at: row.created_at,
    sha256: row.sha256,
    bytes: row.bytes,
    status: row.status,
    retake_of: row.retake_of,
    metadataSha256: await digest(
      new Uint8Array(new TextEncoder().encode(row.metadata)),
    ),
  };
}
// Legacy rows with no receipt_id use their own ID without rewriting source metadata.
// Selection is derived from immutable take numbers, so retries and rejected retakes
// cannot demote an accepted source. One accepted take represents each receipt.
const currentTake =
  "captures.status IN ('accepted','manual-review') AND NOT EXISTS (SELECT 1 FROM captures newer WHERE (newer.receipt_id=COALESCE(captures.receipt_id,captures.id) OR newer.id=COALESCE(captures.receipt_id,captures.id)) AND newer.status IN ('accepted','manual-review') AND ((newer.status='accepted' AND captures.status='manual-review') OR (newer.status=captures.status AND newer.take_number>captures.take_number)))";
const receiptCount =
  "SELECT COUNT(DISTINCT COALESCE(receipt_id,id)) FROM captures WHERE status IN ('accepted','manual-review')";
const captureSelection = `SELECT captures.*, (${currentTake}) AS is_current,
  (SELECT id FROM captures accepted WHERE (accepted.receipt_id=COALESCE(captures.receipt_id,captures.id) OR accepted.id=COALESCE(captures.receipt_id,captures.id)) AND accepted.status IN ('accepted','manual-review') ORDER BY (accepted.status='accepted') DESC,accepted.take_number DESC LIMIT 1) AS current_capture_id,
  EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='ocr') AS ocr_available,
  EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='image') AS image_available,
  EXISTS(SELECT 1 FROM artifacts WHERE capture_id=captures.id AND kind='pdf') AS pdf_available`;
async function captureRow(env: Env, id: string): Promise<CaptureRow> {
  const row = await env.DB.prepare(
    `${captureSelection}, (${receiptCount}) AS accepted_count FROM captures WHERE id = ?`,
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
  preview_requested_until: number;
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
    q?.ok === true && hasReceiptResolution(q.receiptPixels),
    409,
    "Image quality checks did not pass.",
  );
}
async function route(
  request: Request,
  env: Env,
  timing: Timing,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const connection = await connectionRoute(request, env);
  if (connection) return connection;
  if (path === "/api/processing/access" && request.method === "GET")
    return json({
      version: 2,
      capabilities: [
        "read_captures",
        "read_originals",
        "read_documents",
        "submit_claimed_documents",
        "plain_ocr_numeric_comparison",
        "searchable_pdfs",
        "save_ocr_artifacts",
        "save_document_pdfs",
      ],
      captureWrites: false,
      queueClaims: true,
      categories: true,
      independentReview: true,
    });
  const loadCaptures = async () => {
    const rows = await env.DB.prepare(
      `${captureSelection}, ${outlineSelection} FROM captures ORDER BY created_at,id`,
    ).all<CaptureRow>();
    return rows.results.map(publicCapture) as import("../web/types").Capture[];
  };
  await protectBlindParse(request, env);
  const processingResponse = await processingRoute(request, env, loadCaptures);
  if (processingResponse) return processingResponse;
  const documentResponse = await documentRoute(request, env, loadCaptures);
  if (documentResponse) return documentResponse;
  const method = request.method;
  const outlineResponse = await outlineRoute(request, env);
  if (outlineResponse) return outlineResponse;
  const issueResponse = await issueRoute(request, env);
  if (issueResponse) return issueResponse;
  if (path === "/api/me" && method === "GET")
    return json({ email: env.OWNER_EMAIL });
  if (path === "/api/captures" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    requireThat(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      400,
      "Invalid page size.",
    );
    const cursor = (url.searchParams.get("before") ?? "9999|").split("|");
    requireThat(cursor.length === 2, 400, "Invalid cursor.");
    const rows = await env.DB.prepare(
      `${captureSelection}, ${outlineSelection} FROM captures WHERE (created_at,id) < (?,?) ${url.searchParams.get("current") === "1" ? `AND (${currentTake})` : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
      .bind(cursor[0], cursor[1], limit + 1)
      .all<CaptureRow>();
    const page = rows.results.slice(0, limit);
    return json({
      captures: page.map(publicCapture),
      next:
        rows.results.length > limit
          ? `${page.at(-1)!.created_at}|${page.at(-1)!.id}`
          : null,
    });
  }
  const capture = path.match(/^\/api\/captures\/([^/]+)$/);
  if (capture) {
    const id = capture[1];
    requireThat(UUID.test(id), 400, "Invalid capture ID.");
    if (method === "GET") {
      const row = await captureRow(env, id);
      row.manual_outline = (
        await env.DB.prepare(
          `SELECT ${outlineSelection} FROM captures WHERE id=?`,
        )
          .bind(id)
          .first<{ manual_outline: string }>()
      )?.manual_outline;
      const versions = await env.DB.prepare(
        "SELECT kind,sha256,created_at FROM artifacts WHERE capture_id=? ORDER BY created_at DESC,sha256 DESC",
      )
        .bind(id)
        .all();
      return json({
        ...publicCapture(row),
        bytes: row.bytes,
        content_type: row.content_type,
        artifacts: versions.results,
      });
    }
    if (method === "POST") {
      requireThat(
        !(env.RETIRED_CAPTURE_IDS ?? "").split(",").includes(id),
        410,
        "This test capture was permanently retired during the authorized pre-production cleanup. Reload the camera page before scanning real receipts.",
      );
      timing.set(
        "serverRoutingMs",
        performance.now() -
          timing.started -
          (timing.data.values.serverAuthMs ?? 0),
      );
      const data = await timing.measure("serverBodyMs", () =>
        bytes(request, MAX_IMAGE),
      );
      const type = imageType(data);
      const sha = await timing.measure("serverHashMs", () => digest(data));
      const validationStarted = performance.now();
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
          completed === "rejected" ||
          completed === "manual-review",
        400,
        "Invalid capture result.",
      );
      if (completed === "accepted") requireQuality(metadata);
      if (completed === "manual-review")
        requireThat(
          metadata.manualCapture === true,
          400,
          "Manual capture intent is required.",
        );
      const retakeOf = request.headers.get("x-retake-of");
      requireThat(
        retakeOf === null || (UUID.test(retakeOf) && retakeOf !== id),
        400,
        "Invalid retake source.",
      );
      timing.set("serverValidationMs", performance.now() - validationStarted);
      const parent = retakeOf
        ? await timing.measure("serverParentMs", () =>
            captureRow(env, retakeOf),
          )
        : null;
      const provenanceStarted = performance.now();
      const receiptId = parent ? (parent.receipt_id ?? parent.id) : id;
      const restored = recoveryProvenance(
        request.headers.get("x-capture-recovery"),
        {
          id,
          sha256: sha,
          bytes: data.length,
          status: completed,
          retake_of: retakeOf,
          receipt_id: receiptId,
          metadataSha256: await digest(
            new Uint8Array(new TextEncoder().encode(JSON.stringify(metadata))),
          ),
        },
      );
      timing.set("serverProvenanceMs", performance.now() - provenanceStarted);
      const key = `raw/${id}/${sha}`;
      // R2-first can preserve an unreferenced immutable object if D1 fails or
      // rejects an ID conflict. Keep those bytes for investigation; never
      // overwrite the canonical source or auto-delete financial source bytes.
      await timing.measure("serverObjectMs", () =>
        storeOriginal(env.BUCKET, key, data, sha, type),
      );
      // The insert is the uniqueness check. A new capture needs no preflight
      // lookup or separate readback; RETURNING is part of this atomic write.
      const inserted = await timing.measure("serverInsertMs", () =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO captures(id,created_at,sha256,raw_key,content_type,bytes,status,metadata,receipt_id,retake_of,take_number) SELECT ?,?,?,?,?,?,?,?,?,?,COALESCE(?,COALESCE(MAX(take_number),0)+1) FROM captures WHERE receipt_id=? OR id=? RETURNING *",
        )
          .bind(
            id,
            restored?.created_at ?? new Date().toISOString(),
            sha,
            key,
            type,
            data.length,
            completed ?? "checking",
            JSON.stringify(metadata),
            receiptId,
            retakeOf,
            restored?.take_number ?? null,
            receiptId,
            receiptId,
          )
          .first<CaptureRow>(),
      );
      const row =
        inserted ??
        (await timing.measure("serverRetryReadMs", () =>
          env.DB.prepare("SELECT * FROM captures WHERE id=?")
            .bind(id)
            .first<CaptureRow>(),
        ));
      requireThat(row, 503, "Capture metadata was not confirmed.");
      requireThat(
        row.sha256 === sha && row.retake_of === retakeOf,
        409,
        "Capture ID already belongs to different bytes or retake source. Original unchanged.",
      );
      if (row.raw_key !== key)
        await timing.measure("serverReadbackMs", () =>
          verifyOriginal(env.BUCKET, row.raw_key, row.sha256, row.bytes),
        );
      if (request.headers.get("x-capture-acknowledgement") === "durable-v1")
        return json(
          await timing.measure("serverAckMs", () =>
            captureAcknowledgement(row),
          ),
        );
      return json(publicCapture(await captureRow(env, id)));
    }
  }
  const verification = path.match(/^\/api\/captures\/([^/]+)\/verify$/);
  if (verification && method === "GET") {
    const id = verification[1];
    requireThat(UUID.test(id), 400, "Invalid capture ID.");
    timing.set(
      "serverRoutingMs",
      performance.now() -
        timing.started -
        (timing.data.values.serverAuthMs ?? 0),
    );
    const row = await timing.measure("serverRetryReadMs", () =>
      captureRow(env, id),
    );
    await timing.measure("serverReadbackMs", () =>
      verifyOriginal(env.BUCKET, row.raw_key, row.sha256, row.bytes),
    );
    return json({
      ...(await timing.measure("serverAckMs", () =>
        captureAcknowledgement(row),
      )),
      verified: true,
      acceptedCount: row.accepted_count,
    });
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
      ["accepted", "rejected", "manual-review"].includes(String(info.status)),
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
    if (info.status === "manual-review")
      requireThat(
        JSON.parse(row.metadata).manualCapture === true,
        400,
        "Manual capture intent is required.",
      );
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
    const count = await env.DB.prepare(`SELECT (${receiptCount}) AS n`).first<{
      n: number;
    }>();
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
      "UPDATE station SET camera=?, expires=?, state=NULL, preview_session=NULL, preview_requested_until=0, command='pause', sequence=sequence+1, updated=0 WHERE id=1 AND (expires<? OR camera=?)",
    )
      .bind(camera, Date.now() + 10000, Date.now(), camera)
      .run();
    const row = await stationRow(env);
    requireThat(
      row.camera === camera,
      409,
      "Another camera is active. Close it and wait ten seconds.",
    );
    const count = await env.DB.prepare(`SELECT (${receiptCount}) AS n`).first<{
      n: number;
    }>();
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
      "UPDATE station SET expires=0,updated=0,state=NULL,preview_session=NULL,preview_requested_until=0 WHERE id=1 AND camera=?",
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
      "UPDATE station SET state=?,updated=?,expires=? WHERE id=1 AND camera=? AND expires>? RETURNING sequence,command,preview_session,preview_requested_until",
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
      previewRequestedForMs: Math.max(
        0,
        row.preview_requested_until - Date.now(),
      ),
      sequence: row.sequence,
      command: row.command,
      previewSession: row.preview_session
        ? JSON.parse(row.preview_session)
        : null,
    });
  }
  if (path === "/api/station/preview-request" && method === "POST") {
    const { camera } = await bodyJson(request);
    requireThat(
      typeof camera === "string" && UUID.test(camera),
      400,
      "Invalid camera ID.",
    );
    const now = Date.now();
    const result = await env.DB.prepare(
      "UPDATE station SET preview_requested_until=? WHERE id=1 AND camera=? AND expires>?",
    )
      .bind(now + 5000, camera, now)
      .run();
    requireThat(result.meta.changes === 1, 409, "Camera lease expired.");
    return json({ ok: true });
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
        headers: {
          "Content-Type": "image/jpeg",
          "X-Preview-Received-At": image.customMetadata!.capturedAt,
          "X-Preview-Age-Ms": String(
            Math.max(0, Date.now() - Number(image.customMetadata!.capturedAt)),
          ),
        },
      });
    }
  }
  if (path.startsWith("/api/control/") && method === "POST") {
    let command = path.slice("/api/control/".length);
    requireThat(!command.includes(":"), 400, "Unknown command.");
    if (command === "retake") {
      const { captureId } = await bodyJson(request);
      requireThat(
        typeof captureId === "string" && UUID.test(captureId),
        400,
        "Invalid retake source.",
      );
      const capture = await captureRow(env, captureId);
      requireThat(
        capture.status !== "checking",
        409,
        "Wait for the original upload to finish before retaking.",
      );
      command = `retake:${captureId}`;
    }
    requireThat(isControlCommand(command), 400, "Unknown command.");
    const station = await stationRow(env);
    if (
      retakeTarget(command) ||
      command === "cancel-retake" ||
      command === "force" ||
      command === "set-background" ||
      command === "clear-background"
    ) {
      const state = station.state ? JSON.parse(station.state) : null;
      requireThat(
        station.expires > Date.now() &&
          station.updated > Date.now() - 5000 &&
          (command === "clear-background"
            ? state?.supportsBackgroundReset
            : command === "set-background"
              ? state?.supportsBackground
              : command === "force"
                ? state?.supportsForce
                : state?.supportsTargetedRetake) === true,
        409,
        "Enable or reload the phone camera before using this control.",
      );
      // Targeted retakes are queued until the phone finishes any pending upload.
      // Its live state is authoritative; the stored heartbeat can lag a save acknowledgement.
      if (!retakeTarget(command))
        requireThat(
          !state.activeId && state.recovery !== "upload",
          409,
          "Finish the pending photo upload before using this control.",
        );
    }
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
    new Request(new URL(APP_PAGES.has(path) ? "/" : path, url.origin), request),
  );
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const timing = new Timing();
    const timed = /^\/api\/captures\/[^/]+(?:\/verify)?$/.test(
      new URL(request.url).pathname,
    );
    const finish = (response: Response) => {
      if (timed) {
        timing.set("serverTotalMs", performance.now() - timing.started);
        response.headers.set("Server-Timing", timing.header());
        if (timing.data.failedStage)
          response.headers.set(
            "X-Scanner-Timing-Failure",
            timing.data.failedStage,
          );
      }
      return response;
    };
    try {
      if (request.headers.has("authorization"))
        await authorizeProcessor(request, env);
      else authorize(request, env);
      timing.set("serverAuthMs", performance.now() - timing.started);
      return finish(
        secure(
          await route(request, env, timing),
          /^\/assets\/vision\.worker-[\w-]+\.js$/.test(
            new URL(request.url).pathname,
          ),
        ),
      );
    } catch (error) {
      if (
        error instanceof HttpError &&
        [401, 403].includes(error.status) &&
        request.method === "GET" &&
        APP_PAGES.has(new URL(request.url).pathname)
      ) {
        const response = secure(accessPage(error.status));
        const nonce = crypto.randomUUID().replaceAll("-", "");
        const css =
          "body{margin:0;background:#10181f;color:#e4edf2;font:17px/1.6 system-ui,sans-serif}main{max-width:660px;margin:10vh auto;padding:32px}h1{color:#64e3ac;font-size:18px}h2{line-height:1.2;margin-top:32px}a{color:#8ccfff}p{color:#bdcbd5}";
        const html = (await response.text()).replace(
          "</head>",
          `<style nonce="${nonce}">${css}</style></head>`,
        );
        const headers = new Headers(response.headers);
        headers.set(
          "Content-Security-Policy",
          headers
            .get("Content-Security-Policy")!
            .replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`),
        );
        return new Response(html, { status: response.status, headers });
      }
      return finish(
        secure(
          json(
            {
              detail:
                error instanceof HttpError
                  ? error.message
                  : "Storage temporarily unavailable. Your pending capture is retained; retry.",
            },
            error instanceof HttpError ? error.status : 503,
          ),
        ),
      );
    }
  },
};
