import { compareOcrNumbers } from "./ocr-comparison";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { processingRoute } from "./processing";
import {
  arithmetic,
  extractionErrors,
  extractionProblems,
  type Extraction,
} from "../web/extraction";
import { newDocument } from "../web/documents";
import type { Env } from "./index";
let mf: Awaited<ReturnType<typeof runtime>>;
const token = "rsc_" + "a".repeat(43);
beforeEach(async () => {
  mf = await runtime({
    processingTokenSha256: Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  });
}, 30000);
afterEach(async () => {
  await mf?.dispose();
});
async function req(path: string, body?: unknown, machine = false) {
  return mf.dispatchFetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...(machine ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function ok(path: string, body?: unknown, machine = false): Promise<any> {
  const r = await req(path, body, machine);
  const value = await r.json();
  expect(r.status, JSON.stringify(value)).toBe(200);
  return value;
}
async function capture() {
  const id = crypto.randomUUID();
  const r = await mf.dispatchFetch(origin + `/api/captures/${id}`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1400, 2200],
        quality: { ok: true, receiptPixels: [1400, 2200] },
      }),
    },
    body: new Uint8Array([255, 216, 255, Math.floor(Math.random() * 255)]),
  });
  expect(r.status).toBe(200);
  const c = await r.json();
  await ok(`/api/captures/${id}/artifacts/ocr`, {
    source: { captureId: id, sha256: c.sha256 },
    provenance: { engine: "tesseract.js synthetic fixture" },
    text: "1 Synthetic item 12,34\nTOTAL 12,34\nVAT 2,47",
  });
  return c;
}
function extraction(category: string | null = null): Extraction {
  return {
    type: "receipt",
    vendor: "Synthetic shop",
    receipt_date: "2026-01-02",
    reference: "TEST-123",
    currency: "DKK",
    has_handwriting: false,
    has_payment_slip: true,
    payment_status: "approved",
    card_last_four: "1234",
    line_items: [
      {
        description: "Synthetic item",
        quantity: 1,
        unit_price_minor: 1234,
        amount_minor: 1234,
      },
    ],
    adjustments: [],
    total_minor: 1234,
    charged_total_minor: 1234,
    payment_adjustments: [],
    vat_minor: 247,
    tax_basis: "gross",
    completeness: "complete",
    category_id: category,
    certainty: "high",
    uncertainties: [],
    broken_reasons: [],
    confirmed_arithmetic_mismatch: false,
    evidence: "Synthetic complete printed source.",
  };
}
async function category() {
  return (
    await ok("/api/processing/categories", {
      name: "Test supplies",
      description: "Synthetic test purchases.",
    })
  ).id;
}
async function claim(stage = "small") {
  return (await ok("/api/processing/claim", { stage }, true)).claim;
}
it("preserves category definition history and rejects machine edits and stale revisions", async () => {
  const id = await category();
  const previous = (await ok("/api/processing/categories")).find(
    (c: any) => c.id === id,
  );
  const update = {
    id,
    revision: previous.revision,
    name: "Updated supermarket category",
    description: "Explicit cat food plus personal groceries.",
    reason: "Owner split the mixed category.",
  };
  expect((await req("/api/processing/categories", update, true)).status).toBe(
    403,
  );
  const updated = await ok("/api/processing/categories", update);
  expect(updated.revision).toBe(1);
  expect((await req("/api/processing/categories", update)).status).toBe(409);
  const db = await mf.getD1Database("DB");
  const history = await db
    .prepare(
      "SELECT previous,updated,reason FROM purchase_category_revisions WHERE category_id=?",
    )
    .bind(id)
    .first<any>();
  expect(JSON.parse(history.previous)).toEqual(previous);
  expect(JSON.parse(history.updated)).toEqual(updated);
  expect(history.reason).toBe(update.reason);
});
it("corrects only the category, preserving financial values, model readings and review status", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  const initial = extraction(cat);
  await ok(
    "/api/processing/submit",
    { token: lease.token, model: "gpt-5.6-luna", extraction: initial },
    true,
  );
  let doc = (await ok(`/api/documents/${c.id}`)).document;
  await ok("/api/processing/human-review", {
    document_id: doc.id,
    revision: doc.revision,
    extraction: initial,
  });
  doc = (await ok(`/api/documents/${c.id}`)).document;
  const target = await ok("/api/processing/categories", {
    name: "Explicit cat mix",
    description: "Cat treats and personal groceries.",
  });
  const correction = {
    document_id: doc.id,
    revision: doc.revision,
    category_id: target.id,
    evidence: "Cat treats plus tomatoes.",
  };
  expect(
    (await req("/api/processing/category-assignment", correction, true)).status,
  ).toBe(403);
  expect(
    (
      await req("/api/processing/category-assignment", {
        ...correction,
        category_id: "missing",
      })
    ).status,
  ).toBe(400);
  await ok("/api/processing/category-assignment", correction);
  const after = (await ok(`/api/documents/${c.id}`)).document;
  expect(after.processing.extraction).toEqual({
    ...doc.processing.extraction,
    category_id: target.id,
  });
  expect(after.processing).toEqual({
    ...doc.processing,
    extraction: after.processing.extraction,
    human_review_revision: after.revision,
  });
  expect(after.pages).toEqual(doc.pages);
  expect(after.checks).toEqual(doc.checks);
  expect(after.evidence).toContain(correction.evidence);
  expect(
    (await req("/api/processing/category-assignment", correction)).status,
  ).toBe(409);
  const readings = await ok(`/api/processing/readings?document_id=${doc.id}`);
  expect(
    readings.attempts.every((r: any) => r.extraction.category_id === cat),
  ).toBe(true);
});
it("allows one claim, saves structured amounts atomically, and makes retries idempotent", async () => {
  const c = await capture(),
    cat = await category();
  const results = await Promise.all([claim(), claim()]);
  const first = results.find(Boolean)!;
  expect(results.filter(Boolean)).toHaveLength(1);
  const body = {
    token: first.token,
    model: "gpt-5.6-luna",
    extraction: extraction(cat),
  };
  await ok("/api/processing/submit", body, true);
  expect((await ok("/api/processing/submit", body, true)).replayed).toBe(true);
  expect(
    (
      await req(
        "/api/processing/submit",
        { ...body, extraction: { ...body.extraction, total_minor: 12 } },
        true,
      )
    ).status,
  ).toBe(409);
  const d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing).toMatchObject({
    small_model_certainty: "high",
    large_model_confidence: null,
    has_human_review: false,
    not_invoice: false,
  });
  expect(d.filename).toBe("2026-01-02_synthetic_shop.pdf");
  expect(d.scannedAt).toEqual([c.created_at]);
  expect(await claim()).toBeNull();
  expect(await claim("large")).toBeNull();
  expect((await req(`/api/files/${c.id}/raw`)).status).toBe(200);
});
it("checks all receipts even at high certainty, gates Astra comparison, preserves blind parses", async () => {
  const c = await capture(),
    cat = await category(),
    small = await claim();
  const e = {
    ...extraction(cat),
    total_minor: 1300,
    charged_total_minor: 1300,
  };
  await ok(
    "/api/processing/submit",
    { token: small.token, model: "gpt-5.6-luna", extraction: e },
    true,
  );
  expect((await ok(`/api/documents/${c.id}`)).document.status).toBe(
    "model-review",
  );
  const large = await claim("large");
  expect(large.document.processing).toBeUndefined();
  expect((await req(`/api/documents/${c.id}`, undefined, true)).status).toBe(
    409,
  );
  expect(
    (await req(`/api/processing/context?token=${large.token}`, undefined, true))
      .status,
  ).toBe(409);
  const draft = {
    token: large.token,
    model: "gpt-6-astra",
    extraction: extraction(cat),
  };
  await ok("/api/processing/draft", draft, true);
  expect(
    (await req("/api/processing/draft", { ...draft, extraction: e }, true))
      .status,
  ).toBe(409);
  const compare = await ok(
    `/api/processing/context?token=${large.token}`,
    undefined,
    true,
  );
  expect(compare.document.processing.extraction.total_minor).toBe(1300);
  expect(compare.independent_parse.total_minor).toBe(1234);
  await ok("/api/processing/submit", draft, true);
  expect(
    (await ok(`/api/documents/${c.id}`)).document.processing
      .large_model_confidence,
  ).toBe("high");
  const db = await mf.getD1Database("DB");
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM processing_drafts").first()).n,
  ).toBe(1);
});
it("requires interactive human approval and invalidates it when an old client edits fields", async () => {
  const c = await capture(),
    cat = await category(),
    small = await claim();
  await ok(
    "/api/processing/submit",
    {
      token: small.token,
      model: "gpt-5.6-luna",
      extraction: { ...extraction(cat), certainty: "low" },
    },
    true,
  );
  let d = (await ok(`/api/documents/${c.id}`)).document;
  const body = {
    document_id: d.id,
    revision: d.revision,
    extraction: extraction(cat),
  };
  expect((await req("/api/processing/human-review", body, true)).status).toBe(
    403,
  );
  await ok("/api/processing/human-review", body);
  d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing.has_human_review).toBe(true);
  expect(d.processing.human_review_revision).toBe(d.revision);
  const saved = await ok(`/api/processing/readings?document_id=${c.id}`);
  expect(saved.attempts.map((a: any) => a.stage)).toEqual(["human", "small"]);
  expect(saved.attempts[0].extraction).toEqual(body.extraction);
  expect(saved.attempts[1].extraction.certainty).toBe("low");
  expect((await req("/api/processing/human-review", body)).status).toBe(409);
  expect(
    (await ok(`/api/processing/readings?document_id=${c.id}`)).attempts,
  ).toHaveLength(2);
  const forged = structuredClone(d);
  forged.processing.small_model_certainty = "high";
  expect((await req("/api/documents", { documents: [forged] })).status).toBe(
    400,
  );
  delete d.processing;
  d.vendor = "Edited synthetic shop";
  await ok("/api/documents", { documents: [d] });
  d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing).toMatchObject({
    has_human_review: false,
    human_review_revision: null,
    needs_reparse: true,
  });
});
it("rolls back document and provenance writes when a lease expires after the initial read", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  const db = await mf.getD1Database("DB");
  const wrapped = {
    prepare: db.prepare.bind(db),
    batch: async (statements: any[]) => {
      await db.prepare("UPDATE processing_lock SET expires=0").run();
      return db.batch(statements);
    },
  };
  await expect(
    processingRoute(
      new Request(origin + "/api/processing/submit", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          token: lease.token,
          model: "gpt-5.6-luna",
          extraction: extraction(cat),
        }),
      }),
      { DB: wrapped, BUCKET: await mf.getR2Bucket("BUCKET") } as unknown as Env,
      async () => [{ ...c, is_current: true }],
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM document_versions").first()).n,
  ).toBe(0);
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM processing_attempts").first())
      .n,
  ).toBe(0);
  expect(
    (await db.prepare("SELECT COUNT(*) AS n FROM processing_commits").first())
      .n,
  ).toBe(0);
  expect((await req(`/api/files/${c.id}/raw`)).status).toBe(200);
});
it("detaches atomically, preserves originals and suppresses a rejected reattachment", async () => {
  const a = await capture(),
    b = await capture(),
    cat = await category(),
    lease = await claim();
  const target = newDocument(a);
  target.pages.push(...newDocument(b).pages);
  await ok(
    "/api/processing/submit",
    {
      token: lease.token,
      model: "gpt-5.6-luna",
      extraction: extraction(cat),
      documents: [target],
    },
    true,
  );
  const d = (await ok(`/api/documents/${a.id}`)).document;
  await ok("/api/processing/detach", {
    document_id: a.id,
    revision: d.revision,
    capture_id: b.id,
    reason: "Synthetic mismatching transaction reference.",
  });
  const source = (await ok(`/api/documents?captureId=${b.id}`)).document;
  expect(source.id).not.toBe(a.id);
  expect(source.pages[0].captureId).toBe(b.id);
  expect((await req(`/api/files/${b.id}/raw`)).status).toBe(200);
  const again = await claim();
  const fresh = (
    await ok(`/api/processing/context?token=${again.token}`, undefined, true)
  ).document;
  expect(fresh.id).toBe(a.id);
  fresh.pages.push(...source.pages);
  source.pages = [];
  source.mergedInto = fresh.id;
  source.evidence = "Synthetic attempted rematch.";
  expect(
    (
      await req(
        "/api/processing/submit",
        {
          token: again.token,
          model: "gpt-5.6-luna",
          extraction: extraction(cat),
          documents: [fresh, source],
        },
        true,
      )
    ).status,
  ).toBe(409);
});
it("keeps incomplete pages out of human review and retries them after new scans", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  await ok(
    "/api/processing/submit",
    {
      token: lease.token,
      model: "gpt-5.6-luna",
      extraction: {
        ...extraction(cat),
        completeness: "fragment",
        certainty: "medium",
      },
    },
    true,
  );
  expect((await ok(`/api/documents/${c.id}`)).document.status).toBe(
    "awaiting-pages",
  );
  expect(await claim()).toBeNull();
  expect(await claim("large")).toBeNull();
  const next = await capture();
  const n = await claim();
  expect(n.document.id).toBe(next.id);
  await ok(
    "/api/processing/submit",
    { token: n.token, model: "gpt-5.6-luna", extraction: extraction(cat) },
    true,
  );
  expect((await claim()).document.id).toBe(c.id);
});
it("uses integer amounts, keeps included VAT separate and reconciles payment fees", () => {
  const e = extraction();
  expect(extractionErrors(e)).toEqual([]);
  expect(arithmetic(e)).toMatchObject({
    status: "matched",
    difference: 0,
    paymentDifference: 0,
  });
  e.charged_total_minor = 1250;
  e.payment_adjustments = [
    { description: "Printed card fee", amount_minor: 16 },
  ];
  expect(arithmetic(e).paymentDifference).toBe(0);
  e.line_items[0].amount_minor = 12.34;
  expect(extractionErrors(e).length).toBeGreaterThan(0);
});

