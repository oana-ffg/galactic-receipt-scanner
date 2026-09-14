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
                extraction: { ...extraction, vendor: "Synthetic Astra shop" },
                sources: [{ capture_id: d.id, sha256: "synthetic" }],
              },
            ]
          : []),
        {
          revision: 1,
          stage: "small",
          model: "gpt-5.6-luna",
          created_at: captures[0].created_at,
          extraction,
          sources: [{ capture_id: d.id, sha256: "synthetic" }],
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
  let writes = 0;
  let failReadings = false;
  await page.route("**/api/documents/*/pdf?*", (route) =>
    route.fulfill({ contentType: "application/pdf", body: pdfBytes }),
  );
  await page.route("**/api/documents", (route) =>
    route.fulfill({ json: { documents: docs, captures } }),
  );
  await page.route("**/api/processing/categories", (route) =>
    route.fulfill({ json: [] }),
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
      sources: [{ capture_id: doc.id, sha256: "synthetic" }],
    });
    return route.fulfill({
      json: { saved: [{ id: doc.id, revision: doc.revision }] },
    });
  });
  await page.goto("/review");
  await expect(page.locator("#review-list button")).toHaveCount(2);
  await page.locator("#review-list button").first().click();
  const form = page.getByRole("form", { name: "Human review fields" });
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
  await page
    .getByText("Compare saved Luna, Astra and human values", { exact: true })
    .click();
  await expect(page.locator(".review-comparison table")).toContainText(
    "Synthetic Luna shop",
  );
  await expect(page.locator(".review-comparison table")).toContainText(
    "Synthetic Astra shop",
  );
  await form.getByLabel("Vendor", { exact: true }).fill("Cancelled edit");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Synthetic Astra shop",
  );
  expect(writes).toBe(0);
  await form.getByLabel("Vendor", { exact: true }).fill("Human corrected shop");
  await form.getByLabel("Total", { exact: true }).fill("12,34");
  await form.getByLabel("Line amount", { exact: true }).fill("12.34");
  await form.getByRole("button", { name: "Accept human review" }).click();
  await expect(page.locator("#review-message")).toContainText(
    "Human review saved",
  );
  expect(writes).toBe(1);
  expect(docs[0].processing!.extraction.total_minor).toBe(1234);
  expect(docs[0].processing!.extraction.line_items[0].amount_minor).toBe(1234);
  await expect(page.locator("#review-list button")).toHaveCount(1);
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Human corrected shop",
  );
  expect(attempts.get(docs[0].id)![1].extraction.vendor).toBe(
    "Synthetic Astra shop",
  );
  await page.locator("#review-model").selectOption("luna-only");
  await expect(page.locator("#review-list button")).toHaveCount(1);
  await page.locator("#review-list button").click();
  await expect(form.getByLabel("Vendor", { exact: true })).toHaveValue(
    "Synthetic Luna shop",
  );
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
