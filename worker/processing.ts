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
import { jevReadyDocuments, jevSummary } from "./jev";
import {
  documentRoute,
  MAX_DOCUMENT_CHANGES,
  storedDocuments,
} from "./documents";

type Lock = {
  token: string;
  stage: "small" | "large";
  document_id: string;
  revision: number;
  expires: number;
  draft: string | null;
};
const STAGE_MODEL = { small: "gpt-5.6-luna", large: "gpt-6-astra" } as const;
const LEASE_MS = 20 * 60 * 1000;
const BATCH_LEASE_MS = 30 * 60 * 1000;
const BATCH_ID = /^[0-9a-f]{32}$/;
const MAX_SUBMITTED_DOCUMENTS = 20;
async function activeLock(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM processing_lock WHERE id=1 AND expires > unixepoch()*1000",
  ).first<Lock>();
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
  const lock = await activeLock(env);
  if (path === "/api/processing/readings")
    requireThat(
      lock?.stage === "large" && lock.draft !== null,
      409,
      "Reading history requires an active Astra review with a saved independent draft.",
    );
  requireThat(
    !lock || request.method !== "POST",
    409,
    "Use the leased processing submission to change documents while a worker is active.",
  );
  requireThat(
    !lock || lock.stage !== "large" || lock.draft !== null,
    409,
    "Save the independent full parse before reading earlier extraction results.",
  );
}
async function records(env: Env, captures: Capture[]) {
  const stored = await storedDocuments(env);
  const assigned = new Set(
    stored.flatMap((d) => d.pages.map((p) => p.captureId)),
  );
  return [
    ...stored,
    ...captures
      .filter(
        (c) =>
          c.is_current &&
          !assigned.has(c.id) &&
          !stored.some((d) => d.id === c.id),
      )
      .map(newDocument),
  ];
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
) {
  return (await documentRoute(
    new Request(new URL("/api/documents", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents }),
    }),
    env,
    load,
    { statements, trustedProcessing: true },
  ))!;
}
export async function processingRoute(
  request: Request,
  env: Env,
  load: () => Promise<Capture[]>,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (!path.startsWith("/api/processing/")) return null;
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
    const captures = await load(),
      docs = await records(env, captures),
      assigned = docs.filter(
        (doc) =>
          !doc.mergedInto &&
          !doc.duplicateOf &&
          doc.processing?.extraction.category_id === input.id,
      );
    requireThat(
      assigned.length === 0,
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
    const captures = await load(),
      docs = await records(env, captures);
    const doc = docs.find((d) => d.id === input.document_id);
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
    return save(request, env, async () => captures, [doc], []);
  }
  if (path === "/api/processing/claim" && method === "POST") {
    requireThat(
      request.headers.has("authorization"),
      403,
      "Model processing requires scoped machine credentials.",
    );
    const input = await bodyJson(request);
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
    const captures = await load(),
      docs = await records(env, captures);
    const current = new Set(
      captures.filter((c) => c.is_current).map((c) => c.id),
    );
    const jevReady = await jevReadyDocuments(env, docs, captures);
    const time = new Map(captures.map((c) => [c.id, c.created_at]));
    const candidates = docs
      .filter(
        (d) =>
          !excluded.has(d.id) &&
          !d.mergedInto &&
          !d.duplicateOf &&
          d.pages.some((p) => current.has(p.captureId)) &&
          (input.stage === "small"
            ? jevReady.has(d.id) &&
              (!d.processing ||
                d.processing.needs_reparse ||
                (processingDisposition(d.processing) === "awaiting-pages" &&
                  captures.length > d.processing.seen_capture_count))
            : d.processing &&
              jevReady.has(d.id) &&
              !d.processing.needs_reparse &&
              d.processing.large_model_confidence === null &&
              !d.processing.has_human_review &&
              (input.review_all === true
                ? ["extracted", "model-review", "broken"]
                : ["model-review", "broken"]
              ).includes(processingDisposition(d.processing))),
      )
      .sort(
        (a, b) =>
          Number(!!a.processing && !a.processing.needs_reparse) -
            Number(!!b.processing && !b.processing.needs_reparse) ||
          (time.get(a.pages[0].captureId) ?? "").localeCompare(
            time.get(b.pages[0].captureId) ?? "",
          ) ||
          a.id.localeCompare(b.id),
      );
    const d = targeted
      ? docs.find(
          (doc) => doc.id === input.document_id && !excluded.has(doc.id),
        )
      : candidates[0];
    if (targeted) {
      requireThat(d, 404, "Review document not found.");
      requireThat(
        d.revision === input.revision &&
          !d.mergedInto &&
          !d.duplicateOf &&
          d.pages.some((p) => current.has(p.captureId)) &&
          !!d.processing &&
          !d.processing.has_human_review,
        409,
        "Targeted review requires a current, processed, non-human-reviewed document at the expected revision.",
      );
    }
    if (!d) return json({ claim: null, reason: "queue-empty" });
    const token = crypto.randomUUID();
    // Exactly one document lease across both stages. The head predicate rejects stale selection.
    const result = await env.DB.prepare(
      `INSERT INTO processing_lock(id,token,stage,document_id,revision,expires,draft)
      SELECT 1,?,?,?,?,unixepoch()*1000+?,NULL WHERE COALESCE((SELECT revision FROM document_heads WHERE id=?),0)=? AND (?=1 OR EXISTS(SELECT 1 FROM jev_document_heads WHERE document_id=?)) AND NOT EXISTS(SELECT 1 FROM jev_pipeline_runs WHERE phase!='complete' AND step_token IS NOT NULL)
      ON CONFLICT(id) DO UPDATE SET token=excluded.token,stage=excluded.stage,document_id=excluded.document_id,revision=excluded.revision,expires=excluded.expires,draft=NULL WHERE processing_lock.expires<=unixepoch()*1000 RETURNING token,expires`,
    )
      .bind(
        token,
        input.stage,
        d.id,
        d.revision,
        LEASE_MS,
        d.id,
        d.revision,
        targeted ? 1 : 0,
        d.id,
      )
      .first();
    if (!result) return json({ claim: null, reason: "busy-or-changed" });
    return json({
      claim: {
        ...result,
        stage: input.stage,
        document: { id: d.id, revision: d.revision, pages: d.pages },
        scanned_at: d.pages.map((p) => time.get(p.captureId)),
        jev: await jevSummary(env, d),
      },
    });
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
        "DELETE FROM processing_batch_lease WHERE id=1 AND batch_id=? AND owner=? RETURNING batch_id",
      )
        .bind(input.batch_id, input.owner)
        .first<{ batch_id: string }>();
      return json({ released: Boolean(released) });
    }
    const now = new Date().toISOString();
    if (op === "renew") {
      const renewed = await env.DB.prepare(
        "UPDATE processing_batch_lease SET expires=unixepoch()*1000+?,updated_at=? WHERE id=1 AND batch_id=? AND owner=? AND expires>unixepoch()*1000 RETURNING expires",
      )
        .bind(BATCH_LEASE_MS, now, input.batch_id, input.owner)
        .first<{ expires: number }>();
      return json(
        renewed
          ? { lease: { batch_id: input.batch_id, expires: renewed.expires } }
          : { lease: null, reason: "expired-or-replaced" },
      );
    }
    const acquired = await env.DB.prepare(
      `INSERT INTO processing_batch_lease(id,batch_id,owner,expires,created_at,updated_at)
       SELECT 1,?,?,unixepoch()*1000+?,?,? WHERE NOT EXISTS(SELECT 1 FROM jev_pipeline_runs WHERE phase!='complete' AND step_token IS NOT NULL)
       ON CONFLICT(id) DO UPDATE SET batch_id=excluded.batch_id,owner=excluded.owner,expires=excluded.expires,created_at=excluded.created_at,updated_at=excluded.updated_at
       WHERE processing_batch_lease.expires<=unixepoch()*1000 OR (processing_batch_lease.batch_id=excluded.batch_id AND processing_batch_lease.owner=excluded.owner)
       RETURNING expires`,
    )
      .bind(input.batch_id, input.owner, BATCH_LEASE_MS, now, now)
      .first<{ expires: number }>();
    return json(
      acquired
        ? { lease: { batch_id: input.batch_id, expires: acquired.expires } }
        : { lease: null, reason: "busy" },
    );
  }
  if (path === "/api/processing/pdf-review" && method === "POST") {
    requireThat(
      request.headers.has("authorization"),
      403,
      "Use scoped machine credentials for PDF attestation.",
    );
    requireThat(
      !(await activeLock(env)),
      409,
      "Finish the active model claim before confirming a PDF.",
    );
    const input = await bodyJson(request),
      captures = await load(),
      docs = await records(env, captures);
    const doc = docs.find((d) => d.id === input.document_id);
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
        body: JSON.stringify({ documents: [doc] }),
      }),
      env,
      async () => captures,
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
    const captures = await load(),
      docs = await records(env, captures);
    const doc = docs.find((d) => d.id === input.document_id);
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
    return save(request, env, async () => captures, [doc], [humanRecord]);
  }
  if (path === "/api/processing/detach" && method === "POST") {
    const input = await bodyJson(request);
    const captures = await load(),
      docs = await records(env, captures);
    const d = docs.find((d) => d.id === input.document_id);
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
    const lock = await activeLock(env);
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
    const separate = newDocument(captures.find((c) => c.id === p.captureId)!);
    separate.id = crypto.randomUUID();
    separate.pages = [p];
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
    return save(request, env, async () => captures, [d, separate], statements);
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
      const proposed =
        input.model === STAGE_MODEL.small
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
  const lock = await activeLock(env);
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
    await env.DB.prepare("UPDATE processing_lock SET expires=0 WHERE token=?")
      .bind(lock.token)
      .run();
    return json({ released: true });
  }
  if (path === "/api/processing/draft" && method === "POST") {
    validateExtraction(input.extraction);
    await categoryCheck(env, input.extraction);
    const frozen =
      lock.stage === "small"
        ? await (async () => {
            const captures = await load();
            return lunaDraft(
              input,
              lock.document_id,
              lock.revision,
              await records(env, captures),
              captures,
            );
          })()
        : input.extraction;
    const draft = JSON.stringify(frozen);
    requireThat(
      input.model === STAGE_MODEL[lock.stage],
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
        leaseGuard(env, lock, ":draft"),
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
    const pp =
      input.provider === "ppocr"
        ? await ppConfirmation(env, input, frozen, lock.document_id)
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
    const captures = await load(),
      docs = await records(env, captures);
    const doc = docs.find((d) => d.id === lock.document_id);
    requireThat(
      doc && doc.revision === lock.revision,
      409,
      "Claimed document changed.",
    );

    const ordered = captures
      .filter((c) => c.is_current)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
      );
    const after = url.searchParams.get("after_capture");
    const last = after
      ? ordered.findIndex((c) => c.id === after)
      : Math.max(
          ...doc.pages.map((p) =>
            ordered.findIndex((c) => c.id === p.captureId),
          ),
        );
    requireThat(last >= 0, 400, "Unknown page cursor.");
    const first = Math.min(
      ...doc.pages
        .map((p) => ordered.findIndex((c) => c.id === p.captureId))
        .filter((i) => i >= 0),
    );
    const neighbor = (c: (typeof ordered)[number]) => ({
      id: c.id,
      sha256: c.sha256,
      created_at: c.created_at,
      document_id: docs.find((d) => d.pages.some((p) => p.captureId === c.id))
        ?.id,
    });
    const date = url.searchParams.get("date"),
      total = url.searchParams.get("total_minor"),
      currency = url.searchParams.get("currency");
    const matches = docs.filter((d) => {
      const e = d.processing?.extraction;
      if (
        !date ||
        total === null ||
        !currency ||
        !e ||
        e.total_minor === null ||
        (e.currency !== null && e.currency !== currency) ||
        d.mergedInto ||
        d.duplicateOf ||
        d.id === doc.id
      )
        return false;
      // A slip can supply a receipt's hidden date/currency. Keep exact-amount
      // candidates with those missing fields available for visual association.
      const amountDelta = Math.abs(e.total_minor - Number(total));
      return (
        (!e.receipt_date ||
          Math.abs(Date.parse(e.receipt_date) - Date.parse(date)) <=
            3 * 86400000) &&
        (e.receipt_date && e.currency
          ? amountDelta <= Math.max(100, Math.abs(Number(total)) * 0.02)
          : amountDelta === 0)
      );
    });
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
      previous_images: ordered
        .slice(Math.max(0, first - 2), first)
        .reverse()
        .map(neighbor),
      next_images: ordered.slice(last + 1, last + 3).map(neighbor),
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
      input.model === STAGE_MODEL[lock.stage],
      400,
      "Record the actual managed model name.",
    );
    requireThat(
      lock.stage === "small" || lock.draft !== null,
      409,
      "Save Astra's independent full parse first.",
    );
    const captures = await load(),
      docs = await records(env, captures);
    const previous = docs.find((d) => d.id === lock.document_id);
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
        "Save independent OCR/model confirmation before reassessment.",
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
        changed.length <= MAX_SUBMITTED_DOCUMENTS,
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
    retargetAbsorbedAliases(changed, docs, d.id);
    requireThat(
      changed.length <= MAX_DOCUMENT_CHANGES,
      400,
      "The server cannot safely retarget more than 100 affected documents in one merge; preserve the claim for owner-reviewed repair.",
    );
    const rejected = (
      await env.DB.prepare(
        "SELECT capture_id,document_id FROM rejected_associations",
      ).all<{ capture_id: string; document_id: string }>()
    ).results;
    for (const item of changed) {
      requireThat(
        item && typeof item.id === "string",
        400,
        "Invalid changed document.",
      );
      const old = docs.find((d) => d.id === item.id);
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
    const comparison = await compareStoredOcr(env, d, input.extraction, {
      engine: "ppocr",
      strictRegion: true,
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
      const required = requiredMergeReviewReasons(
        donor,
        docs.find((old) => old.id === donor.id),
      );
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
    d.processing!.seen_capture_count = captures.length;
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
    return save(request, env, async () => captures, changed, statements);
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
