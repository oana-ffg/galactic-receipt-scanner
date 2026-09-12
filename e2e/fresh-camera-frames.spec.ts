import {
  chromium,
  webkit,
  expect,
  test,
  type BrowserContext,
} from "@playwright/test";
import { startTestServer } from "../scripts/test-server.mjs";

for (const { engine, photoApi } of (["chromium", "webkit"] as const).flatMap(
  (engine) =>
    ["unavailable", "failing"].map((photoApi) => ({ engine, photoApi })),
)) {
  test(`${engine} camera captures and rearms with playback counters stuck at zero and ${photoApi} photo API`, async () => {
    const server = await startTestServer();
    let context: BrowserContext | undefined;
    try {
      // A disposable normal profile exercises durable Blob storage; Safari
      // private browsing is not a supported mode for pending originals.
      context = await (
        engine === "chromium" ? chromium : webkit
      ).launchPersistentContext("", {
        channel: engine === "chromium" ? "chrome" : "",
        baseURL: server.origin,
      });
      const request = context.request;
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((photoApi) => {
        const canvas = document.createElement("canvas");
        canvas.width = 2000;
        canvas.height = 2400;
        const ctx = canvas.getContext("2d")!;
        const draw = () => {
          ctx.fillStyle = "#181818";
          ctx.fillRect(0, 0, 2000, 2400);
          if (document.documentElement?.dataset.paper !== "true") return;
          ctx.fillStyle = "#c8c8c8";
          ctx.fillRect(380, 180, 1240, 2040);
          ctx.fillStyle = "#232323";
          ctx.font = "56px sans-serif";
          [
            "SYNTHETIC RECEIPT",
            "Test item 123.45",
            "Tax 24.69",
            "Total 123.45",
            "TEST DATA ONLY",
          ].forEach((line, i) => ctx.fillText(line, 450, 420 + i * 210));
        };
        draw();
        setInterval(draw, 70);
        Object.defineProperty(MediaDevices.prototype, "getUserMedia", {
          value: async () => canvas.captureStream(15),
        });
        Object.defineProperty(window, "ImageCapture", {
          value:
            photoApi === "unavailable"
              ? undefined
              : class {
                  async getPhotoCapabilities() {
                    return {
                      imageWidth: { max: 2000 },
                      imageHeight: { max: 2400 },
                    };
                  }
                  async takePhoto() {
                    throw new DOMException(
                      "Sensitive native error detail",
                      "OperationError",
                    );
                  }
                },
          configurable: true,
        });
        HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
          return {
            totalVideoFrames: 0,
            droppedVideoFrames: 0,
            corruptedVideoFrames: 0,
            creationTime: 0,
          };
        };
      }, photoApi);
      const before = (await (await request.get("/api/captures")).json())
        .captures.length;
      await page.goto("/camera");

      await page
        .getByRole("button", { name: "Enable camera", exact: true })
        .click();
      await expect(page.locator("#phase")).not.toHaveText("STARTING CAMERA", {
        timeout: 20000,
      });
      expect(
        await page.locator("#phase").innerText(),
        await page.locator("#detail").innerText(),
      ).not.toBe("CAMERA STOPPED");
      await expect(
        page.getByRole("button", { name: "Camera enabled", exact: true }),
      ).toBeDisabled({ timeout: 20000 });
      const control = await request.post("/api/control/start", {
        headers: { Origin: server.origin, "X-Scanner-Request": "1" },
      });
      expect(control.ok()).toBe(true);
      await page.evaluate(() => {
        document.documentElement.dataset.paper = "true";
      });
      await expect
        .poll(
          async () => {
            const phase = await page.locator("#phase").innerText();
            return phase === "SAVED · NEXT"
              ? phase
              : `${phase}: ${await page.locator("#status").innerText()}`;
          },
          { timeout: 15000 },
        )
        .toBe("SAVED · NEXT");
      const after = (await (await request.get("/api/captures")).json())
        .captures;
      expect(after.length).toBe(before + 1);
      expect(after[0].status).toBe("accepted");
      expect(after[0].outputs).toEqual({ image: false, pdf: false });
      await page.waitForTimeout(1800);
      expect(
        (await (await request.get("/api/captures")).json()).captures.length,
      ).toBe(before + 1);
      await page.evaluate(() => {
        document.documentElement.dataset.paper = "false";
      });
      await expect(page.locator("#status")).toHaveText(
        "Ready for the next receipt.",
      );
      await page
        .getByRole("button", { name: "Report issue", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Report a private issue",
      });
      await dialog
        .getByLabel("Title", { exact: true })
        .fill("Synthetic camera diagnostics");
      await dialog.getByRole("button", { name: "Save private issue" }).click();
      await expect(dialog.locator(".issue-feedback")).toContainText(
        "Private issue saved.",
      );
      const reports = await (await request.get("/api/issues")).json();
      const diagnostic = reports.issues[0].context.diagnostics;
      expect(diagnostic.device).toBe("phone");
      expect(diagnostic.build).toMatch(/\/assets\/.*\.js$/);
      expect(diagnostic.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "camera.frames" }),
          expect.objectContaining({ event: "camera.settings" }),
          expect.objectContaining({
            event: "camera.photo",
            data: expect.objectContaining({
              stage: "video-frame",
              reason:
                photoApi === "unavailable"
                  ? "api-unavailable"
                  : "native-failed",
              ...(photoApi === "failing"
                ? { failedStage: "take-photo", error: "OperationError" }
                : {}),
            }),
          }),
          expect.objectContaining({
            event: "camera.photo",
            data: expect.objectContaining({
              stage: "decoded",
              width: 2000,
              height: 2400,
            }),
          }),
          expect.objectContaining({ event: "vision" }),
          expect.objectContaining({
            event: "scan.transition",
            data: expect.objectContaining({ phase: "green" }),
          }),
          expect.objectContaining({
            event: "upload.saved",
            data: expect.objectContaining({
              id: after[0].id,
              status: "accepted",
            }),
          }),
        ]),
      );
      expect(JSON.stringify(diagnostic)).not.toContain(
        "Sensitive native error detail",
      );
      expect(
        (await (await request.get("/api/captures")).json()).captures.length,
      ).toBe(before + 1);
      expect(errors).toEqual([]);
    } finally {
      try {
        await context?.close();
      } finally {
        await server.close();
      }
    }
  });
}
