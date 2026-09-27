import { expect, test } from "@playwright/test";
import { newDocument } from "../web/documents";
import type { Capture } from "../web/types";

test("paginates and searches review summaries without requesting the full catalog", async ({
  page,
}) => {
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
  ];
  const summaries = ids.map((id, index) => ({
    id,
    revision: 1,
    vendor: index ? "Second synthetic shop" : "First synthetic shop",
    receiptDate: null,
    reference: null,
    kind: "receipt",
    jevRole: null,
    completenessAudit: null,
    sourceInterventionFine: false,
    status: "review",
    reasons: ["Synthetic review reason"],
    pageIds: [id],
    scannedAt: ["2026-09-27T12:00:00Z"],
    processing: {
      has_human_review: false,
      needs_reparse: false,
      luna_needs_human_review: false,
      small_model_certainty: "medium",
      large_model_confidence: "medium",
    },
    duplicateOf: null,
    filename: index ? "Second synthetic shop.pdf" : "First synthetic shop.pdf",
    pdf: null,
  }));
  const requests: URL[] = [];
  await page.route("**/api/processing/categories?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/documents?*", (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const search = url.searchParams.get("q")?.toLowerCase();
    const matches = search
      ? summaries.filter((item) => item.vendor.toLowerCase().includes(search))
      : summaries;
    const after = url.searchParams.get("after");
    const remaining = after
      ? matches.filter((item) => item.id > after)
      : matches;
    return route.fulfill({
      json: {
        documents: remaining.slice(0, 1),
        next: remaining.length > 1 ? remaining[0].id : null,
      },
    });
  });
  await page.goto("/review");
  await expect(page.locator("#review-list button")).toHaveCount(1);
  await expect(page.locator("#review-list")).toContainText(
    "First synthetic shop",
  );
  const listBox = await page.locator(".review-list-column").boundingBox();
  const detailBox = await page.locator("#review-detail").boundingBox();
  expect(detailBox!.x).toBeGreaterThanOrEqual(listBox!.x + listBox!.width);
  await page.evaluate(() => {
    const next = document.querySelector<HTMLButtonElement>(
      ".review-list-controls button:last-child",
    )!;
    next.click();
    next.click();
  });
  await expect(page.locator("#review-list")).toContainText(
    "Second synthetic shop",
  );
  await expect(page.locator(".review-list-controls")).toContainText("Page 2");
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.locator("#review-list")).toContainText(
    "First synthetic shop",
  );
  await page.getByRole("searchbox", { name: "Search" }).fill("second");
  await expect(page.locator("#review-list")).toContainText(
    "Second synthetic shop",
  );
  expect(requests.some((url) => url.searchParams.get("after") === ids[0])).toBe(
    true,
  );
  expect(requests.some((url) => url.searchParams.get("q") === "second")).toBe(
    true,
  );
  expect(requests.every((url) => url.searchParams.get("summary") === "1")).toBe(
    true,
  );
});

test("keeps sparse review filters bounded and offers the next cursor", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/api/processing/categories?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/documents?*", (route) => {
    calls++;
    return route.fulfill({
      json: {
        documents: [],
        next: `aaaaaaaa-aaaa-4aaa-8aaa-${String(calls).padStart(12, "0")}`,
      },
    });
  });
  await page.goto("/review?view=source-intervention");
  await expect(page.locator("#review-list")).toContainText(
    "Continue to the next page",
  );
  expect(calls).toBe(2);
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeEnabled();
});

test("keeps navigation locked while a selected document finishes loading", async ({
  page,
}) => {
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
  const nextId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
  const capture = {
    id,
    sha256: "b".repeat(64),
    created_at: "2026-09-27T12:00:00Z",
    is_current: true,
    metadata: { sourcePixels: [400, 800], quality: {} },
  } as Capture;
  const document = {
    ...newDocument(capture),
    filename: "First synthetic shop.pdf",
    status: "processing",
    reasons: [],
    scannedAt: [capture.created_at],
    pdf: null,
  };
  const summary = (documentId: string) => ({
    ...document,
    id: documentId,
    filename:
      documentId === id
        ? "First synthetic shop.pdf"
        : "Second synthetic shop.pdf",
    pageIds: [documentId],
    processing: {
      has_human_review: false,
      needs_reparse: false,
      luna_needs_human_review: false,
      small_model_certainty: "medium",
      large_model_confidence: "medium",
    },
  });
  await page.route("**/api/processing/categories?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route(`**/api/documents/${id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await route.fulfill({ json: { document, captures: [capture] } });
  });
  await page.route("**/api/documents?*", async (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    if (after) await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({
      json: {
        documents: [summary(after ? nextId : id)],
        next: after ? null : id,
      },
    });
  });
  await page.goto("/review");
  await page.locator("#review-list button").click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForTimeout(65);
  await page.evaluate(() =>
    document
      .querySelector<HTMLButtonElement>(
        ".review-list-controls button:last-child",
      )!
      .click(),
  );
  await expect(page.locator(".review-list-controls")).toContainText("Page 2");
  await expect(page.locator("#review-list")).toContainText(
    "Second synthetic shop",
  );
});

test("refresh releases pagination during an older page request", async ({
  page,
}) => {
  const first = "cccccccc-cccc-4ccc-8ccc-000000000001";
  const second = "cccccccc-cccc-4ccc-8ccc-000000000002";
  let delayedPageRequests = 0;
  await page.route("**/api/processing/categories?*", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/documents?*", async (route) => {
    const after = new URL(route.request().url()).searchParams.get("after");
    if (after && ++delayedPageRequests === 1)
      await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      json: {
        documents: [
          {
            id: after ? second : first,
            revision: 1,
            vendor: after ? "Second synthetic shop" : "First synthetic shop",
            receiptDate: null,
            reference: null,
            kind: "receipt",
            jevRole: null,
            completenessAudit: null,
            sourceInterventionFine: false,
            status: "review",
            reasons: [],
            pageIds: [after ? second : first],
            scannedAt: ["2026-09-27T12:00:00Z"],
            processing: null,
            duplicateOf: null,
            filename: after
              ? "Second synthetic shop.pdf"
              : "First synthetic shop.pdf",
            pdf: null,
          },
        ],
        next: after ? second : first,
      },
    });
  });
  await page.goto("/review");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator("#review-list")).toContainText(
    "Second synthetic shop",
  );
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeEnabled();
});
