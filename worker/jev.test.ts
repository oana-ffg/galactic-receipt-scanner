import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import {
  loadPurchaseCategoryChoices,
  documentEvidence,
  jevSummary,
  mergeDocuments,
  pageFingerprint,
  prepareJevMerge,
  queueJevJob,
  shouldAutoMerge,
} from "./jev";
import {
  ocrArtifactMatchesPage,
  ocrTextArtifactMatchesPage,
} from "../web/ocr-data";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

async function saveCapture() {
  const id = crypto.randomUUID();
  const response = await mf.dispatchFetch(`${origin}/api/captures/${id}`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1000, 1600],
        quality: { ok: true, receiptPixels: [1000, 1600] },
      }),
    },
    body: new Uint8Array([255, 216, 255, 17]),
  });
  expect(response.status).toBe(200);
  return response.json<any>();
}

async function sha256(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function seedHistoricalOcr(
  capture: any,
  text: string,
  createdAt: string,
  region = { left: 0, top: 0, width: 1000, height: 1600 },
) {
  const artifact = {
    source: {
      captureId: capture.id,
      sha256: capture.sha256,
      pixels: [1000, 1600],
      rotation: 0,
      region,
    },
    provenance: { engine: "PP-OCRv6" },
    text,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  const digest = await sha256(bytes);
  const key = `ocr/${capture.id}/${digest}`;
  const db = await mf.getD1Database("DB");
  await (await mf.getR2Bucket("BUCKET")).put(key, bytes);
  await db
    .prepare(
      "INSERT INTO artifacts(key,capture_id,kind,sha256,created_at,content_type) VALUES(?,?,'ocr',?,?,'application/json')",
    )
    .bind(key, capture.id, digest, createdAt)
    .run();
  return digest;
}

async function processingTokenHash(token: string) {
  return sha256(new TextEncoder().encode(token));
}

async function runBackfill(processingToken: string) {
  const response = await mf.dispatchFetch(`${origin}/api/jev/backfill`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${processingToken}`,
    },
    body: "{}",
  });
  const result = await response.json<any>();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}

async function paymentJevResponse(
  request: Request,
  relationship: "payment_match" | "unrelated",
) {
  const body = (await request.json()) as any;
  const text = JSON.stringify(body.state);
  const answers = Object.fromEntries(
    Object.entries<any>(body.questions).map(([name, question]) => {
      const choices = Object.keys(question.criteria);
      const selected =
        name === "page_role"
          ? text.includes("PAYMENT SLIP")
            ? "payment_evidence"
            : "receipt"
          : name === "document_role"
            ? text.includes("PAYMENT SLIP") && !text.includes("SHOP RECEIPT")
              ? "payment_evidence_only"
              : "purchase_document"
            : name === "purchase_category"
              ? "unresolved"
              : relationship;
      return [
        name,
        {
          type: "choice",
          choice: selected,
          probabilities: Object.fromEntries(
            choices.map((choice) => [choice, choice === selected ? 1 : 0]),
          ),
          confidence: 1,
        },
      ];
    }),
  );
  return Response.json({ model: "jev-1.13.0", answers });
}

async function matchingPaymentJevResponse(request: Request) {
  return paymentJevResponse(request, "payment_match");
}

async function unrelatedPaymentJevResponse(request: Request) {
  return paymentJevResponse(request, "unrelated");
}

async function syntheticJevResponse(request: Request) {
  const body = (await request.json()) as any;
  const answers = Object.fromEntries(
    Object.entries<any>(body.questions).map(([name, question]) => {
      const choices = Object.keys(question.criteria);
      const selected =
        name === "page_role"
          ? "receipt"
          : name === "document_role"
            ? "purchase_document"
            : name === "purchase_category"
              ? "unresolved"
              : "unrelated";
      return [
        name,
        {
          type: "choice",
          choice: selected,
          probabilities: Object.fromEntries(
            choices.map((choice) => [choice, choice === selected ? 1 : 0]),
          ),
          confidence: 1,
        },
      ];
    }),
  );
  return Response.json({ model: "jev-1.13.0", answers });
}

it("only auto-groups a positive relationship with conservative confidence", () => {
  const answer = (
    choice: "continuation" | "payment_match" | "unrelated",
    probability: number,
    confidence: number,
  ) => ({
    type: "choice" as const,
    choice,
    probabilities: {
      continuation: choice === "continuation" ? probability : 0,
      payment_match: choice === "payment_match" ? probability : 0,
      unrelated: choice === "unrelated" ? probability : 1 - probability,
    },
    confidence,
  });
  expect(shouldAutoMerge(answer("continuation", 0.9, 0.75))).toBe(true);
  expect(shouldAutoMerge(answer("payment_match", 0.89, 1))).toBe(false);
  expect(shouldAutoMerge(answer("continuation", 1, 0.74))).toBe(false);
  expect(shouldAutoMerge(answer("unrelated", 1, 1))).toBe(false);
});

it("pins Jev readiness to page order, crop, rotation, and source hash", async () => {
  const capture = {
    id: crypto.randomUUID(),
    sha256: "a".repeat(64),
  } as any;
  const original = newDocument(capture);
  const changed = structuredClone(original);
  changed.pages[0].rotation = 90;
  expect(await pageFingerprint(original)).not.toBe(
    await pageFingerprint(changed),
  );
});

it("requires PP OCR to match the exact full-page or cropped layout", () => {
  const fullPage = {
    captureId: "capture",
    sha256: "a".repeat(64),
    crop: null,
    rotation: 0,
  } as any;
  const artifact = {
    source: {
      captureId: "capture",
      sha256: "a".repeat(64),
      pixels: [1000, 1600],
      rotation: 0,
      region: { left: 0, top: 0, width: 1000, height: 1600 },
    },
  } as any;
  expect(ocrArtifactMatchesPage(artifact, fullPage)).toBe(true);
  artifact.source.region = { left: 10, top: 0, width: 990, height: 1600 };
  expect(ocrArtifactMatchesPage(artifact, fullPage)).toBe(false);
  const cropped = { ...fullPage, crop: [10, 20, 900, 1500] } as any;
  artifact.source.region = { left: 10, top: 20, width: 890, height: 1480 };
  expect(ocrArtifactMatchesPage(artifact, cropped)).toBe(true);
});

it("accepts safe detector subregions as Jev text evidence without weakening exact PDF layout checks", () => {
  const fullPage = {
    captureId: "capture",
    sha256: "a".repeat(64),
    crop: null,
    rotation: 0,
  } as any;
  const artifact = {
    source: {
      captureId: "capture",
      sha256: "a".repeat(64),
      pixels: [1000, 1600],
      rotation: 0,
      region: { left: 100, top: 100, width: 800, height: 1300 },
    },
  } as any;
  expect(ocrArtifactMatchesPage(artifact, fullPage)).toBe(false);
  expect(ocrTextArtifactMatchesPage(artifact, fullPage)).toBe(true);

  const containingCrop = {
    ...fullPage,
    crop: [50, 50, 950, 1500],
  } as any;
  expect(ocrTextArtifactMatchesPage(artifact, containingCrop)).toBe(true);
  artifact.source.region = { left: 25, top: 100, width: 875, height: 1300 };
  expect(ocrTextArtifactMatchesPage(artifact, containingCrop)).toBe(false);
  artifact.source.rotation = 90;
  expect(ocrTextArtifactMatchesPage(artifact, fullPage)).toBe(false);
  artifact.source.rotation = 0;
  artifact.source.pixels = {};
  expect(ocrTextArtifactMatchesPage(artifact, fullPage)).toBe(false);
});

it("keeps existing page groups intact and carries annotations and review reasons when merging payment evidence", () => {
  const page = (captureId: string) => ({
    captureId,
    sha256: captureId.repeat(64).slice(0, 64),
    crop: null,
    rotation: 0 as const,
  });
  const receipt = newDocument({ id: crypto.randomUUID() } as any);
  receipt.pages = [page("a"), page("b")];
  receipt.handwriting = "absent";
  const payment = newDocument({ id: crypto.randomUUID() } as any);
  payment.pages = [page("c"), page("d")];
  payment.handwriting = "present";
  payment.annotations = [
    {
      captureId: "c",
      text: "Synthetic note",
      box: [1, 2, 3, 4],
      uncertain: false,
    },
  ];
  payment.uncertainties = ["Synthetic unresolved payment detail."];
  const merged = prepareJevMerge(
    payment,
    receipt,
    "payment_match",
    new Map([
      ["a", "receipt"],
      ["b", "receipt"],
      ["c", "payment_evidence"],
      ["d", "payment_evidence"],
    ]),
  );
  expect(merged.target.pages.map((item) => item.captureId)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
  expect(merged.target.annotations).toEqual(payment.annotations);
  expect(merged.target.handwriting).toBe("present");
  expect(merged.target.uncertainties).toContain(
    "Synthetic unresolved payment detail.",
  );
  expect(merged.donor.pages).toEqual([]);
  expect(merged.donor.annotations).toEqual([]);
  expect(merged.donor.mergedInto).toBe(receipt.id);
});

it("retargets persisted merged and duplicate aliases when Jev absorbs their target", async () => {
  const captures = [
    await saveCapture(),
    await saveCapture(),
    await saveCapture(),
    await saveCapture(),
  ];
  const target = newDocument(captures[0]);
  const donor = newDocument(captures[1]);
  donor.pages.push(newDocument(captures[2]).pages[0]);
  const mergedAlias = newDocument(captures[2]);
  mergedAlias.pages = [];
  mergedAlias.mergedInto = donor.id;
  mergedAlias.evidence = "Synthetic prior merge evidence.";
  const duplicateAlias = newDocument(captures[3]);
  duplicateAlias.duplicateOf = donor.id;
  duplicateAlias.evidence = "Synthetic duplicate evidence.";
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      documents: [target, donor, mergedAlias, duplicateAlias],
    }),
  });
  expect(saved.status, await saved.text()).toBe(200);
  const catalogResponse = await mf.dispatchFetch(`${origin}/api/documents`, {
    headers: ownerHeaders,
  });
  const catalog = await catalogResponse.json<any>();
  const documents = catalog.documents;
  const currentTarget = documents.find((item: any) => item.id === target.id);
  const currentDonor = documents.find((item: any) => item.id === donor.id);
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("BUCKET");
  const merged = await mergeDocuments(
    new Request(origin),
    { DB: db, BUCKET: bucket } as any,
    async () => catalog.captures,
    currentDonor,
    currentTarget,
    "payment_match",
    new Map([
      [captures[0].id, "receipt"],
      [captures[1].id, "payment_evidence"],
      [captures[2].id, "payment_evidence"],
    ]),
    documents,
  );
  expect(merged?.id).toBe(target.id);
  for (const [id, relationship] of [
    [mergedAlias.id, "mergedInto"],
    [duplicateAlias.id, "duplicateOf"],
  ] as const) {
    const response = await mf.dispatchFetch(`${origin}/api/documents/${id}`, {
      headers: ownerHeaders,
    });
    const document = (await response.json<any>()).document;
    expect(document[relationship]).toBe(target.id);
  }
});

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
  const capture = await saveCapture();
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
  expect(saved.jev).toEqual({ status: "complete" });
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare("SELECT role,model FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first(),
  ).toMatchObject({ role: "misc", model: "rule:blank-ocr" });
  expect(
    await db
      .prepare("SELECT role,model FROM jev_document_heads WHERE document_id=?")
      .bind(capture.id)
      .first(),
  ).toMatchObject({ role: "misc", model: "rule:blank-ocr" });
});

it("rejects a document head whose saved assessment is not pinned to the current PP OCR", async () => {
  const capture = await saveCapture();
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
  const capture = await saveCapture();
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
  await mf.dispose();
  mf = await runtime({
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const captures = [await saveCapture(), await saveCapture()];
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
    expect(saved.jev.status).toBe("complete");
  }
  const db = await mf.getD1Database("DB");
  expect(
    (
      await db
        .prepare(
          "SELECT status,COUNT(*) AS count FROM jev_jobs GROUP BY status",
        )
        .all()
    ).results,
  ).toEqual([{ status: "complete", count: 2 }]);
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
  expect(summary.pages.map((page) => page.capture_id)).toEqual(
    captures.map((capture) => capture.id),
  );
});

it("discovers and processes only one historical OCR artifact per backfill request", async () => {
  const processingToken = `rsc_${"b".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [await saveCapture(), await saveCapture()];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
    await seedHistoricalOcr(capture, "", `2026-01-01T00:00:0${index}.000Z`);
  }
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 1,
    blocked: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 1 });
  expect(await db.prepare("SELECT capture_id FROM jev_jobs").first()).toEqual({
    capture_id: captures[0].id,
  });
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 2 });
});

