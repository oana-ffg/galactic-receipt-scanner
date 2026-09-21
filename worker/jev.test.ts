import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import {
  loadPurchaseCategoryChoices,
  documentEvidence,
  jevReadyDocuments,
  jevSummary,
  mergeDocuments,
  pageFingerprint,
  prepareJevMerge,
  queueJevJob,
  shouldAutoMerge,
  summarizeDocumentOcr,
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

async function saveCapture(retakeOf?: string) {
  const id = crypto.randomUUID();
  const response = await mf.dispatchFetch(`${origin}/api/captures/${id}`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      ...(retakeOf ? { "X-Retake-Of": retakeOf } : {}),
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

async function drainBackfill(processingToken: string, limit = 200) {
  const results: any[] = [];
  let complete = false;
  for (let index = 0; index < limit; index += 1) {
    const result = await runBackfill(processingToken);
    results.push(result);
    if (result.remaining === 0) {
      if (complete) return { result, results };
      complete = true;
      continue;
    }
    complete = false;
    expect(result.busy, JSON.stringify(result)).not.toBe(true);
  }
  throw new Error(`Jev backfill did not finish after ${limit} steps.`);
}

async function paymentJevResponse(
  request: Request,
  relationship: "continuation" | "payment_match" | "unrelated",
) {
  const body = (await request.json()) as any;
  const text = JSON.stringify(body.state);
  const answers = Object.fromEntries(
    Object.entries<any>(body.questions).map(([name, question]) => {
      const choices = Object.keys(question.criteria);
      const selected =
        name === "page_role"
          ? text.includes("BANK STATEMENT")
            ? "account_record"
            : text.includes("PAYMENT SLIP")
              ? "payment_evidence"
              : "receipt"
          : name === "document_role"
            ? text.includes("BANK STATEMENT")
              ? "account_record"
              : text.includes("PAYMENT SLIP") && !text.includes("SHOP RECEIPT")
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
  const text = JSON.stringify(body.state);
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
              : name === "completeness"
                ? text.includes("TOTAL")
                  ? "yes"
                  : "no"
                : name === "issue"
                  ? text.includes("TOTAL")
                    ? "none"
                    : "missing_total"
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

it("marks combined OCR truncated when a later receipt footer is outside Jev's input", () => {
  const summary = summarizeDocumentOcr([
    { text: "line\n".repeat(5_000) },
    { text: "PRINTED TOTAL 12,34" },
  ]);
  expect(summary.characters).toBeGreaterThan(24_000);
  expect(summary.truncated).toBe(true);
  expect(summary.text).not.toContain("PRINTED TOTAL");
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
  await drainBackfill(processingToken);
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
  const processingToken = `rsc_${"m".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
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
    expect(saved.jev.status).toBe("classified");
  }
  await drainBackfill(processingToken);
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
    result: { status: "classified" },
    remaining: 1,
    blocked: 0,
  });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 1 });
  expect(await db.prepare("SELECT capture_id FROM jev_jobs").first()).toEqual({
    capture_id: captures[0].id,
  });
  const { result } = await drainBackfill(processingToken);
  expect(result).toMatchObject({
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

  expect((await drainBackfill(processingToken)).result).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
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
    result: { status: "classified" },
    remaining: 1,
    blocked: 0,
  });
  const { result: final } = await drainBackfill(processingToken);
  expect(final).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
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
  await drainBackfill(processingToken);

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

  expect((await runBackfill(processingToken)).remaining).toBe(0);
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

  await drainBackfill(processingToken);
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
  expect((await runBackfill(processingToken)).remaining).toBe(0);
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
  const { result } = await drainBackfill(processingToken);
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

it("lets Jev attach a second detached payment slip to a receipt that already has one", async () => {
  const processingToken = `rsc_${"m".repeat(43)}`;
  const secondSlipPairs: string[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "payment_match" | "unrelated" =
        "unrelated";
      if (body.questions.relationship) {
        const current = body.state.current.ocr as string;
        const candidate = body.state.candidate.ocr as string;
        if (
          current.includes("SHOP RECEIPT") &&
          candidate.includes("PAYMENT SLIP ONE")
        )
          relationship = "payment_match";
        if (
          current.includes("SHOP RECEIPT") &&
          current.includes("PAYMENT SLIP ONE") &&
          candidate.includes("PAYMENT SLIP TWO")
        ) {
          secondSlipPairs.push(
            `${body.state.current.document_id}|${body.state.candidate.document_id}`,
          );
          relationship = "payment_match";
        }
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const receipt = await saveCapture();
  const firstSlip = await saveCapture();
  const separator = await saveCapture();
  const secondSlip = await saveCapture();
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [
    receipt,
    firstSlip,
    separator,
    secondSlip,
  ].entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    receipt,
    "SHOP RECEIPT 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    firstSlip,
    "PAYMENT SLIP ONE 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:01.000Z",
  );
  await seedHistoricalOcr(
    separator,
    "BANK STATEMENT BALANCE SUMMARY",
    "2026-01-01T00:00:02.000Z",
  );
  await seedHistoricalOcr(
    secondSlip,
    "PAYMENT SLIP TWO 21.09.2026 TOTAL 12.34",
    "2026-01-01T00:00:03.000Z",
  );

  const { result } = await drainBackfill(processingToken);
  expect(result).toMatchObject({ remaining: 0, blocked: 0 });
  expect(secondSlipPairs).toEqual([`${receipt.id}|${secondSlip.id}`]);

  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const merged = catalog.documents.find(
    (document: any) => document.id === receipt.id,
  );
  expect(merged.pages.map((page: any) => page.captureId)).toEqual([
    receipt.id,
    firstSlip.id,
    secondSlip.id,
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
  await drainBackfill(processingToken);
  const newer = await seedHistoricalOcr(
    capture,
    " ",
    "2026-01-01T00:00:01.000Z",
  );
  expect(newer).not.toBe(older);
  const db = await mf.getD1Database("DB");
  expect(
    (
      await db
        .prepare(
          "SELECT artifact.capture_id,artifact.sha256 FROM artifacts artifact WHERE artifact.kind='ocr' AND NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.capture_id=artifact.capture_id AND newer.kind='ocr' AND (newer.created_at>artifact.created_at OR (newer.created_at=artifact.created_at AND newer.key>artifact.key))) AND NOT EXISTS (SELECT 1 FROM jev_jobs job WHERE job.capture_id=artifact.capture_id AND job.ocr_sha256=artifact.sha256)",
        )
        .all()
    ).results,
  ).toEqual([{ capture_id: capture.id, sha256: newer }]);
  const resumed = await runBackfill(processingToken);
  expect(resumed).toMatchObject({ remaining: 1, phase: "pages" });
  expect((await drainBackfill(processingToken)).result).toMatchObject({
    remaining: 0,
    phase: "complete",
  });
  expect(
    (
      await db
        .prepare(
          "SELECT ocr_sha256,status FROM jev_jobs WHERE capture_id=? ORDER BY created_at,id",
        )
        .bind(capture.id)
        .all()
    ).results,
  ).toEqual([
    { ocr_sha256: older, status: "complete" },
    { ocr_sha256: newer, status: "complete" },
  ]);
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

it("defers PP refreshes during grouping and reruns the complete pipeline", async () => {
  const processingToken = `rsc_${"k".repeat(43)}`;
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
  let step: any;
  for (let index = 0; index < 20; index += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "group") break;
  }
  expect(step.phase).toBe("group");
  const refresh = await mf.dispatchFetch(
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
        text: " ",
      }),
    },
  );
  const saved = await refresh.json<any>();
  expect(refresh.status, JSON.stringify(saved)).toBe(200);
  expect(saved.jev.status).toBe("pending");
  expect(saved.sha256).not.toBe(older);
  await drainBackfill(processingToken);
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare("SELECT ocr_sha256 FROM jev_page_heads WHERE capture_id=?")
      .bind(capture.id)
      .first(),
  ).toEqual({ ocr_sha256: saved.sha256 });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM jev_jobs").first(),
  ).toEqual({ count: 2 });
  expect(
    (
      await db
        .prepare("SELECT DISTINCT status FROM jev_jobs ORDER BY status")
        .all()
    ).results,
  ).toEqual([{ status: "complete" }]);
});

it("retires classified work when its capture is superseded mid-pipeline", async () => {
  const processingToken = `rsc_${"l".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const original = await saveCapture();
  await seedHistoricalOcr(original, "", "2026-01-01T00:00:00.000Z");
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "classified" },
    phase: "pages",
  });
  await saveCapture(original.id);
  const { result } = await drainBackfill(processingToken);
  expect(result).toMatchObject({ remaining: 0, phase: "complete" });
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare(
        "SELECT status,ineligible_reason FROM jev_jobs WHERE capture_id=?",
      )
      .bind(original.id)
      .first(),
  ).toEqual({
    status: "ineligible",
    ineligible_reason: "capture_not_current",
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_pipeline_runs WHERE phase!='complete'",
      )
      .first(),
  ).toEqual({ count: 0 });
});

it("groups forward once per adjacent document and preserves the first boundary", async () => {
  const processingToken = `rsc_${"e".repeat(43)}`;
  const relationshipPairs: { current: string; candidate: string }[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "unrelated" = "unrelated";
      if (body.questions.relationship) {
        relationshipPairs.push({
          current: body.state.current.document_id,
          candidate: body.state.candidate.document_id,
        });
        if (
          body.state.current.document_id === captures[2]?.id &&
          body.state.candidate.document_id === captures[1]?.id
        )
          relationship = "continuation";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const captures = [];
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 3; index += 1) {
    const capture = await saveCapture();
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:${index.toString().padStart(2, "0")}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      index === 0
        ? "PAYMENT SLIP\nTOTAL 12.34"
        : `SHOP RECEIPT ${index}\nTOTAL 12.34`,
      createdAt,
    );
  }
  const { result } = await drainBackfill(processingToken);
  expect(result).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
  });
  expect(relationshipPairs).toEqual([
    { current: captures[1].id, candidate: captures[0].id },
    { current: captures[2].id, candidate: captures[1].id },
    { current: captures[1].id, candidate: captures[0].id },
  ]);
  expect(
    await db
      .prepare(
        "SELECT COUNT(DISTINCT candidate_id) AS count,MIN(candidate_id) AS candidate_id FROM jev_assessments WHERE task='document-relationship' AND subject_id=?",
      )
      .bind(captures[2].id)
      .first(),
  ).toEqual({ count: 1, candidate_id: captures[1].id });
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    catalog.documents.find((document: any) => document.id === captures[1].id)
      .pages,
  ).toHaveLength(2);
});

it("persists the forward grouping cursor between requests", async () => {
  const processingToken = `rsc_${"w".repeat(43)}`;
  const relationshipPairs: string[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (body.questions.relationship)
        relationshipPairs.push(
          `${body.state.current.document_id}|${body.state.candidate.document_id}`,
        );
      return paymentJevResponse(request, "unrelated");
    },
  });
  const captures = [
    await saveCapture(),
    await saveCapture(),
    await saveCapture(),
  ];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      `SHOP RECEIPT ${index} 19.09.2026`,
      createdAt,
    );
  }
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "group") break;
  }
  expect(step.phase).toBe("group");
  expect(relationshipPairs).toEqual([]);

  await runBackfill(processingToken);
  expect(relationshipPairs).toEqual([`${captures[1].id}|${captures[0].id}`]);
  const cursor = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='group' ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(cursor!.cursor)).toEqual({
    finalize_id: captures[0].id,
    next_id: captures[1].id,
  });

  await runBackfill(processingToken);
  const finalized = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='group' ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(finalized!.cursor)).toEqual({
    active_id: captures[1].id,
  });

  await saveCapture(captures[1].id);
  expect(await runBackfill(processingToken)).toMatchObject({
    result: { status: "cursor-reset" },
    phase: "group",
  });
  const reset = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='group' ORDER BY created_at DESC LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(reset!.cursor)).toEqual({ active_id: captures[0].id });
  await runBackfill(processingToken);
  expect(relationshipPairs).toEqual([
    `${captures[1].id}|${captures[0].id}`,
    `${captures[2].id}|${captures[0].id}`,
  ]);
});

