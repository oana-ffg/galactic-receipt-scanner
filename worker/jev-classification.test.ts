import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import { loadPurchaseCategoryChoices, jevSummary } from "./jev";
import {
  saveCapture,
  seedHistoricalOcr,
  processingTokenHash,
  drainBackfill,
  syntheticJevResponse,
} from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("builds Jev purchase choices from active database categories only", async () => {
  const db = await mf.getD1Database("DB");
  await db.batch([
    db
      .prepare(
        "INSERT INTO purchase_categories(id,normalized_name,name,description,created_at,archived_at) VALUES(?,?,?,?,?,NULL)",
      )
      .bind(
        "active-category",
        "live category",
        "Live category",
        "Definition from the database.",
        "2026-09-19",
      ),
    db
      .prepare(
        "INSERT INTO purchase_categories(id,normalized_name,name,description,created_at,archived_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "archived-category",
        "retired category",
        "Retired category",
        "Must not be offered.",
        "2026-09-19",
        "2026-09-19",
      ),
  ]);
  const choices = await loadPurchaseCategoryChoices({ DB: db } as any);
  expect(choices.criteria).toEqual({
    category_1: "Live category: Definition from the database.",
    unresolved:
      "Use only when the OCR text does not support any listed category.",
  });
  expect(choices.ids.get("category_1")).toBe("active-category");
  expect([...choices.ids.values()]).not.toContain("archived-category");
});

it("classifies blank PP OCR as misc without an external Jev key", async () => {
  const capture = await saveCapture(mf);
  const response = await mf.dispatchFetch(
    `${origin}/api/captures/${capture.id}/artifacts/ocr`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: {
          captureId: capture.id,
          sha256: capture.sha256,
          pixels: [1000, 1600],
          rotation: 0,
          region: { left: 0, top: 0, width: 1000, height: 1600 },
        },
        provenance: { engine: "PP-OCRv6" },
        text: "   ",
      }),
    },
  );
  const saved = await response.json<any>();
  expect(response.status, JSON.stringify(saved)).toBe(200);
  expect(saved.jev).toEqual({ status: "classified" });
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare("SELECT role,model FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first(),
  ).toMatchObject({ role: "misc", model: "rule:blank-ocr" });
  expect(
    await db
      .prepare("SELECT role FROM jev_document_heads WHERE document_id=?")
      .bind(capture.id)
      .first(),
  ).toBeNull();
});

