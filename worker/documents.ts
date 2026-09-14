import {
  documentTypes,
  financialTypes,
  processingDisposition,
} from "../web/extraction";
import type { Env } from "./index";
import type { Capture } from "../web/types";
import {
  DOCUMENT_EVIDENCE_LIMIT,
  documentReasons,
  requiredMergeReviewReasons,
  filenameBase,
  newDocument,
  validDate,
  type ReceiptDocument,
  type DocumentView,
} from "../web/documents";
import {
  bodyJson,
  bytes,
  digest,
  HttpError,
  json,
  requireThat,
  UUID,
} from "./http";

const HASH = /^[a-f0-9]{64}$/;
type FileRow = {
  key: string;
  document_id: string;
  revision: number;
  sha256: string;
  filename: string;
  payload: string;
};

export async function storedDocuments(env: Env): Promise<ReceiptDocument[]> {
  const rows = await env.DB.prepare(
    "SELECT v.payload FROM document_heads h JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision",
  ).all<{ payload: string }>();
  return rows.results.map((row) => JSON.parse(row.payload));
}
async function names(env: Env) {
  return (
    await env.DB.prepare(
      "SELECT filename,document_id FROM document_names",
    ).all<{ filename: string; document_id: string }>()
  ).results;
}
function chooseName(
  doc: ReceiptDocument,
  reserved: Awaited<ReturnType<typeof names>>,
): string | null {
  const base = filenameBase(doc);
  if (!base) return null;
  // Keep previously reserved filenames stable while new documents use date_vendor.
  const legacyBase = base.replace(/^(\d{4}-\d{2}-\d{2})_/, "$1-");
  const prior = reserved.find(
    (r) =>
      r.document_id === doc.id &&
      (doc.processing ? [base] : [base, legacyBase]).some(
        (b) =>
          r.filename === `${b}.pdf` ||
          (r.filename.startsWith(`${b}_`) &&
            /^\d+\.pdf$/.test(r.filename.slice(b.length + 1))),
      ),
  );
  if (prior) return prior.filename;
  for (let suffix = 1; suffix < 100000; suffix++) {
    const name = `${base}${suffix === 1 ? "" : `_${suffix}`}.pdf`;
    const existing = reserved.find((row) => row.filename === name);
    if (!existing || existing.document_id === doc.id) return name;
  }
  throw new HttpError(409, "Filename allocation exhausted.");
}
function validate(
  input: unknown,
  captures: Capture[],
): asserts input is ReceiptDocument {
  requireThat(input && typeof input === "object", 400, "Expected document.");
  const d = input as ReceiptDocument;
  const str = (v: unknown, max = 20000) =>
    typeof v === "string" && v.length <= max;
  requireThat(
    UUID.test(d.id) && Number.isSafeInteger(d.revision) && d.revision >= 0,
    400,
    "Invalid document identity or revision.",
  );
  requireThat(
    d.vendor === null || (str(d.vendor, 150) && d.vendor.trim().length > 0),
    400,
    "Invalid vendor.",
  );
  requireThat(
    d.receiptDate === null ||
      (typeof d.receiptDate === "string" && validDate(d.receiptDate)),
    400,
    "Use a real YYYY-MM-DD receipt date.",
  );
  requireThat(
    documentTypes.includes(d.kind) &&
      (d.reference === null || str(d.reference, 200)),
    400,
    "Invalid document type or reference.",
  );
  requireThat(
    str(d.text, 250000) &&
      str(d.evidence, DOCUMENT_EVIDENCE_LIMIT) &&
      ["unchecked", "absent", "present", "uncertain"].includes(d.handwriting),
    400,
    "Invalid transcription or evidence.",
  );
  for (const list of [d.uncertainties, d.broken])
    requireThat(
      Array.isArray(list) &&
        list.length <= 100 &&
        list.every((v) => str(v, 2000) && v.trim()),
      400,
      "Provide explicit review/broken reasons.",
    );
  requireThat(
    d.checks &&
      ["visual", "transcription", "grouping", "pdf"].every(
        (k) => typeof d.checks[k as keyof typeof d.checks] === "boolean",
      ),
    400,
    "Invalid checks.",
  );
  requireThat(
    d.reviewedPdfSha256 === null ||
      (typeof d.reviewedPdfSha256 === "string" &&
        HASH.test(d.reviewedPdfSha256)),
    400,
    "Invalid reviewed PDF hash.",
  );
  requireThat(
    Array.isArray(d.pages) &&
      d.pages.length <= 100 &&
      (d.pages.length > 0 || d.mergedInto),
    400,
    "Provide 1 to 100 pages, or a merge destination.",
  );
  const boxValid = (box: unknown, capture: Capture) => {
    const dimensions = capture.metadata.sourcePixels;
    return (
      Array.isArray(box) &&
      box.length === 4 &&
      box.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      box[0] >= 0 &&
      box[1] >= 0 &&
      box[2] > box[0] &&
      box[3] > box[1] &&
      dimensions?.length === 2 &&
      box[2] <= dimensions[0] &&
      box[3] <= dimensions[1]
    );
  };
  for (const page of d.pages) {
    requireThat(
      page.type === undefined || documentTypes.includes(page.type),
      400,
      "Invalid page classification.",
    );
    const source = captures.find((c) => c.id === page.captureId);
    requireThat(
      source && HASH.test(page.sha256) && source.sha256 === page.sha256,
      400,
      "Page must reference an existing original and its exact hash.",
    );
    requireThat(
      [0, 90, 180, 270].includes(page.rotation) &&
        (page.crop === null || boxValid(page.crop, source)),
      400,
      "Invalid page rotation or original-pixel crop.",
    );
  }
  requireThat(
    new Set(d.pages.map((p) => p.captureId)).size === d.pages.length,
    400,
    "Repeated page in document.",
  );
  requireThat(
    Array.isArray(d.annotations) && d.annotations.length <= 100,
    400,
    "Invalid annotations.",
  );
  for (const a of d.annotations) {
    const source = captures.find((c) => c.id === a.captureId);
    requireThat(
      source &&
        d.pages.some((p) => p.captureId === a.captureId) &&
        (a.text === null || str(a.text)) &&
        typeof a.uncertain === "boolean" &&
        boxValid(a.box, source),
      400,
      "Annotation needs a page, original-pixel box, exact text or null and uncertainty.",
    );
  }
  for (const target of [d.duplicateOf, d.mergedInto])
    requireThat(
      target === null ||
        (typeof target === "string" && UUID.test(target) && target !== d.id),
      400,
      "Invalid relationship.",
    );
  requireThat(
    !(d.duplicateOf && d.mergedInto) && (!d.mergedInto || d.pages.length === 0),
    400,
    "Merged documents must transfer all pages.",
  );
  if (Object.values(d.checks).some(Boolean) || d.duplicateOf || d.mergedInto)
    requireThat(
      d.evidence.trim().length > 0,
      400,
      "Record source-backed verification evidence.",
    );
  if (d.invoice !== null) {
    requireThat(
      financialTypes.includes(d.kind),
      400,
      "Invoice components require invoice or credit-note type.",
    );
    const v = d.invoice;
    const money = (n: unknown) =>
      Number.isSafeInteger(n) && Math.abs(n as number) <= 100000000000;
    requireThat(
      v &&
        /^[A-Z]{3}$/.test(v.currency) &&
        Array.isArray(v.lines) &&
        v.lines.length > 0 &&
        v.lines.length <= 1000 &&
        v.lines.every(money) &&
        money(v.total),
      400,
      "Invoice amounts must be signed integer minor units.",
    );
    requireThat(
      Array.isArray(v.adjustments) &&
        v.adjustments.length <= 100 &&
        v.adjustments.every(
          (a) => a && str(a.label, 200) && a.label.trim() && money(a.amount),
        ),
      400,
      "Label every invoice tax, discount, freight and rounding adjustment.",
    );
    requireThat(
      ["net-plus-tax", "gross"].includes(v.basis) &&
        str(v.evidence) &&
        v.evidence.trim(),
      400,
      "Record the invoice arithmetic basis and source evidence.",
    );
  }
}