it("leaves the open tail unclassified until the following raw capture has PP OCR", async () => {
  const processingToken = `rsc_${"o".repeat(43)}`;
  const relationshipPairs: string[] = [];
  let captures: any[] = [];
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "unrelated" = "unrelated";
      if (body.questions.relationship) {
        relationshipPairs.push(
          `${body.state.current.document_id}|${body.state.candidate.document_id}`,
        );
        if (
          body.state.current.document_id === captures[2]?.id &&
          body.state.candidate.document_id === captures[1]?.id
        )
          relationship = "continuation";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  captures = [await saveCapture(), await saveCapture(), await saveCapture()];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    captures[0],
    "FIRST SHOP RECEIPT\nTOTAL 10.00",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    captures[1],
    "SECOND SHOP RECEIPT PAGE 1",
    "2026-01-01T00:00:01.000Z",
  );

  const first = await drainBackfill(processingToken);
  expect(
    first.results.some(
      (step) => step.result?.status === "waiting-for-ocr" && step.waiting,
    ),
  ).toBe(true);
  expect(relationshipPairs).toEqual([`${captures[1].id}|${captures[0].id}`]);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(captures[0].id)
      .first(),
  ).toEqual({ document_id: captures[0].id });
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(captures[1].id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT status FROM jev_jobs WHERE capture_id=?")
      .bind(captures[1].id)
      .first(),
  ).toEqual({ status: "waiting" });

  const statusResponse = await mf.dispatchFetch(`${origin}/api/jev/status`, {
    headers: { ...ownerHeaders, Authorization: `Bearer ${processingToken}` },
  });
  expect(statusResponse.status).toBe(200);
  expect((await statusResponse.json<any>()).waiting_current_captures).toBe(1);

  expect(await runBackfill(processingToken)).toMatchObject({
    result: null,
    phase: "complete",
    remaining: 0,
    waiting: true,
  });

  await seedHistoricalOcr(
    captures[2],
    "SECOND SHOP RECEIPT PAGE 2\nTOTAL 20.00",
    "2026-01-01T00:00:02.000Z",
  );
  await drainBackfill(processingToken);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    catalog.documents.find((document: any) => document.id === captures[1].id)
      .pages,
  ).toHaveLength(2);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(captures[1].id)
      .first(),
  ).toEqual({ document_id: captures[1].id });
});

