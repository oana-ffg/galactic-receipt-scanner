import { expect, test } from "@playwright/test";

const pairing = "#key=synthetic-browser-test-key";
const headers = { Authorization: "Bearer synthetic-browser-test-key" };

test("hands-free browser capture produces one durable original, crop and searchable PDF", async ({
  browser,
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/" + pairing);
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
  // Only the camera device is substituted; detector, state, disk, OCR and PDF are real.
  await phone.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    const fixture = { paper: false };
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
  await phone.goto("http://127.0.0.1:8766/camera" + pairing);
  await phone.getByRole("button", { name: "Enable camera" }).click();
  await expect
    .poll(async () =>
      (await request.get("/api/state", { headers }))
        .json()
        .then((state) => state.streamFresh),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Start scanning", exact: true })
    .click();
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = true;
  });
  await expect(page.locator("#phase")).toHaveText("SAVED · NEXT", {
    timeout: 25000,
  });
  await expect(page.locator("#count")).toHaveText("1");
  await expect(page.locator(".capture-row")).toContainText("OCR done", {
    timeout: 25000,
  });
  const response = await request.get("/api/captures", { headers });
  const { captures, count } = await response.json();
  expect(count).toBe(1);
  const capture = captures[0];
  expect(capture.metadata.captureMethod).toBe("full-resolution-video-frame");
  expect(capture.metadata.quality.ok).toBe(true);
  const raw = await request.get(`/api/files/${capture.id}/raw`, { headers });
  expect((await raw.body()).length).toBeGreaterThan(20000);
  const text = await request.get(`/api/files/${capture.id}/text`, { headers });
  expect(await text.text()).toContain("200.00");
  const pdf = await request.get(`/api/files/${capture.id}/pdf`, { headers });
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  await page.screenshot({
    path: "test-results/dashboard-synthetic.png",
    fullPage: true,
  });

  // The unchanged paper is still in view; it must not repeatedly trigger captures.
  await expect
    .poll(async () =>
      (await request.get("/api/state", { headers }))
        .json()
        .then((state) => state.armed),
    )
    .toBe(false);
  expect(
    (await (await request.get("/api/captures", { headers })).json()).count,
  ).toBe(1);
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = false;
  });
  await expect
    .poll(async () =>
      (await request.get("/api/state", { headers }))
        .json()
        .then((state) => state.armed),
    )
    .toBe(true);
  await phone.close();
  await expect(page.locator("#signal")).toHaveClass("signal red");
  expect(errors).toEqual([]);
});
