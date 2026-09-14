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
  const captures = Array.from(
    { length: 4 },
    (_, i) =>
      ({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        sha256: "synthetic",
        created_at: "2026-09-14T10:00:00Z",
        is_current: true,
        metadata: { sourcePixels: [800, 1000] },
      }) as Capture,
  );
  const docs = captures.map((capture, i): DocumentView => ({
    ...newDocument(capture),
    revision: 2,
    filename: `Synthetic receipt ${i + 1}`,
    status: "review",
    reasons: ["Check vendor"],
    scannedAt: [capture.created_at],
    pdf: null,
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
  let writes = 0;
  let failReadings = false;
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
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="white"/><text x="80" y="160" font-size="32">SYNTHETIC RECEIPT</text></svg>',
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
    page.getByRole("img", { name: "Original page 1" }),
  ).toBeVisible();
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
  await form.getByRole("button", { name: "Accept human review" }).click();
  await expect(page.locator("#review-message")).toContainText(
    "Human review saved",
  );
  expect(writes).toBe(1);
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
  await page.screenshot({
    path: "test-results/receipt-viewer-synthetic.png",
    fullPage: true,
  });
});