it("withholds a previously terminal document as soon as a newer raw capture exists", async () => {
  const processingToken = `rsc_${"t".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: syntheticJevResponse,
  });
  const first = await saveCapture();
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", first.id)
    .run();
  await seedHistoricalOcr(
    first,
    "FIRST SHOP RECEIPT TOTAL 10.00",
    "2026-01-01T00:00:00.000Z",
  );
  await drainBackfill(processingToken);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const firstDocument = catalog.documents.find(
    (document: any) => document.id === first.id,
  );
  const env = {
    DB: db,
    BUCKET: await mf.getR2Bucket("BUCKET"),
  } as any;
  expect(
    (await jevReadyDocuments(env, [firstDocument], [first])).has(first.id),
  ).toBe(true);
  let readinessQueries = 0;
  const countingEnv = {
    DB: {
      prepare(sql: string) {
        readinessQueries += 1;
        return db.prepare(sql);
      },
    },
  } as any;
  await jevReadyDocuments(
    countingEnv,
    Array.from({ length: 100 }, () => firstDocument),
  );
  expect(readinessQueries).toBe(4);

  const second = await saveCapture();
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:01.000Z", second.id)
    .run();
  expect(
    (
      await jevReadyDocuments(
        env,
        [firstDocument, newDocument(second)],
        [first, second],
      )
    ).has(first.id),
  ).toBe(false);

  const waiting = await drainBackfill(processingToken);
  expect(
    waiting.results.some(
      (step) => step.result?.status === "waiting-for-ocr" && step.waiting,
    ),
  ).toBe(true);
  expect(
    await db
      .prepare("SELECT document_id FROM jev_document_heads WHERE document_id=?")
      .bind(first.id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT status FROM jev_jobs WHERE capture_id=?")
      .bind(first.id)
      .first(),
  ).toEqual({ status: "waiting" });
  expect(await runBackfill(processingToken)).toMatchObject({
    result: null,
    phase: "complete",
    remaining: 0,
    waiting: true,
  });
  const statusResponse = await mf.dispatchFetch(`${origin}/api/jev/status`, {
    headers: {
      ...ownerHeaders,
      Authorization: `Bearer ${processingToken}`,
    },
  });
  expect(statusResponse.status).toBe(200);
  expect((await statusResponse.json<any>()).waiting_current_captures).toBe(1);
});

it("marks an open tail larger than the D1 parameter limit as waiting", async () => {
  const processingToken = `rsc_${"u".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [];
  for (let index = 0; index < 101; index += 1)
    captures.push(await saveCapture());
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE captures SET created_at=? WHERE id=?")
    .bind("2026-01-01T00:00:00.000Z", captures[0].id)
    .run();
  await seedHistoricalOcr(captures[0], "", "2026-01-01T00:00:00.000Z");

  const waiting = await drainBackfill(processingToken, 20);
  expect(
    waiting.results.some(
      (step) => step.result?.status === "waiting-for-ocr" && step.waiting,
    ),
  ).toBe(true);
});

it("tries shared dates first but lets Jev match apparently conflicting dates", async () => {
  const processingToken = `rsc_${"q".repeat(43)}`;
  const reconciliationPairs: { current: string; candidate: string }[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      let relationship: "continuation" | "payment_match" | "unrelated" =
        "unrelated";
      if (body.questions.relationship) {
        if (reconciling)
          reconciliationPairs.push({
            current: body.state.current.document_id,
            candidate: body.state.candidate.document_id,
          });
        if (
          !reconciling &&
          body.state.current.ocr.includes("PAYMENT SLIP") &&
          body.state.candidate.ocr.includes("PAYMENT SLIP")
        )
          relationship = "continuation";
        else if (
          reconciling &&
          body.state.current.ocr.includes("REFERENCE MATCH") &&
          body.state.candidate.ocr.includes("REFERENCE MATCH")
        )
          relationship = "payment_match";
      }
      return paymentJevResponse(request, relationship);
    },
  });
  const payment = await saveCapture();
  const paymentContinuation = await saveCapture();
  const separator = await saveCapture();
  const conflictingDateMatch = await saveCapture();
  const sameDateWrongReceipt = await saveCapture();
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [
    payment,
    paymentContinuation,
    separator,
    conflictingDateMatch,
    sameDateWrongReceipt,
  ].entries())
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(`2026-01-01T00:00:0${index}.000Z`, capture.id)
      .run();
  await seedHistoricalOcr(
    payment,
    "PAYMENT SLIP 19.09.26 REFERENCE MATCH",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    paymentContinuation,
    "PAYMENT SLIP PART 2 19.09.26 REFERENCE MATCH",
    "2026-01-01T00:00:01.000Z",
  );
  await seedHistoricalOcr(
    separator,
    "BANK STATEMENT BALANCE SUMMARY",
    "2026-01-01T00:00:02.000Z",
  );
  await seedHistoricalOcr(
    conflictingDateMatch,
    "SHOP RECEIPT 20/09/2026 REFERENCE MATCH",
    "2026-01-01T00:00:03.000Z",
  );
  await seedHistoricalOcr(
    sameDateWrongReceipt,
    "SHOP RECEIPT 2026-09-19 REFERENCE OTHER",
    "2026-01-01T00:00:04.000Z",
  );
  let backfill: any;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    backfill = await runBackfill(processingToken);
    if (backfill.phase === "dates") break;
  }
  expect(backfill.phase).toBe("dates");
  await db
    .prepare(
      "INSERT INTO processing_batch_lease(id,batch_id,owner,expires,created_at,updated_at) VALUES(1,?,?,unixepoch()*1000+60000,?,?)",
    )
    .bind(
      "a".repeat(32),
      "synthetic-coordinator",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    )
    .run();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM processing_batch_lease WHERE expires>unixepoch()*1000",
      )
      .first(),
  ).toEqual({ count: 1 });
  expect(
    await db
      .prepare(
        "SELECT phase FROM jev_pipeline_runs WHERE phase!='complete' ORDER BY created_at DESC LIMIT 1",
      )
      .first(),
  ).toEqual({ phase: "dates" });
  reconciling = true;
  expect(await runBackfill(processingToken)).toMatchObject({
    phase: "dates",
    busy: true,
  });
  expect(reconciliationPairs).toEqual([]);
  await db.prepare("DELETE FROM processing_batch_lease WHERE id=1").run();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    backfill = await runBackfill(processingToken);
    if (backfill.remaining === 0) break;
  }
  expect(backfill, JSON.stringify(backfill)).toMatchObject({
    remaining: 0,
    blocked: 0,
  });

  expect(reconciliationPairs).toEqual([
    { current: sameDateWrongReceipt.id, candidate: payment.id },
    { current: conflictingDateMatch.id, candidate: payment.id },
  ]);
  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  const retained = catalog.documents.find(
    (document: any) => document.id === conflictingDateMatch.id,
  );
  const donor = catalog.documents.find(
    (document: any) => document.id === payment.id,
  );
  const separate = catalog.documents.find(
    (document: any) => document.id === sameDateWrongReceipt.id,
  );
  expect(retained.pages.map((page: any) => page.captureId)).toEqual([
    conflictingDateMatch.id,
    payment.id,
    paymentContinuation.id,
  ]);
  expect(donor).toMatchObject({
    pages: [],
    mergedInto: conflictingDateMatch.id,
  });
  expect(
    catalog.documents.find(
      (document: any) => document.id === paymentContinuation.id,
    ),
  ).toMatchObject({ pages: [], mergedInto: conflictingDateMatch.id });
  expect(separate.pages.map((page: any) => page.captureId)).toEqual([
    sameDateWrongReceipt.id,
  ]);
  expect(
    (
      await jevSummary(
        { DB: db, BUCKET: await mf.getR2Bucket("BUCKET") } as any,
        retained,
      )
    ).ready,
  ).toBe(true);
});