export async function documentRoute(
  request: Request,
  env: Env,
  loadCaptures: () => Promise<Capture[]>,
  commit?: { statements: D1PreparedStatement[]; trustedProcessing: boolean },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/documents")) return null;
  const captures = await loadCaptures();
  const stored = await storedDocuments(env);
  const assigned = new Set(
    stored.flatMap((d) => d.pages.map((p) => p.captureId)),
  );
  const docs = [
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
  const reserved = await names(env);
  const fileRows = (
    await env.DB.prepare(
      "SELECT f.*,json_object('pages',json_extract(v.payload,'$.pages')) AS payload FROM document_files f JOIN document_versions v ON v.document_id=f.document_id AND v.revision=f.revision ORDER BY f.created_at DESC,f.sha256 DESC",
    ).all<FileRow>()
  ).results;
  function view(d: ReceiptDocument): DocumentView {
    const filename = chooseName(d, reserved);
    const file = fileRows.find(
      (f) =>
        f.document_id === d.id &&
        f.filename === filename &&
        JSON.stringify(JSON.parse(f.payload).pages) === JSON.stringify(d.pages),
    );
    const state = documentReasons(d);
    function requireProcessing(reason: string) {
      state.reasons.push(reason);
      if (state.status === "ready") state.status = "processing";
    }
    if (
      d.checks.pdf &&
      file?.sha256 !== d.reviewedPdfSha256 &&
      !d.mergedInto &&
      !d.duplicateOf
    ) {
      requireProcessing(
        "The current PDF differs from the visually reviewed version. Inspect it again.",
      );
    }
    const stale = d.pages.some(
      (p) => !captures.find((c) => c.id === p.captureId)?.is_current,
    );
    if (stale && !d.mergedInto && !d.duplicateOf) {
      requireProcessing(
        "A newer current take exists. Reconcile page selection and recheck the output.",
      );
    }
    if (!file && !d.mergedInto && !d.duplicateOf) {
      requireProcessing("PDF has not been saved for these pages and filename.");
    }
    return {
      ...d,
      ...state,
      filename,
      pdf: file ? { sha256: file.sha256, revision: file.revision } : null,
      scannedAt: d.pages.map(
        (p) => captures.find((c) => c.id === p.captureId)!.created_at,
      ),
    };
  }
  if (request.method === "GET") {
    const single = url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})$/);
    const sourceId = url.searchParams.get("captureId");
    if (single || (url.pathname === "/api/documents" && sourceId)) {
      const doc = docs.find((d) =>
        single
          ? d.id === single[1]
          : d.pages.some((p) => p.captureId === sourceId),
      );
      requireThat(doc, 404, "Document not found.");
      return json({
        document: view(doc),
        captures: captures.filter((c) =>
          doc.pages.some((p) => p.captureId === c.id),
        ),
      });
    }
    if (url.pathname === "/api/documents") {
      if (url.searchParams.get("summary") === "1") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        requireThat(
          Number.isInteger(limit) && limit >= 1 && limit <= 100,
          400,
          "Use 1 to 100 summaries per page.",
        );
        const query = (url.searchParams.get("q") ?? "").toLowerCase();
        const after = url.searchParams.get("after") ?? "";
        const matches = docs
          .filter(
            (d) =>
              !d.mergedInto &&
              `${d.vendor ?? ""} ${d.receiptDate ?? ""} ${d.reference ?? ""} ${d.text} ${d.uncertainties.join(" ")}`
                .toLowerCase()
                .includes(query),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
        const page = matches.filter((d) => d.id > after).slice(0, limit + 1);
        return json({
          total: matches.length,
          next: page.length > limit ? page[limit - 1].id : null,
          documents: page.slice(0, limit).map((d) => {
            const v = view(d);
            return {
              id: v.id,
              revision: v.revision,
              vendor: v.vendor,
              receiptDate: v.receiptDate,
              reference: v.reference,
              kind: v.kind,
              status: v.status,
              reasons: v.reasons.slice(0, 3),
              pageIds: v.pages.map((p) => p.captureId),
              scannedAt: v.scannedAt,
              handwriting: v.handwriting,
              processing: v.processing
                ? {
                    not_invoice: v.processing.not_invoice,
                    has_handwriting: v.processing.has_handwriting,
                    small_model_certainty: v.processing.small_model_certainty,
                    large_model_confidence: v.processing.large_model_confidence,
                    has_human_review: v.processing.has_human_review,
                    category_id: v.processing.extraction.category_id,
                    total_minor: v.processing.extraction.total_minor,
                    currency: v.processing.extraction.currency,
                    disposition: processingDisposition(v.processing),
                  }
                : null,
              duplicateOf: v.duplicateOf,
              filename: v.filename,
              pdf: v.pdf,
            };
          }),
        });
      }
      return json({ documents: docs.map(view), captures });
    }
  }
  if (url.pathname === "/api/documents" && request.method === "POST") {
    const input = await bodyJson(request, 2 * 1024 * 1024);
    requireThat(
      Array.isArray(input.documents) &&
        input.documents.length > 0 &&
        input.documents.length <= 100,
      400,
      "Save 1 to 100 document changes together.",
    );
    const changes = input.documents;
    changes.forEach((d) => {
      try {
        validate(d, captures);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "Incomplete or malformed document.");
      }
    });
    const changed = changes as ReceiptDocument[];
    for (const d of changed) {
      const previous = stored.find((s) => s.id === d.id);
      if (!commit?.trustedProcessing) {
        // Old clients may omit processing; never let a round-trip forge or erase it.
        if (d.processing !== undefined)
          requireThat(
            JSON.stringify(d.processing) ===
              JSON.stringify(previous?.processing),
            400,
            "Use the processing or human-review endpoint to change extraction fields.",
          );
        if (previous?.processing) {
          d.processing = structuredClone(previous.processing);
          const semantic = (v: ReceiptDocument) =>
            JSON.stringify({
              pages: v.pages,
              vendor: v.vendor,
              receiptDate: v.receiptDate,
              kind: v.kind,
              reference: v.reference,
              text: v.text,
              handwriting: v.handwriting,
              annotations: v.annotations,
              uncertainties: v.uncertainties,
              broken: v.broken,
              invoice: v.invoice,
              duplicateOf: v.duplicateOf,
              mergedInto: v.mergedInto,
            });
          if (semantic(d) !== semantic(previous)) {
            d.processing.needs_reparse = true;
            d.processing.has_human_review = false;
            d.processing.human_review_revision = null;
            d.processing.large_model_confidence = null;
          }
          d.processing.has_human_review = false;
          d.processing.human_review_revision = null;
        } else delete d.processing;
      }
    }
    for (const d of changed) {
      const previous = stored.find((s) => s.id === d.id);
      if (previous && !d.mergedInto) {
        const before = previous.pages.map((p) => p.captureId);
        const after = d.pages.map((p) => p.captureId);
        const membershipChanged =
          [...before].sort().join() !== [...after].sort().join();
        if (membershipChanged)
          requireThat(
            !Object.values(d.checks).some(Boolean) && d.invoice === null,
            400,
            "Save changed page membership with all checks cleared and invoice components null, then inspect and reverify the new document.",
          );
        else if (before.join() !== after.join())
          requireThat(
            !d.checks.grouping && !d.checks.pdf,
            400,
            "Save reordered pages with grouping and PDF checks cleared, then verify their order.",
          );
      }
      if (d.checks.pdf) {
        const filename = chooseName(d, reserved);
        requireThat(
          fileRows.find(
            (f) =>
              f.document_id === d.id &&
              f.filename === filename &&
              JSON.stringify(JSON.parse(f.payload).pages) ===
                JSON.stringify(d.pages),
          )?.sha256 === d.reviewedPdfSha256,
          400,
          "Generate and inspect the PDF for these exact pages and filename before confirming it.",
        );
      }
      requireThat(
        d.handwriting !== "absent" || d.annotations.length === 0,
        400,
        "Handwritten annotations are present; reconcile them before marking handwriting absent.",
      );
    }
    requireThat(
      new Set(changed.map((d) => d.id)).size === changed.length,
      400,
      "Repeated document change.",
    );
    for (const d of changed)
      requireThat(
        (stored.find((s) => s.id === d.id)?.revision ?? 0) === d.revision,
        409,
        "Document changed. Reload before saving.",
      );
    const final = [
      ...docs.filter((d) => !changed.some((c) => c.id === d.id)),
      ...changed,
    ];
    // A virtual singleton vanishes when its page is explicitly assigned elsewhere.
    const explicitPages = new Set(
      changed.flatMap((d) => d.pages.map((p) => p.captureId)),
    );
    const reconciled = final.filter(
      (d) =>
        d.revision > 0 ||
        changed.includes(d) ||
        !d.pages.some((p) => explicitPages.has(p.captureId)),
    );
    const allPages = reconciled.flatMap((d) => d.pages.map((p) => p.captureId));
    requireThat(
      new Set(allPages).size === allPages.length,
      409,
      "Page belongs to another document. Transfer it in the same save.",
    );
    const previousPages = docs.flatMap((d) => d.pages.map((p) => p.captureId));
    requireThat(
      previousPages.every((id) => allPages.includes(id)),
      400,
      "Every previously assigned source must remain accounted for.",
    );
    for (const d of reconciled) {
      const targetId = d.duplicateOf ?? d.mergedInto;
      if (targetId) {
        const target = reconciled.find((t) => t.id === targetId);
        requireThat(
          target &&
            !target.duplicateOf &&
            !target.mergedInto &&
            target.pages.length > 0,
          400,
          "Relationships must point directly to a retained document.",
        );
        if (d.mergedInto) {
          const previous = stored.find((s) => s.id === d.id);
          const required = requiredMergeReviewReasons(d, previous);
          for (const severity of ["broken", "uncertainties"] as const) {
            requireThat(
              required[severity].every((reason) =>
                target[severity].includes(reason),
              ),
              400,
              "Carry every unresolved source reason into the same review category on the merge destination, then reconcile it there.",
            );
          }
        }
      }
    }
    const batch: D1PreparedStatement[] = [...(commit?.statements ?? [])];
    const at = new Date().toISOString();
    for (const d of changed) {
      const saved = { ...d, revision: d.revision + 1 };
      // Unique (document_id,revision) makes concurrent/stale batches fail atomically.
      batch.push(
        env.DB.prepare(
          "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
        ).bind(d.id, saved.revision, JSON.stringify(saved), at),
      );
      batch.push(
        env.DB.prepare(
          "INSERT INTO document_heads(id,revision) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
        ).bind(d.id, saved.revision),
      );
      batch.push(
        env.DB.prepare("DELETE FROM document_pages WHERE document_id=?").bind(
          d.id,
        ),
      );
      const filename = chooseName(d, reserved);
      if (filename && !reserved.some((r) => r.filename === filename)) {
        reserved.push({ filename, document_id: d.id });
        batch.push(
          env.DB.prepare(
            "INSERT INTO document_names(filename,document_id) VALUES(?,?)",
          ).bind(filename, d.id),
        );
      }
    }
    for (const d of changed)
      for (const [index, p] of d.pages.entries())
        batch.push(
          env.DB.prepare(
            "INSERT INTO document_pages(capture_id,document_id,page_index,type) VALUES(?,?,?,?)",
          ).bind(p.captureId, d.id, index, p.type ?? null),
        );
    try {
      await env.DB.batch(batch);
    } catch (error) {
      if (/UNIQUE constraint|CHECK constraint/.test(String(error)))
        throw new HttpError(
          409,
          "Concurrent document or filename change. Reload and retry.",
        );
      throw error;
    }
    return json({
      saved: changed.map((d) => ({ id: d.id, revision: d.revision + 1 })),
    });
  }
  const match = url.pathname.match(
    /^\/api\/documents\/([0-9a-f-]{36})\/(pdf|history)$/,
  );
  requireThat(match, 404, "Document route not found.");
  const [, id, action] = match;
  const doc = stored.find((d) => d.id === id);
  requireThat(doc, 404, "Save the document before generating its PDF.");
  if (action === "history" && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT revision,payload,created_at FROM document_versions WHERE document_id=? ORDER BY revision DESC",
    )
      .bind(id)
      .all();
    return json(rows.results);
  }
  if (action === "pdf" && request.method === "POST") {
    requireThat(
      Number(url.searchParams.get("revision")) === doc.revision,
      409,
      "Document changed. Regenerate from its current pages.",
    );
    const filename = chooseName(doc, reserved);
    requireThat(
      filename && !doc.mergedInto && !doc.duplicateOf,
      400,
      "Identify receipt date and vendor before saving a named PDF.",
    );
    const data = await bytes(request, 32 * 1024 * 1024);
    requireThat(
      new TextDecoder().decode(data.slice(0, 5)) === "%PDF-",
      415,
      "Expected PDF.",
    );
    const sha = await digest(data);
    const key = `documents/${id}/${doc.revision}/${sha}.pdf`;
    const storedFile = await env.BUCKET.put(key, data, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { sha256: sha },
    });
    if (!storedFile)
      requireThat(
        await env.BUCKET.head(key),
        503,
        "PDF storage not confirmed.",
      );
    await env.DB.prepare(
      "INSERT OR IGNORE INTO document_files(key,document_id,revision,sha256,filename,created_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(key, id, doc.revision, sha, filename, new Date().toISOString())
      .run();
    return json({ sha256: sha, filename, revision: doc.revision });
  }
  if (action === "pdf" && request.method === "GET") {
    const hash = url.searchParams.get("version");
    const revision = url.searchParams.get("revision");
    const selected = view(doc).pdf;
    const file = fileRows.find(
      (f) =>
        f.document_id === id &&
        (hash
          ? f.sha256 === hash && String(f.revision) === revision
          : f.sha256 === selected?.sha256 && f.revision === selected.revision),
    );
    requireThat(
      file,
      404,
      "No matching PDF. Regenerate after changing pages or filename.",
    );
    const object = await env.BUCKET.get(file.key);
    requireThat(object, 503, "PDF unavailable; original sources are retained.");
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "X-Content-SHA256": file.sha256,
      },
    });
  }
  throw new HttpError(405, "Method not allowed.");
}
