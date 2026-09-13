import { chromium, webkit, expect, test } from "@playwright/test";

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} phone reporting survives retired lazy assets and avoids full-resolution copies`, async () => {
    const browser = await (engine === "chromium" ? chromium : webkit).launch({
      channel: engine === "chromium" ? "chrome" : "",
    });
    try {
      const context = await browser.newContext({
        baseURL: "http://127.0.0.1:8766",
        viewport: { width: 393, height: 695 },
      });
      const page = await context.newPage();
      await page.goto("/camera");
      await page.evaluate(async () => {
        const source = document.createElement("canvas");
        source.width = 2160;
        source.height = 3840;
        const drawing = source.getContext("2d")!;
        drawing.fillStyle = "#283848";
        drawing.fillRect(0, 0, source.width, source.height);
        drawing.fillStyle = "white";
        drawing.fillRect(400, 400, 1300, 2600);
        const video = document.querySelector("video")!;
        video.srcObject = source.captureStream(15);
        // WebKit needs frames produced after stream attachment to start playback.
        setInterval(() => drawing.fillRect(400, 400, 1300, 2600), 70);
        await video.play();
        // Extra full-resolution canvases are wasteful for a viewport screenshot
        // and can exhaust a phone's canvas memory while the camera is running.
        const height = Object.getOwnPropertyDescriptor(
          HTMLCanvasElement.prototype,
          "height",
        )!;
        Object.defineProperty(HTMLCanvasElement.prototype, "height", {
          ...height,
          set(value: number) {
            if (this.width * value > 2_000_000)
              throw new Error("Synthetic canvas memory limit");
            height.set!.call(this, value);
          },
        });
        const encode = HTMLCanvasElement.prototype.toBlob;
        let fail = true;
        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
          if (fail) {
            fail = false;
            callback(null);
            return;
          }
          return encode.call(this, callback, ...args);
        };
      });
      // Simulate deployment removing old lazy chunks after the camera page loads.
      const lateScripts: string[] = [];
      await page.route("**/assets/*.js", (route) => {
        lateScripts.push(route.request().url());
        return route.fulfill({ status: 404, body: "Not found" });
      });
      const report = page.getByRole("button", {
        name: "Report issue",
        exact: true,
      });
      await report.click();
      await expect(page.locator("#report-error")).toContainText(
        "Tap Report issue to try again",
      );
      await expect(page.locator("#report-error")).toBeInViewport();
      await expect(report).toBeEnabled();
      await report.click();
      const dialog = page.getByRole("dialog", {
        name: "Report a private issue",
      });
      await expect(dialog).toBeVisible();
      const image = dialog.getByRole("img");
      await expect(image).toBeVisible();
      expect(
        await image.evaluate((node: HTMLImageElement) => node.naturalWidth),
      ).toBe(393);
      const title = `Synthetic ${engine} phone screenshot retry`;
      await dialog.getByLabel("Title", { exact: true }).fill(title);
      await dialog.getByRole("button", { name: "Save private issue" }).click();
      await expect(dialog).not.toBeVisible();
      const reports = await (await context.request.get("/api/issues")).json();
      const saved = reports.issues.find(
        (issue: { title: string }) => issue.title === title,
      );
      expect(saved?.context.diagnostics.device).toBe("phone");
      expect(lateScripts).toEqual([]);
      expect((await context.request.get(saved.screenshot)).ok()).toBe(true);
    } finally {
      await browser.close();
    }
  });
}