it("does not match a current payment against a receipt capture retired after the snapshot", async () => {
  const processingToken = `rsc_${"x".repeat(43)}`;
  const reconciliationPairs: string[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (reconciling && body.questions.relationship)
        reconciliationPairs.push(
          `${body.state.current.document_id}|${body.state.candidate.document_id}`,
        );
      return paymentJevResponse(
        request,
        reconciling ? "payment_match" : "unrelated",
      );
    },
  });
  const receipt = await saveCapture();
  const payment = await saveCapture();
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of [receipt, payment].entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
  }
  await seedHistoricalOcr(
    receipt,
    "SHOP RECEIPT 19.09.2026 REFERENCE MATCH",
    "2026-01-01T00:00:00.000Z",
  );
  await seedHistoricalOcr(
    payment,
    "PAYMENT SLIP 19.09.2026 REFERENCE MATCH",
    "2026-01-01T00:00:01.000Z",
  );

  let step: any;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "dates") break;
  }
  expect(step.phase).toBe("dates");
  const persisted = newDocument(receipt);
  const persistResponse = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
    },
    body: JSON.stringify({ documents: [persisted] }),
  });
  expect(persistResponse.status).toBe(200);
  await saveCapture(receipt.id);
  reconciling = true;
  const { result } = await drainBackfill(processingToken);
  expect(result).toMatchObject({ remaining: 0, blocked: 0 });
  expect(reconciliationPairs).toEqual([]);

  const catalog = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    catalog.documents.find((document: any) => document.id === payment.id).pages,
  ).toEqual([expect.objectContaining({ captureId: payment.id })]);
});

