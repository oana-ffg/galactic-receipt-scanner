import {
  processingClient,
  processingBatch,
  documentWriteGuard,
  reserveBatchDocuments,
} from "./processing-coordination";
import {
  lunaDraft,
  checkQwen,
  confirmationEvidence,
  ppConfirmation,
  checkAssessment,
  type LunaDraft,
} from "./processing-confirmation";
import { compareStoredOcr } from "./ocr-comparison";
import type { Env } from "./index";
import type { Capture } from "../web/types";
import {
  newDocument,
  DOCUMENT_EVIDENCE_LIMIT,
  retargetAbsorbedAliases,
  requiredMergeReviewReasons,
  type ReceiptDocument,
} from "../web/documents";
import {
  arithmetic,
  extractionErrors,
  financialTypes,
  processingDisposition,
  type Extraction,
  type ProcessingState,
} from "../web/extraction";
import { bodyJson, digest, HttpError, json, requireThat, UUID } from "./http";
import { jevOpenTailDocumentId, jevSummary } from "./jev";
import {
  documentRoute,
  MAX_DOCUMENT_CHANGES,
  storedDocumentById,
  storedDocumentsByIds,
  storedAliasesForTargets,
} from "./documents";
import { currentTake } from "./capture-selection";

type Lock = {
  token: string;
  request_sha256: string | null;
  client_sha256: string | null;
  batch_id: string | null;
  stage: "small" | "large";
  document_id: string;
  revision: number;
  expires: number;
  draft: string | null;
};
type ClaimRequestRecord = {
  token: string;
  request_sha256: string;
  stage: "small" | "large";
  document_id: string | null;
  revision: number | null;
  outcome_reason: string;
};
const STAGE_MODEL = { small: "gpt-6-luna", large: "gpt-6-astra" } as const;
const LEGACY_LUNA_MODEL = "gpt-5.6-luna";
function validStageModel(stage: Lock["stage"], model: unknown): boolean {
  return (
    model === STAGE_MODEL[stage] ||
    (stage === "small" && model === LEGACY_LUNA_MODEL)
  );
}
const LEASE_MS = 20 * 60 * 1000;
const BATCH_LEASE_MS = 30 * 60 * 1000;
const BATCH_ID = /^[0-9a-f]{32}$/;
const MAX_SUBMITTED_DOCUMENTS = 20;
async function activeLock(env: Env, token?: unknown) {
  return env.DB.prepare(
    "SELECT * FROM processing_lock WHERE expires>unixepoch()*1000" +
      (token === undefined ? "" : " AND token=?") +
      " LIMIT 1",
  )
    .bind(
      ...(token === undefined ? [] : [typeof token === "string" ? token : ""]),
    )
    .first<Lock>();
}
export async function protectBlindParse(request: Request, env: Env) {
  if (!request.headers.has("authorization")) return;
  const url = new URL(request.url),
    path = url.pathname;
  // This mode exposes checkpoint existence only, never previous model readings.
  if (
    path === "/api/processing/readings" &&
    request.method === "GET" &&
    url.searchParams.has("checkpoint_token")
  )
    return;
  if (
    !path.startsWith("/api/documents") &&
    path !== "/api/processing/readings" &&
    !/^\/api\/files\/[^/]+\/ocr$/.test(path)
  )
    return;
  const credential = await processingClient(request);
  const lock = await env.DB.prepare(
    "SELECT * FROM processing_lock WHERE expires>unixepoch()*1000 AND (client_sha256=? OR client_sha256 IS NULL) LIMIT 1",
  )
    .bind(credential)
    .first<Lock>();
  if (path === "/api/processing/readings")
    requireThat(
      lock?.stage === "large" && lock.draft !== null,
      409,
      "Reading history requires an active Astra review with a saved independent draft.",
    );
  requireThat(
    !lock || lock.stage !== "large" || lock.draft !== null,
    409,
    "Save the independent full parse before reading earlier extraction results.",
  );
}
type ClaimCandidate = {
  id: string;
  priority: number;
  created_at: string;
  scan_id: string;
};

async function claimCandidateRows(
  env: Env,
  stage: "small" | "large",
  excluded: Set<string>,
  after: ClaimCandidate | null,
  captureCount: number,
): Promise<ClaimCandidate[]> {
  const excludedIds = [...excluded];
  const exclusion = excludedIds.length
    ? "AND COALESCE(page.document_id,captures.id) NOT IN (SELECT value FROM json_each(?))"
    : "";
  const candidates: ClaimCandidate[] = [];
  for (const priority of stage === "small" ? [0, 1] : [0]) {
    if (after && priority < after.priority) continue;
    const cursor = after?.priority === priority ? after : null;
    const eligibility =
      priority === 1
        ? `(page.capture_id IS NOT NULL
            AND json_extract(v.payload,'$.processing.extraction.completeness')='fragment'
            AND COALESCE(json_extract(v.payload,'$.processing.needs_reparse'),0)=0
            AND COALESCE(json_extract(v.payload,'$.processing.seen_capture_count'),0)<?)`
        : stage === "small"
          ? `((page.capture_id IS NULL AND h.id IS NULL AND (${currentTake}))
            OR (page.capture_id IS NOT NULL AND h.id IS NOT NULL
              AND (json_extract(v.payload,'$.processing') IS NULL
                OR json_extract(v.payload,'$.processing.needs_reparse')=1)))`
          : `(page.capture_id IS NOT NULL
              AND json_extract(v.payload,'$.processing') IS NOT NULL
              AND COALESCE(json_extract(v.payload,'$.processing.needs_reparse'),0)=0
              AND json_extract(v.payload,'$.processing.large_model_confidence') IS NULL
              AND COALESCE(json_extract(v.payload,'$.processing.has_human_review'),0)=0)`;
    const rows = await env.DB.prepare(
      `SELECT COALESCE(page.document_id,captures.id) AS id,
         ? AS priority,captures.created_at,captures.id AS scan_id
       FROM captures INDEXED BY captures_created_id
       LEFT JOIN document_pages page ON page.capture_id=captures.id
       LEFT JOIN document_heads h ON h.id=COALESCE(page.document_id,captures.id)
       LEFT JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
       JOIN jev_document_heads jev
         ON jev.document_id=COALESCE(page.document_id,captures.id)
         AND jev.role='purchase_document'
       WHERE (captures.created_at,captures.id)>(?,?)
         AND (page.capture_id IS NULL
           OR page.capture_id=json_extract(v.payload,'$.pages[0].captureId'))
         AND json_extract(v.payload,'$.mergedInto') IS NULL
         AND json_extract(v.payload,'$.duplicateOf') IS NULL
         AND NOT EXISTS(SELECT 1 FROM processing_lock l WHERE l.document_id=COALESCE(page.document_id,captures.id) AND l.expires>unixepoch()*1000)
         AND NOT EXISTS(SELECT 1 FROM processing_batch_documents r JOIN processing_batch_lease b ON b.batch_id=r.batch_id WHERE r.document_id=COALESCE(page.document_id,captures.id) AND b.expires>unixepoch()*1000)
         AND ${eligibility}
         AND (page.capture_id IS NULL OR EXISTS (
           SELECT 1 FROM document_pages member
           JOIN captures ON captures.id=member.capture_id
           WHERE member.document_id=page.document_id AND (${currentTake})
         ))
         ${exclusion}
       ORDER BY captures.created_at,captures.id LIMIT ?`,
    )
      .bind(
        priority,
        cursor?.created_at ?? "",
        cursor?.scan_id ?? "",
        ...(priority === 1 ? [captureCount] : []),
        ...(excludedIds.length ? [JSON.stringify(excludedIds)] : []),
        25 - candidates.length,
      )
      .all<ClaimCandidate>();
    candidates.push(...rows.results);
    if (candidates.length === 25) break;
  }
  return candidates;
}

async function claimDocument(
  env: Env,
  id: string,
  loadCapture: (id: string) => Promise<Capture | null>,
): Promise<{ document: ReceiptDocument; captures: Capture[] } | null> {
  const saved = await storedDocumentById(env, id);
  const first = saved ? null : await loadCapture(id);
  if (!saved && !first?.is_current) return null;
  const document = saved ?? newDocument(first!);
  const captures = await Promise.all(
    document.pages.map((page) => loadCapture(page.captureId)),
  );
  if (captures.some((capture) => !capture)) return null;
  return { document, captures: captures as Capture[] };
}

async function capturesForPages(
  pages: ReceiptDocument["pages"],
  loadCapture: (id: string) => Promise<Capture | null>,
): Promise<Capture[]> {
  const ids = [...new Set(pages.map((page) => page.captureId))];
  const captures = await Promise.all(ids.map(loadCapture));
  requireThat(
    captures.every((capture) => capture !== null),
    409,
    "A source page is unavailable.",
  );
  return captures as Capture[];
}