it("adds signed VAT once to net invoice lines and requires the printed tax amount", () => {
  const e = extraction();
  e.type = "invoice";
  e.tax_basis = "net-plus-tax";
  e.line_items[0].amount_minor = 10000;
  e.adjustments = [{ description: "Net discount", amount_minor: -1000 }];
  e.vat_minor = 2250;
  e.total_minor = e.charged_total_minor = 11250;
  expect(arithmetic(e)).toMatchObject({
    status: "matched",
    difference: 0,
    paymentDifference: 0,
  });
  e.vat_minor = null;
  expect(arithmetic(e)).toMatchObject({
    status: "incomplete",
    difference: null,
  });
  expect(extractionProblems(e)).toContain(
    "Printed line amounts cannot yet be fully reconciled.",
  );
  e.confirmed_arithmetic_mismatch = true;
  expect(extractionErrors(e)).toContain(
    "A confirmed mismatch requires a complete financial source with a real arithmetic discrepancy.",
  );
  e.confirmed_arithmetic_mismatch = false;
  e.vat_minor = 0;
  e.total_minor = e.charged_total_minor = 9000;
  expect(arithmetic(e).status).toBe("matched");
  e.vat_minor = 2250;
  e.total_minor = e.charged_total_minor = 11251;
  expect(arithmetic(e).difference).toBe(-1);
  e.type = "credit-note";
  e.line_items[0].amount_minor = -10000;
  e.adjustments = [{ description: "Reversed discount", amount_minor: 1000 }];
  e.vat_minor = -2250;
  e.total_minor = e.charged_total_minor = -11250;
  expect(arithmetic(e).status).toBe("matched");
});