it("checkpoints ranked reconciliation without repeating candidate pairs", async () => {
  const processingToken = `rsc_${"v".repeat(43)}`;
  const reconciliationPairs: string[] = [];
  let reconciling = false;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
    typesafeApiKey: "synthetic-key",
    outboundService: async (request: Request) => {
      const body = (await request.clone().json()) as any;
      if (reconciling && body.questions.relationship)
        reconciliationPairs.push(
          `${body.state.current.document_id}|${body.state.candidate.document_id}`,
        );
      return unrelatedPaymentJevResponse(request);
    },
  });
  const captures = [];
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 4; index += 1) {
    const capture = await saveCapture();
    captures.push(capture);
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      `${index < 2 ? "PAYMENT SLIP" : "SHOP RECEIPT"} ${index} 21.09.2026`,
      createdAt,
    );
  }
  let backfill: any;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (backfill?.phase === "dates") reconciling = true;
    backfill = await runBackfill(processingToken);
    if (backfill.remaining === 0) break;
  }
  expect(backfill).toMatchObject({ remaining: 0, blocked: 0 });
  expect(reconciliationPairs).toHaveLength(3);
  expect(new Set(reconciliationPairs).size).toBe(3);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship' AND subject_id IN (?,?) AND candidate_id IN (?,?)",
      )
      .bind(captures[2].id, captures[3].id, captures[0].id, captures[1].id)
      .first(),
  ).toEqual({ count: 4 });
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
  expect((await drainBackfill(processingToken)).result).toMatchObject({
    remaining: 0,
    blocked: 0,
    phase: "complete",
  });
});

