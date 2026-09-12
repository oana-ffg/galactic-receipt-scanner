import { test, expect } from "@playwright/test";

test("shows saved edges, paginates, remembers audio and stores a private screenshot", async ({
  page,
  request,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const first = {
    id,
    receipt_id: id,
    retake_of: null,
    take_number: 1,
    is_current: true,
    current_capture_id: id,
    created_at: "2026-09-12T10:00:00Z",
    status: "accepted",
    sha256: "synthetic",
    ocr_status: "awaiting Work",
    outputs: { image: false, pdf: false },
    metadata: {
      sourcePixels: [800, 1000],
      quality: {
        ok: true,
        quad: [
          [0.1, 0.1],
          [0.9, 0.1],
          [0.9, 0.9],
          [0.1, 0.9],
        ],
        hands: [],
      },
    },
  };
  await page.route("**/api/captures?*", (route) => {
    const url = new URL(route.request().url());
    const older = url.searchParams.has("before");
    return route.fulfill({
      json: {
        captures: Array.from({ length: older ? 2 : 10 }, (_, i) => ({
          ...first,
          id:
            i === 0
              ? id
              : `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
        })),
        next: older ? null : "2026-09-12T09:00:00Z|synthetic",
      },
    });
  });
  await page.route(`**/api/files/${id}/raw`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="#111"/><rect x="80" y="100" width="640" height="800" fill="white"/><text x="130" y="400" font-size="32">SYNTHETIC RECEIPT</text></svg>',
    }),
  );
  await page.goto("/");
  await expect(page.locator("#captures .capture-row")).toHaveCount(10);
  await expect(page.locator("#saved-photo img")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect full size" }),
  ).toBeEnabled();
  await expect(page.locator("#saved-photo polygon")).toHaveAttribute(
    "points",
    "100,100 900,100 900,900 100,900",
  );
  const alignment = await page.locator("#saved-photo").evaluate((el) => {
    const image = el.querySelector("img")!.getBoundingClientRect();
    const overlay = el.querySelector("svg")!.getBoundingClientRect();
    return (
      Math.abs(image.width - overlay.width) +
      Math.abs(image.height - overlay.height) +
      Math.abs(image.x - overlay.x) +
      Math.abs(image.y - overlay.y)
    );
  });
  expect(alignment).toBeLessThan(1);
  await page.getByRole("button", { name: "Inspect full size" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Actual pixels" }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await expect(page.locator("#captures .capture-row")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Older", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Newer", exact: true }).click();
  await expect(page.locator("#captures .capture-row")).toHaveCount(10);
  await expect(page.locator("#audio")).toBeChecked();
  await page.locator("#audio").uncheck();
  await page.reload();
  await expect(page.locator("#audio")).not.toBeChecked();
  await page.getByRole("button", { name: "Report issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Report a private issue" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.locator("img")).toBeVisible();
  const size = await dialog
    .locator("img")
    .evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight]);
  expect(size).toEqual([1360, 900]);
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Synthetic screenshot test");
  await dialog.getByLabel("What happened?").fill("Synthetic source only.");
  await dialog.getByRole("button", { name: "Save private issue" }).click();
  await expect(dialog.locator(".issue-feedback")).toContainText(
    "Private issue saved.",
  );
  expect(await dialog.locator('a[href*="github.com"]').count()).toBe(0);
  const issues = await (await request.get("/api/issues")).json();
  const issue = issues.issues.find(
    (i: { title: string }) => i.title === "Synthetic screenshot test",
  );
  expect(issue).toBeTruthy();
  const shot = await request.get(issue.screenshot);
  expect(shot.headers()["content-type"]).toBe("image/png");
  expect((await shot.body()).length).toBeGreaterThan(10000);
  await page.screenshot({ path: "test-results/private-issue-synthetic.png" });
  expect(failures).toEqual([]);
});
