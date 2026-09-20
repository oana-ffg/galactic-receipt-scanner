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
import { pageFingerprint } from "./jev";
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
async function seedJevReady(capture: any, ocrSha256: string) {
  const db = await mf.getD1Database("DB");
  const now = new Date().toISOString();
  const pageAssessment = crypto.randomUUID();
  const roleAssessment = crypto.randomUUID();
  const categoryAssessment = crypto.randomUUID();
  const pins = [{ capture_id: capture.id, ocr_sha256: ocrSha256 }];
  await db.batch([
    db
      .prepare(
        "UPDATE jev_jobs SET status='complete',run_token=NULL,last_error=NULL,updated_at=? WHERE capture_id=? AND ocr_sha256=?",
      )
      .bind(now, capture.id, ocrSha256),
    db
      .prepare(
        "INSERT INTO jev_assessments(id,task,subject_id,model,input_sha256,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        roleAssessment,
        "document-role",
        capture.id,
        "synthetic-jev",
        roleAssessment,
        JSON.stringify({
          input: { pins },
          response: {
            model: "synthetic-jev",
            answers: {
              document_role: {
                type: "choice",
                choice: "purchase_document",
                probabilities: {
                  purchase_document: 1,
                  payment_evidence_only: 0,
                  account_record: 0,
                  cash_withdrawal: 0,
                  misc: 0,
                },
                confidence: 1,
              },
            },
          },
        }),
        now,
      ),
    db
      .prepare(
        "INSERT INTO jev_assessments(id,task,subject_id,model,input_sha256,payload,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        categoryAssessment,
        "purchase-category",
        capture.id,
        "synthetic-jev",
        categoryAssessment,
        JSON.stringify({
          input: { pins, category_ids: {} },
          response: {
            model: "synthetic-jev",
            answers: {
              purchase_category: {
                type: "choice",
                choice: "unresolved",
                probabilities: { unresolved: 1 },
                confidence: 1,
              },
            },
          },
        }),
        now,
      ),
    db
      .prepare(
        "INSERT INTO jev_page_heads(capture_id,source_sha256,ocr_sha256,role,probability,confidence,model,assessment_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        capture.id,
        capture.sha256,
        ocrSha256,
        "receipt",
        1_000_000,
        1_000_000,
        "synthetic-jev",
        pageAssessment,
        now,
      ),
    db
      .prepare(
        "INSERT INTO jev_document_heads(document_id,document_revision,page_fingerprint,role,role_probability,role_confidence,category_id,category_probability,category_confidence,model,assessment_id,category_assessment_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        capture.id,
        0,
        await pageFingerprint(newDocument(capture)),
        "purchase_document",
        1_000_000,
        1_000_000,
        null,
        1_000_000,
        1_000_000,
        "synthetic-jev",
        roleAssessment,
        categoryAssessment,
        now,
      ),
  ]);
}
async function capture(jevReady = true) {
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
  const ocr = await ok(`/api/captures/${id}/artifacts/ocr`, {
    source: {
      captureId: id,
      sha256: c.sha256,
      pixels: [1400, 2200],
      rotation: 0,
      region: { left: 0, top: 0, width: 1400, height: 2200 },
    },
    provenance: { engine: "PP-OCRv6" },
    text: "1 Synthetic item 12,34\nTOTAL 12,34\nVAT 2,47",
  });
  if (jevReady) await seedJevReady(c, ocr.sha256);
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
it("does not offer Luna work until the current layout has a Jev pass", async () => {
  const c = await capture(false);
  expect(await claim()).toBeNull();
  const db = await mf.getD1Database("DB");
  const artifact = await db
    .prepare("SELECT sha256 FROM artifacts WHERE capture_id=? AND kind='ocr'")
    .bind(c.id)
    .first<any>();
  await seedJevReady(c, artifact.sha256);
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO jev_pipeline_runs(id,version,phase,snapshot_created_at,snapshot_capture_id,created_at,updated_at) VALUES(?,3,'group',?,?,?,?)",
    )
    .bind(crypto.randomUUID(), c.created_at, c.id, now, now)
    .run();
  expect(await claim()).toBeNull();
  await db.prepare("UPDATE jev_pipeline_runs SET phase='complete'").run();
  const lease = await claim();
  expect(lease.document.id).toBe(c.id);
});
it("globally gates ready receipts while another current Jev job is unfinished", async () => {
  const ready = await capture();
  const unfinished = await capture(false);
  expect(await claim()).toBeNull();
  const db = await mf.getD1Database("DB");
  const artifact = await db
    .prepare("SELECT sha256 FROM artifacts WHERE capture_id=? AND kind='ocr'")
    .bind(unfinished.id)
    .first<any>();
  await seedJevReady(unfinished, artifact.sha256);
  expect((await claim()).document.id).toBe(ready.id);
});
it("excludes documents already verified by the active local batch", async () => {
  const first = await capture(),
    second = await capture();
  const lease = (
    await ok(
      "/api/processing/claim",
      { stage: "small", exclude_document_ids: [first.id] },
      true,
    )
  ).claim;
  expect(lease.document.id).not.toBe(first.id);
  expect(lease.document.pages.map((page: any) => page.captureId)).toEqual([
    second.id,
  ]);
  await ok("/api/processing/release", { token: lease.token }, true);

  for (const excluded of [
    [first.id, first.id],
    ["not-a-document-id"],
    "not-an-array",
  ])
    expect(
      (
        await req(
          "/api/processing/claim",
          { stage: "small", exclude_document_ids: excluded },
          true,
        )
      ).status,
    ).toBe(400);
});
it("preserves unassessed handwriting on an OCR-first saved receipt", async () => {
  const c = await capture(),
    lease = await claim();
  const e = { ...extraction(), has_handwriting: null };
  expect(extractionErrors(e)).toEqual([]);
  await ok(
    "/api/processing/submit",
    { token: lease.token, model: "gpt-5.6-luna", extraction: e },
    true,
  );
  const saved = (await ok(`/api/documents/${c.id}`)).document;
  expect(saved.handwriting).toBe("unchecked");
  expect(saved.processing.extraction.has_handwriting).toBeNull();
  expect(saved.processing.has_handwriting).toBeNull();
});
it("exposes only token-scoped checkpoint status while preserving blind reading protection", async () => {
  const c = await capture(),
    lease = await claim();
  const path = `/api/processing/readings?document_id=${c.id}`;
  const statusPath = path + `&checkpoint_token=${lease.token}`;
  expect((await req(path, undefined, true)).status).toBe(409);
  expect(await ok(statusPath, undefined, true)).toEqual({
    draft_saved: false,
    attempt_saved: false,
    claim_active: true,
  });
  for (const invalid of ["", "invalid"]) {
    expect(
      (await req(path + `&checkpoint_token=${invalid}`, undefined, true))
        .status,
    ).toBe(400);
  }
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO processing_drafts(token,document_id,revision,model,payload,created_at) VALUES(?,?,1,'gpt-5.6-luna',?,datetime('now'))",
    )
    .bind(
      lease.token,
      c.id,
      JSON.stringify({ private: "Initial reading must not be exposed" }),
    )
    .run();
  expect(await ok(statusPath, undefined, true)).toEqual({
    draft_saved: true,
    attempt_saved: false,
    claim_active: true,
  });
  await db
    .prepare(
      "INSERT INTO processing_attempts(token,document_id,revision,stage,model,payload,created_at) VALUES(?,?,1,'small','gpt-5.6-luna',?,datetime('now'))",
    )
    .bind(
      lease.token,
      c.id,
      JSON.stringify({ private: "Final reading must not be exposed" }),
    )
    .run();
  await db
    .prepare("UPDATE processing_lock SET expires=0 WHERE token=?")
    .bind(lease.token)
    .run();
  expect(await ok(statusPath, undefined, true)).toEqual({
    draft_saved: true,
    attempt_saved: true,
    claim_active: false,
  });
  expect(
    await ok(
      path + `&checkpoint_token=${crypto.randomUUID()}`,
      undefined,
      true,
    ),
  ).toEqual({ draft_saved: false, attempt_saved: false, claim_active: false });
  expect(
    await ok(
      `/api/processing/readings?document_id=${crypto.randomUUID()}&checkpoint_token=${lease.token}`,
      undefined,
      true,
    ),
  ).toEqual({ draft_saved: false, attempt_saved: false, claim_active: false });
  expect((await req(path, undefined, true)).status).toBe(409);
  const unauthenticated = await mf.dispatchFetch(origin + statusPath);
  expect(unauthenticated.status).toBe(401);
});
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
it("archives an unused category while preserving history and rejecting active references", async () => {
  const c = await capture(),
    archived = await category(),
    replacement = await ok("/api/processing/categories", {
      name: "Replacement supplies",
      description: "Synthetic replacement category.",
    }),
    lease = await claim();
  await ok(
    "/api/processing/submit",
    {
      token: lease.token,
      model: "gpt-5.6-luna",
      extraction: extraction(archived),
    },
    true,
  );
  let doc = (await ok(`/api/documents/${c.id}`)).document;
  const categoryRecord = (await ok("/api/processing/categories")).find(
    (value: any) => value.id === archived,
  );
  const archive = {
    id: archived,
    revision: categoryRecord.revision,
    reason: "The owner consolidated this synthetic category.",
  };
  expect(
    (await req("/api/processing/category-archive", archive, true)).status,
  ).toBe(403);
  expect((await req("/api/processing/category-archive", archive)).status).toBe(
    409,
  );
  await ok("/api/processing/category-assignment", {
    document_id: doc.id,
    revision: doc.revision,
    category_id: replacement.id,
    evidence: "Synthetic item belongs to the replacement category.",
  });
  const archivedResult = await ok("/api/processing/category-archive", archive);
  expect(archivedResult).toMatchObject({ id: archived, revision: 1 });
  expect(typeof archivedResult.archived_at).toBe("string");
  expect(
    (await ok("/api/processing/categories")).some(
      (value: any) => value.id === archived,
    ),
  ).toBe(false);
  expect(
    (await ok("/api/processing/categories?include_archived=1")).find(
      (value: any) => value.id === archived,
    ),
  ).toMatchObject({
    id: archived,
    name: "Test supplies",
    archived_at: archivedResult.archived_at,
  });
  expect(
    (
      await req(
        "/api/processing/categories?include_archived=1",
        undefined,
        true,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await req("/api/processing/categories", {
        name: "Test supplies",
        description: "Synthetic test purchases.",
      })
    ).status,
  ).toBe(409);
  const db = await mf.getD1Database("DB"),
    stored = await db
      .prepare("SELECT archived_at FROM purchase_categories WHERE id=?")
      .bind(archived)
      .first<any>(),
    history = await db
      .prepare(
        "SELECT previous,updated,reason FROM purchase_category_revisions WHERE category_id=?",
      )
      .bind(archived)
      .first<any>();
  expect(stored.archived_at).toBe(archivedResult.archived_at);
  expect(JSON.parse(history.previous)).toEqual(categoryRecord);
  expect(JSON.parse(history.updated).archived_at).toBe(
    archivedResult.archived_at,
  );
  expect(history.reason).toBe(archive.reason);
  const nextCapture = await capture(),
    nextLease = await claim();
  expect(nextLease.document.id).toBe(nextCapture.id);
  expect(
    (
      await req(
        "/api/processing/submit",
        {
          token: nextLease.token,
          model: "gpt-5.6-luna",
          extraction: extraction(archived),
        },
        true,
      )
    ).status,
  ).toBe(400);
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
it("retargets merged and duplicate aliases when their retained document is absorbed", async () => {
  const leafCapture = await capture();
  const leafLease = await claim();
  const inheritedReason = "Synthetic leaf source still needs review.";
  await ok(
    "/api/processing/submit",
    {
      token: leafLease.token,
      model: "gpt-5.6-luna",
      extraction: {
        ...extraction(),
        certainty: "medium",
        uncertainties: [inheritedReason],
      },
    },
    true,
  );

  const donorCapture = await capture();
  const donorLease = await claim();
  const donor = (await ok(`/api/documents/${donorCapture.id}`)).document;
  const leaf = (await ok(`/api/documents/${leafCapture.id}`)).document;
  donor.pages.push(...leaf.pages);
  leaf.pages = [];
  leaf.mergedInto = donor.id;
  for (const document of [donor, leaf]) {
    document.evidence = "Synthetic first whole-document merge.";
    document.checks = {
      visual: false,
      transcription: false,
      grouping: false,
      pdf: false,
    };
    document.invoice = null;
    document.reviewedPdfSha256 = null;
  }
  await ok(
    "/api/processing/submit",
    {
      token: donorLease.token,
      model: "gpt-5.6-luna",
      extraction: {
        ...extraction(),
        certainty: "medium",
        uncertainties: [inheritedReason],
      },
      documents: [donor, leaf],
    },
    true,
  );

  const duplicateCapture = await capture();
  const duplicateLease = await claim();
  const duplicate = (await ok(`/api/documents/${duplicateCapture.id}`))
    .document;
  duplicate.duplicateOf = donor.id;
  duplicate.evidence = "Synthetic duplicate relationship.";
  await ok(
    "/api/processing/submit",
    {
      token: duplicateLease.token,
      model: "gpt-5.6-luna",
      extraction: extraction(),
      documents: [duplicate],
    },
    true,
  );

  const targetCapture = await capture();
  const targetLease = await claim();
  const target = (await ok(`/api/documents/${targetCapture.id}`)).document;
  const absorbed = (await ok(`/api/documents/${donorCapture.id}`)).document;
  target.pages.push(...absorbed.pages);
  absorbed.pages = [];
  absorbed.mergedInto = target.id;
  for (const document of [target, absorbed]) {
    document.evidence = "Synthetic second whole-document merge.";
    document.checks = {
      visual: false,
      transcription: false,
      grouping: false,
      pdf: false,
    };
    document.invoice = null;
    document.reviewedPdfSha256 = null;
  }
  const finalSubmit = {
    token: targetLease.token,
    model: "gpt-5.6-luna",
    extraction: extraction(),
    documents: [target, absorbed],
  };
  const result = await ok("/api/processing/submit", finalSubmit, true);
  expect(result.saved).toHaveLength(4);

  const savedTarget = (await ok(`/api/documents/${target.id}`)).document;
  const savedDonor = (await ok(`/api/documents/${absorbed.id}`)).document;
  const savedLeaf = (await ok(`/api/documents/${leaf.id}`)).document;
  const savedDuplicate = (await ok(`/api/documents/${duplicate.id}`)).document;
  expect(savedDonor.mergedInto).toBe(savedTarget.id);
  expect(savedLeaf.mergedInto).toBe(savedTarget.id);
  expect(savedDuplicate.duplicateOf).toBe(savedTarget.id);
  expect(savedTarget.uncertainties).toContain(inheritedReason);
  expect(savedLeaf.pages).toEqual([]);
  expect(savedDuplicate.pages).toHaveLength(1);
  expect(await ok("/api/processing/submit", finalSubmit, true)).toEqual({
    saved: result.saved,
    replayed: true,
  });
  expect((await ok(`/api/documents/${savedDonor.id}`)).document.revision).toBe(
    savedDonor.revision,
  );
  expect((await ok(`/api/documents/${savedLeaf.id}`)).document.revision).toBe(
    savedLeaf.revision,
  );
  expect(
    (await ok(`/api/documents/${savedDuplicate.id}`)).document.revision,
  ).toBe(savedDuplicate.revision);
});
it("replays legacy processing attempts with the safely known primary document", async () => {
  const c = await capture(),
    lease = await claim(),
    request = {
      token: lease.token,
      model: "gpt-5.6-luna",
      extraction: extraction(),
    };
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO processing_attempts(token,document_id,revision,stage,model,payload,created_at) VALUES(?,?,1,'small','gpt-5.6-luna',?,datetime('now'))",
    )
    .bind(lease.token, c.id, JSON.stringify({ request }))
    .run();
  await db
    .prepare("UPDATE processing_lock SET expires=0 WHERE token=?")
    .bind(lease.token)
    .run();
  expect(await ok("/api/processing/submit", request, true)).toEqual({
    saved: [{ id: c.id, revision: 1 }],
    replayed: true,
  });
});
it("rejects alias expansion beyond the 100-document atomic-save limit", async () => {
  const donorCapture = await capture();
  const donorLease = await claim();
  await ok(
    "/api/processing/submit",
    {
      token: donorLease.token,
      model: "gpt-5.6-luna",
      extraction: extraction(),
    },
    true,
  );
  const donor = (await ok(`/api/documents/${donorCapture.id}`)).document;

  const db = await mf.getD1Database("DB");
  const aliases = Array.from({ length: 99 }, () => ({
    ...structuredClone(donor),
    id: crypto.randomUUID(),
    revision: 1,
    pages: [],
    mergedInto: donor.id,
    duplicateOf: null,
    evidence: "Synthetic merged alias evidence.",
  }));
  const at = new Date().toISOString();
  await db.batch(
    aliases.flatMap((alias) => [
      db
        .prepare(
          "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
        )
        .bind(alias.id, alias.revision, JSON.stringify(alias), at),
      db
        .prepare("INSERT INTO document_heads(id,revision) VALUES(?,?)")
        .bind(alias.id, alias.revision),
    ]),
  );

  const targetCapture = await capture();
  const targetLease = await claim();
  const target = (await ok(`/api/documents/${targetCapture.id}`)).document;
  const absorbed = (await ok(`/api/documents/${donor.id}`)).document;
  target.pages.push(...absorbed.pages);
  absorbed.pages = [];
  absorbed.mergedInto = target.id;
  for (const document of [target, absorbed]) {
    document.evidence = "Synthetic over-limit whole-document merge.";
    document.checks = {
      visual: false,
      transcription: false,
      grouping: false,
      pdf: false,
    };
    document.invoice = null;
    document.reviewedPdfSha256 = null;
  }
  const response = await req(
    "/api/processing/submit",
    {
      token: targetLease.token,
      model: "gpt-5.6-luna",
      extraction: extraction(),
      documents: [target, absorbed],
    },
    true,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    detail:
      "The server cannot safely retarget more than 100 affected documents in one merge; preserve the claim for owner-reviewed repair.",
  });
  expect(
    (await ok(`/api/documents/${absorbed.id}`)).document.mergedInto,
  ).toBeNull();
  expect(
    (await ok(`/api/documents/${aliases[0].id}`)).document.mergedInto,
  ).toBe(donor.id);
});
it("targets an awaiting-pages review without falling back to the queue or bypassing the lease", async () => {
  const first = await capture(),
    cat = await category(),
    lease = await claim();
  await ok(
    "/api/processing/submit",
    {
      token: lease.token,
      model: "gpt-5.6-luna",
      extraction: { ...extraction(cat), completeness: "fragment" },
    },
    true,
  );
  const target = (await ok(`/api/documents/${first.id}`)).document;
  expect(target.status).toBe("awaiting-pages");
  await capture(); // An unrelated queued capture must never replace the requested target.
  const request = {
    stage: "large",
    document_id: target.id,
    revision: target.revision,
  };
  for (const invalid of [
    { ...request, stage: "small" },
    { ...request, revision: undefined },
    { ...request, revision: -1 },
    { stage: "large", revision: target.revision },
  ])
    expect((await req("/api/processing/claim", invalid, true)).status).toBe(
      400,
    );
  expect(
    (
      await req(
        "/api/processing/claim",
        { ...request, document_id: crypto.randomUUID() },
        true,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await req(
        "/api/processing/claim",
        { ...request, revision: target.revision + 1 },
        true,
      )
    ).status,
  ).toBe(409);
  expect((await req("/api/processing/claim", request)).status).toBe(403);
  const other = await claim();
  expect((await ok("/api/processing/claim", request, true)).reason).toBe(
    "busy-or-changed",
  );
  await ok("/api/processing/release", { token: other.token }, true);
  const review = (await ok("/api/processing/claim", request, true)).claim;
  expect(review.document.id).toBe(target.id);
  expect(review.document.processing).toBeUndefined();
  expect(await claim()).toBeNull();
  const draft = {
    token: review.token,
    model: "gpt-6-astra",
    extraction: extraction(cat),
  };
  await ok("/api/processing/draft", draft, true);
  await ok("/api/processing/submit", draft, true);
  const corrected = (await ok(`/api/documents/${first.id}`)).document;
  expect(corrected.processing.large_model_confidence).toBe("high");
  expect(corrected.processing.has_human_review).toBe(false);
  const readings = await ok(`/api/processing/readings?document_id=${first.id}`);
  expect(JSON.stringify(readings)).toContain("fragment");
  expect(JSON.stringify(readings)).toContain("gpt-6-astra");
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
  expect(
    (
      await req(
        "/api/processing/claim",
        {
          stage: "large",
          document_id: d.id,
          revision: d.revision,
        },
        true,
      )
    ).status,
  ).toBe(409);
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

it("keeps Astra low when it disagrees with PP even if Astra agrees with Luna", async () => {
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
  expect(d.processing.small_model_certainty).toBe("low");
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
  expect(d.processing.large_model_confidence).toBe("low");
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
it("keeps missing-PP documents out of Astra's automatic queue but permits explicit investigation", async () => {
  const c = await capture(),
    cat = await category(),
    lease = await claim();
  await ok(
    "/api/processing/submit",
    { token: lease.token, model: "gpt-5.6-luna", extraction: extraction(cat) },
    true,
  );
  const db = await mf.getD1Database("DB");
  await db
    .prepare("DELETE FROM artifacts WHERE capture_id=? AND kind='ocr'")
    .bind(c.id)
    .run();
  expect(await claim("large")).toBeNull();
  const document = (await ok(`/api/documents/${c.id}`)).document;
  const investigation = (
    await ok(
      "/api/processing/claim",
      {
        stage: "large",
        document_id: document.id,
        revision: document.revision,
      },
      true,
    )
  ).claim;
  expect(investigation.document.id).toBe(document.id);
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

it("finds an undated exact-amount receipt for a slip and exposes chronological predecessors", async () => {
  const receipt = await capture();
  const first = await claim();
  await ok(
    "/api/processing/submit",
    {
      token: first.token,
      model: "gpt-5.6-luna",
      extraction: { ...extraction(), receipt_date: null, currency: null },
    },
    true,
  );
  const slip = await capture();
  const second = await claim();
  expect(second.document.id).toBe(slip.id);
  const base = `/api/processing/context?token=${second.token}`;
  const context = await ok(
    base + "&date=2026-01-02&total_minor=1234&currency=DKK",
    undefined,
    true,
  );
  expect(context.candidates.map((d: any) => d.id)).toContain(receipt.id);
  expect(context.previous_images.map((c: any) => c.id)).toEqual([receipt.id]);
  expect(context.next_images).toEqual([]);
  const different = await ok(
    base + "&date=2026-01-02&total_minor=1235&currency=DKK",
    undefined,
    true,
  );
  expect(different.candidates).toEqual([]);
});

it("never treats a known conflicting currency or distant known date as a missing-field candidate", async () => {
  const receipt = await capture();
  const first = await claim();
  await ok(
    "/api/processing/submit",
    { token: first.token, model: "gpt-5.6-luna", extraction: extraction() },
    true,
  );
  await capture();
  const second = await claim();
  const base = `/api/processing/context?token=${second.token}&total_minor=1234`;
  for (const filter of [
    "&date=2026-01-02&currency=EUR",
    "&date=2026-02-01&currency=DKK",
  ]) {
    const context = await ok(base + filter, undefined, true);
    expect(context.candidates.map((d: any) => d.id)).not.toContain(receipt.id);
  }
});
