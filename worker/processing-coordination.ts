import { digest, requireThat, UUID } from "./http";
import type { Env } from "./index";

export async function processingClient(request: Request) {
  const authorization = request.headers.get("authorization");
  const session = request.headers.get("x-processing-session");
  requireThat(
    session === null || UUID.test(session),
    400,
    "Use a UUID processing session.",
  );
  return authorization
    ? digest(
        Uint8Array.from(
          new TextEncoder().encode(
            authorization + (session ? "|" + session : ""),
          ),
        ),
      )
    : null;
}

export async function processingBatch(request: Request, env: Env) {
  const credential = await processingClient(request);
  if (!credential) return null;
  const batch = await env.DB.prepare(
    "SELECT batch_id FROM processing_batch_lease WHERE client_sha256=? AND expires>unixepoch()*1000",
  )
    .bind(credential)
    .first<{ batch_id: string }>();
  return batch?.batch_id ?? null;
}

// A batch retains its touched documents through PDF creation and final readback.
// Other documents remain available to the other processing workflow.
export function documentWriteGuard(
  env: Env,
  documentIds: string[],
  token: string | null,
  batchId: string | null,
) {
  return env.DB.prepare(
    `INSERT INTO processing_commits(token,valid)
    SELECT ?,NOT EXISTS(
      SELECT 1 FROM processing_lock WHERE document_id IN (SELECT value FROM json_each(?))
      AND expires>unixepoch()*1000 AND token!=?
    ) AND NOT EXISTS(
      SELECT 1 FROM processing_batch_documents d JOIN processing_batch_lease b ON b.batch_id=d.batch_id
      WHERE d.document_id IN (SELECT value FROM json_each(?)) AND b.expires>unixepoch()*1000 AND b.batch_id!=?
    )`,
  ).bind(
    crypto.randomUUID(),
    JSON.stringify(documentIds),
    token ?? "",
    JSON.stringify(documentIds),
    batchId ?? "",
  );
}

export function reserveBatchDocuments(
  env: Env,
  documentIds: string[],
  batchId: string | null,
) {
  if (!batchId) return [];
  return documentIds.map((id) =>
    env.DB.prepare(
      "INSERT INTO processing_batch_documents(document_id,batch_id) VALUES(?,?) ON CONFLICT(document_id) DO UPDATE SET batch_id=excluded.batch_id",
    ).bind(id, batchId),
  );
}