it("re-evaluates legacy ineligible jobs and classifies safe auto-cropped PP text", async () => {
  const processingToken = `rsc_${"r".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture();
  const digest = await seedHistoricalOcr(
    capture,
    "Synthetic shop\nSynthetic item 12,34\nTOTAL 12,34",
    "2026-01-01T00:00:00.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  const db = await mf.getD1Database("DB");
  await queueJevJob({ DB: db } as any, capture.id, digest);
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL",
    )
    .run();
  expect(
    await db.prepare("SELECT status,eligibility_version FROM jev_jobs").first(),
  ).toEqual({ status: "ineligible", eligibility_version: 1 });

  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
  expect(
    await db
      .prepare(
        "SELECT status,eligibility_version,ineligible_reason FROM jev_jobs",
      )
      .first(),
  ).toEqual({
    status: "complete",
    eligibility_version: 2,
    ineligible_reason: null,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_page_heads").first(),
  ).toEqual({ count: 1 });
});

it("reports unprocessed legacy captures in the backfill remaining count", async () => {
  const processingToken = `rsc_${"u".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const captures = [await saveCapture(), await saveCapture()];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const digest = await seedHistoricalOcr(
      capture,
      `Synthetic shop ${index}\nTOTAL 12,34`,
      `2026-01-01T00:00:0${index}.000Z`,
      { left: 100, top: 100, width: 800, height: 1300 },
    );
    await queueJevJob({ DB: db } as any, capture.id, digest);
  }
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL",
    )
    .run();

  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 1,
    blocked: 0,
  });
  let final: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    final = await runBackfill(processingToken);
    if (final.remaining === 0) break;
  }
  expect(final).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_page_heads").first(),
  ).toEqual({ count: 2 });
});

