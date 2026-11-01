import { expect, test } from "@playwright/test";

test("idle and hidden dashboards stop fallback traffic and reconnect when visible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
  const requests = { station: 0, preview: 0, demand: 0 };
  let camera: string | null = null;
  await page.route("**/api/station", async (route) => {
    requests.station++;
    await route.fulfill({
      json: {
        camera,
        previewSession: null,
        state: null,
        count: 0,
        fresh: Boolean(camera),
      },
    });
  });
  await page.route("**/api/station/preview", async (route) => {
    requests.preview++;
    await route.fulfill({ status: 204 });
  });
  await page.route("**/api/station/preview-request", async (route) => {
    requests.demand++;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await expect(page.locator("#count")).toHaveText("0");
  await page.waitForTimeout(6000);
  expect(requests.preview).toBe(0);
  expect(requests.demand).toBe(0);
  expect(requests.station).toBeLessThanOrEqual(3);

  camera = "00000000-0000-4000-8000-000000000001";
  await expect.poll(() => requests.preview).toBeGreaterThanOrEqual(2);
  await expect.poll(() => requests.demand).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Let any request already in flight finish before measuring hidden traffic.
  await page.waitForTimeout(1100);
  const hidden = { ...requests };
  await page.waitForTimeout(3200);
  expect(requests.preview).toBe(hidden.preview);
  expect(requests.demand).toBe(hidden.demand);
  expect(requests.station - hidden.station).toBeLessThanOrEqual(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requests.preview).toBeGreaterThan(hidden.preview);
  await expect.poll(() => requests.demand).toBeGreaterThan(hidden.demand);

  camera = null;
  await page.waitForTimeout(1600);
  const disconnected = requests.preview;
  await page.waitForTimeout(1600);
  expect(requests.preview).toBe(disconnected);
});

test("visibility events cannot overlap a pending station request", async ({
  page,
}) => {
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/station", async (route) => {
    requests++;
    await held;
    await route.fulfill({
      json: {
        camera: null,
        state: null,
        previewSession: null,
        count: 0,
        fresh: false,
      },
    });
  });
  await page.goto("/");
  await expect.poll(() => requests).toBe(1);
  try {
    await page.evaluate(() => {
      for (let i = 0; i < 10; i++)
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(500);
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(page.locator("#count")).toHaveText("0");
});
