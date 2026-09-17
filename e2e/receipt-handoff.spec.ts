import { test, expect } from "@playwright/test";
import { newDocument, type DocumentView } from "../web/documents";
import type { Capture } from "../web/types";

test("copies a saved receipt reference, reopens filtered documents and recovers from clipboard denial", async ({
  page,
  context,
}) => {
  const capture = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
    sha256: "a".repeat(64),
    created_at: "2026-09-17T10:00:00Z",
    is_current: true,
    metadata: { sourcePixels: [400, 800], quality: {} },
  } as Capture;
  const second = {
    ...capture,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
    sha256: "b".repeat(64),
  };
  const doc: DocumentView = {
    ...newDocument(capture),
    pages: [...newDocument(capture).pages, ...newDocument(second).pages],
    revision: 7,
    filename: "Synthetic receipt.pdf",
    status: "processing",
    reasons: [],
    scannedAt: [capture.created_at],
    pdf: null,
  };
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/") &&
      request.method() !== "GET"
    )
      writes.push(request.url());
  });
  await page.route("**/api/documents", (route) =>
    route.fulfill({ json: { documents: [doc], captures: [capture, second] } }),
  );
  await page.route("**/api/processing/categories", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/files/*/raw", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="800"><rect width="400" height="800" fill="white"/><text x="20" y="80">SYNTHETIC RECEIPT</text></svg>',
    }),
  );
  await page.goto("/review");
  await expect(page.locator("#review-list button")).toHaveCount(0);
  await page.goto(`/review?document=${doc.id}`);
  await expect(page.locator("#review-detail h2")).toHaveText(doc.filename!);
  await expect(
    page.locator("#review-list button[aria-current=true]"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Move earlier" }).nth(1).click();
  await expect(page.locator(".review-sources img").first()).toHaveAttribute(
    "src",
    `/api/files/${second.id}/raw`,
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy for Codex" }).click();
  await expect(
    page.getByText("Copied. Paste into Codex and add what looks wrong."),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`Document ID: ${doc.id}`);
  expect(copied).toContain("Saved document revision: 7");
  expect(copied).toContain(
    `1. Capture ${capture.id}, SHA-256 ${capture.sha256}`,
  );
  expect(copied).toContain(`2. Capture ${second.id}, SHA-256 ${second.sha256}`);
  const link = await page
    .getByRole("link", { name: "Receipt link" })
    .getAttribute("href");
  expect(copied).toContain(`Receipt viewer: ${link}`);

  // A later parse must not change the reference already copied for investigation.
  doc.revision = 8;
  await page.goto(link!);
  await expect(page.locator("#review-detail h2")).toHaveText(doc.filename!);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("Permission denied")),
      },
    });
  });
  await page.getByRole("button", { name: "Copy for Codex" }).click();
  const fallback = page.getByRole("textbox", {
    name: "Receipt investigation prompt",
  });
  await expect(fallback).toBeVisible();
  await expect(fallback).toBeFocused();
  await expect(fallback).toHaveValue(/Saved document revision: 8/);
  expect(
    await fallback.evaluate(
      (el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart,
    ),
  ).toBeGreaterThan(100);
  await page.screenshot({ path: "test-results/receipt-handoff-synthetic.png" });
  await page.goto("/review?document=missing");
  await expect(
    page.getByText("The linked document was not found in this instance."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy for Codex" }),
  ).toHaveCount(0);
  await page.locator("#review-list button").click();
  await expect(page).toHaveURL(link!);
  expect(writes).toEqual([]);
});
