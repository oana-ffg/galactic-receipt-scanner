import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import {
  loadPurchaseCategoryChoices,
  jevSummary,
  mergeDocuments,
  pageFingerprint,
  prepareJevMerge,
  shouldAutoMerge,
} from "./jev";
import { ocrArtifactMatchesPage } from "../web/ocr-data";

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
