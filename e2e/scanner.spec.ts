import { expect, test, type Page } from "@playwright/test";

test("capture survives preview delays and a lost acknowledgement without creating a PDF", async ({
  browser,
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
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
  await phone.addInitScript(() => {
    Object.defineProperty(window, "RTCPeerConnection", { value: undefined });
  });
  await syntheticCamera(phone);
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
  // HTTP preview remains slow while independent detection and capture proceed.
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { previewDelay: number } }
    ).scannerFixture.previewDelay = 3000;
  });
  // Preview recovery must not require another Start/Retry command. A real save
  // failure must still block green and retain the exact original for retry.
  await expect(phone.locator("#phase")).toHaveText("NEEDS ATTENTION", {
    timeout: 25000,
  });
  await expect(phone.locator("#status")).toContainText(
    "connection was interrupted",
  );
  const interrupted = (await (await request.get("/api/captures")).json())
    .captures;
  expect(interrupted).toHaveLength(1);
  expect(interrupted[0].status).toBe("accepted");
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { failAcknowledgement: boolean } }
    ).scannerFixture.failAcknowledgement = false;
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
  expect(pdf.status()).toBe(404);
  expect(capture.outputs).toEqual({ image: false, pdf: false });
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
  let reclaimCount = 0;
  phone.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/station/claim") reclaimCount++;
  });
  await phone.route(
    "**/api/station/heartbeat",
    (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Camera lease expired." }),
      }),
    { times: 1 },
  );
  await expect.poll(() => reclaimCount).toBe(1);
  await expect(
    phone.getByRole("button", { name: "Camera enabled", exact: true }),
  ).toBeDisabled();
  expect(
    (await (await request.get("/api/captures")).json()).captures.length,
  ).toBe(1);
  await phone.route("**/api/station/heartbeat", (route) =>
    route.fulfill({ status: 403, contentType: "application/json", body: "{}" }),
  );
  await expect(phone.locator("#phase")).toHaveText("CAMERA STOPPED");
  await expect(
    phone.getByRole("button", { name: "Enable camera", exact: true }),
  ).toBeEnabled();
  await phone.close();
  await expect(page.locator("#signal")).toHaveClass("signal red", {
    timeout: 15000,
  });
  expect(errors).toEqual([]);
});

