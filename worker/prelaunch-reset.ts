// One-off operational migration. Removed after the authorized pre-production reset.
// The reviewed allowlist lives in a short-lived private runtime setting, never source.
import type { Env } from "./index";

interface Manifest {
  expires: number;
  cutoff: number;
  captures: { id: string; sha256: string }[];
}
const response = (value: unknown, status = 200) =>
  Response.json(value, { status });

async function inventory(env: Env, manifest: Manifest) {
  const captures = (
    await env.DB.prepare("SELECT id,sha256 FROM captures ORDER BY id").all<{
      id: string;
      sha256: string;
    }>()
  ).results;
  const artifacts = (await env.DB.prepare("SELECT key FROM artifacts").all())
    .results;
  const objects = await env.BUCKET.list({ limit: 1000 });
  if (
    objects.truncated ||
    artifacts.length ||
    captures.some(
      (row) =>
        !manifest.captures.some(
          (allowed) => allowed.id === row.id && allowed.sha256 === row.sha256,
        ),
    ) ||
    objects.objects.some(
      (object) => object.uploaded.getTime() > manifest.cutoff,
    )
  ) {
    throw new Error(
      "Inventory changed or exceeds the reviewed scope. No deletion performed.",
    );
  }
  const keys = objects.objects
    .map(({ key, etag, size }) => ({ key, etag, size }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ captures, keys })),
      ),
    ),
  )
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return { captures, keys, hash };
}

export async function prelaunchReset(
  request: Request,
  env: Env,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const manifest = JSON.parse(env.PRELAUNCH_RESET_MANIFEST!) as Manifest;
  if (
    !Array.isArray(manifest.captures) ||
    !Number.isFinite(manifest.cutoff) ||
    Date.now() > manifest.expires
  )
    return response(
      {
        detail:
          "Pre-production maintenance authorization expired. Scanning remains paused.",
      },
      503,
    );
  if (path === "/__prelaunch-reset.js" && request.method === "GET")
    return new Response(
      `
const result=document.querySelector('#result'),button=document.querySelector('button');
button.addEventListener('click',async()=>{
 button.disabled=true;
 try {
 const r=await fetch('/__prelaunch-reset',{method:'POST',headers:{'Content-Type':'application/json','X-Scanner-Request':'1'},body:JSON.stringify({inventory:button.dataset.inventory})});
 result.textContent=JSON.stringify(await r.json(),null,2);
 } catch(e) { result.textContent=String(e); }
});`,
      { headers: { "Content-Type": "text/javascript" } },
    );
  if (path !== "/__prelaunch-reset")
    return response(
      {
        detail:
          "Pre-production cleanup in progress. Scanning is paused; reload when complete.",
      },
      503,
    );
  try {
    const current = await inventory(env, manifest);
    if (request.method === "GET")
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorized pre-production cleanup</title><h1>One-off pre-production cleanup</h1><p>${current.captures.length} test captures; ${current.keys.length} stored files; ${current.keys.reduce((sum, key) => sum + key.size, 0)} bytes. No OCR or PDF records.</p><p>Scanning is paused. Only the reviewed test inventory can be removed. This operation will be removed after verification.</p><button data-inventory="${current.hash}">Permanently clear this test inventory</button><pre id="result"></pre><script src="/__prelaunch-reset.js"></script></html>`,
        { headers: { "Content-Type": "text/html;charset=utf-8" } },
      );
    if (request.method !== "POST")
      return response({ detail: "Method not allowed" }, 405);
    const body = (await request.json()) as { inventory?: string };
    if (body.inventory !== current.hash)
      return response(
        { detail: "Inventory changed. Reload and inspect it before clearing." },
        409,
      );
    if (!current.captures.length && !current.keys.length)
      return response({
        captures: 0,
        artifacts: 0,
        objects: 0,
        complete: true,
      });
    // All application routes are disabled while maintenance is configured. Delete only
    // the inspected object keys; preserve DB records if object removal is incomplete.
    if (current.keys.length)
      await env.BUCKET.delete(current.keys.map((object) => object.key));
    const remaining = await env.BUCKET.list({ limit: 1000 });
    if (remaining.truncated || remaining.objects.length)
      throw new Error("File storage is not empty. Database records retained.");
    await env.DB.batch([
      ...current.captures.map((row) =>
        env.DB.prepare("DELETE FROM captures WHERE id=? AND sha256=?").bind(
          row.id,
          row.sha256,
        ),
      ),
      env.DB.prepare("DELETE FROM station WHERE id=1"),
    ]);
    const final = await inventory(env, manifest);
    const station = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM station",
    ).first<{ count: number }>();
    return response({
      captures: final.captures.length,
      artifacts: 0,
      objects: final.keys.length,
      station: station?.count,
      complete: !final.captures.length && !final.keys.length && !station?.count,
    });
  } catch (error) {
    return response(
      {
        detail:
          error instanceof Error
            ? error.message
            : "Maintenance failed; inspect storage before resuming.",
      },
      409,
    );
  }
}