it("keeps completed Jev evidence pinned when a newer legacy artifact is rejected", async () => {
  const processingToken = `rsc_${"s".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture();
  const completed = await seedHistoricalOcr(
    capture,
    "Completed synthetic shop\nTOTAL 12,34",
    "2026-01-01T00:00:00.000Z",
  );
  const db = await mf.getD1Database("DB");
  await queueJevJob({ DB: db } as any, capture.id, completed);
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });

  const rejected = await seedHistoricalOcr(
    capture,
    "Newer rejected synthetic OCR",
    "2026-01-01T00:00:01.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  await queueJevJob({ DB: db } as any, capture.id, rejected);
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL WHERE ocr_sha256=?",
    )
    .bind(rejected)
    .run();

  expect(await runBackfill(processingToken)).toEqual({
    result: null,
    remaining: 0,
    blocked: 0,
  });
  expect(
    (
      await db
        .prepare(
          "SELECT ocr_sha256,status,eligibility_version FROM jev_jobs ORDER BY ocr_sha256",
        )
        .all()
    ).results,
  ).toEqual(
    [
      { ocr_sha256: rejected, status: "ineligible", eligibility_version: 1 },
      { ocr_sha256: completed, status: "complete", eligibility_version: 2 },
    ].sort((a, b) => a.ocr_sha256.localeCompare(b.ocr_sha256)),
  );
  const stored = await mf.dispatchFetch(
    `${origin}/api/documents/${capture.id}`,
    { headers: ownerHeaders },
  );
  const document = (await stored.json<any>()).document;
  expect(
    await jevSummary(
      { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
      document,
    ),
  ).toMatchObject({ ready: true });
  expect(
    await db.prepare("SELECT ocr_sha256 FROM jev_page_heads").first(),
  ).toEqual({ ocr_sha256: completed });
  expect(
    await documentEvidence(
      { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
      document,
    ),
  ).toMatchObject({
    ocr: { pins: [{ capture_id: capture.id, ocr_sha256: completed }] },
  });
});

it("retries only the newest legacy artifact and leaves its older sibling untouched", async () => {
  const processingToken = `rsc_${"t".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const capture = await saveCapture();
  const older = await seedHistoricalOcr(
    capture,
    "Older synthetic shop\nTOTAL 10,00",
    "2026-01-01T00:00:00.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  const newer = await seedHistoricalOcr(
    capture,
    "Newer synthetic shop\nTOTAL 12,34",
    "2026-01-01T00:00:01.000Z",
    { left: 100, top: 100, width: 800, height: 1300 },
  );
  const db = await mf.getD1Database("DB");
  await queueJevJob({ DB: db } as any, capture.id, older);
  await queueJevJob({ DB: db } as any, capture.id, newer);
  await db
    .prepare(
      "UPDATE jev_jobs SET status='ineligible',eligibility_version=1,ineligible_reason=NULL",
    )
    .run();

  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
  expect(
    (
      await db
        .prepare(
          "SELECT ocr_sha256,status,eligibility_version FROM jev_jobs ORDER BY ocr_sha256",
        )
        .all()
    ).results,
  ).toEqual(
    [
      { ocr_sha256: older, status: "ineligible", eligibility_version: 1 },
      { ocr_sha256: newer, status: "complete", eligibility_version: 2 },
    ].sort((a, b) => a.ocr_sha256.localeCompare(b.ocr_sha256)),
  );
  expect(
    await db.prepare("SELECT ocr_sha256 FROM jev_page_heads").first(),
  ).toEqual({ ocr_sha256: newer });
  expect(await runBackfill(processingToken)).toEqual({
    result: null,
    remaining: 0,
    blocked: 0,
  });
});

it("backfills a historical receipt before its later matching payment slip", async () => {
  const processingToken = `rsc_${"c".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: matchingPaymentJevResponse,
  });
  const receipt = await saveCapture();
  const payment = await saveCapture();
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", receipt.id)
    .run();
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:01.000Z", payment.id)
    .run();
  await seedHistoricalOcr(
    receipt,
    "SHOP RECEIPT\nTOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    payment,
    "PAYMENT SLIP\nTOTAL 12.34",
    "2026-01-01T00:00:01.000Z",
  );
  expect(await runBackfill(processingToken)).toMatchObject({ remaining: 1 });
  let result: any;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await runBackfill(processingToken);
    if (result.remaining === 0) break;
  }
  expect(result).toMatchObject({ remaining: 0, blocked: 0 });
  const response = await mf.dispatchFetch(`${origin}/api/documents`, {
    headers: ownerHeaders,
  });
  const catalog = await response.json<any>();
  expect(response.status, JSON.stringify(catalog)).toBe(200);
  const active = catalog.documents.filter(
    (document: any) => !document.mergedInto && !document.duplicateOf,
  );
  expect(active).toHaveLength(1);
  expect(active[0].pages.map((page: any) => page.captureId)).toEqual([
    receipt.id,
    payment.id,
  ]);
});

it("does not let an older completed artifact hide a newer unqueued PP artifact", async () => {
  const processingToken = `rsc_${"d".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const capture = await saveCapture();
  const older = await seedHistoricalOcr(
    capture,
    "",
    "2026-01-01T00:00:00.000Z",
  );
  expect(await runBackfill(processingToken)).toMatchObject({ remaining: 0 });
  const newer = await seedHistoricalOcr(
    capture,
    " ",
    "2026-01-01T00:00:01.000Z",
  );
  expect(newer).not.toBe(older);
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
  });
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare("SELECT ocr_sha256 FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first(),
  ).toEqual({ ocr_sha256: newer });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 2 });
});