it("retries a saved grouping decision after the merge write fails", async () => {
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
  for (const [index, capture] of [receipt, payment].entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      index === 0 ? "SHOP RECEIPT TOTAL 12.34" : "PAYMENT SLIP TOTAL 12.34",
      createdAt,
    );
  }
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "group") break;
  }
  expect(step.phase).toBe("group");
  await db
    .prepare(
      "CREATE TRIGGER synthetic_fail_merge BEFORE INSERT ON document_versions BEGIN SELECT RAISE(ABORT, 'synthetic merge failure'); END",
    )
    .run();
  const failed = await mf.dispatchFetch(`${origin}/api/jev/backfill`, {
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
  expect(failed.status).toBe(503);
  expect(
    await db
      .prepare(
        "SELECT cursor,step_token FROM jev_pipeline_runs WHERE phase='group'",
      )
      .first(),
  ).toEqual({ cursor: null, step_token: null });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship'",
      )
      .first(),
  ).toEqual({ count: 1 });
  await db.prepare("DROP TRIGGER synthetic_fail_merge").run();
  await drainBackfill(processingToken);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_assessments WHERE task='document-relationship'",
      )
      .first(),
  ).toEqual({ count: 1 });
});

it("serializes forward grouping with the pipeline step lease", async () => {
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
  const db = await mf.getD1Database("DB");
  for (let index = 0; index < 2; index += 1) {
    const capture = await saveCapture();
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      `${index ? "SHOP RECEIPT" : "PAYMENT SLIP"} TOTAL 12.34`,
      createdAt,
    );
  }
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "group") break;
  }
  const first = runBackfill(processingToken);
  await relationshipStarted;
  const concurrent = await runBackfill(processingToken);
  expect(concurrent).toMatchObject({
    phase: "group",
    remaining: 1,
    busy: true,
  });
  releaseRelationship();
  expect(await first).toMatchObject({
    phase: "group",
    remaining: 1,
    busy: false,
  });
});

