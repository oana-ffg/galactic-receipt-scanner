import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { test, expect } from "@playwright/test";
import { newDocument, type DocumentView } from "../web/documents";
import type { Capture } from "../web/types";
import type { Extraction } from "../web/extraction";
import type { SavedReading } from "../web/review-values";

const extraction: Extraction = {
  type: "receipt",
  vendor: "Synthetic Luna shop",
  receipt_date: "2026-01-02",
  reference: "SYNTHETIC",
  currency: "DKK",
  has_handwriting: false,
  has_payment_slip: false,
  payment_status: "unknown",
  card_last_four: null,
  line_items: [
    {
      description: "Synthetic item",
      quantity: 1,
      unit_price_minor: 1200,
      amount_minor: 1200,
    },
  ],
  adjustments: [],
  total_minor: 1200,
  charged_total_minor: null,
  payment_adjustments: [],
  vat_minor: null,
  tax_basis: "gross",
  completeness: "complete",
  category_id: null,
  certainty: "medium",
  uncertainties: ["Check vendor"],
  broken_reasons: [],
  confirmed_arithmetic_mismatch: false,
  evidence: "Synthetic image inspected",
};

test("filters model confidence, compares readings, cancels edits and accepts a separate human reading", async ({
  page,
}) => {
  const categoryA = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
  const categoryB = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
  const categories = [
    {
      id: categoryA,
      name: "Synthetic groceries",
      description: "Synthetic food purchases",
    },
    {
      id: categoryB,
      name: "Synthetic supplies",
      description: "Synthetic household supplies",
    },
  ];
  await page.setViewportSize({ width: 1000, height: 800 });
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const sheet = pdf.addPage([400, 1200]);
    sheet.drawText(`SYNTHETIC RECEIPT ${i + 1}`);
  }
  const pdfBytes = Buffer.from(await pdf.save());
  const pdfHash = createHash("sha256").update(pdfBytes).digest("hex");
  const captures = Array.from(
    { length: 4 },
    (_, i) =>
      ({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        sha256: "synthetic",
        created_at: "2026-09-14T10:00:00Z",
        is_current: true,
        metadata: {
          sourcePixels: [800, 2000],
          quality: {
            quad: [
              [0.1, 0.1],
              [0.9, 0.1],
              [0.9, 0.9],
              [0.1, 0.9],
            ],
          },
        },
      }) as Capture,
  );
  const docs = captures.map((capture, i): DocumentView => ({
    ...newDocument(capture),
    revision: 2,
    filename: `Synthetic receipt ${i + 1}`,
    status: "review",
    reasons: ["Check vendor"],
    scannedAt: [capture.created_at],
    pdf: i === 0 ? { sha256: pdfHash, revision: 2 } : null,
    processing: {
      extraction,
      small_model_certainty: "medium",
      large_model_confidence:
        i === 2 ? null : i === 3 ? "high" : i === 0 ? "low" : "medium",
      not_invoice: false,
      has_handwriting: false,
      has_human_review: false,
      human_review_revision: null,
      needs_reparse: false,
      seen_capture_count: 4,
    },
  }));
  const secondPage = {
    ...captures[0],
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000004",
  };
  captures.push(secondPage);
  docs[0].pages.push({ ...docs[0].pages[0], captureId: secondPage.id });
  const attempts = new Map<string, SavedReading[]>(
    docs.map((d) => [
      d.id,
      [
        ...(d.processing!.large_model_confidence
          ? [
              {
                revision: 2,
                stage: "large",
                model: "gpt-6-astra",
                created_at: captures[0].created_at,
                extraction: {
                  ...extraction,
                  vendor: "Synthetic Astra shop",
                  category_id: categoryA,
                  receipt_date: "2026-01-08",
                },
                sources: d.pages.map((p) => ({
                  capture_id: p.captureId,
                  sha256: p.sha256,
                })),
              },
            ]
          : []),
        {
          revision: 1,
          stage: "small",
          model: "gpt-5.6-luna",
          created_at: captures[0].created_at,
          extraction,
          sources: d.pages.map((p) => ({
            capture_id: p.captureId,
            sha256: p.sha256,
          })),
        },
      ],
    ]),
  );
  for (const attempt of attempts.get(docs[3].id)!)
    attempt.extraction = {
      ...attempt.extraction,
      currency: "JPY",
      adjustments: [{ description: "Synthetic discount", amount_minor: -25 }],
    };
  attempts.get(docs[0].id)!.push({
    revision: 2,
    stage: "independent",
    model: "future-reviewer",
    created_at: captures[0].created_at,
    extraction: { ...extraction, receipt_date: "2026-01-09" },
    sources: docs[0].pages.map((p) => ({
      capture_id: p.captureId,
      sha256: p.sha256,
    })),
  });
  const ocrText = JSON.stringify({
    source: {
      captureId: secondPage.id,
      sha256: "synthetic",
      pixels: [800, 2000],
      region: { left: 0, top: 0, width: 800, height: 2000 },
      coordinates: "original image pixels; top-left origin",
    },
    provenance: { engine: "PP-OCRv6" },
    confidence: 64.25,
    lines: [
      { text: "SYNTHETIC OCR SHOP", confidence: 99 },
      { text: "Synthetic item 12,00", confidence: 88 },
      { text: "TOTAL 12,00", confidence: 0 },
      {
        text: "X8-01-2026 18:58",
        confidence: 70,
        box: { x0: 80, y0: 200, x1: 200, y1: 240 },
        words: [
          {
            text: "X8-01-2026",
            confidence: 70,
            box: { x0: 80, y0: 200, x1: 200, y1: 240 },
          },
          { text: "UNSCORED", box: { x0: 210, y0: 200, x1: 330, y1: 240 } },
        ],
      },
    ],
    text: "SYNTHETIC OCR SHOP\nSynthetic item 12,00\nTOTAL 12,00\nX8-01-2026 18:58",
  });
  const ocrHash = createHash("sha256").update(ocrText).digest("hex");
  let writes = 0;
  let failReadings = false;
  let failOcr = true;
  await page.route("**/api/captures/*", (route) =>
    route.fulfill({
      json: {
        artifacts: route.request().url().endsWith(secondPage.id)
          ? [
              {
                kind: "ocr",
                sha256: ocrHash,
                created_at: captures[0].created_at,
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/files/*/ocr?*", (route) =>
    failOcr
      ? route.fulfill({ status: 503 })
      : route.fulfill({ contentType: "application/json", body: ocrText }),
  );
  await page.route("**/api/documents/*/pdf?*", (route) =>
    route.fulfill({ contentType: "application/pdf", body: pdfBytes }),
  );
  await page.route("**/api/documents", (route) =>
    route.fulfill({ json: { documents: docs, captures } }),
  );
  await page.route("**/api/processing/categories", (route) =>
    route.fulfill({ json: categories }),
  );
  await page.route("**/api/processing/readings?*", (route) =>
    failReadings
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({
          json: {
            attempts: attempts.get(
              new URL(route.request().url()).searchParams.get("document_id")!,
            ),
            readings: [],
          },
        }),
  );
  await page.route("**/api/files/*/raw", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="2000"><rect width="800" height="2000" fill="white"/><text x="80" y="160" font-size="32">SYNTHETIC RECEIPT</text></svg>',
    }),
  );
  await page.route("**/api/processing/human-review", (route) => {
    writes++;
    const body = route.request().postDataJSON();
    const doc = docs.find((d) => d.id === body.document_id)!;
    doc.revision++;
    doc.processing = {
      ...doc.processing!,
      extraction: body.extraction,
      has_human_review: true,
      human_review_revision: doc.revision,
    };
    attempts.get(doc.id)!.unshift({
      revision: doc.revision,
      stage: "human",
      model: "human",
      created_at: captures[0].created_at,
      extraction: body.extraction,
      sources: doc.pages.map((p) => ({
        capture_id: p.captureId,
        sha256: p.sha256,
      })),
    });
    return route.fulfill({
      json: { saved: [{ id: doc.id, revision: doc.revision }] },
    });
  });
  await page.goto("/review");
  await expect(page.locator("#review-list button")).toHaveCount(2);
  await page.locator("#review-list button").first().click();
  const form = page.getByRole("form", { name: "Human review fields" });
  await expect(
    form.getByRole("combobox", { name: "Purchase category", exact: true }),
  ).toBeVisible();
  await expect(
    form.getByRole("combobox", { name: "Purchase category", exact: true }),
  ).toHaveValue(categoryA);

  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Synthetic Astra shop",
  );
  await expect(
    page.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await expect(form.getByLabel("Total", { exact: true })).toHaveValue("12.00");
  await expect(form.getByLabel("Line amount", { exact: true })).toHaveValue(
    "12.00",
  );
  const placement = await page.evaluate(() => {
    const preview = document
      .querySelector(".document-preview")!
      .getBoundingClientRect();
    const editor = document
      .querySelector(".processing-review")!
      .getBoundingClientRect();
    return {
      sameTop: Math.abs(preview.top - editor.top) < 2,
      beside: preview.right <= editor.left,
      visible: preview.bottom <= innerHeight,
    };
  });
  expect(placement).toEqual({ sameTop: true, beside: true, visible: true });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "PDF page 2 of 2" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/receipt-review-pdf-synthetic.png",
  });
  const beforeScroll = await page.locator(".document-preview").boundingBox();
  await page
    .locator(".processing-review")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  expect((await page.locator(".document-preview").boundingBox())!.y).toBe(
    beforeScroll!.y,
  );
  await page.locator(".processing-review").evaluate((el) => (el.scrollTop = 0));
  await form.getByLabel("Vendor", { exact: true }).fill("Draft stays intact");
  await page
    .getByRole("button", { name: "Compare readings", exact: true })
    .click();
  const comparison = page.getByRole("region", {
    name: "Model comparison",
    exact: true,
  });
  await expect(comparison).toBeVisible();
  await expect(form).toBeHidden();
  await expect(
    comparison.getByRole("button", { name: "Retry loading OCR" }),
  ).toBeVisible();
  failOcr = false;
  await comparison.getByRole("button", { name: "Retry loading OCR" }).click();
  await expect(
    comparison.getByRole("columnheader", { name: /PP-OCRv6/ }),
  ).toBeVisible();
  await expect(
    comparison.getByRole("columnheader", { name: /PP-OCRv6/ }),
  ).toContainText("Page 2 OCR confidence: 64.3%");
  await expect(
    comparison.getByRole("columnheader", { name: /future-reviewer/ }),
  ).toBeVisible();
  const dateRow = comparison.getByRole("row").filter({
    has: page.getByRole("rowheader", {
      name: "Purchase date Different",
      exact: true,
    }),
  });
  const categoryRow = comparison.getByRole("row").filter({
    has: page.getByRole("rowheader", {
      name: "Purchase category Different",
      exact: true,
    }),
  });
  await expect(categoryRow).toContainText("Synthetic groceries");
  await expect(categoryRow).toContainText("Unclassified");
  await expect(categoryRow).toContainText("Not assigned by OCR");
  await expect(dateRow).toContainText("2 January 2026");
  await expect(dateRow).toContainText("8 January 2026");
  await expect(dateRow).toContainText("9 January 2026");
  await expect(dateRow).toContainText("X8-01-2026 18:58");
  await comparison
    .getByRole("checkbox", { name: "future-reviewer", exact: true })
    .uncheck();
  await expect(
    comparison.getByRole("columnheader", { name: /future-reviewer/ }),
  ).toHaveCount(0);
  await expect(dateRow).toHaveClass("review-difference");
  await expect(
    comparison.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "Total", exact: true }),
    }),
  ).toContainText("12.00 DKK");
  await expect(comparison).toContainText("Synthetic Luna shop");
  await expect(comparison).toContainText("Synthetic Astra shop");
  await expect(
    page.getByRole("img", { name: "PDF page 2 of 2" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/model-comparison-synthetic.png",
  });
  await comparison.getByText("OCR text", { exact: true }).click();
  const confidenceTable = comparison.getByRole("table", {
    name: "PP-OCRv6 · Page 2 line confidence",
  });
  await expect(
    confidenceTable.getByRole("row").filter({ hasText: "TOTAL 12,00" }),
  ).toHaveText("TOTAL 12,000.0%");
  await expect(confidenceTable.locator("tbody tr.ocr-uncertain")).toHaveCount(
    2,
  );
  await comparison
    .getByRole("searchbox", { name: "Find in OCR text" })
    .fill("X8");
  await expect(confidenceTable.locator("tbody td").first()).toHaveText(
    "X8-01-2026 18:58",
  );
  await expect(confidenceTable.locator("tbody td").last()).toHaveText("70.0%");
  await page.screenshot({ path: "test-results/ocr-confidence-synthetic.png" });
  await comparison.getByText("OCR text", { exact: true }).click();
  await comparison
    .getByText("Compare line items and adjustments", { exact: true })
    .click();
  for (const model of ["Luna", "Astra"]) {
    const lines = comparison.getByRole("region", {
      name: `${model} line items`,
      exact: true,
    });
    await expect(lines).toContainText("Synthetic item");
    await expect(lines).toContainText("Amount: 12.00 DKK");
  }
  await page
    .getByRole("checkbox", { name: "OCR overlay", exact: true })
    .check();
  await expect(page.getByLabel("Preview source", { exact: true })).toHaveValue(
    "crop",
  );
  const overlay = page.getByRole("img", {
    name: "Saved OCR overlay",
    exact: true,
  });
  await expect(
    page.getByRole("img", { name: "Cropped scan 2 of 2" }),
  ).toBeVisible();
  await expect(overlay).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Receipt preview", exact: true }),
  ).toContainText("Page OCR confidence: 64.3% (mean of lines)");
  await expect(overlay).toHaveAttribute("viewBox", "0 0 656 1616");
  await expect(overlay.locator("text")).toHaveText(["X8-01-2026", "UNSCORED"]);
  await expect(overlay.locator("rect").first()).toHaveAttribute("x", "8");
  await expect(overlay.locator("rect").first()).toHaveAttribute("y", "8");
  await expect(overlay.locator("g.ocr-uncertain")).toHaveCount(2);
  await expect(overlay.locator("title").last()).toContainText(
    "OCR confidence: Unavailable",
  );
  await page
    .getByRole("button", { name: "Previous scan", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "Cropped scan 1 of 2" }),
  ).toBeVisible();
  await expect(overlay).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Receipt preview", exact: true }),
  ).toContainText("no saved word/line positions for this page");
  await page.getByRole("button", { name: "Next scan", exact: true }).click();
  await expect(overlay).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const alignment = await page
    .locator(".document-preview-stage")
    .evaluate((stage) => {
      const canvas = stage.querySelector("canvas")!.getBoundingClientRect(),
        svg = stage.querySelector("svg")!.getBoundingClientRect();
      return {
        sameSize:
          Math.abs(canvas.width - svg.width) < 1 &&
          Math.abs(canvas.height - svg.height) < 1,
        samePosition: canvas.x === svg.x && canvas.y === svg.y,
      };
    });
  expect(alignment).toEqual({ sameSize: true, samePosition: true });
  const previewRequests: string[] = [];
  const recordPreviewRequest = (request: { url(): string }) => {
    if (/\/api\/(?:files\/|documents\/.*\/pdf)/.test(request.url()))
      previewRequests.push(request.url());
  };
  page.on("request", recordPreviewRequest);
  const toggling = await page
    .locator(".document-preview")
    .evaluate((preview) => {
      const viewport = preview.querySelector<HTMLElement>(
        ".document-preview-viewport",
      )!;
      const canvas = viewport.querySelector("canvas")!;
      const svg = viewport.querySelector<SVGSVGElement>(".ocr-overlay")!;
      const toggle = preview.querySelector<HTMLInputElement>(
        ".ocr-overlay-toggle input",
      )!;
      viewport.scrollTop = 300;
      viewport.scrollLeft = 100;
      const before = {
        top: viewport.scrollTop,
        left: viewport.scrollLeft,
        width: canvas.getBoundingClientRect().width,
        viewportTop: viewport.getBoundingClientRect().top,
      };
      let visibleCorrectly = true;
      for (let i = 0; i < 12; i++) {
        toggle.click();
        visibleCorrectly &&=
          (getComputedStyle(svg).display !== "none") === toggle.checked;
      }
      return {
        visibleCorrectly,
        sameCanvas: canvas === viewport.querySelector("canvas"),
        sameOverlay: svg === viewport.querySelector(".ocr-overlay"),
        samePosition:
          viewport.scrollTop === before.top &&
          viewport.scrollLeft === before.left &&
          viewport.getBoundingClientRect().top === before.viewportTop,
        sameZoom: canvas.getBoundingClientRect().width === before.width,
      };
    });
  expect(toggling).toEqual({
    visibleCorrectly: true,
    sameCanvas: true,
    sameOverlay: true,
    samePosition: true,
    sameZoom: true,
  });
  await page
    .getByRole("checkbox", { name: "OCR overlay", exact: true })
    .uncheck();
  await expect(page.locator(".ocr-overlay")).toBeHidden();
  await expect(page.getByLabel("Preview source", { exact: true })).toHaveValue(
    "crop",
  );
  await expect(
    page.getByRole("img", { name: "Cropped scan 2 of 2" }),
  ).toBeVisible();
  expect(previewRequests).toEqual([]);
  page.off("request", recordPreviewRequest);
  await page.getByLabel("Preview source", { exact: true }).selectOption("pdf");
  await expect(
    page.getByRole("img", { name: "PDF page 2 of 2" }),
  ).toBeVisible();
  // Toggle in the same JS turn as PDF navigation, before its async rendering completes.
  for (const [buttonName, scanName, pdfName] of [
    ["Previous page", "Cropped scan 1 of 2", "PDF page 1 of 2"],
    ["Next page", "Cropped scan 2 of 2", "PDF page 2 of 2"],
  ]) {
    await page
      .getByRole("button", { name: buttonName, exact: true })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        document
          .querySelector<HTMLInputElement>(".ocr-overlay-toggle input")!
          .click();
      });
    await expect(
      page.getByRole("img", { name: scanName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("checkbox", { name: "OCR overlay", exact: true })
      .uncheck();
    await page
      .getByLabel("Preview source", { exact: true })
      .selectOption("pdf");
    await expect(
      page.getByRole("img", { name: pdfName, exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Edit receipt", exact: true }).click();
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Draft stays intact",
  );
  expect(writes).toBe(0);
  await form.getByLabel("Vendor", { exact: true }).fill("Cancelled edit");
  await form
    .getByRole("combobox", { name: "Purchase category", exact: true })
    .selectOption(categoryB);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Synthetic Astra shop",
  );
  expect(writes).toBe(0);
  await expect(
    form.getByRole("combobox", { name: "Purchase category", exact: true }),
  ).toHaveValue(categoryA);
  await form
    .getByRole("combobox", { name: "Purchase category", exact: true })
    .selectOption(categoryB);
  await form.getByLabel("Vendor", { exact: true }).fill("Human corrected shop");
  await form.getByLabel("Total", { exact: true }).fill("12,34");
  await form.getByLabel("Line amount", { exact: true }).fill("12.34");
  await form.getByRole("button", { name: "Accept human review" }).click();
  await expect(page.locator("#review-message")).toContainText(
    "Receipt changes saved",
  );
  expect(writes).toBe(1);
  expect(docs[0].processing!.extraction.category_id).toBe(categoryB);
  expect(
    attempts.get(docs[0].id)!.find((a) => a.model === "gpt-6-astra")!.extraction
      .category_id,
  ).toBe(categoryA);
  expect(docs[0].processing!.extraction.total_minor).toBe(1234);
  expect(docs[0].processing!.extraction.line_items[0].amount_minor).toBe(1234);
  await expect(page.locator("#review-list button")).toHaveCount(1);
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Human corrected shop",
  );
  expect(
    attempts.get(docs[0].id)!.find((a) => a.model === "gpt-6-astra")!.extraction
      .vendor,
  ).toBe("Synthetic Astra shop");
  await page
    .getByRole("button", { name: "Compare readings", exact: true })
    .click();
  await expect(
    comparison.getByRole("columnheader", { name: /Human review/ }),
  ).toBeVisible();
  await expect(
    comparison.getByRole("row").filter({
      has: page.getByRole("rowheader", {
        name: "Total Different",
        exact: true,
      }),
    }),
  ).toContainText("12.34 DKK");
  await page.getByRole("button", { name: "Edit receipt", exact: true }).click();
  await page.locator("#review-model").selectOption("luna-only");
  await expect(page.locator("#review-list button")).toHaveCount(1);
  await page.locator("#review-list button").click();
  await expect(page.locator("#review-message")).toBeEmpty();
  expect(docs[2].processing!.has_human_review).toBe(false);
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Synthetic Luna shop",
  );
  await page
    .getByRole("button", { name: "Compare readings", exact: true })
    .click();
  await expect(
    comparison.getByRole("columnheader", { name: /Astra/ }),
  ).toHaveCount(0);
  await expect(comparison).toContainText(
    "No saved OCR for these source pages.",
  );
  await expect(
    comparison.getByRole("row").filter({
      has: page.getByRole("rowheader", {
        name: "Purchase date",
        exact: true,
      }),
    }),
  ).not.toHaveClass("review-difference");
  await page.getByRole("button", { name: "Edit receipt", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Cropped scan 1 of 1" }),
  ).toBeVisible();
  const imageLayout = await page
    .locator(".document-preview-viewport")
    .evaluate((el) => {
      const canvas = el.querySelector("canvas")!;
      return {
        pixels: [canvas.width, canvas.height],
        fitWidth:
          Math.abs(canvas.getBoundingClientRect().width - el.clientWidth) < 1,
        scrolls: el.scrollHeight > el.clientHeight,
      };
    });
  expect(imageLayout).toEqual({
    pixels: [656, 1616],
    fitWidth: true,
    scrolls: true,
  });
  await page.locator("#review-model").selectOption("astra");
  await page.locator("#review-confidence").selectOption("high");
  await expect(page.locator("#review-list button")).toHaveCount(1);
  failReadings = true;
  await page.locator("#review-list button").click();
  await expect(
    page.getByRole("button", { name: "Retry loading readings" }),
  ).toBeVisible();
  await expect(form).toHaveCount(0);
  failReadings = false;
  await page.getByRole("button", { name: "Retry loading readings" }).click();
  await expect(form).toBeVisible();
  await expect(form.getByLabel("Total", { exact: true })).toHaveValue("1200");
  await form.getByLabel(/Document adjustments/).fill("Malformed adjustment");
  await form.getByLabel("Currency", { exact: true }).fill("DKK");
  await form.getByLabel("Currency", { exact: true }).press("Tab");
  await expect(page.getByRole("alert")).toContainText(
    "before changing currency",
  );
  await expect(form.getByLabel("Total", { exact: true })).toHaveValue("1200");
  await form
    .getByLabel(/Document adjustments/)
    .fill("Synthetic discount = -25");
  await form.getByRole("button", { name: "Accept human review" }).click();
  await expect.poll(() => writes).toBe(2);
  await expect(form.getByLabel("Total", { exact: true })).toHaveValue("12.00");
  await expect(form.getByLabel("Unit price", { exact: true })).toHaveValue(
    "12.00",
  );
  await expect(form.getByLabel("Line amount", { exact: true })).toHaveValue(
    "12.00",
  );
  await expect(form.getByLabel(/Document adjustments/)).toHaveValue(
    "Synthetic discount = -0.25",
  );
  expect(docs[3].processing!.extraction).toMatchObject({
    currency: "DKK",
    total_minor: 1200,
    adjustments: [{ description: "Synthetic discount", amount_minor: -25 }],
    line_items: [{ unit_price_minor: 1200, amount_minor: 1200 }],
  });
  await form.getByLabel("Currency", { exact: true }).fill("EUR");
  await form.getByRole("button", { name: "Accept human review" }).click();
  await expect.poll(() => writes).toBe(3);
  expect(docs[3].processing!.extraction.total_minor).toBe(1200);
  await page.screenshot({
    path: "test-results/receipt-viewer-synthetic.png",
    fullPage: true,
  });
});
