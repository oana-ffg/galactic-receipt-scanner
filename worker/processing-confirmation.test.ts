import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import type { Extraction } from "../web/extraction";

let mf: Awaited<ReturnType<typeof runtime>>;
const accessToken = "rsc_" + "q".repeat(43);
const hash = (character: string) => character.repeat(64);

beforeEach(async () => {
  const encoded = new TextEncoder().encode(accessToken);
  const tokenHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  mf = await runtime({ processingTokenSha256: tokenHash });
}, 30_000);

afterEach(async () => mf?.dispose());

async function request(path: string, body?: unknown, machine = true) {
  return mf.dispatchFetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...(machine ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok(path: string, body?: unknown, machine = true): Promise<any> {
  const response = await request(path, body, machine);
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value;
}

function reading(total = 1234, categoryId: string | null = null): Extraction {
  return {
    type: "receipt",
    vendor: "Checkpoint Shop",
    receipt_date: "2026-09-14",
    reference: "CONFIRM-1",
    currency: "DKK",
    has_handwriting: false,
    has_payment_slip: false,
    payment_status: "approved",
    card_last_four: "1234",
    line_items: [
      {
        description: "Synthetic item",
        quantity: 1,
        unit_price_minor: total,
        amount_minor: total,
      },
    ],
    adjustments: [],
    total_minor: total,
    charged_total_minor: total,
    payment_adjustments: [],
    vat_minor: 247,
    tax_basis: "gross",
    completeness: "complete",
    category_id: categoryId,
    certainty: "high",
    uncertainties: [],
    broken_reasons: [],
    confirmed_arithmetic_mismatch: false,
    evidence: "Synthetic pixels read independently.",
  };
}

async function capture() {
  const id = crypto.randomUUID();
  const response = await mf.dispatchFetch(origin + `/api/captures/${id}`, {
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
    body: new Uint8Array([255, 216, 255, 42]),
  });
  expect(response.status).toBe(200);
  const saved = await response.json<any>();
  await ok(
    `/api/captures/${id}/artifacts/ocr`,
    {
      source: {
        captureId: id,
        sha256: saved.sha256,
        pixels: [1400, 2200],
        region: { left: 0, top: 0, width: 1400, height: 2200 },
      },
      provenance: { engine: "tesseract.js synthetic fixture" },
      text: "1 Synthetic item 12,34\nTOTAL 12,34\nVAT 2,47",
    },
    false,
  );
  return saved;
}

async function claim(stage: "small" | "large", reviewAll = false) {
  return (
    await ok("/api/processing/claim", {
      stage,
      ...(reviewAll ? { review_all: true } : {}),
    })
  ).claim;
}

it("pins PP evidence without Qwen and preserves first-pass readings through submission", async () => {
  const source = await capture();
  const lease = await claim("small");
  const document = (await ok(`/api/documents/${source.id}`, undefined, false))
    .document;
  document.pages[0].crop = [0, 0, 1400, 2200];
  const initial = reading();
  initial.line_items = [];
  initial.uncertainties = ["Detailed financial verification deferred"];
  await ok("/api/processing/draft", {
    token: lease.token,
    model: "gpt-5.6-luna",
    extraction: initial,
    documents: [document],
    pixel_pdf_sha256: hash("a"),
    images: [{ sha256: hash("b"), pixels: [1400, 2200] }],
  });
  const artifact = {
    source: {
      captureId: source.id,
      sha256: source.sha256,
      pixels: [1400, 2200],
      region: { left: 0, top: 0, width: 1400, height: 2200 },
      rotation: 0,
    },
    provenance: { engine: "PP-OCRv6" },
    text: "Checkpoint Shop\n2026-09-14\nTOTAL 12,34\nVAT 2,47",
  };
  const wrong = await ok(
    `/api/captures/${source.id}/artifacts/ocr`,
    { ...artifact, source: { ...artifact.source, rotation: 90 } },
    false,
  );
  const confirmation = {
    token: lease.token,
    provider: "ppocr",
    pixel_pdf_sha256: hash("a"),
    artifacts: [{ capture_id: source.id, sha256: wrong.sha256 }],
  };
  const rejected = await request("/api/processing/confirmation", confirmation);
  expect(rejected.status, await rejected.text()).toBe(409);
  const saved = await ok(
    `/api/captures/${source.id}/artifacts/ocr`,
    artifact,
    false,
  );
  confirmation.artifacts[0].sha256 = saved.sha256;
  const confirmed = await ok("/api/processing/confirmation", confirmation);
  expect(confirmed.qwen).toBeUndefined();
  expect(confirmed.ppocr.artifacts).toEqual(confirmation.artifacts);
  expect(confirmed.evidence.initial_ocr.artifacts).toEqual(
    confirmation.artifacts,
  );
  const revised = { ...initial, vendor: "Checkpoint Shop corrected" };
  await ok("/api/processing/submit", {
    token: lease.token,
    model: "gpt-5.6-luna",
    extraction: revised,
    documents: [document],
    assessment: {
      confirmation_sha256: confirmed.sha256,
      rationale:
        "Corrected vendor spelling from pixels after PP evidence; finance remains deferred.",
      changed_fields: ["vendor"],
    },
  });
  expect(
    (await ok("/api/processing/confirmation", confirmation)).replayed,
  ).toBe(true);
  expect(
    (
      await request("/api/processing/confirmation", {
        ...confirmation,
        pixel_pdf_sha256: hash("c"),
      })
    ).status,
  ).toBe(409);
  const db = await mf.getD1Database("DB");
  const draft = await db
    .prepare("SELECT payload FROM processing_drafts WHERE token=?")
    .bind(lease.token)
    .first<any>();
  const final = (await ok(`/api/documents/${source.id}`, undefined, false))
    .document;
  expect(JSON.parse(draft.payload).extraction.vendor).toBe(initial.vendor);
  expect(final.processing.extraction.vendor).toBe(revised.vendor);
  expect(final.processing.extraction.uncertainties).toContain(
    "Detailed financial verification deferred",
  );
});

it("stores immutable ordered Luna, Qwen, and reassessed readings", async () => {
  const source = await capture();
  const lease = await claim("small");
  const document = (await ok(`/api/documents/${source.id}`, undefined, false))
    .document;
  document.pages[0].crop = [0, 0, 1400, 2200];
  const initial = reading();
  const draft = {
    token: lease.token,
    model: "gpt-5.6-luna",
    extraction: initial,
    documents: [document],
    pixel_pdf_sha256: hash("a"),
    images: [{ sha256: hash("b"), pixels: [1400, 2200] }],
  };
  await ok("/api/processing/draft", draft);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE processing_lock SET expires=0 WHERE token=?")
    .bind(lease.token)
    .run();
  expect((await ok("/api/processing/draft", draft)).replayed).toBe(true);
  expect(
    (
      await request("/api/processing/draft", {
        ...draft,
        extraction: reading(999),
      })
    ).status,
  ).toBe(409);
  await db
    .prepare(
      "UPDATE processing_lock SET expires=unixepoch()*1000+1200000 WHERE token=?",
    )
    .bind(lease.token)
    .run();

  const qwen = reading(1299);
  qwen.category_id = null;
  const confirmation = {
    token: lease.token,
    model: "qwen3-vl:8b-instruct",
    model_digest: hash("c"),
    prompt_sha256: hash("d"),
    schema_sha256: hash("e"),
    runtime_version: "0.12.0",
    pixel_pdf_sha256: draft.pixel_pdf_sha256,
    images: draft.images,
    options: { temperature: 0, num_predict: 6000 },
    extraction: qwen,
    done_reason: "stop",
    elapsed_seconds: 1.5,
  };
  const savedConfirmation = await ok(
    "/api/processing/confirmation",
    confirmation,
  );
  expect(savedConfirmation.evidence.differing_fields).toContain("total_minor");
  await db
    .prepare("UPDATE processing_lock SET expires=0 WHERE token=?")
    .bind(lease.token)
    .run();
  const replayedConfirmation = await ok(
    "/api/processing/confirmation",
    confirmation,
  );
  expect(replayedConfirmation.replayed).toBe(true);
  expect(replayedConfirmation.sha256).toBe(savedConfirmation.sha256);
  expect(
    (
      await request("/api/processing/confirmation", {
        ...confirmation,
        elapsed_seconds: 2,
      })
    ).status,
  ).toBe(409);
  await db
    .prepare(
      "UPDATE processing_lock SET expires=unixepoch()*1000+1200000 WHERE token=?",
    )
    .bind(lease.token)
    .run();

  const final = reading(1299);
  const assessment = {
    confirmation_sha256: savedConfirmation.sha256,
    rationale: "The independent pixels support the corrected printed amount.",
    changed_fields: ["line_items", "total_minor", "charged_total_minor"],
  };
  const changedLayout = structuredClone(document);
  changedLayout.pages[0].crop = [1, 0, 1400, 2200];
  expect(
    (
      await request("/api/processing/submit", {
        token: lease.token,
        model: "gpt-5.6-luna",
        extraction: final,
        documents: [changedLayout],
        assessment,
      })
    ).status,
  ).toBe(409);
  const submit = {
    token: lease.token,
    model: "gpt-5.6-luna",
    extraction: final,
    documents: [document],
    assessment,
  };
  await ok("/api/processing/submit", submit);
  expect((await ok("/api/processing/submit", submit)).replayed).toBe(true);

  expect(
    (
      await request(
        `/api/processing/readings?document_id=${source.id}`,
        undefined,
        true,
      )
    ).status,
  ).toBe(409);

  const readings = (
    await ok(
      `/api/processing/readings?document_id=${source.id}`,
      undefined,
      false,
    )
  ).readings;
  expect(readings).toHaveLength(1);
  expect(readings[0].initial.extraction.total_minor).toBe(1234);
  expect(readings[0].confirmation.qwen.extraction.total_minor).toBe(1299);
  expect(readings[0].updated.extraction.total_minor).toBe(1299);
  expect(readings[0].updated.assessment.confirmation_sha256).toBe(
    savedConfirmation.sha256,
  );
  expect(
    (await ok(`/api/documents/${source.id}`, undefined, false)).document
      .processing.extraction.total_minor,
  ).toBe(1299);
});

it("keeps legacy Luna submission and Astra draft flow compatible", async () => {
  const source = await capture();
  const category = (
    await ok("/api/processing/categories", {
      name: "Confirmation fixtures",
      description: "Synthetic confirmation workflow purchases.",
    })
  ).id;
  const small = await claim("small");
  await ok("/api/processing/submit", {
    token: small.token,
    model: "gpt-5.6-luna",
    extraction: reading(1234, category),
  });
  expect(await claim("large")).toBeNull();
  const large = await claim("large", true);
  expect(large.document.id).toBe(source.id);
  const astraDraft = {
    token: large.token,
    model: "gpt-6-astra",
    extraction: reading(1234, category),
  };
  await ok("/api/processing/draft", astraDraft);
  expect((await ok("/api/processing/draft", astraDraft)).saved).toBe(true);
  await ok("/api/processing/submit", astraDraft);
  const saved = (await ok(`/api/documents/${source.id}`, undefined, false))
    .document;
  expect(saved.processing.large_model_confidence).toBe("high");
});

it("accepts a frozen duplicate disposition without losing either source", async () => {
  const first = await capture();
  const second = await capture();
  const lease = await claim("small");
  expect(lease.document.id).toBe(first.id);
  const target = (await ok(`/api/documents/${first.id}`, undefined, false))
    .document;
  const original = (await ok(`/api/documents/${second.id}`, undefined, false))
    .document;
  target.duplicateOf = second.id;
  target.pages[0].crop = [0, 0, 1400, 2200];
  await ok("/api/processing/draft", {
    token: lease.token,
    model: "gpt-5.6-luna",
    extraction: reading(),
    documents: [target, original],
    pixel_pdf_sha256: hash("f"),
    images: [{ sha256: hash("1"), pixels: [1400, 2200] }],
  });
});