it("checkpoints a long unmatched payment search and resumes from saved Jev assessments", async () => {
  const processingToken = `rsc_${"e".repeat(43)}`;
  let jevCalls = 0;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      jevCalls += 1;
      return unrelatedPaymentJevResponse(request);
    },
  });
  const captures = [];
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 13; index += 1) {
    const capture = await saveCapture();
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:${index.toString().padStart(2, "0")}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      index < 12
        ? `PAYMENT SLIP ${index}\nTOTAL 12.34`
        : "SHOP RECEIPT\nTOTAL 12.34",
      createdAt,
    );
  }
  for (let index = 0; index < 12; index += 1)
    expect(await runBackfill(processingToken)).toMatchObject({
      result: { status: "complete" },
    });
  let result: any;
  let pending = 0;
  const cursors: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const callsBefore = jevCalls;
    result = await runBackfill(processingToken);
    expect(jevCalls - callsBefore).toBeLessThanOrEqual(3);
    const row = await db
      .prepare(
        "SELECT status,attempts,association_progress FROM jev_jobs WHERE capture_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(captures[12].id)
      .first<{
        status: string;
        attempts: number;
        association_progress: string | null;
      }>();
    if (result.result.status === "pending") {
      pending += 1;
      expect(row).toMatchObject({ status: "pending", attempts: 0 });
      if (row?.association_progress)
        cursors.push(JSON.parse(row.association_progress).next);
    }
    if (result.remaining === 0) break;
  }
  expect(result).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
  expect(pending).toBeGreaterThanOrEqual(3);
  expect(new Set(cursors).size).toBeGreaterThanOrEqual(3);
  expect(
    cursors.every((next, index) => !index || next >= cursors[index - 1]),
  ).toBe(true);
});