it("retries a merge when a document revision changes during Jev comparison", async () => {
  const processingToken = `rsc_${"w".repeat(43)}`;
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
      return matchingPaymentJevResponse(request);
    },
  });
  const captures = [await saveCapture(), await saveCapture()];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(
      capture,
      `${index ? "SHOP RECEIPT" : "PAYMENT SLIP"} TOTAL 12.34`,
      createdAt,
    );
  }
  const persisted = newDocument(captures[0]);
  const initialSave = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [persisted] }),
  });
  expect(initialSave.status).toBe(200);
  let step: any;
  for (let index = 0; index < 10; index += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "group") break;
  }
  const grouping = runBackfill(processingToken);
  await relationshipStarted;
  const current = await (
    await mf.dispatchFetch(`${origin}/api/documents/${captures[0].id}`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  current.document.vendor = "Owner correction during comparison";
  const changed = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documents: [current.document] }),
  });
  expect(changed.status).toBe(200);
  releaseRelationship();
  expect(await grouping).toMatchObject({
    phase: "group",
    remaining: 1,
    busy: true,
  });
  const beforeRetry = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    beforeRetry.documents.find(
      (document: any) => document.id === captures[0].id,
    ).pages,
  ).toHaveLength(1);

  await drainBackfill(processingToken);
  const afterRetry = await (
    await mf.dispatchFetch(`${origin}/api/documents`, {
      headers: ownerHeaders,
    })
  ).json<any>();
  expect(
    afterRetry.documents.find((document: any) => document.id === captures[1].id)
      .pages,
  ).toHaveLength(2);
});