it("rejects a document head whose saved assessment is not pinned to the current PP OCR", async () => {
  const processingToken = `rsc_${"h".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const capture = await saveCapture(mf);
  const response = await mf.dispatchFetch(
    `${origin}/api/captures/${capture.id}/artifacts/ocr`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: {
          captureId: capture.id,
          sha256: capture.sha256,
          pixels: [1000, 1600],
          rotation: 0,
          region: { left: 0, top: 0, width: 1000, height: 1600 },
        },
        provenance: { engine: "PP-OCRv6" },
        text: "",
      }),
    },
  );
  expect(response.status).toBe(200);
  await drainBackfill(mf, processingToken);
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("BUCKET");
  const stored = await mf.dispatchFetch(
    `${origin}/api/documents/${capture.id}`,
    {
      headers: ownerHeaders,
    },
  );
  const document = (await stored.json<any>()).document;
  expect(
    await jevSummary({ DB: db, BUCKET: bucket } as any, document),
  ).toMatchObject({ ready: true });
  const assessment = await db
    .prepare(
      "SELECT a.id,a.payload FROM jev_document_heads h JOIN jev_assessments a ON a.id=h.assessment_id WHERE h.document_id=?",
    )
    .bind(document.id)
    .first<{ id: string; payload: string }>();
  const payload = JSON.parse(assessment!.payload);
  payload.input.pins[0].ocr_sha256 = "f".repeat(64);
  await db
    .prepare("UPDATE jev_assessments SET payload=? WHERE id=?")
    .bind(JSON.stringify(payload), assessment!.id)
    .run();
  expect(
    await jevSummary({ DB: db, BUCKET: bucket } as any, document),
  ).toMatchObject({ ready: false });
});

it("keeps a nonblank PP upload successful and Jev retryable when unconfigured", async () => {
  const capture = await saveCapture(mf);
  const response = await mf.dispatchFetch(
    `${origin}/api/captures/${capture.id}/artifacts/ocr`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: {
          captureId: capture.id,
          sha256: capture.sha256,
          pixels: [1000, 1600],
          rotation: 0,
          region: { left: 0, top: 0, width: 1000, height: 1600 },
        },
        provenance: { engine: "PP-OCRv6" },
        text: "Synthetic shop\nTOTAL 12,34",
      }),
    },
  );
  const saved = await response.json<any>();
  expect(response.status, JSON.stringify(saved)).toBe(200);
  expect(saved.jev).toEqual({ status: "failed" });
  const db = await mf.getD1Database("DB");
  expect(await db.prepare("SELECT status FROM jev_jobs").first()).toMatchObject(
    { status: "failed" },
  );
});

it("completes each page job without starving a multi-page document and binds the final head to both PP pins", async () => {
  const processingToken = `rsc_${"m".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  const db = await mf.getD1Database("DB");
  for (const capture of captures) {
    capture.created_at = new Date().toISOString();
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(capture.created_at, capture.id)
      .run();
  }
  const document = newDocument(captures[0]);
  document.pages = captures.map((capture) => newDocument(capture).pages[0]);
  const grouped = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [document] }),
  });
  expect(grouped.status, await grouped.text()).toBe(200);
  for (const capture of captures) {
    const response = await mf.dispatchFetch(
      `${origin}/api/captures/${capture.id}/artifacts/ocr`,
      {
        method: "POST",
        headers: {
          ...ownerHeaders,
          Origin: origin,
          "X-Scanner-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: {
            captureId: capture.id,
            sha256: capture.sha256,
            pixels: [1000, 1600],
            rotation: 0,
            region: { left: 0, top: 0, width: 1000, height: 1600 },
          },
          provenance: { engine: "PP-OCRv6" },
          text: "Synthetic shop\nSynthetic item 12,34\nTOTAL 12,34",
        }),
      },
    );
    const saved = await response.json<any>();
    expect(response.status, JSON.stringify(saved)).toBe(200);
    expect(saved.jev.status).toBe("classified");
  }
  await drainBackfill(mf, processingToken);
  const settledStatuses = async () =>
    (
      await db
        .prepare(
          "SELECT status,COUNT(*) AS count FROM jev_jobs GROUP BY status",
        )
        .all()
    ).results;
  expect(await settledStatuses()).toEqual([{ status: "deferred", count: 2 }]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-classification'",
      )
      .first(),
  ).toEqual({ count: 0 });
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(new Date(Date.now() - 32 * 60_000).toISOString(), captures[0].id)
    .run();
  await drainBackfill(mf, processingToken);
  expect(await settledStatuses()).toEqual([{ status: "deferred", count: 2 }]);
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(new Date(Date.now() - 31 * 60_000).toISOString(), captures[1].id)
    .run();
  await drainBackfill(mf, processingToken);
  expect(await settledStatuses()).toEqual([{ status: "complete", count: 2 }]);
  const stored = await mf.dispatchFetch(
    `${origin}/api/documents/${document.id}`,
    {
      headers: ownerHeaders,
    },
  );
  const current = (await stored.json<any>()).document;
  const summary = await jevSummary(
    {
      DB: db,
      BUCKET: await mf.getR2Bucket("BUCKET"),
    } as any,
    current,
  );
  expect(summary.ready).toBe(true);
  expect(summary.document?.role).toBe("purchase_document");
  expect(summary.document?.assessment_id).toBe(
    summary.document?.category_assessment_id,
  );
  expect(
    (
      await db
        .prepare(
          "SELECT task,COUNT(*) AS count FROM jev_assessments WHERE task LIKE 'document-%' OR task='purchase-category' GROUP BY task",
        )
        .all()
    ).results,
  ).toEqual([{ task: "document-classification", count: 1 }]);
  expect(summary.pages.map((page) => page.capture_id)).toEqual(
    captures.map((capture) => capture.id),
  );
  const assess = () =>
    mf.dispatchFetch(`${origin}/api/jev/completeness`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
        Authorization: `Bearer ${processingToken}`,
      },
      body: JSON.stringify({ document_id: document.id }),
    });
  const firstAssessment = await assess();
  expect(firstAssessment.status, await firstAssessment.clone().text()).toBe(
    200,
  );
  expect(await firstAssessment.json<any>()).toMatchObject({
    result: "yes",
    issue: "none",
    assessed: true,
  });
  const repeatedAssessment = await assess();
  expect(repeatedAssessment.status).toBe(200);
  expect(await repeatedAssessment.json<any>()).toMatchObject({ result: "yes" });
  const auditedDocument = await mf.dispatchFetch(
    `${origin}/api/documents/${document.id}`,
    { headers: ownerHeaders },
  );
  expect(
    (await auditedDocument.json<any>()).document.completenessAudit,
  ).toMatchObject({
    result: "yes",
    issue: "none",
  });
  const refresh = () =>
    mf.dispatchFetch(`${origin}/api/jev/documents/${document.id}/refresh`, {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        Authorization: `Bearer ${processingToken}`,
      },
    });
  await db
    .prepare(
      "UPDATE jev_document_heads SET page_fingerprint=? WHERE document_id=?",
    )
    .bind("f".repeat(64), document.id)
    .run();
  await db
    .prepare("UPDATE jev_jobs SET status='classified' WHERE capture_id=?")
    .bind(captures[0].id)
    .run();
  await db
    .prepare("UPDATE jev_jobs SET status='waiting' WHERE capture_id=?")
    .bind(captures[1].id)
    .run();
  await db
    .prepare(
      "INSERT INTO processing_lock(id,token,stage,document_id,revision,expires) VALUES(1,'synthetic','review',?,?,?)",
    )
    .bind(document.id, document.revision, Date.now() + 60_000)
    .run();
  expect((await refresh()).status).toBe(409);
  await db.prepare("DELETE FROM processing_lock WHERE id=1").run();
  const jobStatuses = async () =>
    (
      await db
        .prepare(
          "SELECT status FROM jev_jobs WHERE capture_id IN (?,?) ORDER BY capture_id",
        )
        .bind(captures[0].id, captures[1].id)
        .all<{ status: string }>()
    ).results.map((row) => row.status);
  const statusesBeforeRefresh = await jobStatuses();
  expect([...statusesBeforeRefresh].sort()).toEqual(["classified", "waiting"]);
  const refreshed = await refresh();
  expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  expect(await refreshed.json<any>()).toMatchObject({ status: "classified" });
  expect(await jobStatuses()).toEqual(statusesBeforeRefresh);
  await db
    .prepare("DELETE FROM jev_document_heads WHERE document_id=?")
    .bind(document.id)
    .run();
  const recreated = await refresh();
  expect(recreated.status, await recreated.clone().text()).toBe(200);
  expect(await recreated.json<any>()).toMatchObject({ status: "classified" });
  expect(await jobStatuses()).toEqual(statusesBeforeRefresh);
  const repeatedRefresh = await refresh();
  expect(repeatedRefresh.status).toBe(200);
  expect(await repeatedRefresh.json<any>()).toMatchObject({
    status: "verified",
  });
  const restoredDocument = await mf.dispatchFetch(
    `${origin}/api/documents/${document.id}`,
    { headers: ownerHeaders },
  );
  expect((await restoredDocument.json<any>()).document).toMatchObject({
    jevRole: "purchase_document",
    completenessAudit: { result: "yes" },
  });
  await db
    .prepare("UPDATE jev_jobs SET status='complete' WHERE capture_id IN (?,?)")
    .bind(captures[0].id, captures[1].id)
    .run();
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,created_at,updated_at) VALUES(?,3,'pages',?,?,?,?)",
    )
    .bind(crypto.randomUUID(), captures[1].created_at, captures[1].id, now, now)
    .run();
  expect(
    (
      await jevSummary(
        { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
        current,
      )
    ).ready,
  ).toBe(true);
});