async function draftSources(
  env: Env,
  inputDocuments: unknown,
  loadCapture: (id: string) => Promise<Capture | null>,
): Promise<{ previous: ReceiptDocument[]; captures: Capture[] }> {
  requireThat(
    Array.isArray(inputDocuments) &&
      inputDocuments.length > 0 &&
      inputDocuments.length <= 20 &&
      inputDocuments.every(
        (item) => item && typeof item.id === "string" && UUID.test(item.id),
      ),
    400,
    "Freeze 1 to 20 affected documents with valid IDs.",
  );
  const ids = inputDocuments.map((item) => item.id as string);
  const stored = await storedDocumentsByIds(env, ids);
  const previous: ReceiptDocument[] = [];
  for (const id of ids) {
    const saved = stored.get(id);
    if (saved) {
      previous.push(saved);
      continue;
    }
    const [capture, assigned] = await Promise.all([
      loadCapture(id),
      env.DB.prepare(
        "SELECT document_id FROM document_pages WHERE capture_id=?",
      )
        .bind(id)
        .first<{ document_id: string }>(),
    ]);
    if (capture?.is_current && !assigned) previous.push(newDocument(capture));
  }
  const proposedPages = inputDocuments.flatMap((item) =>
    Array.isArray(item.pages) ? item.pages : [],
  ) as ReceiptDocument["pages"];
  requireThat(
    proposedPages.length <= 100 &&
      proposedPages.every(
        (page) =>
          page &&
          typeof page.captureId === "string" &&
          UUID.test(page.captureId),
      ),
    400,
    "Freeze at most 100 valid source pages.",
  );
  const captures = await capturesForPages(
    [...previous.flatMap((document) => document.pages), ...proposedPages],
    loadCapture,
  );
  return { previous, captures };
}
function validateExtraction(value: unknown): asserts value is Extraction {
  const errors = extractionErrors(value);
  requireThat(!errors.length, 400, errors.join(" "));
}
async function categoryCheck(env: Env, e: Extraction) {
  if (e.category_id !== null)
    requireThat(
      await env.DB.prepare(
        "SELECT id FROM purchase_categories WHERE id=? AND archived_at IS NULL",
      )
        .bind(e.category_id)
        .first(),
      400,
      "Unknown purchase category.",
    );
}
function state(
  e: Extraction,
  previous: ProcessingState | undefined,
  stage: Lock["stage"] | "human",
  revision: number,
): ProcessingState {
  return {
    extraction: e,
    not_invoice: e.type !== "unknown" && !financialTypes.includes(e.type),
    has_handwriting: e.has_handwriting,
    small_model_certainty:
      stage === "small"
        ? e.certainty
        : (previous?.small_model_certainty ?? null),
    large_model_confidence:
      stage === "large"
        ? e.certainty
        : stage === "human"
          ? (previous?.large_model_confidence ?? null)
          : null,
    has_human_review: stage === "human",
    human_review_revision: stage === "human" ? revision + 1 : null,
    luna_needs_human_review:
      stage === "human"
        ? false
        : stage === "small"
          ? e.needs_human_review === true
          : (previous?.luna_needs_human_review ??
            previous?.extraction.needs_human_review ??
            false),
    luna_human_review_reasons:
      stage === "human"
        ? []
        : stage === "small"
          ? [...(e.human_review_reasons ?? [])]
          : [
              ...(previous?.luna_human_review_reasons ??
                previous?.extraction.human_review_reasons ??
                []),
            ],
    needs_reparse: false,
    seen_capture_count: previous?.seen_capture_count ?? 0,
  };
}
function applyExtraction(
  d: ReceiptDocument,
  e: Extraction,
  p: ProcessingState,
) {
  d.processing = p;
  d.kind = e.type;
  if (d.pages.length === 1) d.pages[0].type = e.type;
  d.vendor = e.vendor;
  d.receiptDate = e.receipt_date;
  d.reference = e.reference;
  d.handwriting =
    e.has_handwriting === null
      ? "unchecked"
      : e.has_handwriting
        ? "present"
        : "absent";
  d.invoice = null;
  d.uncertainties = [...e.uncertainties];
  d.broken = [...e.broken_reasons];
  d.evidence = e.evidence;
  d.checks = {
    visual: false,
    transcription: false,
    grouping: false,
    pdf: false,
  };
  d.reviewedPdfSha256 = null;
}