it("recovers an interrupted job that the previous request boundary blocked", async () => {
  const processingToken = `rsc_${"f".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const capture = await saveCapture();
  const ocrSha256 = await seedHistoricalOcr(
    capture,
    "",
    "2026-01-01T00:00:00.000Z",
  );
  const db = await mf.getD1Database("DB");
  const jobId = await queueJevJob(
    {
      DB: db,
      BUCKET: await mf.getR2Bucket("BUCKET"),
    } as any,
    capture.id,
    ocrSha256,
  );
  await db
    .prepare(
      "UPDATE jev_jobs SET status='blocked',attempts=3,last_error='Interrupted Jev run; safe to retry.',updated_at=? WHERE id=?",
    )
    .bind("2026-01-01T00:00:01.000Z", jobId)
    .run();
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
});

it("retries an accepted match when the merge save fails before cursor advancement", async () => {
  const processingToken = `rsc_${"g".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: matchingPaymentJevResponse,
  });
  const receipt = await saveCapture();
  const payment = await saveCapture();
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", receipt.id)
    .run();
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:01.000Z", payment.id)
    .run();
  await seedHistoricalOcr(
    receipt,
    "SHOP RECEIPT\nTOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    payment,
    "PAYMENT SLIP\nTOTAL 12.34",
    "2026-01-01T00:00:01.000Z",
  );
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
  });
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_merge BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT, 'synthetic merge failure'); END",
    )
    .run();
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "failed" },
    remaining: 1,
  });
  expect(
    await db
      .prepare(
        "SELECT association_progress FROM jev_jobs WHERE capture_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(payment.id)
      .first(),
  ).toEqual({ association_progress: null });
  await db.prepare("DROP TRIGGER synthetic_fail_merge").run();
  let result: any;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await runBackfill(processingToken);
    if (result.remaining === 0) break;
  }
  expect(result).toMatchObject({
    result: { status: "complete" },
    remaining: 0,
    blocked: 0,
  });
  const documents = await mf.dispatchFetch(`${origin}/api/documents`, {
    headers: ownerHeaders,
  });
  const catalog = await documents.json<any>();
  expect(
    catalog.documents
      .filter(
        (document: any) => !document.mergedInto && !document.duplicateOf,
      )[0]
      .pages.map((page: any) => page.captureId),
  ).toEqual([receipt.id, payment.id]);
});

