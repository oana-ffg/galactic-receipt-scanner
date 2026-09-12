import { expect, test } from "@playwright/test";

test("camera analysis waits for a new decoded frame when the video stalls", async ({
  page,
}) => {
  await page.route("**/api/station", (route) =>
    route.fulfill({ json: { count: 1 } }),
  );
  await page.route("**/api/station/claim", (route) =>
    route.fulfill({ json: { count: 1, sequence: 1 } }),
  );
  await page.route("**/api/station/heartbeat", (route) =>
    route.fulfill({
      json: { sequence: 1, command: "pause", previewSession: null },
    }),
  );
  await page.addInitScript(() => {
    window.Worker = class {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      postMessage(data: {
        id: number;
        preview?: unknown;
        bitmap?: ImageBitmap;
      }) {
        if (data.preview) {
          const root = document.documentElement;
          root.dataset.analyses = String(
            Number(root.dataset.analyses ?? 0) + 1,
          );
        }
        data.bitmap?.close();
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              id: data.id,
              quality: {
                ok: false,
                empty: false,
                quad: null,
                hands: [],
                reason: "Synthetic frame",
              },
            },
          }),
        );
      }
      terminate() {}
    } as unknown as typeof Worker;
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const stream = canvas.captureStream(10);
      setInterval(() => canvas.getContext("2d")!.fillRect(0, 0, 64, 64), 50);
      return stream;
    };
    HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
      return {
        totalVideoFrames: Number(document.documentElement.dataset.frames ?? 1),
      } as VideoPlaybackQuality;
    };
  });
  await page.goto("/camera");
  await page
    .getByRole("button", { name: "Enable camera", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-analyses", "1");
  // Keep the media clock advancing while its decoded-frame count is frozen.
  await page.waitForTimeout(600);
  await expect(page.locator("html")).toHaveAttribute("data-analyses", "1");
  await page.evaluate(() => {
    document.documentElement.dataset.frames = "2";
  });
  await expect(page.locator("html")).toHaveAttribute("data-analyses", "2");
});
