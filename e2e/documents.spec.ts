import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import { pageFingerprint } from "../worker/jev";
const processorToken = "rsc_" + "s".repeat(43);
let isolated: Awaited<ReturnType<typeof runtime>>;
test.beforeEach(async ({ page }) => {
  isolated = await runtime({
    processingTokenSha256: createHash("sha256")
      .update(processorToken)
      .digest("hex"),
  });
  await page.route(`${origin}/**`, async (route) => {
    const req = route.request();
    const response = await isolated.dispatchFetch(req.url(), {
      method: req.method(),
      headers: { ...req.headers(), ...ownerHeaders },
      body: req.postDataBuffer() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  await isolated?.dispose();
});
const isolatedRequest = {
  async post(
    path: string,
    options: { data: Buffer; headers: Record<string, string> },
  ) {
    const r = await isolated.dispatchFetch(origin + path, {
      method: "POST",
      body: options.data,
      headers: { ...options.headers, ...ownerHeaders },
    });
    return { ok: () => r.ok };
  },
  async get(path: string) {
    const r = await isolated.dispatchFetch(origin + path, {
      headers: ownerHeaders,
    });
    return {
      ok: () => r.ok,
      body: async () => Buffer.from(await r.arrayBuffer()),
      json: () => r.json(),
    };
  },
};

test("review saves non-adjacent pages, produces a named multi-page PDF and keeps uncertainty visible", async ({
  page,
}) => {
  const request = isolatedRequest;
  test.setTimeout(120000);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const image = await readFile("e2e/fixtures/generated/danish.png");
  for (const id of ids) {
    const r = await request.post(`/api/captures/${id}`, {
      data: image,
      headers: {
        Origin: "http://127.0.0.1:8766",
        "X-Scanner-Request": "1",
        "X-Capture-Status": "accepted",
        "X-Capture-Metadata": JSON.stringify({
          sourcePixels: [941, 1672],
          quality: { ok: true, receiptPixels: [941, 1672] },
        }),
      },
    });
    expect(r.ok()).toBe(true);
  }
  // Processing has already saved PP's full-original-canvas search layer.
  const layer = await PDFDocument.create();
  const font = await layer.embedFont(StandardFonts.Helvetica);
  layer
    .addPage([941, 1672])
    .drawText("Synthetic receipt 24.95", { x: 100, y: 100, font });
  const layerBytes = Buffer.from(await layer.save());
  for (const id of ids) {
    const artifact = {
      verified: false,
      text: "Synthetic receipt 24.95",
      provenance: { engine: "PP-OCRv6" },
      source: {
        captureId: id,
        sha256: createHash("sha256").update(image).digest("hex"),
        pixels: [941, 1672],
        region: { left: 0, top: 0, width: 941, height: 1672 },
        rotation: 0,
      },
      text_only_pdf_layers: [
        {
          base64: layerBytes.toString("base64"),
          sha256: createHash("sha256").update(layerBytes).digest("hex"),
        },
      ],
    };
    const saved = await request.post(`/api/captures/${id}/artifacts/ocr`, {
      data: Buffer.from(JSON.stringify(artifact)),
      headers: {
        Origin: origin,
        "X-Scanner-Request": "1",
        "Content-Type": "application/json",
      },
    });
    expect(saved.ok()).toBe(true);
  }
  await page.addInitScript(() => {
    const tools: Record<string, { execute: (input: object) => Promise<any> }> =
      {};
    Object.assign(window, { documentTools: tools });
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: (tool: {
          name: string;
          execute: (input: object) => Promise<any>;
        }) => {
          tools[tool.name] = tool;
        },
      },
    });
  });
  await page.goto("/review");
  await expect(
    page.getByRole("heading", { name: "Receipt review", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#review-counts")).toContainText(
    "3 awaiting processing",
  );
  await expect(page.locator("#review-list button")).toHaveCount(0);
  await page.locator("#review-confidence").selectOption("all");
  await page.locator("#review-model").selectOption("all");
  await page.locator("#review-filter").selectOption("processing");
  await expect(page.locator("#review-list button")).toHaveCount(3);
  await page.locator("#review-filter").selectOption("attention");
  const result = await page.evaluate(async (ids) => {
    const tools = (window as any).documentTools;
    const { document: first } = await tools.read_document.execute({
      id: ids[0],
    });
    const { document: last } = await tools.read_document.execute({
      id: ids[2],
    });
    first.pages.push(...last.pages);
    first.vendor = "Synthetic paper shop";
    first.receiptDate = "2026-08-14";
    first.kind = "invoice";
    first.handwriting = "uncertain";
    first.evidence =
      "Synthetic pages 1 and 2 explicitly matched despite intervening capture.";
    first.uncertainties = ["Unclear handwritten payer name."];
    first.invoice = {
      currency: "DKK",
      lines: [10000, 5000],
      adjustments: [{ label: "VAT", amount: 3750 }],
      total: 18751,
      basis: "net-plus-tax",
      evidence: "Synthetic totals mismatch by one minor unit.",
    };
    await tools.save_documents.execute({ documents: [first] });
    return tools.generate_document_pdf.execute({ id: first.id });
  }, ids);
  expect(result.filename).toBe("2026-08-14_synthetic_paper_shop.pdf");
  const response = await request.get(
    `/api/documents/${ids[0]}/pdf?revision=${result.revision}&version=${result.sha256}`,
  );
  expect(response.ok()).toBe(true);
  const pdfBytes = await response.body();
  const pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getPageCount()).toBe(2);
  const loading = getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
  });
  const searchable = await loading.promise;
  for (let number = 1; number <= 2; number++) {
    const pageText = await (await searchable.getPage(number)).getTextContent();
    const text = pageText.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    expect(text).toContain("Synthetic receipt 24.95");
  }
  await loading.destroy();
  await mkdir("test-results/documents", { recursive: true });
  await writeFile("test-results/documents/synthetic-grouped.pdf", pdfBytes);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: /2026-08-14_synthetic_paper_shop/ })
    .click();
  await expect(
    page
      .locator("#review-detail")
      .getByText("Unclear handwritten payer name.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#review-detail")
      .getByText(/Extracted amounts do not balance/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Page 2", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/documents/review-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  const preview = page.getByRole("dialog", { name: /Saved PDF:/ });
  await expect(
    preview.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await expect(preview.getByRole("status")).toHaveText(
    /saved PDF checksum verified/,
  );
  await preview.getByRole("button", { name: "Next page" }).click();
  await expect(
    preview.getByRole("img", { name: "PDF page 2 of 2" }),
  ).toBeVisible();
  await expect(preview.locator("canvas")).toHaveCount(1);
  await preview.getByRole("button", { name: "Zoom in" }).click();
  await expect(preview.getByRole("button", { name: "Fit page" })).toBeVisible();
  await preview.getByRole("button", { name: "Previous page" }).click();
  await expect(
    preview.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Close PDF" }).click();
  await expect(preview).toHaveCount(0);
  const pdfUrl = `${origin}/api/documents/${ids[0]}/pdf?version=${result.sha256}&revision=${result.revision}`;
  await page.route(pdfUrl, (route) =>
    route.fulfill({
      contentType: "application/pdf",
      body: Buffer.from("%PDF-tampered synthetic response"),
    }),
  );
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  await expect(preview.getByRole("status")).toHaveText(/PDF checksum mismatch/);
  await expect(preview.locator("canvas")).toBeHidden();
  await preview.getByRole("button", { name: "Close PDF" }).click();
  await expect(preview).toHaveCount(0);
  await page.unroute(pdfUrl);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(pdfUrl, async (route) => {
    requested();
    await held;
    await route
      .fulfill({ contentType: "application/pdf", body: pdfBytes })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  await started;
  await preview.getByRole("button", { name: "Close PDF" }).click();
  await expect(preview).toHaveCount(0);
  release();
  await page.unroute(pdfUrl);
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  await expect(
    preview.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Close PDF" }).click();
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const history = await request.get(`/api/documents/${ids[0]}/history`);
  expect((await history.json()).length).toBe(1);
  for (const id of ids)
    expect((await request.get(`/api/files/${id}/raw`)).ok()).toBe(true);
  const approvedRevision = await page.evaluate(async (id) => {
    const tools = (window as any).documentTools;
    const { document: d } = await tools.read_document.execute({ id });
    d.invoice.total = 18750;
    d.uncertainties = [];
    d.handwriting = "absent";
    d.checks = { visual: true, transcription: true, grouping: true, pdf: true };
    d.reviewedPdfSha256 = d.pdf.sha256;
    const saved = await tools.save_documents.execute({ documents: [d] });
    return saved.saved[0].revision;
  }, ids[0]);
  await request.post(
    `/api/documents/${ids[0]}/pdf?revision=${approvedRevision}`,
    {
      data: Buffer.from("%PDF-new synthetic artifact for review-hash test"),
      headers: { Origin: "http://127.0.0.1:8766", "X-Scanner-Request": "1" },
    },
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const check = page.getByRole("checkbox", {
    name: "Generated PDF inspected for clipping and legibility",
  });
  await expect(check).not.toBeChecked();
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await expect(page.locator("#review-message")).toHaveText(/Review saved/);
  const checked = await request.get(`/api/documents/${ids[0]}`);
  expect((await checked.json()).document.checks.pdf).toBe(false);
});

test("human review edits structured values and detaches a wrong page into the pool", async ({
  page,
}) => {
  const ids = [randomUUID(), randomUUID()];
  const image = await readFile("e2e/fixtures/generated/danish.png");
  for (const id of ids)
    expect(
      (
        await isolatedRequest.post(`/api/captures/${id}`, {
          data: image,
          headers: {
            Origin: origin,
            "X-Scanner-Request": "1",
            "X-Capture-Status": "accepted",
            "X-Capture-Metadata": JSON.stringify({
              sourcePixels: [941, 1672],
              quality: { ok: true, receiptPixels: [941, 1672] },
            }),
          },
        })
      ).ok(),
    ).toBe(true);
  await page.goto("/review");
  await page
    .getByLabel("Category name", { exact: true })
    .fill("Synthetic supplies");
  await page
    .getByLabel("What belongs in this category?")
    .fill("Synthetic test purchases only.");
  await page.getByRole("button", { name: "Add category", exact: true }).click();
  await expect(page.locator("#review-categories")).toContainText(
    "Synthetic test purchases only.",
  );
  await page.getByText("Purchase categories", { exact: true }).click();
  await page
    .locator("#review-categories")
    .getByText("Synthetic supplies", { exact: true })
    .click();
  const categoryEditor = page.getByRole("form", {
    name: "Edit category Synthetic supplies",
    exact: true,
  });
  await categoryEditor
    .getByLabel("Category name", { exact: true })
    .fill("Synthetic reviewed supplies");
  await categoryEditor
    .getByLabel("Reason for category change")
    .fill("Clarify the synthetic category name.");
  await categoryEditor
    .getByRole("button", { name: "Save category definition" })
    .click();
  await expect(page.locator("#review-categories")).toContainText(
    "Synthetic reviewed supplies",
  );
  async function model(path: string, body: object): Promise<any> {
    const response = await isolated.dispatchFetch(origin + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${processorToken}` },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    expect(response.status, JSON.stringify(data)).toBe(200);
    return data;
  }
  const categories = await (
    await isolatedRequest.get("/api/processing/categories")
  ).json();
  const secondCategory = await model("/api/processing/categories", {
    name: "Synthetic personal",
    description: "Synthetic personal groceries only.",
  });
  const captures = await Promise.all(
    ids.map(
      async (id) =>
        await (await isolatedRequest.get(`/api/captures/${id}`)).json(),
    ),
  );
  const db = await isolated.getD1Database("DB");
  for (const capture of captures) {
    const ocrResponse = await isolated.dispatchFetch(
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
            pixels: [941, 1672],
            rotation: 0,
            region: { left: 0, top: 0, width: 941, height: 1672 },
          },
          provenance: { engine: "PP-OCRv6" },
          text: "Synthetic shop\nSynthetic item 12,34\nTOTAL 12,34",
        }),
      },
    );
    expect(ocrResponse.status).toBe(200);
    const ocr = await ocrResponse.json<any>();
    const roleAssessment = randomUUID();
    const categoryAssessment = randomUUID();
    const now = new Date().toISOString();
    const pins = [{ capture_id: capture.id, ocr_sha256: ocr.sha256 }];
    await db.batch([
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
          ocr.sha256,
          "receipt",
          1_000_000,
          1_000_000,
          "synthetic-jev",
          randomUUID(),
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
  const lease = (await model("/api/processing/claim", { stage: "small" }))
    .claim;
  const target = newDocument(captures.find((c) => c.id === lease.document.id));
  target.pages = captures.map((c) => newDocument(c).pages[0]);
  const extraction = {
    type: "receipt",
    vendor: "Synthetic shop",
    receipt_date: "2026-01-02",
    reference: null,
    currency: "DKK",
    has_handwriting: true,
    has_payment_slip: false,
    payment_status: "not-applicable",
    card_last_four: null,
    line_items: [
      {
        description: "Synthetic item",
        quantity: null,
        unit_price_minor: null,
        amount_minor: 1234,
      },
    ],
    adjustments: [],
    total_minor: 1234,
    charged_total_minor: null,
    payment_adjustments: [],
    vat_minor: null,
    tax_basis: "gross",
    completeness: "complete",
    category_id: categories[0].id,
    certainty: "medium",
    uncertainties: [],
    broken_reasons: [],
    confirmed_arithmetic_mismatch: false,
    evidence: "Synthetic test extraction.",
  };
  await model("/api/processing/submit", {
    token: lease.token,
    model: "gpt-5.6-luna",
    extraction,
    documents: [target],
  });
  const assembled = (
    await (await isolatedRequest.get(`/api/documents/${target.id}`)).json()
  ).document;
  const large = (
    await model("/api/processing/claim", {
      stage: "large",
      document_id: assembled.id,
      revision: assembled.revision,
    })
  ).claim;
  await model("/api/processing/draft", {
    token: large.token,
    model: "gpt-6-astra",
    extraction,
  });
  await model("/api/processing/submit", {
    token: large.token,
    model: "gpt-6-astra",
    extraction,
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator("#review-filter").selectOption("review");
  await page.locator("#review-list button").click();
  await page
    .getByText("Review notes and document details", { exact: true })
    .click();
  await expect(
    page
      .locator(".processing-review")
      .getByText(/Luna: medium · Astra: medium/),
  ).toBeVisible();
  await expect(page.getByLabel("Handwriting is present")).toBeChecked();
  await page
    .getByLabel("Vendor", { exact: true })
    .fill("Corrected synthetic vendor");
  await page
    .getByLabel("Review findings", { exact: true })
    .fill("Human checked every synthetic source.");
  await page.getByRole("button", { name: "Accept human review" }).click();
  // Wait for the saved document to replace the old form before expanding its notes.
  await expect(page.getByText(/Human reviewed: yes/)).toBeAttached();
  await page
    .getByText("Review notes and document details", { exact: true })
    .click();
  await expect(page.getByText(/Human reviewed: yes/)).toBeVisible();
  const saved = await (
    await isolatedRequest.get(`/api/documents/${target.id}`)
  ).json();
  expect(saved.document.vendor).toBe("Corrected synthetic vendor");
  expect(saved.document.processing.human_review_revision).toBe(
    saved.document.revision,
  );
  await page
    .getByRole("combobox", { name: "Purchase category", exact: true })
    .selectOption(secondCategory.id);
  await page.getByText("Correct category only", { exact: true }).click();
  await page
    .getByLabel("Category explanation", { exact: true })
    .fill("Only synthetic personal groceries are present.");
  await page
    .getByRole("button", { name: "Save category only", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Purchase category", exact: true }),
  ).toHaveValue(secondCategory.id);
  const recategorized = (
    await (await isolatedRequest.get(`/api/documents/${target.id}`)).json()
  ).document;
  expect(recategorized.processing.has_human_review).toBe(true);
  expect(recategorized.vendor).toBe(saved.document.vendor);
  expect(recategorized.processing.extraction).toEqual({
    ...saved.document.processing.extraction,
    category_id: secondCategory.id,
  });
  expect(recategorized.evidence).toContain(
    "Only synthetic personal groceries are present.",
  );
  await page
    .getByText("Originals and page organisation", { exact: true })
    .click();
  await page
    .getByLabel("Reason for detaching page")
    .nth(1)
    .fill("Different synthetic transaction.");
  await page
    .getByRole("button", { name: "This page belongs elsewhere" })
    .nth(1)
    .click();
  await expect(page.locator("#review-message")).toContainText(
    "Page detached and returned to the matching pool",
  );
  const split = await (
    await isolatedRequest.get(
      `/api/documents?captureId=${target.pages[1].captureId}`,
    )
  ).json();
  expect(split.document.id).not.toBe(target.id);
  expect(split.document.pages).toHaveLength(1);
  await page.screenshot({
    path: "test-results/documents/structured-review.png",
    fullPage: true,
  });
});
