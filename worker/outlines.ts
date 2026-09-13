import type { Env } from "./index";
import { bodyJson, json, requireThat, UUID } from "./http";

export const outlineSelection = `(SELECT payload FROM capture_outlines WHERE capture_id=captures.id ORDER BY created_at DESC,id DESC LIMIT 1) AS manual_outline`;

function validQuad(value: unknown): value is number[][] {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p.every(
          (n) =>
            typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
        ),
    )
  )
    return false;
  // Require a convex, clockwise perimeter in image coordinates, with real area.
  return value.every((p, i) => {
    const b = value[(i + 1) % 4],
      c = value[(i + 2) % 4];
    return (
      (b[0] - p[0]) * (c[1] - b[1]) - (b[1] - p[1]) * (c[0] - b[0]) > 0.000001
    );
  });
}

export async function outlineRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/api\/captures\/([^/]+)\/outlines$/,
  );
  if (!match) return null;
  const captureId = match[1];
  requireThat(UUID.test(captureId), 400, "Invalid capture ID.");
  const capture = await env.DB.prepare(
    "SELECT sha256,status FROM captures WHERE id=?",
  )
    .bind(captureId)
    .first<{ sha256: string; status: string }>();
  requireThat(capture, 404, "Capture not found.");
  if (request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT payload FROM capture_outlines WHERE capture_id=? ORDER BY created_at DESC,id DESC",
    )
      .bind(captureId)
      .all<{ payload: string }>();
    return json({
      outlines: rows.results.map((row) => JSON.parse(row.payload)),
    });
  }
  if (request.method !== "POST")
    return json({ detail: "Method not allowed." }, 405);
  const input = await bodyJson(request, 4000);
  requireThat(
    typeof input.id === "string" && UUID.test(input.id),
    400,
    "Provide a correction ID for safe retries.",
  );
  requireThat(
    input.source_sha256 === capture.sha256,
    409,
    "Original checksum differs. Inspect the current original.",
  );
  requireThat(
    ["accepted", "manual-review", "rejected"].includes(capture.status),
    409,
    "Wait for the capture to finish saving.",
  );
  requireThat(
    validQuad(input.quad),
    400,
    "Provide four normalized corners in clockwise perimeter order.",
  );
  requireThat(
    typeof input.note === "string" &&
      input.note.trim().length > 0 &&
      input.note.length <= 2000,
    400,
    "Describe the manual inspection.",
  );
  requireThat(
    input.previous_id === null ||
      (typeof input.previous_id === "string" && UUID.test(input.previous_id)),
    400,
    "Provide the previous correction ID, or null for the first correction.",
  );
  const readRetry = async () => {
    const existing = await env.DB.prepare(
      "SELECT capture_id,payload FROM capture_outlines WHERE id=?",
    )
      .bind(input.id)
      .first<{ capture_id: string; payload: string }>();
    if (!existing) return null;
    const saved = JSON.parse(existing.payload);
    requireThat(
      existing.capture_id === captureId &&
        saved.source_sha256 === input.source_sha256 &&
        JSON.stringify(saved.quad) === JSON.stringify(input.quad) &&
        saved.note === String(input.note).trim() &&
        saved.previous_id === input.previous_id,
      409,
      "Correction ID already belongs to different content.",
    );
    return saved;
  };
  const retry = await readRetry();
  if (retry) return json(retry);
  const latest = await env.DB.prepare(
    "SELECT created_at FROM capture_outlines WHERE capture_id=? ORDER BY created_at DESC,id DESC LIMIT 1",
  )
    .bind(captureId)
    .first<{ created_at: string }>();
  const saved = {
    id: input.id,
    source_sha256: capture.sha256,
    quad: input.quad,
    note: input.note.trim(),
    previous_id: input.previous_id,
    created_at: new Date(
      Math.max(Date.now(), latest ? Date.parse(latest.created_at) + 1 : 0),
    ).toISOString(),
  };
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO capture_outlines(id,capture_id,payload,created_at) SELECT ?,?,?,? WHERE (SELECT id FROM capture_outlines WHERE capture_id=? ORDER BY created_at DESC,id DESC LIMIT 1) IS ?",
  )
    .bind(
      saved.id,
      captureId,
      JSON.stringify(saved),
      saved.created_at,
      captureId,
      input.previous_id,
    )
    .run();
  if (result.meta.changes !== 1) {
    const retry = await readRetry();
    if (retry) return json(retry);
  }
  requireThat(
    result.meta.changes === 1,
    409,
    "Outline changed. Read the latest correction before saving.",
  );
  return json(saved, 201);
}
