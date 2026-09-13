import { expect, test, chromium, webkit } from "@playwright/test";
import { build } from "esbuild";
import { CaptureState } from "../web/state";

for (const engine of ["chromium", "webkit"] as const) {
  test(`${engine} preview outline follows video and fallback image bounds and expires`, async () => {
    const browser = await (engine === "chromium" ? chromium : webkit).launch({
      channel: engine === "chromium" ? "chrome" : undefined,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="preview" id="preview"><video id="live-feed"></video><canvas id="feed" hidden></canvas></div>',
      );
      await page.addStyleTag({ path: "web/style.css" });
      const bundle = await build({
        stdin: {
          contents: `import { PreviewOverlay } from './web/preview-overlay';
            window.overlay = new PreviewOverlay(document.getElementById('preview'));`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: "iife",
      });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const state = new CaptureState().value;
      Object.assign(state, {
        cameraConnected: true,
        detectorReady: true,
        cameraId: "synthetic-camera",
        stateRevision: 1,
        quality: {
          ok: true,
          reason: "synthetic",
          quad: [
            [0.1, 0.2],
            [0.9, 0.2],
            [0.9, 0.8],
            [0.1, 0.8],
          ],
          hands: [],
        },
      });
      await page.evaluate((state) => {
        const video = document.querySelector<HTMLVideoElement>("video")!;
        // Fixed intrinsic dimensions isolate object-fit geometry from decoding.
        Object.defineProperty(video, "videoWidth", { value: 1600 });
        Object.defineProperty(video, "videoHeight", { value: 900 });
        video.style.width = "100%";
        video.style.height = "100%";
        const overlay = (window as any).overlay;
        overlay.setMedia(video);
        overlay.update(state);
      }, state);
      const svg = page.locator("#preview-overlay");
      await expect(svg).toBeVisible();
      await expect(svg.locator("polygon")).toHaveAttribute(
        "points",
        "100,200 900,200 900,800 100,800",
      );
      await expect(svg.locator("polygon")).toHaveAttribute("stroke", "#57e0a5");
      for (const viewport of [
        { width: 1200, height: 800 },
        { width: 430, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await expect
          .poll(async () =>
            page.evaluate(() => {
              const video = document.querySelector<HTMLVideoElement>("video")!;
              const box = video.getBoundingClientRect();
              const outline = document
                .getElementById("preview-overlay")!
                .getBoundingClientRect();
              const scale = Math.min(box.width / 1600, box.height / 900);
              return Math.max(
                Math.abs(outline.width - 1600 * scale),
                Math.abs(outline.height - 900 * scale),
                Math.abs(outline.x - (box.x + (box.width - 1600 * scale) / 2)),
                Math.abs(outline.y - (box.y + (box.height - 900 * scale) / 2)),
              );
            }),
          )
          .toBeLessThan(1);
      }
      await page.evaluate((state) => {
        const canvas = document.querySelector("canvas")!;
        canvas.width = 600;
        canvas.height = 900;
        canvas.hidden = false;
        document.querySelector("video")!.hidden = true;
        const overlay = (window as any).overlay;
        overlay.setMedia(canvas);
        overlay.update({ ...state, stateRevision: 2 });
      }, state);
      await expect(svg).toBeVisible();
      const imageBox = await page.locator("canvas").boundingBox();
      const outlineBox = await svg.boundingBox();
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(imageBox![key] - outlineBox![key])).toBeLessThan(1);
      await expect(svg).toHaveCSS("pointer-events", "none");
      // Re-delivered identical state cannot refresh expired geometry.
      await page.evaluate((state) => {
        const overlay = (window as any).overlay;
        (window as any).replay = setInterval(
          () => overlay.update({ ...state, stateRevision: 2 }),
          100,
        );
      }, state);
      await expect(svg).toBeHidden({ timeout: 4000 });
      await page.evaluate(() => clearInterval((window as any).replay));
      state.stateRevision = 2;
      for (const changes of [
        { quality: { ...state.quality, quad: null } },
        { activeId: "synthetic-capture" },
        { cameraConnected: false },
        { detectorReady: false },
      ]) {
        state.stateRevision!++;
        await page.evaluate(
          (state) => (window as any).overlay.update(state),
          state,
        );
        await expect(svg).toBeVisible();
        state.stateRevision!++;
        await page.evaluate((state) => (window as any).overlay.update(state), {
          ...state,
          ...changes,
        });
        await expect(svg).toBeHidden();
      }
    } finally {
      await browser.close();
    }
  });
}
