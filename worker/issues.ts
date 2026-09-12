import type { Env } from "./index";
import {
  UUID,
  bytes,
  digest,
  imageType,
  json,
  requireThat,
  bodyJson,
} from "./http";

interface IssueRow {
  id: string;
  created_at: string;
  updated_at: string;
  status: string;
  title: string;
  description: string;
  context: string;
  screenshot_key: string;
  sha256: string;
  fingerprint: string;
}
const publicIssue = (row: IssueRow) => ({
  id: row.id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  status: row.status,
  title: row.title,
  description: row.description,
  context: JSON.parse(row.context),
  sha256: row.sha256,
  screenshot: `/api/issues/${row.id}/screenshot`,
});
export async function issueRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/issues" && request.method === "GET") {
    const before = url.searchParams.get("before") ?? "9999|";
    const cursor = before.split("|");
    requireThat(cursor.length === 2, 400, "Invalid cursor.");
    const rows = await env.DB.prepare(
      "SELECT * FROM issues WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 21",
    )
      .bind(...cursor)
      .all<IssueRow>();
    const page = rows.results.slice(0, 20);
    return json({
      issues: page.map(publicIssue),
      next:
        rows.results.length > 20
          ? `${page.at(-1)!.created_at}|${page.at(-1)!.id}`
          : null,
    });
  }
  const match = url.pathname.match(/^\/api\/issues\/([^/]+)(\/screenshot)?$/);
  if (!match) return null;
  const [, id, screenshot] = match;
  requireThat(UUID.test(id), 400, "Invalid issue ID.");
  if (request.method === "POST" && !screenshot) {
    const contentType = request.headers.get("content-type") ?? "";
    requireThat(
      contentType.toLowerCase().startsWith("multipart/form-data;"),
      415,
      "Use a multipart issue report.",
    );
    const envelope = await bytes(request, 12 * 1024 * 1024 + 64 * 1024);
    let form: FormData;
    try {
      form = await new Response(envelope, {
        headers: { "Content-Type": contentType },
      }).formData();
    } catch {
      return json({ detail: "Invalid issue upload." }, 400);
    }
    requireThat(
      [...form.keys()].length === 2 &&
        form.getAll("metadata").length === 1 &&
        form.getAll("screenshot").length === 1,
      400,
      "Provide issue details and one screenshot.",
    );
    const metadataText = form.get("metadata");
    requireThat(
      typeof metadataText === "string" && metadataText.length <= 64000,
      400,
      "Invalid issue details.",
    );
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      return json({ detail: "Invalid issue details." }, 400);
    }
    requireThat(
      metadata && typeof metadata === "object" && !Array.isArray(metadata),
      400,
      "Invalid issue details.",
    );
    const { title, description, context = {} } = metadata;
    requireThat(
      typeof title === "string" &&
        title.trim().length > 0 &&
        title.length <= 160,
      400,
      "Enter a title of up to 160 characters.",
    );
    requireThat(
      typeof description === "string" && description.length <= 8000,
      400,
      "Description must be at most 8000 characters.",
    );
    const contextJson = JSON.stringify(context);
    requireThat(
      contextJson.length <= 48000,
      413,
      "Issue context is too large.",
    );
    const screenshotFile = form.get("screenshot");
    requireThat(
      screenshotFile instanceof File &&
        screenshotFile.size > 0 &&
        screenshotFile.size <= 12 * 1024 * 1024,
      400,
      "Provide a screenshot of up to 12 MB.",
    );
    const data = new Uint8Array(await screenshotFile.arrayBuffer());
    const type = imageType(data);
    const sha = await digest(data);
    const fingerprint = await digest(
      new Uint8Array(
        new TextEncoder().encode(
          JSON.stringify([title.trim(), description, context, sha]),
        ),
      ),
    );
    const existing = await env.DB.prepare("SELECT * FROM issues WHERE id=?")
      .bind(id)
      .first<IssueRow>();
    if (existing) {
      requireThat(
        existing.fingerprint === fingerprint,
        409,
        "This issue ID already belongs to a different report.",
      );
      return json(publicIssue(existing));
    }
    const key = `issues/${id}/${sha}`;
    const stored = await env.BUCKET.put(key, data, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: type },
      customMetadata: { sha256: sha },
    });
    requireThat(
      stored || (await env.BUCKET.head(key)),
      503,
      "Screenshot storage not confirmed.",
    );
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO issues(id,created_at,updated_at,status,title,description,context,screenshot_key,sha256,fingerprint) VALUES(?,?,?,'open',?,?,?,?,?,?)",
    )
      .bind(
        id,
        now,
        now,
        title.trim(),
        description,
        contextJson,
        key,
        sha,
        fingerprint,
      )
      .run();
    const result = (await env.DB.prepare("SELECT * FROM issues WHERE id=?")
      .bind(id)
      .first<IssueRow>())!;
    requireThat(
      result.fingerprint === fingerprint,
      409,
      "This issue ID already belongs to a different report.",
    );
    return json(publicIssue(result), 201);
  }
  const row = await env.DB.prepare("SELECT * FROM issues WHERE id=?")
    .bind(id)
    .first<IssueRow>();
  requireThat(row, 404, "Issue not found.");
  if (screenshot && request.method === "GET") {
    const object = await env.BUCKET.get(row.screenshot_key);
    requireThat(object, 404, "Screenshot not found.");
    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType ?? "image/png",
      },
    });
  }
  if (!screenshot && request.method === "GET") {
    const updates = await env.DB.prepare(
      "SELECT status,note,created_at FROM issue_updates WHERE issue_id=? ORDER BY created_at,id",
    )
      .bind(id)
      .all();
    return json({ ...publicIssue(row), updates: updates.results });
  }
  if (!screenshot && request.method === "PATCH") {
    const { status, note } = await bodyJson(request);
    requireThat(
      typeof status === "string" &&
        ["open", "in-progress", "resolved"].includes(status),
      400,
      "Invalid issue status.",
    );
    requireThat(
      typeof note === "string" && note.trim().length > 0 && note.length <= 4000,
      400,
      "A progress or verification note is required.",
    );
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE issues SET status=?,updated_at=? WHERE id=?").bind(
        status,
        now,
        id,
      ),
      env.DB.prepare(
        "INSERT INTO issue_updates(id,issue_id,status,note,created_at) VALUES(?,?,?,?,?)",
      ).bind(crypto.randomUUID(), id, status, note, now),
    ]);
    return json({ ok: true });
  }
  return json({ detail: "Method not allowed." }, 405);
}
