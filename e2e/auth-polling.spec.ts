import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("dashboard stops polling after owner access is denied", async ({ page }) => {
  let stationRequests = 0;
  await page.route(/\/api\/station(?:\/preview)?$/, async (route) => {
    stationRequests++;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Sign in with the owner account." }),
    });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText(
    "sign in with the owner account",
  );
  await page.waitForTimeout(1000);
  const stoppedAt = stationRequests;
  await page.waitForTimeout(1000);
  expect(stationRequests).toBe(stoppedAt);
});

test("late preview decode cannot redraw after access is denied", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    Object.defineProperty(window, "createImageBitmap", {
      value: async (source: ImageBitmapSource) => {
        (window as any).bitmapStarted = true;
        await new Promise<void>((resolve) => {
          (window as any).releaseBitmap = resolve;
        });
        const bitmap = await decode(source);
        (window as any).bitmapFinished = true;
        return bitmap;
      },
    });
  });
  const preview = await readFile("e2e/fixtures/generated/flat.png");
  await page.route(/\/api\/station\/preview$/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: preview }),
  );
  let releaseStation!: () => void;
  const stationHeld = new Promise<void>((resolve) => {
    releaseStation = resolve;
  });
  await page.route(/\/api\/station$/, async (route) => {
    await stationHeld;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Sign in with the owner account." }),
    });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).bitmapStarted === true);
  releaseStation();
  await expect(page.locator("#status")).toContainText("sign in");
  await page.evaluate(() => (window as any).releaseBitmap());
  await page.waitForFunction(() => (window as any).bitmapFinished === true);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.locator("#feed")).toBeHidden();
  await expect(page.locator("#empty-preview")).toBeVisible();
});