async function save(
  request: Request,
  env: Env,
  load: () => Promise<Capture[]>,
  documents: ReceiptDocument[],
  statements: D1PreparedStatement[],
  loadCapture?: (id: string) => Promise<Capture | null>,
  loadSelectedCaptures?: (ids: string[]) => Promise<Capture[]>,
  lock?: Lock,
) {
  return (await documentRoute(
    new Request(new URL("/api/documents", request.url), {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ documents }),
    }),
    env,
    load,
    {
      statements: [
        ...statements,
        ...reserveBatchDocuments(
          env,
          documents.map((d) => d.id),
          lock?.batch_id ?? null,
        ),
      ],
      trustedProcessing: true,
      processingToken: lock?.token,
      batchId: lock?.batch_id,
    },
    loadCapture,
    loadSelectedCaptures,
  ))!;
}
export async function processingRoute(
  request: Request,
  env: Env,
  load: () => Promise<Capture[]>,
  loadCapture: (id: string) => Promise<Capture | null>,
  loadSelectedCaptures?: (ids: string[]) => Promise<Capture[]>,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (!path.startsWith("/api/processing/")) return null;
  if (path === "/api/processing/ocr-layouts" && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT json_extract(page.value, '$.captureId') AS capture_id,
              json_extract(page.value, '$.sha256') AS source_sha256,
              json_extract(page.value, '$.rotation') AS rotation
       FROM document_heads h
       JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
       JOIN json_each(v.payload, '$.pages') page
       WHERE json_extract(v.payload, '$.mergedInto') IS NULL
       ORDER BY capture_id`,
    ).all<{
      capture_id: string;
      source_sha256: string;
      rotation: number;
    }>();
    return json({
      layouts: rows.results.map((row) => ({
        capture_id: row.capture_id,
        source_sha256: row.source_sha256,
        rotation: row.rotation,
      })),
    });
  }
  if (path === "/api/processing/reparse" && method === "POST") {
    requireThat(
      request.headers.has("authorization"),
      403,
      "Use scoped machine credentials to queue a Luna reparse.",
    );
    requireThat(
      !(await activeLock(env)),
      409,
      "Finish the active model claim before queueing a reparse.",
    );
    const lease = await env.DB.prepare(
      "SELECT batch_id FROM processing_batch_lease WHERE expires>unixepoch()*1000",
    ).first();
    requireThat(
      !lease,
      409,
      "Finish the active processing batch before queueing a reparse.",
    );
    const input = await bodyJson(request);
    requireThat(
      Array.isArray(input.documents) &&
        input.documents.length > 0 &&
        input.documents.length <= MAX_DOCUMENT_CHANGES,
      400,
      "Queue 1 to 100 saved documents at a time.",
    );
    const requested = input.documents as { id: string; revision: number }[];
    requireThat(
      requested.every(
        (item) =>
          item &&
          UUID.test(item.id) &&
          Number.isSafeInteger(item.revision) &&
          item.revision > 0,
      ) && new Set(requested.map((item) => item.id)).size === requested.length,
      400,
      "Use distinct saved document IDs and exact revisions.",
    );
    const stored = await storedDocumentsByIds(
      env,
      requested.map(({ id }) => id),
    );
    const changed = requested.map(({ id, revision }) => {
      const current = stored.get(id);
      requireThat(
        current && current.revision === revision,
        409,
        "Document changed. Reload before queueing its reparse.",
      );
      requireThat(
        !current.mergedInto &&
          !current.duplicateOf &&
          current.processing &&
          financialTypes.includes(current.processing.extraction.type) &&
          current.processing.extraction.line_items.length === 0 &&
          !current.processing.needs_reparse &&
          !current.processing.has_human_review,
        409,
        "Only unreviewed financial documents with no saved line items can be queued here.",
      );
      const doc = structuredClone(current);
      doc.processing!.needs_reparse = true;
      doc.processing!.large_model_confidence = null;
      return doc;
    });
    // This assertion shares the document write transaction. A worker may acquire a
    // claim after the reads above but before save, so the lease check must repeat here.
    const guardToken = `reparse:${crypto.randomUUID()}`;
    const guard = env.DB.prepare(
      "INSERT INTO processing_commits(token,valid) SELECT ?,NOT EXISTS(SELECT 1 FROM processing_lock WHERE expires>unixepoch()*1000) AND NOT EXISTS(SELECT 1 FROM processing_batch_lease WHERE expires>unixepoch()*1000)",
    ).bind(guardToken);
    const clearGuard = env.DB.prepare(
      "DELETE FROM processing_commits WHERE token=?",
    ).bind(guardToken);
    return save(
      request,
      env,
      load,
      changed,
      [guard, clearGuard],
      loadCapture,
      loadSelectedCaptures,
    );
  }
  if (path === "/api/processing/readings" && method === "GET") {
    const id = url.searchParams.get("document_id");
    requireThat(id && UUID.test(id), 400, "Choose a document.");
    if (url.searchParams.has("checkpoint_token")) {
      const checkpoint = url.searchParams.get("checkpoint_token");
      requireThat(
        checkpoint && UUID.test(checkpoint),
        400,
        "Choose a valid checkpoint.",
      );
      const status = await env.DB.prepare(
        `SELECT
        EXISTS(SELECT 1 FROM processing_drafts WHERE token=?1 AND document_id=?2) AS draft_saved,
        EXISTS(SELECT 1 FROM processing_attempts WHERE token=?1 AND document_id=?2) AS attempt_saved,
        EXISTS(SELECT 1 FROM processing_lock WHERE token=?1 AND document_id=?2 AND expires > unixepoch()*1000) AS claim_active`,
      )
        .bind(checkpoint, id)
        .first<{
          draft_saved: number;
          attempt_saved: number;
          claim_active: number;
        }>();
      requireThat(status, 500, "Checkpoint status unavailable.");
      return json({
        draft_saved: !!status.draft_saved,
        attempt_saved: !!status.attempt_saved,
        claim_active: !!status.claim_active,
      });
    }
    const rows = await env.DB.prepare(
      `SELECT d.revision,d.model,d.payload AS initial,d.created_at,c.payload AS confirmation,c.sha256 AS confirmation_sha256,a.payload AS updated
      FROM processing_drafts d LEFT JOIN processing_confirmations c ON c.token=d.token LEFT JOIN processing_attempts a ON a.token=d.token
      WHERE d.document_id=? ORDER BY d.created_at DESC LIMIT 20`,
    )
      .bind(id)
      .all<any>();
    const attempts = await env.DB.prepare(
      "SELECT revision,stage,model,payload,created_at FROM processing_attempts WHERE document_id=? ORDER BY revision DESC",
    )
      .bind(id)
      .all<{
        revision: number;
        stage: string;
        model: string;
        payload: string;
        created_at: string;
      }>();
    return json({
      attempts: attempts.results.map(({ payload, ...row }) => {
        const saved = JSON.parse(payload);
        return {
          ...row,
          extraction: saved.request.extraction,
          sources: saved.sources,
        };
      }),
      readings: rows.results.map((row) => ({
        revision: row.revision,
        model: row.model,
        created_at: row.created_at,
        initial: JSON.parse(row.initial),
        confirmation: row.confirmation ? JSON.parse(row.confirmation) : null,
        confirmation_sha256: row.confirmation_sha256,
        updated: row.updated
          ? ((v: any) => ({
              model: v.request.model,
              extraction: v.request.extraction,
              assessment: v.request.assessment ?? null,
            }))(JSON.parse(row.updated))
          : null,
      })),
    });
  }
  if (path === "/api/processing/categories") {
    if (method === "GET") {
      const includeArchived = url.searchParams.get("include_archived") === "1";
      requireThat(
        !includeArchived || !request.headers.has("authorization"),
        403,
        "Archived categories require the owner's interactive session.",
      );
      return json(
        (
          await env.DB.prepare(
            includeArchived
              ? `SELECT id,name,description,archived_at,COALESCE((SELECT MAX(revision) FROM purchase_category_revisions r WHERE r.category_id=purchase_categories.id),0) AS revision
                FROM purchase_categories ORDER BY name`
              : `SELECT id,name,description,COALESCE((SELECT MAX(revision) FROM purchase_category_revisions r WHERE r.category_id=purchase_categories.id),0) AS revision
                FROM purchase_categories WHERE archived_at IS NULL ORDER BY name`,
          ).all()
        ).results,
      );
    }
    requireThat(method === "POST", 405, "Method not allowed.");
    const input = await bodyJson(request);
    requireThat(
      typeof input.name === "string" &&
        input.name.trim().length > 0 &&
        input.name.length <= 150 &&
        typeof input.description === "string" &&
        input.description.trim().length > 0 &&
        input.description.length <= 2000,
      400,
      "A category needs a name and description.",
    );
    const name = input.name.trim().normalize("NFKC"),
      normalized = name.toLocaleLowerCase("en").replace(/\s+/g, " ");
    if (input.id !== undefined) {
      requireThat(
        !request.headers.has("authorization"),
        403,
        "Category definition edits require the owner's interactive session.",
      );
      requireThat(
        !(await activeLock(env)),
        409,
        "Finish the active model claim before changing category definitions.",
      );
      requireThat(
        typeof input.id === "string" &&
          UUID.test(input.id) &&
          typeof input.revision === "number" &&
          Number.isSafeInteger(input.revision) &&
          input.revision >= 0,
        400,
        "Read the category and its revision before editing.",
      );
      requireThat(
        typeof input.reason === "string" &&
          input.reason.trim().length > 0 &&
          input.reason.length <= 2000,
        400,
        "Explain the category definition change.",
      );
      const previous = await env.DB.prepare(
        "SELECT id,name,description,COALESCE((SELECT MAX(revision) FROM purchase_category_revisions r WHERE r.category_id=purchase_categories.id),0) AS revision FROM purchase_categories WHERE id=? AND archived_at IS NULL",
      )
        .bind(input.id)
        .first<{
          id: string;
          name: string;
          description: string;
          revision: number;
        }>();
      requireThat(
        previous && previous.revision === input.revision,
        409,
        "Category changed. Reload before editing.",
      );
      const collision = await env.DB.prepare(
        "SELECT id FROM purchase_categories WHERE normalized_name=? AND id<>?",
      )
        .bind(normalized, input.id)
        .first();
      requireThat(!collision, 409, "Another category already has this name.");
      const updated = {
        id: input.id,
        name,
        description: input.description.trim(),
        revision: previous.revision + 1,
      };
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO purchase_category_revisions(category_id,revision,previous,updated,reason,created_at) VALUES(?,?,?,?,?,?)",
          ).bind(
            input.id,
            updated.revision,
            JSON.stringify(previous),
            JSON.stringify(updated),
            input.reason.trim(),
            new Date().toISOString(),
          ),
          env.DB.prepare(
            "UPDATE purchase_categories SET normalized_name=?,name=?,description=? WHERE id=?",
          ).bind(normalized, name, updated.description, input.id),
        ]);
      } catch (error) {
        if (/UNIQUE constraint/.test(String(error)))
          throw new HttpError(
            409,
            "Concurrent category change. Reload before editing.",
          );
        throw error;
      }
      return json(updated);
    }
    await env.DB.prepare(
      "INSERT INTO purchase_categories(id,normalized_name,name,description,created_at) VALUES(?,?,?,?,?) ON CONFLICT(normalized_name) DO NOTHING",
    )
      .bind(
        crypto.randomUUID(),
        normalized,
        name,
        input.description.trim(),
        new Date().toISOString(),
      )
      .run();
    const result = await env.DB.prepare(
      "SELECT id,name,description,archived_at FROM purchase_categories WHERE normalized_name=?",
    )
      .bind(normalized)
      .first<{
        id: string;
        name: string;
        description: string;
        archived_at: string | null;
      }>();
    requireThat(
      result?.archived_at === null &&
        result.description === input.description.trim(),
      409,
      "This category name is unavailable. Read and reuse the active category or choose a distinct name.",
    );
    return json({
      id: result.id,
      name: result.name,
      description: result.description,
    });
  }
  if (path === "/api/processing/category-archive" && method === "POST") {
    requireThat(
      !request.headers.has("authorization"),
      403,
      "Category archival requires the owner's interactive session.",
    );
    requireThat(
      !(await activeLock(env)),
      409,
      "Finish the active model claim before archiving a category.",
    );
    const input = await bodyJson(request);
    requireThat(
      typeof input.id === "string" &&
        UUID.test(input.id) &&
        typeof input.revision === "number" &&
        Number.isSafeInteger(input.revision) &&
        input.revision >= 0,
      400,
      "Read the category and its revision before archiving.",
    );
    requireThat(
      typeof input.reason === "string" &&
        input.reason.trim().length > 0 &&
        input.reason.length <= 2000,
      400,
      "Explain why the category is being archived.",
    );
    const previous = await env.DB.prepare(
      "SELECT id,name,description,COALESCE((SELECT MAX(revision) FROM purchase_category_revisions r WHERE r.category_id=purchase_categories.id),0) AS revision FROM purchase_categories WHERE id=? AND archived_at IS NULL",
    )
      .bind(input.id)
      .first<{
        id: string;
        name: string;
        description: string;
        revision: number;
      }>();
    requireThat(
      previous && previous.revision === input.revision,
      409,
      "Category changed. Reload before archiving.",
    );
    const assigned = await env.DB.prepare(
      `SELECT h.id FROM document_heads h
       CROSS JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
       WHERE json_extract(v.payload,'$.mergedInto') IS NULL
         AND json_extract(v.payload,'$.duplicateOf') IS NULL
         AND json_extract(v.payload,'$.processing.extraction.category_id')=?
       LIMIT 1`,
    )
      .bind(input.id)
      .first<{ id: string }>();
    requireThat(
      !assigned,
      409,
      "Reassign every retained document before archiving this category.",
    );
    const archivedAt = new Date().toISOString(),
      updated = {
        ...previous,
        revision: previous.revision + 1,
        archived_at: archivedAt,
      };
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO purchase_category_revisions(category_id,revision,previous,updated,reason,created_at) VALUES(?,?,?,?,?,?)",
        ).bind(
          input.id,
          updated.revision,
          JSON.stringify(previous),
          JSON.stringify(updated),
          input.reason.trim(),
          archivedAt,
        ),
        env.DB.prepare(
          "UPDATE purchase_categories SET archived_at=? WHERE id=? AND archived_at IS NULL",
        ).bind(archivedAt, input.id),
      ]);
    } catch (error) {
      if (/UNIQUE constraint/.test(String(error)))
        throw new HttpError(
          409,
          "Concurrent category change. Reload before archiving.",
        );
      throw error;
    }
    return json({
      id: input.id,
      revision: updated.revision,
      archived_at: archivedAt,
    });
  }
  if (path === "/api/processing/category-assignment" && method === "POST") {
    requireThat(
      !request.headers.has("authorization"),
      403,
      "Category corrections require the owner's interactive session.",
    );
    requireThat(
      !(await activeLock(env)),
      409,
      "Finish the active model claim before correcting a category.",
    );
    const input = await bodyJson(request);
    requireThat(
      typeof input.category_id === "string" && UUID.test(input.category_id),
      400,
      "Choose an existing category.",
    );
    requireThat(
      typeof input.evidence === "string" &&
        input.evidence.trim().length > 0 &&
        input.evidence.length <= 2000,
      400,
      "Explain the category choice using the receipt items.",
    );
    const doc = await storedDocumentById(env, String(input.document_id ?? ""));
    requireThat(
      doc &&
        doc.processing &&
        doc.revision === input.revision &&
        !doc.mergedInto &&
        !doc.duplicateOf,
      409,
      "Reload a retained processed document before correcting its category.",
    );
    const category = await env.DB.prepare(
      "SELECT id,name,description FROM purchase_categories WHERE id=? AND archived_at IS NULL",
    )
      .bind(input.category_id)
      .first<{ id: string; name: string; description: string }>();
    requireThat(category, 400, "Choose an existing category.");
    const note = `Category (owner correction): ${category.name}. ${input.evidence.trim()}`;
    requireThat(
      doc.evidence.length + note.length + 1 <= DOCUMENT_EVIDENCE_LIMIT,
      400,
      "Document notes are full; preserve them before adding another correction.",
    );
    doc.processing.extraction.category_id = category.id;
    doc.evidence = [doc.evidence, note].filter(Boolean).join("\n");
    // Preserve every original model reading and confidence; this is category-only.
    // Existing human approval covers unchanged financial fields, with this explicit owner correction.
    if (doc.processing.has_human_review)
      doc.processing.human_review_revision = doc.revision + 1;
    return save(
      request,
      env,
      load,
      [doc],
      [],
      loadCapture,
      loadSelectedCaptures,
    );
  }
  if (path === "/api/processing/claim" && method === "POST") {
    requireThat(
      request.headers.has("authorization"),
      403,
      "Model processing requires scoped machine credentials.",
    );
    const input = await bodyJson(request, 64 * 1024);
    requireThat(
      input.stage === "small" || input.stage === "large",
      400,
      "Choose small or large processing stage.",
    );
    const excludedDocumentIds = input.exclude_document_ids ?? [];
    requireThat(
      Array.isArray(excludedDocumentIds) &&
        excludedDocumentIds.length <= 1000 &&
        new Set(excludedDocumentIds).size === excludedDocumentIds.length &&
        excludedDocumentIds.every(
          (id: unknown) => typeof id === "string" && UUID.test(id),
        ),
      400,
      "Batch document exclusions must contain unique document IDs.",
    );
    const excluded = new Set<string>(excludedDocumentIds);
    const requestedToken = input.claim_token;
    requireThat(
      requestedToken === undefined ||
        (typeof requestedToken === "string" && UUID.test(requestedToken)),
      400,
      "A claim token must be a UUID.",
    );
    const targeted = input.document_id !== undefined;
    requireThat(
      targeted
        ? input.stage === "large" &&
            typeof input.document_id === "string" &&
            input.document_id.length > 0 &&
            typeof input.revision === "number" &&
            Number.isSafeInteger(input.revision) &&
            input.revision >= 0
        : input.revision === undefined,
      400,
      "A targeted review requires stage large, document_id and its current revision.",
    );
    const requestSha256 = requestedToken
      ? await digest(
          Uint8Array.from(
            new TextEncoder().encode(
              JSON.stringify({
                stage: input.stage,
                document_id: targeted ? input.document_id : null,
                revision: targeted ? input.revision : null,
                review_all: input.review_all === true,
                exclude_document_ids: [...excluded].sort(),
              }),
            ),
          ),
        )
      : null;
    let priorRequest = requestedToken
      ? await env.DB.prepare(
          "SELECT token,request_sha256,stage,document_id,revision,outcome_reason FROM processing_claim_requests WHERE token=?",
        )
          .bind(requestedToken)
          .first<ClaimRequestRecord>()
      : null;
    if (priorRequest)
      requireThat(
        priorRequest.request_sha256 === requestSha256 &&
          priorRequest.stage === input.stage,
        409,
        "A claim token is permanently bound to its original request.",
      );
    const claimResponse = async (lock: Lock) => {
      const selected = await claimDocument(env, lock.document_id, loadCapture);
      const document = selected?.document;
      requireThat(
        document &&
          document.revision === lock.revision &&
          !document.mergedInto &&
          !document.duplicateOf,
        409,
        "Claimed document changed; wait for the lease to expire before retrying.",
      );
      const time = new Map(
        selected!.captures.map((capture) => [capture.id, capture.created_at]),
      );
      return json({
        claim: {
          token: lock.token,
          expires: lock.expires,
          stage: lock.stage,
          document: {
            id: document.id,
            revision: document.revision,
            pages: document.pages,
          },
          scanned_at: document.pages.map((page) => time.get(page.captureId)),
          jev: await jevSummary(env, document),
        },
      });
    };
    if (priorRequest) {
      const existing = await env.DB.prepare(
        "SELECT * FROM processing_lock WHERE token=? AND request_sha256=? AND stage=? AND expires>unixepoch()*1000",
      )
        .bind(requestedToken, requestSha256, input.stage)
        .first<Lock>();
      if (existing && priorRequest.outcome_reason === "pending") {
        await env.DB.prepare(
          "UPDATE processing_claim_requests SET document_id=?,revision=?,outcome_reason='active' WHERE token=? AND request_sha256=? AND outcome_reason='pending'",
        )
          .bind(
            existing.document_id,
            existing.revision,
            requestedToken,
            requestSha256,
          )
          .run();
        priorRequest = {
          ...priorRequest,
          document_id: existing.document_id,
          revision: existing.revision,
          outcome_reason: "active",
        };
      }
      if (priorRequest.document_id === null) {
        requireThat(
          priorRequest.outcome_reason !== "pending",
          409,
          "The original claim request has not reached a durable outcome; do not select replacement work.",
        );
        return json({ claim: null, reason: priorRequest.outcome_reason });
      }
      requireThat(
        existing &&
          existing.document_id === priorRequest.document_id &&
          existing.revision === priorRequest.revision,
        409,
        "The original claim is no longer active; use a new token for new work.",
      );
      return claimResponse(existing);
    }
    if (requestedToken) {
      const began = await env.DB.prepare(
        "INSERT INTO processing_claim_requests(token,request_sha256,stage,document_id,revision,outcome_reason,created_at) VALUES(?,?,?,NULL,NULL,'pending',?) ON CONFLICT(token) DO NOTHING RETURNING token",
      )
        .bind(
          requestedToken,
          requestSha256,
          input.stage,
          new Date().toISOString(),
        )
        .first<{ token: string }>();
      requireThat(
        began,
        409,
        "The claim token is already being resolved; retry only the exact same request.",
      );
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM captures",
    ).first<{ total: number }>();
    const captureCount = count?.total ?? 0;
    let d: ReceiptDocument | null = null;
    let currentPages: Capture[] = [];
    if (targeted) {
      const selected = excluded.has(input.document_id as string)
        ? null
        : await claimDocument(env, input.document_id as string, loadCapture);
      d = selected?.document ?? null;
      currentPages = selected?.captures ?? [];
    } else {
      const openTail = await jevOpenTailDocumentId(env);
      let cursor: ClaimCandidate | null = null;
      for (;;) {
        const rows = await claimCandidateRows(
          env,
          input.stage,
          excluded,
          cursor,
          captureCount,
        );
        if (!rows.length) break;
        for (const row of rows) {
          if (row.id === openTail) continue;
          const selected = await claimDocument(env, row.id, loadCapture);
          if (!selected) continue;
          const candidate = selected.document;
          if (
            candidate.mergedInto ||
            candidate.duplicateOf ||
            !selected.captures.some((capture) => capture.is_current)
          )
            continue;
          const eligible =
            input.stage === "small"
              ? !candidate.processing ||
                candidate.processing.needs_reparse ||
                (processingDisposition(candidate.processing) ===
                  "awaiting-pages" &&
                  captureCount > candidate.processing.seen_capture_count)
              : !!candidate.processing &&
                !candidate.processing.needs_reparse &&
                candidate.processing.large_model_confidence === null &&
                !candidate.processing.has_human_review &&
                (input.review_all === true
                  ? ["extracted", "model-review", "broken"]
                  : ["model-review", "broken"]
                ).includes(processingDisposition(candidate.processing));
          if (eligible && (await jevSummary(env, candidate)).ready) {
            d = candidate;
            currentPages = selected.captures;
            break;
          }
        }
        if (d || rows.length < 25) break;
        cursor = rows.at(-1)!;
      }
    }
    if (targeted) {
      requireThat(d, 404, "Review document not found.");
      requireThat(
        d.revision === input.revision &&
          !d.mergedInto &&
          !d.duplicateOf &&
          currentPages.some((capture) => capture.is_current) &&
          !!d.processing &&
          !d.processing.has_human_review,
        409,
        "Targeted review requires a current, processed, non-human-reviewed document at the expected revision.",
      );
    }
    if (!d) {
      if (requestedToken)
        await env.DB.prepare(
          "UPDATE processing_claim_requests SET outcome_reason='queue-empty' WHERE token=? AND request_sha256=? AND outcome_reason='pending'",
        )
          .bind(requestedToken, requestSha256)
          .run();
      return json({ claim: null, reason: "queue-empty" });
    }
    const token = requestedToken ?? crypto.randomUUID();
    const credential = await processingClient(request);
    const batchId = await processingBatch(request, env);
    // Both selection and acquisition exclude reservations; the SQL predicate is
    // authoritative when another worker wins between these two operations.
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO processing_lock(token,request_sha256,stage,document_id,revision,expires,draft,client_sha256,batch_id)
        SELECT ?,?,?,?,?,unixepoch()*1000+?,NULL,?,?
        WHERE COALESCE((SELECT revision FROM document_heads WHERE id=?),0)=?
        AND (?=1 OR EXISTS(SELECT 1 FROM jev_document_heads WHERE document_id=?))
        AND NOT EXISTS(SELECT 1 FROM jev_pipeline_runs WHERE phase!='complete' AND step_token IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM processing_lock WHERE expires>unixepoch()*1000 AND (client_sha256=? OR client_sha256 IS NULL))
        AND NOT EXISTS(SELECT 1 FROM processing_batch_documents r JOIN processing_batch_lease b ON b.batch_id=r.batch_id WHERE r.document_id=? AND b.expires>unixepoch()*1000)
        ON CONFLICT(document_id) DO UPDATE SET token=excluded.token,request_sha256=excluded.request_sha256,stage=excluded.stage,revision=excluded.revision,expires=excluded.expires,draft=NULL,client_sha256=excluded.client_sha256,batch_id=excluded.batch_id
        WHERE processing_lock.expires<=unixepoch()*1000 RETURNING token,expires`,
      ).bind(
        token,
        requestSha256,
        input.stage,
        d.id,
        d.revision,
        LEASE_MS,
        credential,
        batchId,
        d.id,
        d.revision,
        targeted ? 1 : 0,
        d.id,
        credential,
        d.id,
      ),
      env.DB.prepare(
        `INSERT INTO processing_batch_documents(document_id,batch_id)
        SELECT document_id,batch_id FROM processing_lock WHERE token=? AND batch_id IS NOT NULL
        ON CONFLICT(document_id) DO UPDATE SET batch_id=excluded.batch_id`,
      ).bind(token),
    ]);
    const result = results[0].results[0] as
      { token: string; expires: number } | undefined;
    if (!result) {
      if (requestedToken)
        await env.DB.prepare(
          "UPDATE processing_claim_requests SET outcome_reason='busy-or-changed' WHERE token=? AND request_sha256=? AND outcome_reason='pending'",
        )
          .bind(requestedToken, requestSha256)
          .run();
      return json({ claim: null, reason: "busy-or-changed" });
    }
    const lock = {
      token,
      request_sha256: requestSha256,
      client_sha256: credential,
      batch_id: batchId,
      stage: input.stage,
      document_id: d.id,
      revision: d.revision,
      expires: result.expires,
      draft: null,
    } as Lock;
    if (requestedToken)
      await env.DB.prepare(
        "UPDATE processing_claim_requests SET document_id=?,revision=?,outcome_reason='active' WHERE token=? AND request_sha256=? AND outcome_reason='pending'",
      )
        .bind(d.id, d.revision, requestedToken, requestSha256)
        .run();
    return claimResponse(lock);
  }
  if (path === "/api/processing/batch-lease" && method === "POST") {
    requireThat(
      request.headers.has("authorization"),
      403,
      "Receipt batch coordination requires scoped machine credentials.",
    );
    const input = await bodyJson(request);
    const op = typeof input.op === "string" ? input.op : "";
    requireThat(
      ["acquire", "renew", "release"].includes(op) &&
        typeof input.batch_id === "string" &&
        BATCH_ID.test(input.batch_id) &&
        typeof input.owner === "string" &&
        input.owner.trim().length > 0 &&
        input.owner.length <= 200,
      400,
      "Use a valid receipt batch lease request.",
    );
    if (op === "release") {
      const released = await env.DB.prepare(
        "DELETE FROM processing_batch_lease WHERE batch_id=? AND owner=? RETURNING batch_id",
      )
        .bind(input.batch_id, input.owner)
        .first<{ batch_id: string }>();
      return json({ released: Boolean(released) });
    }
    const now = new Date().toISOString();
    if (op === "renew") {
      const renewed = await env.DB.prepare(
        "UPDATE processing_batch_lease SET expires=unixepoch()*1000+?,updated_at=? WHERE batch_id=? AND owner=? AND expires>unixepoch()*1000 RETURNING expires",
      )
        .bind(BATCH_LEASE_MS, now, input.batch_id, input.owner)
        .first<{ expires: number }>();
      return json(
        renewed
          ? { lease: { batch_id: input.batch_id, expires: renewed.expires } }
          : { lease: null, reason: "expired-or-replaced" },
      );
    }
    let acquired: { expires: number } | null;
    try {
      acquired = await env.DB.prepare(
        `INSERT INTO processing_batch_lease(batch_id,owner,expires,created_at,updated_at,client_sha256)
       SELECT ?,?,unixepoch()*1000+?,?,?,?
       WHERE NOT EXISTS(SELECT 1 FROM jev_pipeline_runs WHERE phase!='complete' AND step_token IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM processing_batch_lease WHERE expires>unixepoch()*1000 AND batch_id!=? AND (client_sha256=? OR client_sha256 IS NULL))
       ON CONFLICT(batch_id) DO UPDATE SET expires=excluded.expires,updated_at=excluded.updated_at
       WHERE processing_batch_lease.owner=excluded.owner AND (processing_batch_lease.client_sha256 IS NULL OR processing_batch_lease.client_sha256=excluded.client_sha256)
       RETURNING expires`,
      )
        .bind(
          input.batch_id,
          input.owner,
          BATCH_LEASE_MS,
          now,
          now,
          await processingClient(request),
          input.batch_id,
          await processingClient(request),
        )
        .first<{ expires: number }>();
    } catch (error) {
      // This statement has no receipt fields or text. Preserve its database
      // error so a failed write can be distinguished from a failed response.
      console.error(
        JSON.stringify({
          event: "processing_batch_lease_acquire",
          batch_id: input.batch_id,
          outcome: "database-error",
          reason:
            error instanceof Error ? error.message : "Unknown database error",
          ray_id: request.headers.get("cf-ray"),
        }),
      );
      throw error;
    }
    const outcome = acquired ? "acquired" : "busy";
    const response = json(
      acquired
        ? { lease: { batch_id: input.batch_id, expires: acquired.expires } }
        : { lease: null, reason: "busy" },
    );
    // Persist the lease outcome and prepared response as a checkpoint. If the
    // client receives a different result, later investigation has this marker.
    let auditPersisted = false;
    try {
      await env.DB.prepare(
        "INSERT INTO processing_batch_lease_events(id,batch_id,outcome,expires,ray_id,created_at) VALUES(?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          input.batch_id,
          outcome,
          acquired?.expires ?? null,
          request.headers.get("cf-ray"),
          now,
        )
        .run();
      auditPersisted = true;
    } catch (error) {
      // Diagnostics must never change the lease result or invite a write retry.
      console.error(
        JSON.stringify({
          event: "processing_batch_lease_audit_failure",
          batch_id: input.batch_id,
          error_type: error instanceof Error ? error.name : typeof error,
          ray_id: request.headers.get("cf-ray"),
        }),
      );
    }
    console.info(
      JSON.stringify({
        event: "processing_batch_lease_acquire",
        batch_id: input.batch_id,
        outcome,
        expires: acquired?.expires ?? null,
        response_status: response.status,
        audit_persisted: auditPersisted,
        ray_id: request.headers.get("cf-ray"),
      }),
    );
    return response;
  }
  if (path === "/api/processing/pdf-review" && method === "POST") {
    requireThat(
      request.headers.has("authorization"),
      403,
      "Use scoped machine credentials for PDF attestation.",
    );
    const input = await bodyJson(request);
    const doc = await storedDocumentById(env, String(input.document_id ?? ""));
    requireThat(
      doc &&
        doc.revision === input.revision &&
        typeof input.sha256 === "string",
      409,
      "Document changed; read and inspect the current PDF.",
    );
    requireThat(
      typeof input.evidence === "string" &&
        input.evidence.trim().length > 0 &&
        input.evidence.length <= 2000,
      400,
      "Record the actual PDF inspection.",
    );
    doc.checks.pdf = true;
    doc.reviewedPdfSha256 = input.sha256;
    doc.evidence = [doc.evidence, input.evidence]
      .filter(Boolean)
      .join("\n")
      .slice(0, 20000);
    return (await documentRoute(
      new Request(new URL("/api/documents", request.url), {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({ documents: [doc] }),
      }),
      env,
      load,
      undefined,
      loadCapture,
      loadSelectedCaptures,
    ))!;
  }
  if (path === "/api/processing/human-review" && method === "POST") {
    requireThat(
      !request.headers.has("authorization"),
      403,
      "Human approval requires the owner's interactive session.",
    );
    const input = await bodyJson(request, 1024 * 1024);
    validateExtraction(input.extraction);
    await categoryCheck(env, input.extraction);
    const doc = await storedDocumentById(env, String(input.document_id ?? ""));
    requireThat(
      doc && doc.revision === input.revision,
      409,
      "Document changed. Reload before approving.",
    );
    const keepPdf =
      doc.vendor === input.extraction.vendor &&
      doc.receiptDate === input.extraction.receipt_date &&
      doc.checks.pdf;
    const checkedHash = doc.reviewedPdfSha256;
    applyExtraction(
      doc,
      input.extraction,
      state(input.extraction, doc.processing, "human", doc.revision),
    );
    if (keepPdf) {
      doc.checks.pdf = true;
      doc.reviewedPdfSha256 = checkedHash;
    }
    const humanRecord = env.DB.prepare(
      "INSERT INTO processing_attempts(token,document_id,revision,stage,model,payload,created_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      doc.id,
      doc.revision + 1,
      "human",
      "human",
      JSON.stringify({
        request: { extraction: input.extraction },
        sources: doc.pages.map((p) => ({
          capture_id: p.captureId,
          sha256: p.sha256,
        })),
      }),
      new Date().toISOString(),
    );
    return save(
      request,
      env,
      load,
      [doc],
      [humanRecord],
      loadCapture,
      loadSelectedCaptures,
    );
  }
  if (path === "/api/processing/detach" && method === "POST") {
    const input = await bodyJson(request);
    const d = await storedDocumentById(env, String(input.document_id ?? ""));
    requireThat(
      d && d.revision === input.revision && d.pages.length > 1,
      409,
      "Reload a document with at least two pages before detaching.",
    );
    const p = d.pages.find((p) => p.captureId === input.capture_id);
    requireThat(
      p &&
        typeof input.reason === "string" &&
        input.reason.trim().length > 0 &&
        input.reason.length <= 2000,
      400,
      "Choose a page and explain the rejected match.",
    );
    // Machine detach is only allowed after the independent Astra parse checkpoint.
    const lock = await activeLock(env, input.token);
    if (request.headers.has("authorization"))
      requireThat(
        lock &&
          input.token === lock.token &&
          lock.document_id === d.id &&
          lock.stage === "large" &&
          lock.draft,
        409,
        "An Astra claim and saved independent parse are required to detach a page.",
      );
    else
      requireThat(
        !lock,
        409,
        "A model is processing a document. Retry when its lease finishes.",
      );
    const detachedCapture = await loadCapture(p.captureId);
    requireThat(detachedCapture, 503, "A source page is unavailable.");
    const separate = newDocument(detachedCapture);
    separate.id = crypto.randomUUID();
    separate.pages = [p];
    const originalAlias = await storedDocumentById(env, p.captureId);
    const detachedAlias =
      originalAlias?.mergedInto === d.id && !originalAlias.pages.length
        ? structuredClone(originalAlias)
        : null;
    if (detachedAlias) {
      detachedAlias.mergedInto = separate.id;
      const reasons = requiredMergeReviewReasons(
        detachedAlias,
        originalAlias ?? undefined,
      );
      separate.uncertainties.push(...reasons.uncertainties);
      separate.broken.push(...reasons.broken);
    }
    d.pages = d.pages.filter((page) => page !== p);
    d.annotations = d.annotations.filter((a) => a.captureId !== p.captureId);
    if (d.processing) {
      d.processing.needs_reparse = true;
      d.processing.has_human_review = false;
      d.processing.human_review_revision = null;
      d.processing.large_model_confidence = null;
    }
    d.checks = {
      visual: false,
      transcription: false,
      grouping: false,
      pdf: false,
    };
    d.reviewedPdfSha256 = null;
    d.invoice = null;
    const statements = [
      env.DB.prepare(
        "INSERT INTO rejected_associations(id,capture_id,document_id,reason,created_at) VALUES(?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        p.captureId,
        d.id,
        input.reason,
        new Date().toISOString(),
      ),
    ];
    if (lock) {
      statements.unshift(leaseGuard(env, lock));
      statements.push(
        env.DB.prepare(
          "UPDATE processing_lock SET expires=0 WHERE token=?",
        ).bind(lock.token),
      );
    }
    return save(
      request,
      env,
      load,
      detachedAlias ? [d, separate, detachedAlias] : [d, separate],
      statements,
      loadCapture,
      loadSelectedCaptures,
      lock ?? undefined,
    );
  }
  requireThat(
    request.headers.has("authorization"),
    403,
    "Model processing requires scoped machine credentials.",
  );
  const input =
    method === "POST"
      ? await bodyJson(request, 512 * 1024)
      : { token: url.searchParams.get("token") };
  requireThat(
    typeof input.token === "string" && UUID.test(input.token),
    400,
    "A claim token is required.",
  );
  if (path === "/api/processing/submit" && method === "POST") {
    const done = await env.DB.prepare(
      "SELECT document_id,revision,payload FROM processing_attempts WHERE token=?",
    )
      .bind(input.token)
      .first<{ document_id: string; revision: number; payload: string }>();
    if (done) {
      const prior = JSON.parse(done.payload);
      requireThat(
        JSON.stringify(prior.request) === JSON.stringify(input),
        409,
        "This claim was already submitted with different data.",
      );
      const saved =
        prior.saved === undefined
          ? [{ id: done.document_id, revision: done.revision }]
          : prior.saved;
      requireThat(
        Array.isArray(saved) &&
          saved.length > 0 &&
          saved.length <= MAX_DOCUMENT_CHANGES &&
          new Set(saved.map((item: any) => item?.id)).size === saved.length &&
          saved.every(
            (item: any) =>
              item &&
              typeof item.id === "string" &&
              UUID.test(item.id) &&
              Number.isSafeInteger(item.revision) &&
              item.revision > 0,
          ) &&
          saved.some(
            (item: any) =>
              item.id === done.document_id && item.revision === done.revision,
          ),
        500,
        "Stored processing acknowledgement is invalid.",
      );
      return json({
        saved,
        replayed: true,
      });
    }
  }
  if (path === "/api/processing/draft" && method === "POST") {
    const previous = await env.DB.prepare(
      "SELECT model,payload FROM processing_drafts WHERE token=?",
    )
      .bind(input.token)
      .first<{ model: string; payload: string }>();
    if (previous) {
      const proposed = validStageModel("small", input.model)
        ? {
            version: 1,
            extraction: input.extraction,
            documents: input.documents,
            pixel_pdf_sha256: input.pixel_pdf_sha256,
            images: input.images,
          }
        : input.extraction;
      requireThat(
        previous.model === input.model &&
          previous.payload === JSON.stringify(proposed),
        409,
        "Initial reading is immutable.",
      );
      return json({ saved: true, replayed: true });
    }
  }
  if (path === "/api/processing/confirmation" && method === "POST") {
    const previous = await env.DB.prepare(
      "SELECT request,payload,sha256 FROM processing_confirmations WHERE token=?",
    )
      .bind(input.token)
      .first<any>();
    if (previous) {
      const saved = JSON.parse(previous.request);
      requireThat(
        Object.keys(input).length === Object.keys(saved).length + 1 &&
          Object.keys(saved).every(
            (k) => JSON.stringify(input[k]) === JSON.stringify(saved[k]),
          ),
        409,
        "Confirmation is immutable.",
      );
      return json({
        saved: true,
        sha256: previous.sha256,
        ...JSON.parse(previous.payload),
        replayed: true,
      });
    }
  }
  const lock = await activeLock(env, input.token);
  requireThat(
    lock && lock.token === input.token,
    409,
    "Claim expired or belongs to another worker. Claim again before saving.",
  );
  if (path === "/api/processing/renew" && method === "POST") {
    const result = await env.DB.prepare(
      "UPDATE processing_lock SET expires=unixepoch()*1000+? WHERE token=? AND expires>unixepoch()*1000 RETURNING expires",
    )
      .bind(LEASE_MS, lock.token)
      .first();
    requireThat(result, 409, "Claim expired.");
    return json(result);
  }
  if (path === "/api/processing/release" && method === "POST") {
    await env.DB.batch([
      env.DB.prepare("UPDATE processing_lock SET expires=0 WHERE token=?").bind(
        lock.token,
      ),
      env.DB.prepare(
        "DELETE FROM processing_batch_documents WHERE document_id=? AND batch_id=?",
      ).bind(lock.document_id, lock.batch_id),
    ]);
    return json({ released: true });
  }
  if (path === "/api/processing/draft" && method === "POST") {
    validateExtraction(input.extraction);
    await categoryCheck(env, input.extraction);
    const frozen =
      lock.stage === "small"
        ? await (async () => {
            const sources = await draftSources(
              env,
              input.documents,
              loadCapture,
            );
            return lunaDraft(
              input,
              lock.document_id,
              lock.revision,
              sources.previous,
              sources.captures,
            );
          })()
        : input.extraction;
    const draft = JSON.stringify(frozen);
    requireThat(
      validStageModel(lock.stage, input.model),
      400,
      "Record the actual managed model name.",
    );
    if (lock.draft !== null) {
      requireThat(
        lock.draft === draft,
        409,
        "The independent parse is immutable.",
      );
      return json({ saved: true });
    }
    try {
      await env.DB.batch([
        documentWriteGuard(
          env,
          lock.stage === "small"
            ? (frozen as LunaDraft).documents.map((d) => d.id)
            : [lock.document_id],
          lock.token,
          lock.batch_id,
        ),
        leaseGuard(env, lock, ":draft"),
        ...reserveBatchDocuments(
          env,
          lock.stage === "small"
            ? (frozen as LunaDraft).documents.map((d) => d.id)
            : [lock.document_id],
          lock.batch_id,
        ),
        env.DB.prepare(
          "INSERT INTO processing_drafts(token,document_id,revision,model,payload,created_at) VALUES(?,?,?,?,?,?)",
        ).bind(
          lock.token,
          lock.document_id,
          lock.revision,
          input.model,
          draft,
          new Date().toISOString(),
        ),
        env.DB.prepare("UPDATE processing_lock SET draft=? WHERE token=?").bind(
          draft,
          lock.token,
        ),
      ]);
    } catch (error) {
      if (/constraint/.test(String(error)))
        throw new HttpError(
          409,
          "The independent parse was already saved or the claim expired.",
        );
      throw error;
    }
    return json({ saved: true });
  }
  if (path === "/api/processing/confirmation" && method === "POST") {
    requireThat(
      lock.stage === "small" && lock.draft !== null,
      409,
      "Save Luna's initial reading before confirmation.",
    );
    const frozen = JSON.parse(lock.draft!) as LunaDraft;
    requireThat(frozen.version === 1, 409, "Unsupported Luna draft.");
    const draftDocument = frozen.documents.find(
      (document) => document.id === lock.document_id,
    );
    requireThat(draftDocument, 409, "Frozen document is unavailable.");
    const draftCaptures = await capturesForPages(
      draftDocument.pages,
      loadCapture,
    );
    const pp =
      input.provider === "ppocr"
        ? await ppConfirmation(
            env,
            input,
            frozen,
            lock.document_id,
            draftCaptures,
          )
        : null;
    const checked = pp?.checked ?? checkQwen(input, frozen, lock.document_id);
    const encoded = JSON.stringify(checked);
    const prior = await env.DB.prepare(
      "SELECT request,payload,sha256 FROM processing_confirmations WHERE token=?",
    )
      .bind(lock.token)
      .first<any>();
    if (prior) {
      requireThat(prior.request === encoded, 409, "Confirmation is immutable.");
      return json({
        saved: true,
        sha256: prior.sha256,
        ...JSON.parse(prior.payload),
      });
    }
    const evidence =
      pp?.payload.evidence ??
      (await confirmationEvidence(
        env,
        frozen,
        lock.document_id,
        input.extraction as Extraction,
        draftCaptures,
      ));
    const payload = JSON.stringify(pp?.payload ?? { qwen: checked, evidence });
    requireThat(
      new TextEncoder().encode(payload).length <= 512 * 1024,
      400,
      "Confirmation exceeds the evidence limit.",
    );
    const hash = await digest(
      new Uint8Array(new TextEncoder().encode(payload)),
    );
    try {
      await env.DB.batch([
        leaseGuard(env, lock, ":confirmation"),
        env.DB.prepare(
          "INSERT INTO processing_confirmations(token,document_id,revision,request,payload,sha256,created_at) VALUES(?,?,?,?,?,?,?)",
        ).bind(
          lock.token,
          lock.document_id,
          lock.revision,
          encoded,
          payload,
          hash,
          new Date().toISOString(),
        ),
      ]);
    } catch (error) {
      if (!/constraint/i.test(String(error))) throw error;
      const replay = await env.DB.prepare(
        "SELECT request,payload,sha256 FROM processing_confirmations WHERE token=?",
      )
        .bind(lock.token)
        .first<any>();
      requireThat(
        replay && replay.request === encoded,
        409,
        "Confirmation changed or the claim expired.",
      );
      return json({
        saved: true,
        sha256: replay.sha256,
        ...JSON.parse(replay.payload),
      });
    }
    return json({ saved: true, sha256: hash, ...JSON.parse(payload) });
  }
  if (path === "/api/processing/context" && method === "GET") {
    requireThat(
      lock.stage === "small" || lock.draft !== null,
      409,
      "Save the independent parse before comparison.",
    );
    const selected = await claimDocument(env, lock.document_id, loadCapture);
    const doc = selected?.document;
    requireThat(
      doc && doc.revision === lock.revision,
      409,
      "Claimed document changed.",
    );
    const orderedPages = selected!.captures
      .filter((capture) => capture.is_current)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    requireThat(
      orderedPages.length > 0,
      409,
      "Claimed pages are no longer current.",
    );
    const after = url.searchParams.get("after_capture");
    const nextCursor = after ? await loadCapture(after) : orderedPages.at(-1)!;
    requireThat(nextCursor?.is_current, 400, "Unknown page cursor.");
    type Neighbor = {
      id: string;
      sha256: string;
      created_at: string;
      document_id: string;
    };
    const [previousImages, nextImages] = await Promise.all([
      env.DB.prepare(
        `SELECT captures.id,captures.sha256,captures.created_at,
          COALESCE(page.document_id,captures.id) AS document_id
         FROM captures LEFT JOIN document_pages page ON page.capture_id=captures.id
         WHERE (${currentTake}) AND (captures.created_at,captures.id)<(?,?)
         ORDER BY captures.created_at DESC,captures.id DESC LIMIT 2`,
      )
        .bind(orderedPages[0].created_at, orderedPages[0].id)
        .all<Neighbor>(),
      env.DB.prepare(
        `SELECT captures.id,captures.sha256,captures.created_at,
          COALESCE(page.document_id,captures.id) AS document_id
         FROM captures LEFT JOIN document_pages page ON page.capture_id=captures.id
         WHERE (${currentTake}) AND (captures.created_at,captures.id)>(?,?)
         ORDER BY captures.created_at,captures.id LIMIT 2`,
      )
        .bind(nextCursor.created_at, nextCursor.id)
        .all<Neighbor>(),
    ]);
    const date = url.searchParams.get("date"),
      total = url.searchParams.get("total_minor"),
      currency = url.searchParams.get("currency");
    const requestedTotal = Number(total);
    const matches =
      date &&
      total !== null &&
      currency &&
      Number.isFinite(requestedTotal) &&
      Number.isFinite(Date.parse(date))
        ? (
            await env.DB.prepare(
              `SELECT v.payload FROM document_heads h
             CROSS JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
             WHERE h.id!=?
               AND json_extract(v.payload,'$.mergedInto') IS NULL
               AND json_extract(v.payload,'$.duplicateOf') IS NULL
               AND json_extract(v.payload,'$.processing.extraction.total_minor') IS NOT NULL
               AND (json_extract(v.payload,'$.processing.extraction.currency') IS NULL
                 OR json_extract(v.payload,'$.processing.extraction.currency')=?)
               AND (json_extract(v.payload,'$.processing.extraction.receipt_date') IS NULL
                 OR ABS(julianday(json_extract(v.payload,'$.processing.extraction.receipt_date'))-julianday(?))<=3)
               AND ((json_extract(v.payload,'$.processing.extraction.receipt_date') IS NOT NULL
                 AND json_extract(v.payload,'$.processing.extraction.currency') IS NOT NULL
                 AND ABS(json_extract(v.payload,'$.processing.extraction.total_minor')-?)<=?)
                 OR ((json_extract(v.payload,'$.processing.extraction.receipt_date') IS NULL
                   OR json_extract(v.payload,'$.processing.extraction.currency') IS NULL)
                   AND json_extract(v.payload,'$.processing.extraction.total_minor')=?))
             ORDER BY h.id LIMIT 51`,
            )
              .bind(
                doc.id,
                currency,
                date,
                requestedTotal,
                Math.max(100, Math.abs(requestedTotal) * 0.02),
                requestedTotal,
              )
              .all<{ payload: string }>()
          ).results.map((row) => JSON.parse(row.payload) as ReceiptDocument)
        : [];
    const relevantIds = [doc.id, ...matches.slice(0, 50).map((d) => d.id)];
    const rejected = (
      await env.DB.prepare(
        `SELECT capture_id,document_id,reason FROM rejected_associations WHERE document_id IN (${relevantIds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 101`,
      )
        .bind(...relevantIds)
        .all()
    ).results;
    return json({
      rejected_associations_truncated: rejected.length > 100,
      document: doc,
      jev: await jevSummary(env, doc),
      ocr_comparison: doc.processing?.ocr_comparison ?? null,
      independent_parse: lock.draft
        ? lock.stage === "small"
          ? JSON.parse(lock.draft).extraction
          : JSON.parse(lock.draft)
        : null,
      previous_images: previousImages.results,
      next_images: nextImages.results,
      candidates: matches.slice(0, 50).map((d) => ({
        id: d.id,
        revision: d.revision,
        pages: d.pages,
        vendor: d.vendor,
        receipt_date: d.receiptDate,
        reference: d.reference,
        type: d.processing!.extraction.type,
        total_minor: d.processing!.extraction.total_minor,
        currency: d.processing!.extraction.currency,
        has_payment_slip: d.processing!.extraction.has_payment_slip,
        payment_status: d.processing!.extraction.payment_status,
        card_last_four: d.processing!.extraction.card_last_four,
      })),
      candidates_truncated: matches.length > 50,
      rejected_associations: rejected.slice(0, 100),
    });
  }
  if (path === "/api/processing/submit" && method === "POST") {
    validateExtraction(input.extraction);
    await categoryCheck(env, input.extraction);
    requireThat(
      validStageModel(lock.stage, input.model),
      400,
      "Record the actual managed model name.",
    );
    requireThat(
      lock.stage === "small" || lock.draft !== null,
      409,
      "Save Astra's independent full parse first.",
    );
    const selected = await claimDocument(env, lock.document_id, loadCapture);
    const previous = selected?.document;
    requireThat(
      previous && previous.revision === lock.revision,
      409,
      "The claimed document changed.",
    );
    let confirmation: any = null;
    if (lock.stage === "small" && lock.draft !== null) {
      const frozen = JSON.parse(lock.draft) as LunaDraft;
      requireThat(
        frozen.version === 1 &&
          JSON.stringify(input.documents) === JSON.stringify(frozen.documents),
        409,
        "Final reassessment must keep the frozen documents and page layout.",
      );
      confirmation = await env.DB.prepare(
        "SELECT payload,sha256 FROM processing_confirmations WHERE token=?",
      )
        .bind(lock.token)
        .first<any>();
      requireThat(
        confirmation,
        409,
        "Save the source-matched PP-OCR evidence checkpoint before reassessment.",
      );
      checkAssessment(input.assessment, confirmation.sha256);
      const finalExtraction = input.extraction;
      const changedFields = Object.keys(frozen.extraction).filter(
        (k) =>
          JSON.stringify(frozen.extraction[k as keyof Extraction]) !==
          JSON.stringify(finalExtraction[k as keyof Extraction]),
      );
      requireThat(
        JSON.stringify([...input.assessment.changed_fields].sort()) ===
          JSON.stringify(changedFields.sort()),
        400,
        "Report every changed extraction field exactly once.",
      );
    } else
      requireThat(
        input.assessment === undefined,
        400,
        "Reassessment requires a saved Luna draft and confirmation.",
      );
    const changed =
      input.documents === undefined
        ? [structuredClone(previous)]
        : (structuredClone(input.documents) as ReceiptDocument[]);
    requireThat(
      Array.isArray(changed) &&
        changed.length > 0 &&
        changed.length <= MAX_SUBMITTED_DOCUMENTS &&
        changed.every(
          (item) => item && typeof item.id === "string" && UUID.test(item.id),
        ),
      400,
      "Submit at most 20 affected documents.",
    );
    const d = changed.find((d) => d?.id === lock.document_id);
    requireThat(
      d && d.revision === lock.revision && !d.mergedInto,
      400,
      "Keep the claimed document as the retained target.",
    );
    // Existing aliases must continue to point directly at the retained record.
    // Normalize them inside this leased atomic save so a whole-document merge
    // cannot create leaf -> absorbed donor -> target relationship chains.
    const absorbedIds = changed
      .filter((item) => item.mergedInto === d.id)
      .map((item) => item.id);
    const [stored, aliases] = await Promise.all([
      storedDocumentsByIds(
        env,
        changed.map((item) => item.id),
      ),
      storedAliasesForTargets(env, absorbedIds),
    ]);
    for (const alias of aliases) stored.set(alias.id, alias);
    retargetAbsorbedAliases(changed, aliases, d.id);
    requireThat(
      changed.length <= MAX_DOCUMENT_CHANGES,
      400,
      "The server cannot safely retarget more than 100 affected documents in one merge; preserve the claim for owner-reviewed repair.",
    );
    const changedIds = changed.map((item) => item.id);
    const rejected = (
      await env.DB.prepare(
        `SELECT capture_id,document_id FROM rejected_associations
         WHERE document_id IN (${changedIds.map(() => "?").join(",")})`,
      )
        .bind(...changedIds)
        .all<{ capture_id: string; document_id: string }>()
    ).results;
    for (const item of changed) {
      requireThat(
        item && typeof item.id === "string",
        400,
        "Invalid changed document.",
      );
      const old =
        stored.get(item.id) ?? (item.id === previous.id ? previous : undefined);
      // Only the target receives fresh model validation. Other affected records are invalidated.
      item.processing = old?.processing
        ? structuredClone(old.processing)
        : undefined;
      if (item.processing) {
        item.processing.needs_reparse = true;
        item.processing.has_human_review = false;
        item.processing.human_review_revision = null;
        item.processing.large_model_confidence = null;
      }
      requireThat(
        Array.isArray(item.pages) &&
          !item.pages.some((p) =>
            rejected.some(
              (r) => r.capture_id === p.captureId && r.document_id === item.id,
            ),
          ),
        409,
        "This page association was rejected; keep it detached for another match.",
      );
    }
    const relevantCaptures = await Promise.all(
      d.pages.map((page) => loadCapture(page.captureId)),
    );
    requireThat(
      relevantCaptures.every((capture) => capture !== null),
      409,
      "A submitted source page is unavailable.",
    );
    const comparison = await compareStoredOcr(env, d, input.extraction, {
      engine: "ppocr",
      strictRegion: true,
      captures: relevantCaptures as Capture[],
    });
    requireThat(
      comparison.status !== "missing",
      409,
      "Exact-layout PP OCR is required; this document is not processing-eligible.",
    );
    const extracted = structuredClone(input.extraction);
    // Retain inherited review notes even when reassessment omits or paraphrases them.
    // The immutable attempt still stores the model's exact submitted reading below.
    for (const donor of changed.filter((item) => item.mergedInto === d.id)) {
      const required = requiredMergeReviewReasons(donor, stored.get(donor.id));
      extracted.uncertainties = [
        ...new Set([...extracted.uncertainties, ...required.uncertainties]),
      ];
      extracted.broken_reasons = [
        ...new Set([...extracted.broken_reasons, ...required.broken]),
      ];
    }
    if (
      (extracted.uncertainties.length > input.extraction.uncertainties.length ||
        extracted.broken_reasons.length >
          input.extraction.broken_reasons.length) &&
      extracted.certainty === "high"
    )
      extracted.certainty = "medium";
    validateExtraction(extracted);
    const conflict = comparison.status === "disagreement";
    if (
      lock.stage === "large" &&
      comparison.status === "disagreement" &&
      typeof input.ocr_resolution === "string" &&
      input.ocr_resolution.trim().length > 0 &&
      input.ocr_resolution.length <= 20000
    )
      comparison.resolution = input.ocr_resolution;
    const jev = await jevSummary(env, d);
    const jevDocument = jev.ready ? jev.document : null;
    const jevDisagreement = Boolean(
      jevDocument &&
      ((jevDocument.role === "purchase_document" &&
        !financialTypes.includes(extracted.type)) ||
        (jevDocument.category_id !== null &&
          extracted.category_id !== jevDocument.category_id)),
    );
    const unresolvedOcrConflict = conflict && !comparison.resolution;
    if (lock.stage === "small" && (jevDisagreement || unresolvedOcrConflict))
      extracted.certainty = "low";
    else if (lock.stage === "large" && comparison.status === "disagreement")
      extracted.certainty = "low";
    applyExtraction(
      d,
      extracted,
      state(extracted, previous.processing, lock.stage, d.revision),
    );
    d.processing!.ocr_comparison = comparison;
    d.processing!.jev_assessment = jevDocument;
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM captures",
    ).first<{ total: number }>();
    d.processing!.seen_capture_count = count?.total ?? 0;
    const saved = changed.map((document) => ({
      id: document.id,
      revision: document.revision + 1,
    }));
    const payload = JSON.stringify({
      request: input,
      saved,
      independent_draft_token: lock.draft ? lock.token : null,
      confirmation_sha256: confirmation?.sha256 ?? null,
      arithmetic: arithmetic(input.extraction),
      sources: d.pages.map((p) => ({
        capture_id: p.captureId,
        sha256: p.sha256,
      })),
    });
    const statements = [
      leaseGuard(env, lock),
      env.DB.prepare(
        "INSERT INTO processing_attempts(token,document_id,revision,stage,model,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      ).bind(
        lock.token,
        d.id,
        d.revision + 1,
        lock.stage,
        input.model,
        payload,
        new Date().toISOString(),
      ),
      env.DB.prepare("UPDATE processing_lock SET expires=0 WHERE token=?").bind(
        lock.token,
      ),
    ];
    return save(
      request,
      env,
      load,
      changed,
      statements,
      loadCapture,
      loadSelectedCaptures,
      lock,
    );
  }
  throw new HttpError(404, "Processing route not found.");
}
function leaseGuard(env: Env, lock: Lock, phase = "") {
  return env.DB.prepare(
    "INSERT INTO processing_commits(token,valid) SELECT ?,EXISTS(SELECT 1 FROM processing_lock WHERE token=? AND document_id=? AND revision=? AND stage=? AND expires>unixepoch()*1000)",
  ).bind(
    lock.token + phase,
    lock.token,
    lock.document_id,
    lock.revision,
    lock.stage,
  );
}