it("prevents a superseded Jev execution from overwriting its successor cursor", async () => {
  const processingToken = `rsc_${"h".repeat(43)}`;
  let releaseRelationship!: () => void;
  const relationshipReleased = new Promise<void>((resolve) => {
    releaseRelationship = resolve;
  });
  let markRelationshipStarted!: () => void;
  const relationshipStarted = new Promise<void>((resolve) => {
    markRelationshipStarted = resolve;
  });
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship) {
        markRelationshipStarted();
        await relationshipReleased;
      }
      return unrelatedPaymentJevResponse(request);
    },
  });
  const payment = await saveCapture();
  const receipt = await saveCapture();
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", payment.id)
    .run();
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:01.000Z", receipt.id)
    .run();
  await seedHistoricalOcr(
    payment,
    "PAYMENT SLIP\nTOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    receipt,
    "SHOP RECEIPT\nTOTAL 12.34",
    "2026-01-01T00:00:01.000Z",
  );
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "complete" },
  });
  const oldExecution = runBackfill(processingToken);
  await relationshipStarted;
  const job = await db
    .prepare("SELECT id,run_token FROM jev_jobs WHERE capture_id=?")
    .bind(receipt.id)
    .first<{ id: string; run_token: string }>();
  const successorProgress = JSON.stringify({ scope: "successor", next: 7 });
  await db
    .prepare(
      "UPDATE jev_jobs SET run_token='successor-token',association_progress=? WHERE id=?",
    )
    .bind(successorProgress, job!.id)
    .run();
  releaseRelationship();
  expect(await oldExecution).toMatchObject({
    result: { status: "running", superseded: true },
  });
  expect(
    await db
      .prepare("SELECT run_token,association_progress FROM jev_jobs WHERE id=?")
      .bind(job!.id)
      .first(),
  ).toEqual({
    run_token: "successor-token",
    association_progress: successorProgress,
  });
});

