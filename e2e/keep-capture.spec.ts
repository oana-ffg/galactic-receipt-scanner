import { chromium, webkit, test, expect } from "@playwright/test";
import { startTestServer } from "../scripts/test-server.mjs";
for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine}: keep failed quality, retry lost keep acknowledgement, then scan unrelated paper`, async () => {
    test.setTimeout(120000);
    const server = await startTestServer();
    const context = await (
      engine === "chromium" ? chromium : webkit
    ).launchPersistentContext("", {
      channel: engine === "chromium" ? "chrome" : "",
      baseURL: server.origin,
    });
    try {
      const phone = await context.newPage();
      await phone.addInitScript(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 2000;
        canvas.height = 2400;
        const ctx = canvas.getContext("2d")!;
        setInterval(() => {
          ctx.fillStyle = "#181818";
          ctx.fillRect(0, 0, 2000, 2400);
          if (document.documentElement.dataset.paper !== "true") return;
          ctx.fillStyle = "#eeeeee";
          ctx.fillRect(380, 180, 1240, 2040);
          ctx.fillStyle = "#202020";
          ctx.font = "bold 56px monospace";
          [
            "SYNTHETIC RECEIPT",
            "Test item 123.45",
            "Tax 24.69",
            "Total 123.45",
            "TEST DATA ONLY",
          ].forEach((line, i) => ctx.fillText(line, 445, 410 + i * 235));
        }, 70);
        Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
          value: async () => canvas.captureStream(15),
        });
        Object.defineProperty(window, "ImageCapture", { value: undefined });
        Object.defineProperty(window, "RTCPeerConnection", {
          value: undefined,
        });
        const bitmap = window.createImageBitmap.bind(window);
        window.createImageBitmap = (async (
          source: ImageBitmapSource,
          ...args: unknown[]
        ) => {
          if (
            source instanceof HTMLVideoElement &&
            document.documentElement.dataset.blur === "true"
          ) {
            const blurred = document.createElement("canvas");
            blurred.width = source.videoWidth;
            blurred.height = source.videoHeight;
            const target = blurred.getContext("2d")!;
            // A badly undersampled still gives the real vision worker a reproducible rejected original.
            const small = document.createElement("canvas");
            small.width = 40;
            small.height = 48;
            small.getContext("2d")!.drawImage(source, 0, 0, 40, 48);
            target.drawImage(small, 0, 0, blurred.width, blurred.height);
            return bitmap(blurred);
          }
          return (bitmap as (...args: unknown[]) => Promise<ImageBitmap>)(
            source,
            ...args,
          );
        }) as typeof createImageBitmap;
        const fetchOriginal = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const response = await fetchOriginal(input, init);
          if (
            String(input).endsWith("/keep") &&
            document.documentElement.dataset.loseKeep === "true"
          ) {
            delete document.documentElement.dataset.loseKeep;
            throw new Error("Synthetic lost keep acknowledgement");
          }
          return response;
        };
      });
      await phone.goto("/camera");
      await phone
        .getByRole("button", { name: "Enable camera", exact: true })
        .click();
      await phone.evaluate(() => {
        Object.assign(document.documentElement.dataset, {
          paper: "true",
          blur: "true",
          loseKeep: "true",
        });
      });
      await expect(phone.locator("#phase")).toHaveText("NEEDS ATTENTION", {
        timeout: 30000,
      });
      const before = (await (await context.request.get("/api/captures")).json())
        .captures;
      expect(before).toHaveLength(1);
      expect(before[0].status).toBe("rejected");
      await phone.locator("#keep").click();
      await expect(phone.locator("#status")).toContainText(
        "Could not confirm keeping",
      );
      await expect(phone.locator("#phase")).toHaveText("NEEDS ATTENTION");
      // Desktop fallback command targets exactly the failed capture and retries idempotently.
      const desktop = await context.newPage();
      await desktop.goto("/");
      await expect(desktop.locator("#keep")).toBeEnabled();
      await desktop.locator("#keep").click();
      await expect(phone.locator("#phase")).toHaveText("SAVED FOR REVIEW");
      await expect(phone.locator("#count")).toHaveText("1");
      const kept = await (
        await context.request.get(`/api/captures/${before[0].id}`)
      ).json();
      expect(kept).toMatchObject({
        status: "manual-review",
        source_status: "rejected",
        sha256: before[0].sha256,
        metadata: { quality: { ok: false } },
      });
      await phone.waitForTimeout(1800);
      expect(
        (await (await context.request.get("/api/captures")).json()).captures,
      ).toHaveLength(1);
      await phone.evaluate(() => {
        document.documentElement.dataset.paper = "false";
      });
      await expect
        .poll(
          async () =>
            (await (await context.request.get("/api/station")).json()).state
              .armed,
        )
        .toBe(true);
      await phone.evaluate(() => {
        Object.assign(document.documentElement.dataset, {
          paper: "true",
          blur: "false",
        });
      });
      await expect(phone.locator("#phase")).toHaveText("SAVED · NEXT", {
        timeout: 30000,
      });
      const after = (await (await context.request.get("/api/captures")).json())
        .captures;
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({
        status: "accepted",
        retake_of: null,
        take_number: 1,
      });
      expect(after[0].receipt_id).not.toBe(kept.receipt_id);
    } finally {
      await context.close();
      await server.close();
    }
  });
}
