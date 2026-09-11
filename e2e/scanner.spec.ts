import { expect, test } from "@playwright/test";

test("hands-free browser capture produces one durable original, crop and PDF", async ({
  browser,
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start scanning", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#captures")).toContainText("No captures yet");
  const controls = await page.locator(".controls").boundingBox();
  expect(controls!.y + controls!.height).toBeLessThan(900);

  const phone = await browser.newPage({
    viewport: { width: 393, height: 852 },
  });
  phone.on("pageerror", (error) => errors.push(error.message));
  // Exercise the actual phone page and upload buffer with a synthetic camera stream.
  // Only the camera device is substituted; detector, state, D1/R2 and PDF are real.
  await phone.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    const fixture = {
      paper: false,
      previewOffline: false,
      heartbeatOffline: false,
      failFinalize: true,
    };
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const path = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.origin,
      ).pathname;
      if (fixture.previewOffline && path === "/api/station/preview")
        throw new DOMException("Fetch is aborted", "AbortError");
      if (fixture.heartbeatOffline && path === "/api/station/heartbeat")
        throw new TypeError("Load failed");
      if (fixture.failFinalize && path.endsWith("/finalize"))
        return new Response("Temporary service error", { status: 503 });
      return fetchOriginal(input, init);
    };
    Object.assign(window, { scannerFixture: fixture });
    setInterval(() => {
      ctx.fillStyle = "#191919";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!fixture.paper) return;
      ctx.fillStyle = "#f4f4f4";
      ctx.fillRect(380, 180, 1240, 2040);
      ctx.fillStyle = "#141414";
      ctx.font = "bold 64px monospace";
      [
        "SYNTHETIC RECEIPT",
        "2026-09-11",
        "Food      125.50",
        "Litter     74.50",
        "TOTAL     200.00",
        "TEST DATA ONLY",
      ].forEach((line, i) => ctx.fillText(line, 445, 410 + i * 235));
    }, 70);
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async () => canvas.captureStream(15),
    });
    Object.defineProperty(window, "ImageCapture", {
      value: undefined,
      configurable: true,
    });
  });
  await phone.goto("http://127.0.0.1:8766/camera");
  await expect(phone.locator("#phase")).toHaveText("ENABLE CAMERA");
  await expect(phone.locator("#status")).toContainText("Tap Enable camera");
  await phone.getByRole("button", { name: "Enable camera" }).click();
  await expect(phone.locator("#status")).toContainText("Choose Start scanning");
  await expect
    .poll(async () =>
      (await request.get("/api/station"))
        .json()
        .then((station) => station.fresh),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Start scanning", exact: true })
    .click();
  await expect(phone.locator("#phase")).toHaveText("WAIT");
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { previewOffline: boolean } }
    ).scannerFixture.previewOffline = true;
  });
  await expect(phone.locator("#connection-warning")).toContainText(
    "Retrying automatically",
  );
  await expect(phone.locator("#status")).not.toContainText("Fetch is aborted");
  await expect(page.locator("#connection-warning")).toContainText(
    "Desktop preview is delayed",
  );
  await phone.evaluate(() => {
    (
      window as unknown as {
        scannerFixture: { previewOffline: boolean; paper: boolean };
      }
    ).scannerFixture.previewOffline = false;
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = true;
  });
  await expect(phone.locator("#connection-warning")).toBeEmpty();
  // Preview recovery must not require another Start/Retry command. A real save
  // failure must still block green and retain the exact original for retry.
  await expect(phone.locator("#phase")).toHaveText("NEEDS ATTENTION", {
    timeout: 25000,
  });
  await expect(phone.locator("#status")).toContainText(
    "temporarily unavailable",
  );
  const interrupted = (await (await request.get("/api/captures")).json())
    .captures;
  expect(interrupted).toHaveLength(1);
  expect(interrupted[0].status).toBe("checking");
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { failFinalize: boolean } }
    ).scannerFixture.failFinalize = false;
  });
  await phone.getByRole("button", { name: "Retry upload" }).click();
  await expect(page.locator("#phase")).toHaveText("SAVED · NEXT", {
    timeout: 25000,
  });
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator(".capture-row")).toContainText(
    "OCR awaiting Work",
    {
      timeout: 25000,
    },
  );
  const response = await request.get("/api/captures");
  const { captures } = await response.json();
  expect(captures).toHaveLength(1);
  const capture = captures[0];
  expect(capture.id).toBe(interrupted[0].id);
  expect(capture.sha256).toBe(interrupted[0].sha256);
  expect(capture.metadata.captureMethod).toBe("full-resolution-video-frame");
  expect(capture.metadata.quality.ok).toBe(true);
  const raw = await request.get(`/api/files/${capture.id}/raw`);
  expect((await raw.body()).length).toBeGreaterThan(20000);
  const pdf = await request.get(`/api/files/${capture.id}/pdf`);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  await page.screenshot({
    path: "test-results/dashboard-synthetic.png",
    fullPage: true,
  });

  // A heartbeat interruption recovers without clearing the saved/removal latch.
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { heartbeatOffline: boolean } }
    ).scannerFixture.heartbeatOffline = true;
  });
  await expect(phone.locator("#phase")).toHaveText("RECONNECTING");
  await expect(phone.locator("#status")).toContainText(
    "Reconnecting automatically",
  );
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { heartbeatOffline: boolean } }
    ).scannerFixture.heartbeatOffline = false;
  });
  await expect(phone.locator("#phase")).toHaveText("SAVED · NEXT");
  // The unchanged paper is still in view; it must not repeatedly trigger captures.
  await expect
    .poll(async () =>
      (await request.get("/api/station"))
        .json()
        .then((station) => station.state?.armed),
    )
    .toBe(false);
  expect(
    (await (await request.get("/api/captures")).json()).captures.length,
  ).toBe(1);
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = false;
  });
  await expect
    .poll(async () =>
      (await request.get("/api/station"))
        .json()
        .then((station) => station.state?.armed),
    )
    .toBe(true);
  await phone.route("**/api/station/heartbeat", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Camera lease expired." }),
    }),
  );
  await expect(phone.locator("#phase")).toHaveText("CAMERA STOPPED");
  await expect(phone.locator("#status")).toContainText(
    "Tap Enable camera to reconnect",
  );
  await expect(
    phone.getByRole("button", { name: "Enable camera" }),
  ).toBeEnabled();
  await phone.close();
  await expect(page.locator("#signal")).toHaveClass("signal red", {
    timeout: 15000,
  });
  expect(errors).toEqual([]);
});
