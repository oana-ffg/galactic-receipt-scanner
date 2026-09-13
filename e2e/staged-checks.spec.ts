import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Quality } from "../web/types";

test("real vision worker skips idle ML, stages a candidate, and checks the saved image", async ({
  page,
}) => {
  const workerFile = (await readdir("dist/client/assets")).find(
    (name) => name.startsWith("vision.worker-") && name.endsWith(".js"),
  )!;
  await page.goto("/");
  const result = await page.evaluate(async (workerUrl) => {
    const worker = new Worker(workerUrl);
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    let id = 0;
    async function analyze(options: {
      full?: boolean;
      preview?: { capture: boolean; removal: boolean };
    }): Promise<Quality> {
      const bitmap = await createImageBitmap(canvas);
      return new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) =>
          data.error ? reject(new Error(data.error)) : resolve(data.quality);
        worker.onerror = reject;
        worker.postMessage({ id: ++id, bitmap, ...options }, [bitmap]);
      });
    }
    const scanning = { preview: { capture: true, removal: false } };
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, 2000, 2400);
    const idle = await analyze(scanning);
    ctx.fillStyle = "#c8c8c8";
    ctx.fillRect(380, 180, 1240, 2040);
    ctx.fillStyle = "#232323";
    ctx.font = "56px sans-serif";
    for (const [i, line] of [
      "SYNTHETIC RECEIPT",
      "Test item 123.45",
      "Tax 24.69",
      "Total 123.45",
      "TEST DATA ONLY",
    ].entries())
      ctx.fillText(line, 450, 420 + i * 210);
    const paused = await analyze({
      preview: { capture: false, removal: false },
    });
    const candidate = await analyze(scanning);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const ready = await analyze(scanning);
    const photo = await analyze({ full: true });
    const saved = await analyze({ preview: { capture: false, removal: true } });
    const removal = { preview: { capture: false, removal: true } };
    const original = document.createElement("canvas");
    original.width = canvas.width;
    original.height = canvas.height;
    original.getContext("2d")!.drawImage(canvas, 0, 0);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, 2000, 2400);
    ctx.drawImage(original, 100, 0);
    const moved = await analyze(removal);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, 2000, 2400);
    ctx.drawImage(original, -700, 0);
    const clipped = await analyze(removal);
    ctx.fillStyle = "#c8c8c8";
    ctx.fillRect(0, 0, 2000, 2400);
    const washedOut = await analyze(removal);
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, 2000, 2400);
    const removed = await analyze({
      preview: { capture: false, removal: true },
    });
    worker.terminate();
    return {
      idle,
      paused,
      candidate,
      ready,
      photo,
      saved,
      moved,
      clipped,
      washedOut,
      removed,
    };
  }, `/assets/${workerFile}`);
  expect(result.idle).toMatchObject({ ok: false, handsChecked: false });
  expect(result.paused).toMatchObject({ ok: false, handsChecked: false });
  expect(result.candidate).toMatchObject({
    ok: false,
    candidateReady: true,
    handsChecked: false,
  });
  expect(result.ready).toMatchObject({
    ok: true,
    handsChecked: true,
    hands: [],
  });
  expect(result.photo).toMatchObject({
    ok: true,
    handsChecked: true,
    hands: [],
  });
  expect(result.saved).toMatchObject({
    ok: false,
    handsChecked: false,
    empty: false,
  });
  expect(result.saved.sharpness).toBeUndefined();
  for (const quality of [result.moved, result.clipped])
    expect(quality.empty).toBe(false);
  expect(result.saved.removalDiagnostics).toMatchObject({
    geometry: "outline",
    naturalEmpty: false,
    calibration: "disabled",
  });
  expect(result.removed.removalDiagnostics).toMatchObject({
    naturalEmpty: true,
    calibration: "disabled",
    cutHigh: expect.any(Number),
  });
  expect(result.washedOut.emptyStrong).toBe(false);
  expect(result.removed).toMatchObject({
    empty: true,
    emptyStrong: true,
    handsChecked: true,
    hands: [],
  });
});