async function syntheticCamera(phone: Page) {
  await phone.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    const fixture = {
      paper: false,
      blankPhoto: false,
      previewOffline: false,
      heartbeatOffline: false,
      failAcknowledgement: true,
      previewDelay: 0,
      originalDelay: 0,
      backgroundPulse: false,
      handheld: false,
      exposurePulse: false,
    };
    const originalBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((
      source: ImageBitmapSource,
      ...args: unknown[]
    ) => {
      if (source instanceof HTMLVideoElement && fixture.blankPhoto) {
        const blank = document.createElement("canvas");
        blank.width = 2000;
        blank.height = 2400;
        blank.getContext("2d")!.fillRect(0, 0, 2000, 2400);
        return originalBitmap(blank);
      }
      return (originalBitmap as (...params: unknown[]) => Promise<ImageBitmap>)(
        source,
        ...args,
      );
    }) as typeof createImageBitmap;
    const originalEncode = HTMLCanvasElement.prototype.toBlob;
    let photoEncodes = 0;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (this.width > 1000 && ++photoEncodes > 1) {
        callback(null);
        return;
      }
      originalEncode.call(this, callback, type, quality);
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
      if (path === "/api/station/preview" && fixture.previewDelay)
        await new Promise((resolve) =>
          setTimeout(resolve, fixture.previewDelay),
        );
      if (
        fixture.originalDelay &&
        init?.method === "POST" &&
        /^\/api\/captures\/[^/]+$/.test(path)
      )
        await new Promise((resolve) =>
          setTimeout(resolve, fixture.originalDelay),
        );
      const response = await fetchOriginal(input, init);
      if (
        fixture.failAcknowledgement &&
        init?.method === "POST" &&
        /^\/api\/captures\/[^/]+$/.test(path)
      )
        throw new DOMException("Fetch is aborted", "AbortError");
      return response;
    };
    Object.assign(window, { scannerFixture: fixture });
    setInterval(() => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const phase = Math.floor(performance.now() / 350) % 2;
      const background = fixture.backgroundPulse && phase ? 75 : 25;
      ctx.fillStyle = `rgb(${background},${background},${background})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!fixture.paper) return;
      if (fixture.handheld) ctx.translate(phase ? 50 : -50, phase ? 20 : -20);
      const paper = fixture.exposurePulse && phase ? 224 : 244;
      ctx.fillStyle = `rgb(${paper},${paper},${paper})`;
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
}

test("direct preview delivers live frames and immediate controls while HTTP preview is slow", async ({
  browser,
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const tools: Record<
      string,
      { execute: (input: object) => Promise<unknown> }
    > = {};
    Object.assign(window, { scannerTools: tools });
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: (tool: {
          name: string;
          execute: (input: object) => Promise<unknown>;
        }) => {
          tools[tool.name] = tool;
        },
      },
    });
  });
  await page.goto("/");
  const phone = await browser.newPage();
  await syntheticCamera(phone);
  await phone.goto("http://127.0.0.1:8766/camera");
  await phone.evaluate(() => {
    const f = (
      window as unknown as {
        scannerFixture: { failAcknowledgement: boolean; previewDelay: number };
      }
    ).scannerFixture;
    f.failAcknowledgement = false;
    f.previewDelay = 3000;
    Object.assign(f, {
      backgroundPulse: true,
      exposurePulse: true,
      handheld: true,
    });
  });
  // The prior camera's lease naturally expires; no test data is deleted.
  await expect
    .poll(
      async () => (await (await request.get("/api/station")).json()).fresh,
      { timeout: 15000 },
    )
    .toBe(false);
  // Freshness expires after five seconds; the exclusive camera lease lasts ten.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await phone.getByRole("button", { name: "Enable camera" }).click();
  await expect(page.locator("#live-feed")).toBeVisible({ timeout: 20000 });
  await expect
    .poll(
      () =>
        page
          .locator("#live-feed")
          .evaluate((el: HTMLVideoElement) => el.videoWidth),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0);
  const sample = await page
    .locator("#live-feed")
    .evaluate(async (video: HTMLVideoElement) => {
      const first = video.getVideoPlaybackQuality().totalVideoFrames;
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return {
        frames: video.getVideoPlaybackQuality().totalVideoFrames - first,
        milliseconds: performance.now() - start,
      };
    });
  console.log("Direct preview benchmark", JSON.stringify(sample));
  expect(sample.frames).toBeGreaterThan(10);
  await page
    .getByRole("button", { name: "Start scanning", exact: true })
    .click();
  await expect(phone.locator("#phase")).toHaveText("WAIT", { timeout: 1500 });
  const started = Date.now();
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = true;
  });
  await expect(phone.locator("#phase")).toHaveText("SAVED · NEXT", {
    timeout: 5000,
  });
  console.log("Original capture benchmark ms", Date.now() - started);
  const { captures } = await (await request.get("/api/captures")).json();
  expect(captures[0].outputs).toEqual({ image: false, pdf: false });
  await expect(phone.locator("#count")).toHaveText(String(captures.length));
  // Later movement cannot invalidate the already frozen and checked original.
  await phone.evaluate(() => {
    const f = (
      window as unknown as {
        scannerFixture: { paper: boolean; originalDelay: number };
      }
    ).scannerFixture;
    f.paper = false;
    f.originalDelay = 1200;
  });
  await expect(phone.locator("#status")).toHaveText(
    "Ready for the next receipt.",
  );
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = true;
  });
  await expect(phone.locator("#phase")).toHaveText("SAVING ORIGINAL");
  await phone.evaluate(() => {
    (
      window as unknown as { scannerFixture: { paper: boolean } }
    ).scannerFixture.paper = false;
  });
  await expect(phone.locator("#phase")).toHaveText("SAVED · NEXT");
  await expect(phone.locator("#status")).toHaveText(
    "Ready for the next receipt.",
  );
  await phone.evaluate(() =>
    Object.assign(
      (window as unknown as { scannerFixture: object }).scannerFixture,
      { paper: true, blankPhoto: true, originalDelay: 0 },
    ),
  );
  await expect(phone.locator("#phase")).toHaveText("NEEDS ATTENTION");
  await expect(
    phone.getByRole("button", { name: "Retake photo", exact: true }),
  ).toBeEnabled();
  await expect(
    phone.getByRole("button", { name: "Retry upload", exact: true }),
  ).toBeDisabled();
  await phone.evaluate(() =>
    Object.assign(
      (window as unknown as { scannerFixture: object }).scannerFixture,
      { blankPhoto: false },
    ),
  );
  await phone
    .getByRole("button", { name: "Retake photo", exact: true })
    .click();
  await expect(phone.locator("#phase")).toHaveText("SAVED · NEXT");
  const batch = (await (await request.get("/api/captures")).json()).captures;
  expect(
    batch.filter(
      (capture: { status: string }) => capture.status === "rejected",
    ),
  ).toHaveLength(1);
  expect(
    batch.filter(
      (capture: { status: string }) => capture.status === "accepted",
    ),
  ).toHaveLength(4);
  const current = batch[0];
  const rejected = batch.find(
    (capture: { status: string }) => capture.status === "rejected",
  );
  expect(current.retake_of).toBe(rejected.id);
  expect(current.receipt_id).toBe(rejected.receipt_id);
  // A desktop retake of an accepted photo stays one receipt even if its
  // acknowledgement is lost and the phone has to retry the original upload.
  await phone.evaluate(() =>
    Object.assign(
      (window as unknown as { scannerFixture: object }).scannerFixture,
      { failAcknowledgement: true },
    ),
  );
  await page.getByRole("button", { name: "Retake photo", exact: true }).click();
  await expect(phone.locator("#phase")).toHaveText("NEEDS ATTENTION");
  const duringRetry = (await (await request.get("/api/captures")).json())
    .captures;
  const retake = duringRetry[0];
  expect(retake).toMatchObject({
    receipt_id: current.receipt_id,
    retake_of: current.id,
    take_number: 3,
    is_current: true,
  });
  expect((await (await request.get("/api/station")).json()).count).toBe(4);
  await phone.evaluate(() =>
    Object.assign(
      (window as unknown as { scannerFixture: object }).scannerFixture,
      { failAcknowledgement: false },
    ),
  );
  await phone
    .getByRole("button", { name: "Retry upload", exact: true })
    .click();
  await expect(phone.locator("#phase")).toHaveText("SAVED · NEXT");
  await expect(phone.locator("#count")).toHaveText("4");
  await expect(page.locator("#captures")).toContainText(
    "Previous take · Not counted",
  );
  await expect(page.locator("#captures")).toContainText("Retake 3");
  const afterRetry = (await (await request.get("/api/captures")).json())
    .captures;
  expect(afterRetry).toHaveLength(duringRetry.length);
  expect(
    afterRetry.find((capture: { id: string }) => capture.id === current.id),
  ).toMatchObject({ is_current: false, sha256: current.sha256 });
  const currentTakes = (
    await (await request.get("/api/captures?current=1")).json()
  ).captures;
  expect(currentTakes).toHaveLength(4);
  expect(
    currentTakes.some((capture: { id: string }) => capture.id === current.id),
  ).toBe(false);
  await phone.close();
  // Crops and PDFs are an explicit downstream action on an existing original.
  const prepared = (await page.evaluate(async (id) => {
    const tools = (
      window as unknown as {
        scannerTools: Record<
          string,
          { execute: (input: object) => Promise<unknown> }
        >;
      }
    ).scannerTools;
    return tools.prepare_receipt_outputs.execute({ id });
  }, captures[0].id)) as {
    outputs: { image: boolean; pdf: boolean };
    sha256: string;
  };
  expect(prepared.outputs).toEqual({ image: true, pdf: true });
  expect(prepared.sha256).toBe(captures[0].sha256);
  const pdf = await request.get(`/api/files/${captures[0].id}/pdf`);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
});
