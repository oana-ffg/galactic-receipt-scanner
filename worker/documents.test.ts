import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { newDocument, retargetAbsorbedAliases } from "../web/documents";
import { documentRoute } from "./documents";
import { pageFingerprint } from "./jev-head-identity";
import type { Quality } from "../web/types";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
async function request(
  path: string,
  method = "GET",
  body?: BodyInit,
  headers = {},
) {
  return mf.dispatchFetch(origin + path, {
    method,
    body,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...headers,
    },
  });
}
async function capture(quality: Partial<Quality> = {}, retakeOf?: string) {
  const id = crypto.randomUUID();
  const r = await request(
    `/api/captures/${id}`,
    "POST",
    new Uint8Array([255, 216, 255, Math.floor(Math.random() * 255)]),
    {
      "X-Capture-Status": "accepted",
      ...(retakeOf ? { "X-Retake-Of": retakeOf } : {}),
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1400, 2200],
        quality: { ok: true, receiptPixels: [1400, 2200], ...quality },
      }),
    },
  );
  expect(r.status).toBe(200);
  return r.json();
}
const save = (documents: unknown[]) =>
  request("/api/documents", "POST", JSON.stringify({ documents }));
it("records a human source decision without invalidating the audit and reopens on a new audit", async () => {
  const source = await capture();
  expect((await save([newDocument(source)])).status).toBe(200);
  const db = await mf.getD1Database("DB");
  const current = (
    (await (await request(`/api/documents/${source.id}`)).json()) as any
  ).document;
  const fingerprint = await pageFingerprint(current);
  const pageAssessmentId = crypto.randomUUID();
  const documentAssessmentId = crypto.randomUUID();
  const ocrHash = "b".repeat(64);
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO jev_page_heads(capture_id,source_sha256,ocr_sha256,role,probability,confidence,model,assessment_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      source.id,
      source.sha256,
      ocrHash,
      "receipt",
      1,
      1,
      "synthetic",
      pageAssessmentId,
      now,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO jev_document_heads(document_id,document_revision,page_fingerprint,role,role_probability,role_confidence,model,assessment_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      source.id,
      current.revision,
      fingerprint,
      "purchase_document",
      1,
      1,
      "synthetic",
      documentAssessmentId,
      now,
    )
    .run();
  const assess = async (id: string, at: string) =>
    db
      .prepare(
        "INSERT INTO jev_assessments(id,task,subject_id,subject_revision,model,input_sha256,payload,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        "receipt-completeness-v1",
        source.id,
        current.revision,
        "synthetic",
        id.replaceAll("-", "").padEnd(64, "0"),
        JSON.stringify({
          input: {
            page_fingerprint: fingerprint,
            pins: [{ capture_id: source.id, ocr_sha256: ocrHash }],
          },
          response: {
            answers: {
              completeness: { choice: "no", confidence: 1 },
              issue: { choice: "missing_total" },
            },
          },
        }),
        at,
      )
      .run();
  const firstId = crypto.randomUUID();
  await assess(firstId, "2026-09-27T10:00:00.000Z");
  const read = async () =>
    ((await (await request(`/api/documents/${source.id}`)).json()) as any)
      .document;
  const decide = (assessmentId: string, decision: string) =>
    request(
      `/api/documents/${source.id}/source-review`,
      "POST",
      JSON.stringify({ assessmentId, decision }),
    );
  expect((await read()).sourceInterventionFine).toBe(false);
  expect((await decide(firstId, "fine")).status).toBe(200);
  const accepted = await read();
  expect(accepted.revision).toBe(current.revision);
  expect(accepted.completenessAudit.assessmentId).toBe(firstId);
  expect(accepted.sourceInterventionFine).toBe(true);
  expect(accepted.reasons.join(" ")).not.toContain("Needs source intervention");
  const secondId = crypto.randomUUID();
  await assess(secondId, "2026-09-27T10:00:01.000Z");
  expect((await read()).sourceInterventionFine).toBe(false);
  expect((await decide(firstId, "fine")).status).toBe(409);
  expect((await decide(secondId, "fine")).status).toBe(200);
  expect((await decide(secondId, "needs-review")).status).toBe(200);
  expect((await read()).sourceInterventionFine).toBe(false);
});
it("exposes only page rotation for OCR and discards legacy crop input", async () => {
  const source = await capture();
  const before = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(before.layouts.some((row: any) => row.capture_id === source.id)).toBe(
    false,
  );
  const document = newDocument(source);
  (document.pages[0] as any).crop = [10, 20, 1000, 1800];
  document.pages[0].rotation = 90;
  expect((await save([document])).status).toBe(200);
  const first = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    first.layouts.find((row: any) => row.capture_id === source.id),
  ).toEqual({
    capture_id: source.id,
    source_sha256: source.sha256,
    rotation: 90,
  });
  const saved = (
    (await (await request(`/api/documents/${source.id}`)).json()) as any
  ).document;
  expect(saved.pages[0]).not.toHaveProperty("crop");
  saved.pages[0].crop = [20, 30, 1000, 1800];
  expect((await save([saved])).status).toBe(200);
  const latest = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    latest.layouts.find((row: any) => row.capture_id === source.id),
  ).toEqual({
    capture_id: source.id,
    source_sha256: source.sha256,
    rotation: 90,
  });
  const latestSaved = (await (
    await request(`/api/documents/${source.id}`)
  ).json()) as any;
  expect(latestSaved.document.pages[0]).not.toHaveProperty("crop");
});
it("reads saved page layout even when the page index table is stale", async () => {
  const source = await capture();
  const document = newDocument(source);
  (document.pages[0] as any).crop = [40, 50, 900, 1700];
  expect((await save([document])).status).toBe(200);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE document_pages SET page_index=7 WHERE capture_id=?")
    .bind(source.id)
    .run();
  const layouts = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    layouts.layouts.find((row: any) => row.capture_id === source.id),
  ).toEqual({
    capture_id: source.id,
    source_sha256: source.sha256,
    rotation: 0,
  });
});
it("preserves scan times and sources through non-adjacent grouping, splitting and optimistic revisions", async () => {
  const a = await capture(),
    middle = await capture(),
    b = await capture();
  const one = newDocument(a),
    two = newDocument(b);
  (two.pages[0] as any).crop = [20, 30, 1000, 1800];
  one.vendor = two.vendor = "Synthetic shop";
  one.receiptDate = two.receiptDate = "2026-02-01";
  expect((await save([one, two])).status).toBe(200);
  const first = await (await request("/api/documents")).json();
  const savedA = first.documents.find((d: any) => d.id === a.id),
    savedB = first.documents.find((d: any) => d.id === b.id);
  expect(savedA.filename).toBe("2026-02-01_synthetic_shop.pdf");
  expect(savedB.filename).toBe("2026-02-01_synthetic_shop_2.pdf");
  expect(savedA.scannedAt).toEqual([a.created_at]);
  savedA.pages.push(...savedB.pages);
  savedA.evidence = "Same synthetic invoice number and pages 1/2, 2/2.";
  savedB.pages = [];
  savedB.mergedInto = a.id;
  savedB.evidence = savedA.evidence;
  expect((await save([savedA, savedB])).status).toBe(200);
  expect((await save([savedA, savedB])).status).toBe(409);
  const second = await (await request("/api/documents")).json();
  const grouped = second.documents.find((d: any) => d.id === a.id);
  expect(grouped.pages.map((p: any) => p.captureId)).toEqual([a.id, b.id]);
  expect(
    (await (await request(`/api/documents?captureId=${b.id}`)).json()).document
      .id,
  ).toBe(a.id);
  const donorAlias = (await (await request(`/api/documents/${b.id}`)).json())
    .document;
  expect(donorAlias.pages).toEqual([]);
  expect(donorAlias.mergedInto).toBe(a.id);
  const mergedLayouts = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    mergedLayouts.layouts.filter((row: any) => row.capture_id === b.id),
  ).toEqual([
    {
      capture_id: b.id,
      source_sha256: b.sha256,
      rotation: 0,
    },
  ]);
  expect(second.documents.some((d: any) => d.id === middle.id)).toBe(true);
  expect((await request(`/api/files/${b.id}/raw`)).status).toBe(200);
  const drop = { ...grouped, pages: [grouped.pages[0]] };
  expect((await save([drop])).status).toBe(400);
  const separate = { ...newDocument(b), id: crypto.randomUUID() };
  expect((await save([drop, separate])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${a.id}/history`)).json()).length,
  ).toBe(3);
});
it("reads one document without loading the collection and excludes an unsaved retired take", async () => {
  const source = await capture();
  const db = await mf.getD1Database("DB");
  const response = await documentRoute(
    new Request(`${origin}/api/documents/${source.id}`),
    { DB: db } as any,
    async () => {
      throw Error("full capture collection was loaded");
    },
    undefined,
    async (id) => (id === source.id ? source : null),
  );
  expect(response?.status).toBe(200);
  expect(((await response!.json()) as any).document.id).toBe(source.id);
  const retake = await capture({}, source.id);
  expect((await request(`/api/documents/${source.id}`)).status).toBe(404);
  expect((await request(`/api/documents/${retake.id}`)).status).toBe(200);
});
it("reports individual read timings only when requested", async () => {
  const source = await capture();
  const document = newDocument(source);
  document.vendor = "Synthetic shop";
  document.receiptDate = "2026-02-01";
  expect((await save([document])).status).toBe(200);

  const ordinary = await request(`/api/documents/${source.id}`);
  expect(ordinary.headers.get("Server-Timing")).toBeNull();

  const profiled = await request(`/api/documents/${source.id}?profile=1`);
  expect(profiled.status).toBe(200);
  expect(await profiled.json()).toEqual(await ordinary.json());
  const timing = profiled.headers.get("Server-Timing") ?? "";
  for (const name of [
    "document",
    "capture",
    "filename_reservations",
    "pdf_records",
    "jev_assessments",
    "jev_document_heads",
    "jev_page_heads",
  ]) {
    expect(timing).toMatch(new RegExp(`(?:^|, )${name};dur=\\d+\\.\\d`));
  }
});
it("rejects spoofed sources, missing fields, cyclic duplicates and invalid money", async () => {
  const c = await capture(),
    d = newDocument(c);
  expect((await save([{}])).status).toBe(400);
  expect(
    (await save([{ ...d, pages: [{ ...d.pages[0], sha256: "f".repeat(64) }] }]))
      .status,
  ).toBe(400);
  const another = newDocument(await capture());
  d.duplicateOf = another.id;
  another.duplicateOf = d.id;
  d.evidence = another.evidence = "Synthetic duplicate evidence";
  expect((await save([d, another])).status).toBe(400);
  d.duplicateOf = null;
  expect(
    (
      await save([
        {
          ...d,
          invoice: {
            currency: "DKK",
            lines: [1.5],
            adjustments: [],
            total: 1.5,
            basis: "gross",
            evidence: "Test",
          },
        },
      ])
    ).status,
  ).toBe(400);
});
it("never hides an unassigned current original on its first processing save", async () => {
  const a = newDocument(await capture()),
    b = newDocument(await capture());
  expect(
    (
      await save([
        {
          ...a,
          pages: [],
          mergedInto: b.id,
          evidence: "Attempted virtual merge",
        },
      ])
    ).status,
  ).toBe(400);
  expect((await save([{ ...a, pages: b.pages }])).status).toBe(400);
  const catalog = await (await request("/api/documents")).json();
  expect(
    catalog.documents.some((d: any) =>
      d.pages.some((p: any) => p.captureId === a.id),
    ),
  ).toBe(true);
  expect(
    (
      await save([
        {
          ...a,
          checks: { ...a.checks, pdf: true },
          evidence: "Premature PDF check",
        },
      ])
    ).status,
  ).toBe(400);
  a.duplicateOf = b.id;
  a.broken = ["OCR failed on synthetic source"];
  a.evidence = "Proposed duplicate";
  expect((await save([a])).status).toBe(200);
  const updated = await (await request("/api/documents")).json();
  const duplicate = updated.documents.find((d: any) => d.id === a.id);
  expect(duplicate.status).toBe("duplicate");
  expect(duplicate.reasons).toContain("OCR failed on synthetic source");
});
it("keeps broken totals broken and invalidates output after page changes", async () => {
  const c = await capture(),
    d = newDocument(c);
  d.vendor = "Invoice test";
  d.receiptDate = "2026-02-02";
  d.kind = "invoice";
  d.evidence = "Synthetic invoice";
  d.checks.visual = d.checks.transcription = d.checks.grouping = true;
  d.invoice = {
    currency: "DKK",
    lines: [100, 200],
    adjustments: [],
    total: 301,
    basis: "gross",
    evidence: "Source lines",
  };
  expect((await save([d])).status).toBe(200);
  let catalog = await (await request("/api/documents")).json();
  let current = catalog.documents.find((x: any) => x.id === c.id);
  expect(current.status).toBe("broken");
  const uploaded = await request(
    `/api/documents/${d.id}/pdf?revision=1`,
    "POST",
    "%PDF-1.7\nsynthetic test envelope",
  );
  expect(uploaded.status).toBe(200);
  const pdf = await uploaded.json();
  const pinned = `/api/documents/${d.id}/pdf?revision=1&version=${pdf.sha256}`;
  expect((await request(pinned)).status).toBe(200);
  current.pages[0].rotation = 90;
  expect((await save([current])).status).toBe(200);
  catalog = await (await request("/api/documents")).json();
  current = catalog.documents.find((x: any) => x.id === c.id);
  expect(current.pdf).toBeNull();
  expect((await request(pinned)).status).toBe(200);
  expect(
    (
      await request(
        `/api/documents/${d.id}/pdf?revision=1`,
        "POST",
        "%PDF-stale",
      )
    ).status,
  ).toBe(409);
});
it("allows only one concurrent revision and keeps access owner-only", async () => {
  const d = newDocument(await capture());
  expect((await save([d])).status).toBe(200);
  d.revision = 1;
  const results = await Promise.all([
    save([{ ...d, vendor: "Choice A" }]),
    save([{ ...d, vendor: "Choice B" }]),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await mf.dispatchFetch(origin + "/api/documents")).status).toBe(401);
  expect(
    (
      await request("/api/documents", "GET", undefined, {
        "oai-authenticated-user-email": "other@example.test",
      })
    ).status,
  ).toBe(403);
  expect((await request("/review")).status).toBe(200);
});
it("paginates compact summaries and returns individual sources without all batch text", async () => {
  const a = newDocument(await capture()),
    b = newDocument(await capture());
  a.vendor = "Synthetic Orchard";
  a.text = "unique distant continuation ZX123";
  b.text = "another document";
  expect((await save([a, b])).status).toBe(200);
  const first = await (
    await request("/api/documents?summary=1&limit=1")
  ).json();
  expect(first.documents).toHaveLength(1);
  expect(first.next).toBeTruthy();
  expect(first.documents[0]).not.toHaveProperty("text");
  const second = await (
    await request(`/api/documents?summary=1&limit=1&after=${first.next}`)
  ).json();
  expect(second.documents[0].id).not.toBe(first.documents[0].id);
  const search = await (
    await request("/api/documents?summary=1&q=ZX123")
  ).json();
  expect(search.documents.map((d: any) => d.id)).toEqual([a.id]);
  const detail = await (await request(`/api/documents/${a.id}`)).json();
  expect(detail.document.text).toBe(a.text);
  expect(detail.captures.map((c: any) => c.id)).toEqual([a.id]);
  const lookup = await (
    await request(`/api/documents?captureId=${a.id}`)
  ).json();
  expect(lookup.document.id).toBe(a.id);
});
it("pages default summaries using selected captures only", async () => {
  await capture();
  await capture();
  const selected = async (id: string) =>
    (await (await request(`/api/captures/${id}`)).json()) as any;
  const db = await mf.getD1Database("DB");
  const response = await documentRoute(
    new Request(origin + "/api/documents?summary=1&limit=1"),
    { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
    async () => {
      throw new Error("Full capture collection was loaded");
    },
    undefined,
    selected,
    async (ids) => Promise.all(ids.map(selected)),
  );
  const page = (await response!.json()) as any;
  expect(page.documents).toHaveLength(1);
  expect(page.next).toBeTruthy();
  expect(page.total).toBeGreaterThanOrEqual(2);
});
it("searches and filters reviewer pages on the server without loading the catalog", async () => {
  const a = newDocument(await capture());
  const b = newDocument(await capture());
  const marker = crypto.randomUUID().replaceAll("-", "");
  a.vendor = `Synthetic Orchard ${marker}`;
  b.vendor = "Synthetic Grocer";
  b.broken = ["Synthetic source requires review"];
  expect((await save([a, b])).status).toBe(200);
  const db = await mf.getD1Database("DB");
  const selected = async (id: string) =>
    (await (await request(`/api/captures/${id}`)).json()) as any;
  const route = async (query: string) => {
    const response = await documentRoute(
      new Request(origin + `/api/documents?summary=1&${query}`),
      { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
      async () => {
        throw new Error("Full capture collection was loaded");
      },
      undefined,
      selected,
      async (ids) => Promise.all(ids.map(selected)),
    );
    expect(response?.status).toBe(200);
    return response!.json() as Promise<any>;
  };
  const search = await route(`q=${marker}&limit=1`);
  expect(search.documents.map((item: any) => item.id)).toEqual([a.id]);
  expect(search.next).toBeNull();
  const review = await route(
    "review=1&view=broken&model=all&confidence=all&human=all&limit=1",
  );
  const results = [...review.documents];
  let next = review.next;
  while (next) {
    const page = await route(
      `review=1&view=broken&model=all&confidence=all&human=all&limit=1&after=${next}`,
    );
    results.push(...page.documents);
    next = page.next;
  }
  expect(results.map((item: any) => item.id)).toContain(b.id);
  expect(results.every((item: any) => item.status === "broken")).toBe(true);
  const defaultView = await route(`review=1&limit=1&q=${marker}`);
  expect(defaultView.documents).toEqual([]);
});
it("finds Unicode vendors, displayed filenames, and reviewed documents in All", async () => {
  const source = await capture();
  const document = newDocument(source);
  const marker = crypto.randomUUID().replaceAll("-", "");
  document.vendor = `ØSTER ${marker}`;
  document.receiptDate = "2026-09-27";
  expect((await save([document])).status).toBe(200);
  const saved = (
    (await (await request(`/api/documents/${document.id}`)).json()) as any
  ).document;
  expect(saved.filename).toBeTruthy();
  const unicode = (await (
    await request(
      `/api/documents?summary=1&q=${encodeURIComponent(`øster ${marker}`)}`,
    )
  ).json()) as any;
  expect(unicode.documents.map((item: any) => item.id)).toEqual([document.id]);
  expect(
    (await request(`/api/documents?summary=1&q=${encodeURIComponent("ø")}`))
      .status,
  ).toBe(400);
  const filename = (await (
    await request(
      `/api/documents?summary=1&q=${encodeURIComponent(saved.filename)}`,
    )
  ).json()) as any;
  expect(filename.documents.map((item: any) => item.id)).toEqual([document.id]);
  const db = await mf.getD1Database("DB");
  const extraction = {
    type: "receipt",
    vendor: document.vendor,
    receipt_date: document.receiptDate,
    reference: null,
    currency: null,
    has_handwriting: false,
    has_payment_slip: false,
    payment_status: "unknown",
    card_last_four: null,
    line_items: [],
    adjustments: [],
    total_minor: null,
    charged_total_minor: null,
    payment_adjustments: [],
    vat_minor: null,
    tax_basis: "unknown",
    completeness: "complete",
    category_id: null,
    certainty: "medium",
    uncertainties: [],
    broken_reasons: [],
    confirmed_arithmetic_mismatch: false,
    evidence: "Synthetic review",
  };
  saved.processing = {
    extraction,
    not_invoice: false,
    has_handwriting: false,
    small_model_certainty: "medium",
    large_model_confidence: "medium",
    has_human_review: true,
    human_review_revision: saved.revision,
    needs_reparse: false,
    seen_capture_count: 1,
  };
  await db
    .prepare(
      "UPDATE document_versions SET payload=? WHERE document_id=? AND revision=?",
    )
    .bind(JSON.stringify(saved), document.id, saved.revision)
    .run();
  const reviewed = (await (
    await request(
      `/api/documents?summary=1&review=1&view=all&model=astra&confidence=medium&human=reviewed&q=${marker}`,
    )
  ).json()) as any;
  expect(reviewed.documents.map((item: any) => item.id)).toEqual([document.id]);
});
it("backfills existing documents into trigram search and follows later revisions", async () => {
  const legacy = await runtime({ migrationLimit: 32 });
  try {
    const db = await legacy.getD1Database("DB");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
      )
      .bind(id, 1, JSON.stringify({ vendor: "ØSTER synthetic" }), now)
      .run();
    await db
      .prepare("INSERT INTO document_heads(id,revision) VALUES(?,?)")
      .bind(id, 1)
      .run();
    const migration = await readFile(
      "drizzle/0032_document-review-search.sql",
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.prepare(statement).run();
    const search = async (query: string) =>
      (
        await db
          .prepare(
            "SELECT rowid FROM document_search WHERE document_search MATCH ?",
          )
          .bind(`"${query}"`)
          .all()
      ).results;
    expect(await search("øster")).toHaveLength(1);
    await db
      .prepare(
        "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
      )
      .bind(id, 2, JSON.stringify({ vendor: "REVISED synthetic" }), now)
      .run();
    await db
      .prepare("UPDATE document_heads SET revision=? WHERE id=?")
      .bind(2, id)
      .run();
    expect(await search("øster")).toHaveLength(0);
    expect(await search("revised")).toHaveLength(1);
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT h.id FROM document_heads h
       JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision
       WHERE h.id>? AND (h.rowid IN (SELECT rowid FROM document_search WHERE document_search MATCH ?)
         OR h.id IN (SELECT document_id FROM document_names WHERE instr(lower(filename),?)>0))
       ORDER BY h.id LIMIT ?`,
      )
      .bind("", '"revised"', "revised", 51)
      .all<{ detail: string }>();
    expect(
      plan.results.some((row) => row.detail.includes("VIRTUAL TABLE INDEX")),
    ).toBe(true);
    expect(plan.results.some((row) => row.detail.includes("CORRELATED"))).toBe(
      false,
    );
  } finally {
    await legacy.dispose();
  }
});
it("reserves filenames for a full summary page within the database bind limit", async () => {
  const documents = [];
  for (let index = 0; index < 51; index++) {
    const document = newDocument(await capture());
    document.vendor = `Synthetic Merchant ${index}`;
    document.receiptDate = "2026-09-22";
    documents.push(document);
  }
  expect((await save(documents)).status).toBe(200);
  const response = await request("/api/documents?summary=1&limit=51");
  expect(response.status).toBe(200);
});
it("keeps unresolved reasons on retained documents during agent-driven merges", async () => {
  const a = newDocument(await capture()),
    b = newDocument(await capture());
  a.broken = ["OCR failed on a synthetic source"];
  expect((await save([a, b])).status).toBe(200);
  a.revision = b.revision = 1;
  b.pages.push(...a.pages);
  a.pages = [];
  a.mergedInto = b.id;
  a.evidence = "Synthetic merge";
  expect((await save([a, b])).status).toBe(400);
  b.broken = [...a.broken];
  expect((await save([a, b])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${b.id}`)).json()).document.status,
  ).toBe("broken");
  a.revision = b.revision = 2;
  b.broken = [];
  b.evidence = "Original inspected: the synthetic OCR failure is resolved.";
  expect((await save([b])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${b.id}`)).json()).document.broken,
  ).toEqual([]);
  const history = await (
    await request(`/api/documents/${b.id}/history`)
  ).json();
  expect(history).toHaveLength(3);
  b.revision = 3;
  a.uncertainties = ["New synthetic handwritten amount needs clarification"];
  expect((await save([a])).status).toBe(400);
  b.uncertainties = [...a.uncertainties];
  expect((await save([a, b])).status).toBe(200);
  a.revision = 3;
  b.revision = 4;
  const c = newDocument(await capture());
  a.mergedInto = c.id;
  c.evidence = "Synthetic retargeting";
  expect((await save([a, c])).status).toBe(400);
  c.broken = [...a.broken];
  c.uncertainties = [...a.uncertainties];
  expect((await save([a, c])).status).toBe(200);
});
it("rejects a merge that would leave an incoming alias pointing to another alias", async () => {
  const first = newDocument(await capture());
  const retained = newDocument(await capture());
  const alias = newDocument(await capture());
  alias.duplicateOf = first.id;
  alias.evidence = "Synthetic duplicate scan";
  expect((await save([first, retained, alias])).status).toBe(200);
  first.revision = retained.revision = 1;
  retained.pages.push(...first.pages);
  first.pages = [];
  first.mergedInto = retained.id;
  first.evidence = "Synthetic merge";
  expect((await save([first, retained])).status).toBe(400);
});
it("lists a document's saved aliases so a grouping can retarget them without the catalog", async () => {
  const first = newDocument(await capture());
  const retained = newDocument(await capture());
  const alias = newDocument(await capture());
  alias.duplicateOf = first.id;
  alias.evidence = "Synthetic duplicate scan";
  expect((await save([first, retained, alias])).status).toBe(200);
  const aliases = (await (
    await request(`/api/documents?aliasesOf=${first.id}`)
  ).json()) as { documents: any[] };
  expect(aliases.documents.map((document) => document.id)).toEqual([alias.id]);
  expect(
    (await (await request(`/api/documents?aliasesOf=${retained.id}`)).json())
      .documents,
  ).toEqual([]);
  expect((await request("/api/documents?aliasesOf=invalid")).status).toBe(400);
  first.revision = retained.revision = 1;
  retained.pages.push(...first.pages);
  first.pages = [];
  first.mergedInto = retained.id;
  first.evidence = "Synthetic merge";
  const changes = [first, retained];
  retargetAbsorbedAliases(changes, aliases.documents, retained.id);
  expect((await save(changes)).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${alias.id}`)).json()).document
      .duplicateOf,
  ).toBe(retained.id);
});
it("pins visual approval to a stored PDF hash and requires review after regeneration", async () => {
  const d = newDocument(await capture());
  d.vendor = "Synthetic approved";
  d.receiptDate = "2026-01-01";
  d.kind = "receipt";
  d.handwriting = "absent";
  d.evidence = "Synthetic originals inspected";
  d.checks = { visual: true, transcription: true, grouping: true, pdf: false };
  expect((await save([d])).status).toBe(200);
  const first = await (
    await request(
      `/api/documents/${d.id}/pdf?revision=1`,
      "POST",
      "%PDF-first synthetic output",
    )
  ).json();
  d.revision = 1;
  d.checks.pdf = true;
  d.reviewedPdfSha256 = first.sha256;
  expect((await save([d])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${d.id}`)).json()).document.status,
  ).toBe("ready");
  const incoming = newDocument(await capture());
  expect(
    (
      await save([
        {
          ...d,
          revision: 2,
          pages: [...d.pages, ...incoming.pages],
          checks: { ...d.checks, pdf: false },
        },
      ])
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        `/api/documents/${d.id}/pdf?revision=2`,
        "POST",
        "%PDF-second synthetic output",
      )
    ).status,
  ).toBe(200);
  const changed = await (await request(`/api/documents/${d.id}`)).json();
  expect(changed.document.status).toBe("processing");
  expect(changed.document.reasons.join(" ")).toContain(
    "visually reviewed version",
  );
});