it("downgrades OCR disagreement without correcting the model and lets Astra resolve it from pixels", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  const e = extraction(cat);
  e.line_items[0].amount_minor = 1294;
  e.line_items[0].unit_price_minor = 1294;
  e.total_minor = 1294;
  e.charged_total_minor = 1294;
  await ok(
    "/api/processing/submit",
    { token: lease.token, model: "gpt-5.6-luna", extraction: e },
    true,
  );
  let d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing.small_model_certainty).toBe("medium");
  expect(d.processing.extraction.total_minor).toBe(1294);
  expect(d.processing.ocr_comparison.status).toBe("disagreement");
  const large = await claim("large");
  await ok(
    "/api/processing/draft",
    { token: large.token, model: "gpt-6-astra", extraction: e },
    true,
  );
  await ok(
    "/api/processing/submit",
    {
      token: large.token,
      model: "gpt-6-astra",
      extraction: e,
      ocr_resolution:
        "Synthetic visual reread confirms 12.94; OCR confused the 9 with a 3.",
    },
    true,
  );
  d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing.large_model_confidence).toBe("high");
  expect(d.processing.extraction.total_minor).toBe(1294);
  expect(d.processing.ocr_comparison.resolution).toContain("visual reread");
});

it("does not accept a wrong total merely because it occurs on another OCR line", () => {
  const e = extraction();
  e.total_minor = 2500;
  expect(
    compareOcrNumbers(e, "1 Synthetic item 25,00\nTOTAL 12,34\nVAT 2,47").some(
      (p) => p.startsWith("Printed total"),
    ),
  ).toBe(true);
});