it("creates only one active pipeline when initial backfill requests overlap", async () => {
  const processingToken = `rsc_${"i".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  await saveCapture();
  const results = await Promise.all([
    runBackfill(processingToken),
    runBackfill(processingToken),
  ]);
  expect(results.every((result) => result.remaining === 1)).toBe(true);
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS count FROM jev_pipeline_runs WHERE phase!='complete'",
      )
      .first(),
  ).toEqual({ count: 1 });
});

it("checkpoints final document classification one document per request", async () => {
  const processingToken = `rsc_${"j".repeat(43)}`;
  await mf.dispose();
  mf = await runtime({
    processingTokenSha256: await processingTokenHash(processingToken),
  });
  const captures = [await saveCapture(), await saveCapture()];
  const db = await mf.getD1Database("DB");
  for (const [index, capture] of captures.entries()) {
    const createdAt = `2026-01-01T00:00:0${index}.000Z`;
    await db
      .prepare("UPDATE captures SET created_at=? WHERE id=?")
      .bind(createdAt, capture.id)
      .run();
    await seedHistoricalOcr(capture, "", createdAt);
  }
  let step: any;
  for (let index = 0; index < 30; index += 1) {
    step = await runBackfill(processingToken);
    if (step.phase === "documents") break;
  }
  expect(step.phase).toBe("documents");
  await runBackfill(processingToken);
  const first = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='documents' LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(first!.cursor).after_id).toBe(captures[0].id);
  await saveCapture(captures[0].id);
  await runBackfill(processingToken);
  const second = await db
    .prepare(
      "SELECT cursor FROM jev_pipeline_runs WHERE phase='documents' LIMIT 1",
    )
    .first<{ cursor: string }>();
  expect(JSON.parse(second!.cursor).after_id).toBe(captures[1].id);
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
  expect(calls).toBe(1);
  const db = await mf.getD1Database("DB");
  expect(
    await db.prepare("SELECT status,run_token FROM jev_jobs").first(),
  ).toEqual({ status: "classified", run_token: null });
  await drainBackfill(processingToken);
  expect(calls).toBe(2);
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
  await drainBackfill(processingToken);
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