it("defers an unsaved singleton until its scan has settled", async () => {
  const processingToken = `rsc_${"s".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(new Date().toISOString(), capture.id)
    .run();
  await seedHistoricalOcr(
    mf,
    capture,
    "Synthetic shop\nSynthetic item 12,34\nTOTAL 12,34",
    new Date().toISOString(),
  );
  const held = await drainBackfill(mf, processingToken);
  expect(held.result).toMatchObject({
    remaining: 0,
    waiting: true,
    settling_jobs: 1,
  });
  expect(await db.prepare("SELECT status FROM jev_jobs").first()).toEqual({
    status: "deferred",
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM document_pages").first(),
  ).toEqual({ count: 0 });
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(new Date(Date.now() - 31 * 60_000).toISOString(), capture.id)
    .run();
  const finished = await drainBackfill(mf, processingToken);
  expect(finished.result).toMatchObject({
    remaining: 0,
    waiting: false,
    settling_jobs: 0,
  });
  expect(await db.prepare("SELECT status FROM jev_jobs").first()).toEqual({
    status: "complete",
  });
});

it("does not publish a targeted Jev classification after a concurrent document edit", async () => {
  const processingToken = `rsc_${"z".repeat(43)}`;
  let holdClassification = false;
  let markClassificationStarted!: () => void;
  const classificationStarted = new Promise<void>((resolve) => {
    markClassificationStarted = resolve;
  });
  let releaseClassification!: () => void;
  const classificationReleased = new Promise<void>((resolve) => {
    releaseClassification = resolve;
  });
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (holdClassification && body.questions.document_role) {
        holdClassification = false;
        markClassificationStarted();
        await classificationReleased;
      }
      return syntheticJevResponse(request);
    },
  });
  const capture = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  const createdAt = "2026-01-01T00:00:00.000Z";
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind(createdAt, capture.id)
    .run();
  const document = newDocument(capture);
  const grouped = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [document] }),
  });
  expect(grouped.status, await grouped.clone().text()).toBe(200);
  await seedHistoricalOcr(mf, capture, "SYNTHETIC SHOP TOTAL 12.34", createdAt);
  await drainBackfill(mf, processingToken);
  await db
    .prepare("DELETE FROM jev_document_heads WHERE document_id=?")
    .bind(document.id)
    .run();
  await db
    .prepare(
      "DELETE FROM jev_assessments WHERE task='document-classification' AND subject_id=?",
    )
    .bind(document.id)
    .run();
  holdClassification = true;
  const pending = mf.dispatchFetch(
    `${origin}/api/jev/documents/${document.id}/refresh`,
    {
      method: "POST",
      headers: {
        ...ownerHeaders,
        Origin: origin,
        "X-Scanner-Request": "1",
        Authorization: `Bearer ${processingToken}`,
      },
    },
  );
  await classificationStarted;
  const saved = await db
    .prepare(
      "SELECT v.revision,v.payload FROM document_heads h JOIN document_versions v ON v.document_id=h.id AND v.revision=h.revision WHERE h.id=?",
    )
    .bind(document.id)
    .first<{ revision: number; payload: string }>();
  expect(saved).toBeTruthy();
  const changed = JSON.parse(saved!.payload);
  changed.revision = saved!.revision + 1;
  changed.vendor = "Synthetic corrected vendor";
  await db
    .prepare(
      "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
    )
    .bind(document.id, changed.revision, JSON.stringify(changed), createdAt)
    .run();
  await db
    .prepare("UPDATE document_heads SET revision=? WHERE id=?")
    .bind(changed.revision, document.id)
    .run();
  releaseClassification();
  expect((await pending).status).toBe(409);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(document.id)
      .first(),
  ).toBeNull();
});

it("retains Jev classification and completeness through a metadata save in both document views", async () => {
  const processingToken = `rsc_${"r".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture(mf);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", capture.id)
    .run();
  await seedHistoricalOcr(
    mf,
    capture,
    "SYNTHETIC SHOP RECEIPT TOTAL 10.00",
    "2026-01-01T00:00:00.000Z",
  );
  await drainBackfill(mf, processingToken);
  const assessed = await mf.dispatchFetch(`${origin}/api/jev/completeness`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${processingToken}`,
    },
    body: JSON.stringify({ document_id: capture.id }),
  });
  expect(assessed.status, await assessed.clone().text()).toBe(200);
  const read = async () =>
    (
      await (
        await mf.dispatchFetch(`${origin}/api/documents/${capture.id}`, {
          headers: ownerHeaders,
        })
      ).json<any>()
    ).document;
  const before = await read();
  expect(before.completenessAudit).toMatchObject({ result: "yes" });
  const updated = {
    ...before,
    vendor: "Synthetic extracted vendor",
    receiptDate: "2026-01-01",
    kind: "receipt",
  };
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [updated] }),
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  const after = await read();
  expect(after.revision).toBe(before.revision + 1);
  expect(after.pages).toEqual(before.pages);
  expect(after.jevRole).toBe(before.jevRole);
  expect(after.completenessAudit).toEqual(before.completenessAudit);
  for (const route of [
    "/api/documents?summary=1&limit=100",
    "/api/jev/documents?limit=100",
  ]) {
    const response = await mf.dispatchFetch(`${origin}${route}`, {
      headers: {
        ...ownerHeaders,
        Authorization: `Bearer ${processingToken}`,
      },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const catalog = await response.json<any>();
    expect(catalog.documents[0]).toMatchObject(
      route.startsWith("/api/jev/")
        ? {
            ready: true,
            jev: { role: "purchase_document" },
            completeness_audit: before.completenessAudit,
          }
        : {
            jevRole: before.jevRole,
            completenessAudit: before.completenessAudit,
          },
    );
  }
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM jev_assessments WHERE task=?")
      .bind("receipt-completeness-v1")
      .first(),
  ).toEqual({ count: 1 });
});

it("paginates the Jev document inventory", async () => {
  await mf.dispose();
  const processingToken = `rsc_${"v".repeat(43)}`;
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [await saveCapture(mf), await saveCapture(mf)];
  for (const capture of captures) {
    const response = await mf.dispatchFetch(
      `${origin}/api/captures/${capture.id}/artifacts/ocr`,
      {
        method: "POST",
        headers: {
          ...ownerHeaders,
          Origin: origin,
          "X-Scanner-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          source: {
            captureId: capture.id,
            sha256: capture.sha256,
            pixels: [1000, 1600],
            rotation: 0,
            region: { left: 0, top: 0, width: 1000, height: 1600 },
          },
          provenance: { engine: "PP-OCRv6" },
          text: "",
        }),
      },
    );
    expect(response.status, await response.text()).toBe(200);
  }
  await drainBackfill(mf, processingToken);
  const headers = {
    ...ownerHeaders,
    Origin: origin,
    "X-Scanner-Request": "1",
    Authorization: `Bearer ${processingToken}`,
  };
  const filteredResponse = await mf.dispatchFetch(
    `${origin}/api/jev/documents?limit=1&disagreements=1`,
    { headers },
  );
  const filtered = await filteredResponse.json<any>();
  expect(filteredResponse.status, JSON.stringify(filtered)).toBe(200);
  expect(filtered.documents).toEqual([]);
  expect(filtered.next).toBe(captures.map((capture) => capture.id).sort()[0]);
  const firstResponse = await mf.dispatchFetch(
    `${origin}/api/jev/documents?limit=1`,
    { headers },
  );
  const first = await firstResponse.json<any>();
  expect(firstResponse.status, JSON.stringify(first)).toBe(200);
  expect(first.documents).toHaveLength(1);
  expect(first.next).toBe(first.documents[0].document_id);
  const secondResponse = await mf.dispatchFetch(
    `${origin}/api/jev/documents?limit=1&after=${encodeURIComponent(first.next)}`,
    { headers },
  );
  const second = await secondResponse.json<any>();
  expect(secondResponse.status, JSON.stringify(second)).toBe(200);
  expect(second.documents).toHaveLength(1);
  expect(second.next).toBeNull();
  expect(
    new Set([first.documents[0].document_id, second.documents[0].document_id]),
  ).toEqual(new Set(captures.map((capture) => capture.id)));
});
