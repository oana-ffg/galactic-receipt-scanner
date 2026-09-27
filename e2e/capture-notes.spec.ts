import { expect, test, type APIRequestContext } from "@playwright/test";
import { startTestServer } from "../scripts/test-server.mjs";

let instance: Awaited<ReturnType<typeof startTestServer>>;
test.beforeAll(async () => {
  instance = await startTestServer();
});
test.afterAll(async () => {
  await instance?.close();
});

async function saveSyntheticCapture(request: APIRequestContext) {
  const id = crypto.randomUUID();
  const saved = await request.post(`${instance.origin}/api/captures/${id}`, {
    data: Buffer.from([255, 216, 255, 12]),
    headers: {
      Origin: instance.origin,
      "X-Scanner-Request": "1",
      "X-Capture-Status": "accepted",
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1200, 1800],
        quality: { ok: true, receiptPixels: [1200, 1800] },
      }),
    },
  });
  expect(saved.status()).toBe(200);
  return id;
}

test("owner can comment on a saved receipt and see the note in source review", async ({
  page,
  request,
}) => {
  const id = await saveSyntheticCapture(request);
  await page.goto(instance.origin);
  const row = page.locator(".capture-row").first();
  await expect(row).toContainText("Current take");
  await row.getByRole("button", { name: "Comment" }).click();
  const input = row.getByRole("textbox", { name: /original paper/i });
  const panelInput = page.locator("#saved-photo").getByRole("textbox", {
    name: /original paper/i,
  });
  await input.fill("Draft in the capture list");
  await expect(panelInput).toHaveValue("Draft in the capture list");
  await panelInput.fill("Original paper is cut off. No fuller copy exists.");
  await expect(input).toHaveValue(
    "Original paper is cut off. No fuller copy exists.",
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/captures/*/notes", async (route) => {
    await held;
    await route.continue();
  });
  await row.getByRole("button", { name: "Save comment" }).click();
  await expect(input).toBeDisabled();
  release();
  await expect(row).toContainText(
    "Original paper is cut off. No fuller copy exists.",
  );

  await page.goto(`${instance.origin}/review?document=${id}`);
  await expect(page.locator(".review-owner-notes")).toContainText(
    "Original paper is cut off. No fuller copy exists.",
  );
  await expect(page.locator(".review-sources")).toContainText(
    "Original paper is cut off. No fuller copy exists.",
  );
});

test("an unfinished comment survives capture-list replacement", async ({
  page,
  request,
}) => {
  for (let index = 0; index < 11; index++) await saveSyntheticCapture(request);
  await page.goto(instance.origin);
  const row = page.locator(".capture-row").first();
  await row.getByRole("button", { name: "Comment" }).click();
  await row
    .getByRole("textbox", { name: /original paper/i })
    .fill("Draft while scanning continues");
  await page.getByRole("button", { name: "Older" }).click();
  await page.getByRole("button", { name: "Newer" }).click();
  await expect(
    page
      .locator(".capture-row")
      .first()
      .getByRole("textbox", { name: /original paper/i }),
  ).toHaveValue("Draft while scanning continues");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/captures/*/notes", async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Synthetic save failure" }),
    });
  });
  await page
    .locator(".capture-row")
    .first()
    .getByRole("button", { name: "Save comment" })
    .click();
  await page.getByRole("button", { name: "Older" }).click();
  await page.getByRole("button", { name: "Newer" }).click();
  release();
  const restored = page.locator(".capture-row").first();
  await expect(restored).toContainText("Could not save comment");
  await expect(
    restored.getByRole("textbox", { name: /original paper/i }),
  ).toHaveValue("Draft while scanning continues");
});

test("a comment added in review appears above the intervention area immediately", async ({
  page,
  request,
}) => {
  const id = await saveSyntheticCapture(request);
  await page.goto(`${instance.origin}/review?document=${id}`);
  const source = page
    .locator(".review-sources")
    .locator(".capture-notes")
    .first();
  await source.getByRole("button", { name: "Comment" }).click();
  await source
    .getByRole("textbox", { name: /original paper/i })
    .fill("This is the best available original paper.");
  await source.getByRole("button", { name: "Save comment" }).click();
  await expect(page.locator(".review-owner-notes")).toContainText(
    "This is the best available original paper.",
  );
});