it("atomically owns a Jev job while upload and backfill overlap", async () => {
  await mf.dispose();
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let calls = 0;
  const processingToken = `rsc_${"q".repeat(43)}`;
  const tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(processingToken),
      ),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  mf = await runtime({
    typesafeApiKey: "synthetic-key",
    processingTokenSha256: tokenHash,
    outboundService: async (request: Request) => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await firstReleased;
      }
      return syntheticJevResponse(request);
    },
  });
  const capture = await saveCapture();
  const upload = mf.dispatchFetch(
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
  await firstStarted;
  const concurrent = await mf.dispatchFetch(`${origin}/api/jev/backfill`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
      Authorization: `Bearer ${processingToken}`,
    },
    body: "{}",
  });
  const concurrentResult = await concurrent.json<any>();
  expect(concurrent.status, JSON.stringify(concurrentResult)).toBe(200);
  expect(concurrentResult).toMatchObject({ result: null, remaining: 1 });
  releaseFirst();
  const saved = await upload;
  expect(saved.status, await saved.text()).toBe(200);
  expect(calls).toBe(3);
  const db = await mf.getD1Database("DB");
  expect(
    await db.prepare("SELECT status,run_token FROM jev_jobs").first(),
  ).toEqual({ status: "complete", run_token: null });
});

it("paginates the Jev document inventory", async () => {
  await mf.dispose();
  const processingToken = `rsc_${"v".repeat(43)}`;
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [await saveCapture(), await saveCapture()];
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
