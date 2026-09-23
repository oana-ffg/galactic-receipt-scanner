import {
  documentTypes,
  financialTypes,
  processingDisposition,
} from "../web/extraction";
import type { Env } from "./index";
import type { Capture } from "../web/types";
import { currentTake } from "./capture-selection";
import { loadCompletenessAudits } from "./completeness-state";
import {
  DOCUMENT_EVIDENCE_LIMIT,
  documentReasons,
  requiredMergeReviewReasons,
  filenameBase,
  newDocument,
  needsSourceIntervention,
  completenessUncertain,
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
export const MAX_DOCUMENT_CHANGES = 100;
type FileRow = {
  key: string;
  document_id: string;
  revision: number;
  sha256: string;
  filename: string;
  payload: string;
};

function storedDocumentPayload(payload: string): ReceiptDocument {
  const document = JSON.parse(payload) as ReceiptDocument;
  // Older immutable revisions contain a processing crop. It is no longer state.
  for (const page of document.pages) delete (page as { crop?: unknown }).crop;
  return document;
}

export async function storedDocuments(env: Env): Promise<ReceiptDocument[]> {
  const rows = await env.DB.prepare(
    "SELECT v.payload FROM document_heads h CROSS JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision",
  ).all<{ payload: string }>();
  return rows.results.map((row) => storedDocumentPayload(row.payload));
}

export async function storedDocumentById(
  env: Env,
  documentId: string,
): Promise<ReceiptDocument | null> {
  const row = await env.DB.prepare(
    "SELECT v.payload FROM document_heads h JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision WHERE h.id=?",
  )
    .bind(documentId)
    .first<{ payload: string }>();
  return row ? storedDocumentPayload(row.payload) : null;
}
export async function storedDocumentsByIds(
  env: Env,
  ids: string[],
): Promise<Map<string, ReceiptDocument>> {
  const result = new Map<string, ReceiptDocument>();
  for (let offset = 0; offset < ids.length; offset += 99) {
    const chunk = ids.slice(offset, offset + 99);
    const rows = await env.DB.prepare(
      `SELECT h.id,v.payload FROM document_heads h
       JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
       WHERE h.id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ id: string; payload: string }>();
    for (const row of rows.results)
      result.set(row.id, storedDocumentPayload(row.payload));
  }
  return result;
}
export async function storedAliasesForTargets(
  env: Env,
  targetIds: string[],
): Promise<ReceiptDocument[]> {
  if (!targetIds.length) return [];
  const aliases: ReceiptDocument[] = [];
  for (let offset = 0; offset < targetIds.length; offset += 50) {
    const chunk = targetIds.slice(offset, offset + 50);
    const slots = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT v.payload FROM document_heads h
       CROSS JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
       WHERE json_extract(v.payload,'$.mergedInto') IN (${slots})
          OR json_extract(v.payload,'$.duplicateOf') IN (${slots})`,
    )
      .bind(...chunk, ...chunk)
      .all<{ payload: string }>();
    aliases.push(
      ...rows.results.map((row) => storedDocumentPayload(row.payload)),
    );
  }
  return aliases;
}
function samePageSources(left: unknown, right: ReceiptDocument["pages"]) {
  if (!Array.isArray(left)) return false;
  const source = (page: ReceiptDocument["pages"][number]) => ({
    captureId: page.captureId,
    sha256: page.sha256,
    rotation: page.rotation,
    type: page.type ?? null,
  });
  return JSON.stringify(left.map(source)) === JSON.stringify(right.map(source));
}
async function names(env: Env, documents: ReceiptDocument[]) {
  const bases = [
    ...new Set(
      documents.flatMap((document) => {
        const base = filenameBase(document);
        return base ? [base, base.replace(/^(\d{4}-\d{2}-\d{2})_/, "$1-")] : [];
      }),
    ),
  ];
  if (!bases.length) return [];
  if (bases.length > 100)
    return (
      await env.DB.prepare(
        "SELECT filename,document_id FROM document_names",
      ).all<{ filename: string; document_id: string }>()
    ).results;
  const result: { filename: string; document_id: string }[] = [];
  for (let offset = 0; offset < bases.length; offset += 40) {
    const chunk = bases.slice(offset, offset + 40);
    const ranges = chunk.map(() => "(filename>=? AND filename<?)").join(" OR ");
    const rows = await env.DB.prepare(
      `SELECT filename,document_id FROM document_names WHERE ${ranges}`,
    )
      .bind(...chunk.flatMap((base) => [base, `${base}\uffff`]))
      .all<{ filename: string; document_id: string }>();
    result.push(...rows.results);
  }
  return [...new Map(result.map((row) => [row.filename, row])).values()];
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
      [0, 90, 180, 270].includes(page.rotation),
      400,
      "Invalid page rotation.",
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
  loadCapture?: (id: string) => Promise<Capture | null>,
  loadSelectedCaptures?: (ids: string[]) => Promise<Capture[]>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/documents")) return null;
  const single =
    request.method === "GET"
      ? url.pathname.match(/^\/api\/documents\/([0-9a-f-]{36})$/)
      : null;
  const namedAction = url.pathname.match(
    /^\/api\/documents\/([0-9a-f-]{36})\/(pdf|history)$/,
  );
  const sourceId =
    request.method === "GET" && url.pathname === "/api/documents"
      ? url.searchParams.get("captureId")
      : null;
  const summaryLimit =
    request.method === "GET" &&
    url.pathname === "/api/documents" &&
    url.searchParams.get("summary") === "1" &&
    !url.searchParams.get("q")
      ? Number(url.searchParams.get("limit") ?? 50)
      : null;
  const searchQuery =
    request.method === "GET" &&
    url.pathname === "/api/documents" &&
    url.searchParams.get("summary") === "1"
      ? (url.searchParams.get("q") ?? "").toLowerCase()
      : "";
  const scopedPost =
    request.method === "POST" &&
    url.pathname === "/api/documents" &&
    loadSelectedCaptures
      ? await bodyJson(request, 2 * 1024 * 1024)
      : null;
  let captures: Capture[];
  let stored: ReceiptDocument[];
  let summaryPage: { total: number; next: string | null } | null = null;
  if (scopedPost) {
    const changes = scopedPost.documents;
    requireThat(
      Array.isArray(changes) &&
        changes.length > 0 &&
        changes.length <= MAX_DOCUMENT_CHANGES &&
        changes.every(
          (item) => item && typeof item.id === "string" && UUID.test(item.id),
        ),
      400,
      "Save 1 to 100 document changes with valid IDs.",
    );
    const ids = changes.map((item: ReceiptDocument) => item.id);
    const prior = await storedDocumentsByIds(env, ids);
    const targets = changes.flatMap((item: ReceiptDocument) =>
      [item.duplicateOf, item.mergedInto].filter(
        (id): id is string => typeof id === "string" && UUID.test(id),
      ),
    );
    const relations = await storedDocumentsByIds(env, targets);
    const reparented = changes
      .filter(
        (item: ReceiptDocument) =>
          (item.duplicateOf ?? null) !==
            (prior.get(item.id)?.duplicateOf ?? null) ||
          (item.mergedInto ?? null) !==
            (prior.get(item.id)?.mergedInto ?? null),
      )
      .map((item: ReceiptDocument) => item.id);
    const aliases = await storedAliasesForTargets(env, reparented);
    stored = [
      ...new Map([
        ...prior,
        ...relations,
        ...aliases.map((alias) => [alias.id, alias] as const),
      ]).values(),
    ];
    const sourceIds = [
      ...new Set([
        ...stored.flatMap((document) =>
          document.pages.map((page) => page.captureId),
        ),
        ...changes.flatMap((item: ReceiptDocument) =>
          Array.isArray(item.pages)
            ? item.pages
                .map((page) => page?.captureId)
                .filter(
                  (id): id is string => typeof id === "string" && UUID.test(id),
                )
            : [],
        ),
        ...ids,
        ...targets,
      ]),
    ];
    captures = await loadSelectedCaptures!(sourceIds);
  } else if (searchQuery && loadSelectedCaptures) {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    requireThat(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      400,
      "Use 1 to 100 summaries per page.",
    );
    const after = url.searchParams.get("after") ?? "";
    const matches = (await storedDocuments(env))
      .filter(
        (document) =>
          !document.mergedInto &&
          `${document.vendor ?? ""} ${document.receiptDate ?? ""} ${document.reference ?? ""} ${document.text} ${document.uncertainties.join(" ")}`
            .toLowerCase()
            .includes(searchQuery),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const page = matches
      .filter((document) => document.id > after)
      .slice(0, limit + 1);
    stored = page.slice(0, limit);
    const ids = [
      ...new Set(
        stored.flatMap((document) =>
          document.pages.map((item) => item.captureId),
        ),
      ),
    ];
    captures = await loadSelectedCaptures(ids);
    requireThat(
      captures.length === ids.length,
      503,
      "A selected document page is unavailable.",
    );
    summaryPage = {
      total: matches.length,
      next: page.length > limit ? stored.at(-1)!.id : null,
    };
  } else if (summaryLimit !== null && loadSelectedCaptures) {
    requireThat(
      Number.isInteger(summaryLimit) &&
        summaryLimit >= 1 &&
        summaryLimit <= 100,
      400,
      "Use 1 to 100 summaries per page.",
    );
    const after = url.searchParams.get("after") ?? "";
    const [savedRows, virtualRows, savedCount, virtualCount] =
      await Promise.all([
        env.DB.prepare(
          `SELECT h.id,v.payload FROM document_heads h
         JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
         WHERE h.id>? AND json_extract(v.payload,'$.mergedInto') IS NULL
         ORDER BY h.id LIMIT ?`,
        )
          .bind(after, summaryLimit + 1)
          .all<{ id: string; payload: string }>(),
        env.DB.prepare(
          `SELECT captures.id FROM captures
         LEFT JOIN document_pages page ON page.capture_id=captures.id
         LEFT JOIN document_heads saved ON saved.id=captures.id
         WHERE captures.id>? AND page.capture_id IS NULL AND saved.id IS NULL
           AND (${currentTake}) ORDER BY captures.id LIMIT ?`,
        )
          .bind(after, summaryLimit + 1)
          .all<{ id: string }>(),
        env.DB.prepare(
          `SELECT COUNT(*) AS total FROM document_heads h
         JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
         WHERE json_extract(v.payload,'$.mergedInto') IS NULL`,
        ).first<{ total: number }>(),
        env.DB.prepare(
          `SELECT COUNT(*) AS total FROM captures
         LEFT JOIN document_pages page ON page.capture_id=captures.id
         LEFT JOIN document_heads saved ON saved.id=captures.id
         WHERE page.capture_id IS NULL AND saved.id IS NULL AND (${currentTake})`,
        ).first<{ total: number }>(),
      ]);
    const ordered = [
      ...savedRows.results.map((row) => ({ ...row, virtual: false })),
      ...virtualRows.results.map((row) => ({
        id: row.id,
        payload: "",
        virtual: true,
      })),
    ].sort((a, b) => a.id.localeCompare(b.id));
    const page = ordered.slice(0, summaryLimit);
    stored = page
      .filter((row) => !row.virtual)
      .map((row) => storedDocumentPayload(row.payload));
    const ids = [
      ...new Set([
        ...stored.flatMap((document) =>
          document.pages.map((item) => item.captureId),
        ),
        ...page.filter((row) => row.virtual).map((row) => row.id),
      ]),
    ];
    captures = await loadSelectedCaptures(ids);
    requireThat(
      captures.length === ids.length,
      503,
      "A selected document page is unavailable.",
    );
    summaryPage = {
      total: (savedCount?.total ?? 0) + (virtualCount?.total ?? 0),
      next: ordered.length > summaryLimit ? page.at(-1)!.id : null,
    };
  } else if ((single || sourceId || namedAction) && loadCapture) {
    const requestedId = single?.[1] ?? namedAction?.[1] ?? sourceId!;
    const page = sourceId
      ? await env.DB.prepare(
          "SELECT document_id FROM document_pages WHERE capture_id=?",
        )
          .bind(sourceId)
          .first<{ document_id: string }>()
      : null;
    const saved = await storedDocumentById(
      env,
      page?.document_id ?? requestedId,
    );
    if (
      saved &&
      (single ||
        namedAction ||
        saved.pages.some((item) => item.captureId === sourceId))
    ) {
      stored = [saved];
      const selected = await Promise.all(
        saved.pages.map((item) => loadCapture(item.captureId)),
      );
      requireThat(
        selected.every((item) => item !== null),
        503,
        "A saved document page is unavailable.",
      );
      captures = selected as Capture[];
    } else {
      const capture = await loadCapture(requestedId);
      const assignment =
        capture &&
        (await env.DB.prepare(
          "SELECT document_id FROM document_pages WHERE capture_id=?",
        )
          .bind(capture.id)
          .first<{ document_id: string }>());
      requireThat(
        capture?.is_current && !assignment,
        404,
        "Document not found.",
      );
      stored = [];
      captures = [capture];
    }
  } else {
    captures = await loadCaptures();
    stored = await storedDocuments(env);
  }
  const assigned = new Set(
    stored.flatMap((d) => d.pages.map((p) => p.captureId)),
  );
  const storedIds = new Set(stored.map((document) => document.id));
  const capturesById = new Map(
    captures.map((capture) => [capture.id, capture]),
  );
  const docs = [
    ...stored,
    ...captures
      .filter(
        (c) => c.is_current && !assigned.has(c.id) && !storedIds.has(c.id),
      )
      .map(newDocument),
  ];
  let completenessAudits = new Map<
    string,
    NonNullable<DocumentView["completenessAudit"]>
  >();
  let jevRoles = new Map<string, string>();
  const loadReviewState = async (selected: ReceiptDocument[]) => {
    const state = await loadCompletenessAudits(env, selected);
    completenessAudits = state.audits;
    jevRoles = state.roles;
  };
  const nameCandidates = scopedPost
    ? [
        ...docs,
        ...(scopedPost.documents as ReceiptDocument[]).filter(
          (item: unknown): item is ReceiptDocument =>
            !!item &&
            typeof item === "object" &&
            (typeof (item as ReceiptDocument).vendor === "string" ||
              (item as ReceiptDocument).vendor === null) &&
            (typeof (item as ReceiptDocument).receiptDate === "string" ||
              (item as ReceiptDocument).receiptDate === null),
        ),
      ]
    : docs;
  const reserved =
    namedAction?.[2] === "history" ? [] : await names(env, nameCandidates);
  let fileRows: FileRow[] = [];
  let filesLoaded = false;
  const loadFileRows = async (documentIds?: string[]) => {
    if (filesLoaded) return;
    if (documentIds?.length === 0) {
      filesLoaded = true;
      return;
    }
    fileRows = (
      await env.DB.prepare(
        `SELECT f.*,json_object('pages',json_extract(v.payload,'$.pages')) AS payload FROM document_files f JOIN document_versions v ON v.document_id=f.document_id AND v.revision=f.revision ${documentIds ? `WHERE f.document_id IN (${documentIds.map(() => "?").join(",")})` : ""} ORDER BY f.created_at DESC,f.sha256 DESC`,
      )
        .bind(...(documentIds ?? []))
        .all<FileRow>()
    ).results;
    filesLoaded = true;
  };
  function view(d: ReceiptDocument): DocumentView {
    const filename = chooseName(d, reserved);
    const file = fileRows.find(
      (f) =>
        f.document_id === d.id &&
        f.filename === filename &&
        samePageSources(JSON.parse(f.payload).pages, d.pages),
    );
    const state = documentReasons(d);
    const completenessAudit = completenessAudits.get(d.id) ?? null;
    if (needsSourceIntervention({ completenessAudit })) {
      state.reasons.unshift(
        `Needs source intervention: ${completenessAudit!.result === "no" ? completenessAudit!.issue.replaceAll("_", " ") : "Jev could not confirm completeness confidently"}. Inspect the saved scans and page grouping; look for the original paper if a page or printed total is absent.`,
      );
      if (state.status === "ready") state.status = "review";
    } else if (completenessUncertain({ completenessAudit })) {
      state.reasons.unshift(
        completenessAudit?.issue === "evidence_too_long"
          ? "Combined OCR exceeds Jev's assessment limit. Review the saved pages in sections before treating this document as complete."
          : "Completeness could not be established confidently from OCR. Inspect the saved scans before treating this document as complete.",
      );
      if (state.status === "ready") state.status = "review";
    }
    if (!d.checks.visual && !d.mergedInto && !d.duplicateOf) {
      for (const [index, page] of d.pages.entries()) {
        const blur = capturesById.get(page.captureId)?.metadata.quality?.blur;
        if (blur?.category === "uncertain") {
          state.reasons.push(
            `Page ${index + 1}: borderline blur flagged at capture (${blur.score?.toFixed(3)}). Inspect the original text during review.`,
          );
          if (state.status === "ready") state.status = "review";
        }
      }
    }
    if (!d.mergedInto && !d.duplicateOf) {
      for (const [index, page] of d.pages.entries()) {
        const source = capturesById.get(page.captureId);
        if (source?.kept) {
          state.reasons.push(
            `Page ${index + 1}: kept by the owner as best available despite failed quality checks. Original warning: ${source.metadata.quality?.reason ?? "Quality check failed."}`,
          );
          if (state.status === "ready") state.status = "review";
        }
      }
    }
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
      (p) => !capturesById.get(p.captureId)?.is_current,
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
      completenessAudit,
      jevRole: jevRoles.get(d.id) ?? null,
      filename,
      pdf: file ? { sha256: file.sha256, revision: file.revision } : null,
      scannedAt: d.pages.map((p) => capturesById.get(p.captureId)!.created_at),
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
      await loadFileRows([doc.id]);
      await loadReviewState([doc]);
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
        const page = summaryPage
          ? matches
          : matches.filter((d) => d.id > after).slice(0, limit + 1);
        await loadFileRows(page.slice(0, limit).map((document) => document.id));
        await loadReviewState(page.slice(0, limit));
        return json({
          total: summaryPage?.total ?? matches.length,
          next:
            summaryPage?.next ??
            (page.length > limit ? page[limit - 1].id : null),
          documents: page.slice(0, limit).map((d) => {
            const v = view(d);
            return {
              id: v.id,
              revision: v.revision,
              vendor: v.vendor,
              receiptDate: v.receiptDate,
              reference: v.reference,
              kind: v.kind,
              jevRole: v.jevRole,
              completenessAudit: v.completenessAudit,
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
                    luna_needs_human_review:
                      v.processing.luna_needs_human_review ??
                      v.processing.extraction.needs_human_review ??
                      false,
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
      await loadFileRows();
      await loadReviewState(docs);
      return json({ documents: docs.map(view), captures });
    }
  }
  if (url.pathname === "/api/documents" && request.method === "POST") {
    const input = scopedPost ?? (await bodyJson(request, 2 * 1024 * 1024));
    requireThat(
      Array.isArray(input.documents) &&
        input.documents.length > 0 &&
        input.documents.length <= MAX_DOCUMENT_CHANGES,
      400,
      "Save 1 to 100 document changes together.",
    );
    const changes = input.documents;
    changes.forEach((d) => {
      if (Array.isArray(d?.pages))
        for (const page of d.pages)
          if (page && typeof page === "object") delete page.crop;
      try {
        validate(d, captures);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "Incomplete or malformed document.");
      }
    });
    const changed = changes as ReceiptDocument[];
    if (changed.some((document) => document.checks.pdf))
      await loadFileRows(changed.map((document) => document.id));
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
              samePageSources(JSON.parse(f.payload).pages, d.pages),
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
    if (scopedPost) {
      const changedIds = new Set(changed.map((document) => document.id));
      const pageIds = [...explicitPages];
      for (let offset = 0; offset < pageIds.length; offset += 99) {
        const chunk = pageIds.slice(offset, offset + 99);
        const owners = await env.DB.prepare(
          `SELECT capture_id,document_id FROM document_pages
           WHERE capture_id IN (${chunk.map(() => "?").join(",")})`,
        )
          .bind(...chunk)
          .all<{ capture_id: string; document_id: string }>();
        requireThat(
          owners.results.every((owner) => changedIds.has(owner.document_id)),
          409,
          "Page belongs to another document. Transfer it in the same save.",
        );
      }
    }
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
  const match = namedAction;
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
    await loadFileRows([doc.id]);
    await loadReviewState([doc]);
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