it("preserves a nonblocking blur flag and shows it until visual review", async () => {
  const blur: NonNullable<Quality["blur"]> = {
    version: "crete-1",
    score: 0.35,
    category: "uncertain",
    region: "document-bounds",
    sourceBounds: [0, 0, 1400, 2200],
    pixels: [382, 600],
    filterSize: 11,
    fineBelow: 0.3,
    blurryAbove: 0.38,
  };
  const c = await capture({ blur });
  expect(c.status).toBe("accepted");
  const original = await (await request(`/api/captures/${c.id}`)).json();
  expect(original.metadata.quality.blur).toEqual(blur);
  const listed = await (await request("/api/documents")).json();
  const view = listed.documents.find((d: any) => d.id === c.id);
  expect(view.reasons.join(" ")).toContain(
    "borderline blur flagged at capture (0.350)",
  );
  const d = newDocument(original);
  d.checks.visual = true;
  d.evidence = "Synthetic original visually checked for blur.";
  const saved = await save([d]);
  expect(saved.status, await saved.text()).toBe(200);
  const reviewed = await (await request("/api/documents")).json();
  expect(
    reviewed.documents.find((v: any) => v.id === c.id).reasons.join(" "),
  ).not.toContain("borderline blur");
  expect(
    (await (await request(`/api/captures/${c.id}`)).json()).metadata.quality
      .blur,
  ).toEqual(blur);
});