it("treats unaligned or reused OCR lines as uncertainty", () => {
  const e = extraction();
  e.line_items.push(structuredClone(e.line_items[0]));
  expect(
    compareOcrNumbers(e, "1 Synthetic item 12,34\nTOTAL 12,34\nVAT 2,47").some(
      (p) => p.includes("Line 2 cannot be aligned"),
    ),
  ).toBe(true);
  e.line_items = [{ ...e.line_items[0], description: "Different product" }];
  expect(
    compareOcrNumbers(e, "1 Unrelated product 12,34\nTOTAL 12,34").length,
  ).toBeGreaterThan(0);
});
it("does not let Astra override missing ordinary OCR or browsers forge model provenance", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  const db = await mf.getD1Database("DB");
  await db
    .prepare("DELETE FROM artifacts WHERE capture_id=? AND kind='ocr'")
    .bind(c.id)
    .run();
  await ok(
    "/api/processing/submit",
    { token: lease.token, model: "gpt-5.6-luna", extraction: extraction(cat) },
    true,
  );
  const large = await claim("large");
  expect(
    (
      await req(
        "/api/processing/draft",
        {
          token: large.token,
          model: "gpt-5.6-luna",
          extraction: extraction(cat),
        },
        true,
      )
    ).status,
  ).toBe(400);
  await ok(
    "/api/processing/draft",
    { token: large.token, model: "gpt-6-astra", extraction: extraction(cat) },
    true,
  );
  await ok(
    "/api/processing/submit",
    {
      token: large.token,
      model: "gpt-6-astra",
      extraction: extraction(cat),
      ocr_resolution:
        "There is no OCR, so this cannot establish numeric agreement.",
    },
    true,
  );
  const d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing.large_model_confidence).toBe("medium");
  expect(d.status).toBe("review");
  expect((await req("/api/processing/claim", { stage: "small" })).status).toBe(
    403,
  );
});
it("pins PDF attestation to current pages/hash and approves humans only at the final revision", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  await ok(
    "/api/processing/submit",
    { token: lease.token, model: "gpt-5.6-luna", extraction: extraction(cat) },
    true,
  );
  let d = (await ok(`/api/documents/${c.id}`)).document;
  const upload = await mf.dispatchFetch(
    origin + `/api/documents/${c.id}/pdf?revision=${d.revision}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: "%PDF-synthetic-test-artifact",
    },
  );
  expect(upload.status).toBe(200);
  const artifact = await upload.json();
  expect(
    (
      await req(
        "/api/processing/pdf-review",
        {
          document_id: d.id,
          revision: d.revision,
          sha256: "f".repeat(64),
          evidence: "Synthetic inspection.",
        },
        true,
      )
    ).status,
  ).toBe(400);
  await ok(
    "/api/processing/pdf-review",
    {
      document_id: d.id,
      revision: d.revision,
      sha256: artifact.sha256,
      evidence: "Synthetic PDF inspected.",
    },
    true,
  );
  d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.checks.pdf).toBe(true);
  await ok("/api/processing/human-review", {
    document_id: d.id,
    revision: d.revision,
    extraction: extraction(cat),
  });
  d = (await ok(`/api/documents/${c.id}`)).document;
  expect(d.processing.human_review_revision).toBe(d.revision);
  expect(d.checks.pdf).toBe(true);
  expect(d.status).toBe("ready");
  await ok(
    "/api/processing/pdf-review",
    {
      document_id: d.id,
      revision: d.revision,
      sha256: artifact.sha256,
      evidence: "Another actual synthetic inspection.",
    },
    true,
  );
  expect(
    (await ok(`/api/documents/${c.id}`)).document.processing.has_human_review,
  ).toBe(false);
});
