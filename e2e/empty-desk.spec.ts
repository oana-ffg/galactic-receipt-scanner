import { readFile, readdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import type { Quality } from "../web/types";

test("authorized empty-desk screenshot cannot qualify as a receipt", async ({
  page,
}) => {
  const workerFile = (await readdir("dist/client/assets")).find(
    (name) => name.startsWith("vision.worker-") && name.endsWith(".js"),
  )!;
  const fixture = await readFile(
    "e2e/fixtures/real/empty-desk-reflection-overlay.png",
  );
  await page.goto("/camera");
  const quality = await page.evaluate(
    async ({ workerUrl, fixture }) => {
      const worker = new Worker(workerUrl);
      try {
        const image = new Image();
        image.src = fixture;
        await image.decode();
        const bitmap = await createImageBitmap(image);
        return await new Promise<Quality>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Desk check timed out")),
            20000,
          );
          worker.onmessage = (event) => {
            clearTimeout(timer);
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data.quality);
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            reject(new Error(event.message));
          };
          worker.postMessage({ id: 1, bitmap, full: true }, [bitmap]);
        });
      } finally {
        worker.terminate();
      }
    },
    {
      workerUrl: `/assets/${workerFile}`,
      fixture: `data:image/png;base64,${fixture.toString("base64")}`,
    },
  );
  expect(quality.ok).toBe(false);
  expect(quality.handsChecked).toBe(true);
  expect(quality.hands).toEqual([]);
  // Rejection must come from the scene checks, not merely the small screenshot.
  expect(quality.receiptPixels).toBeUndefined();
});
