import { test, expect } from "@playwright/test";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";

test("PDF drafts preserve baselines and recent captures show both versions without writes", async ({
  page,
}) => {
  const worker = (await readdir("dist/client/assets")).find(
    (n) => n.startsWith("vision.worker-") && n.endsWith(".js"),
  )!;
  await page.goto("/");
  const fixture = await page.evaluate(async (worker) => {
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#181818";
    ctx.fillRect(0, 0, 2000, 2400);
    ctx.fillStyle = "#ddd";
    ctx.beginPath();
    [
      [380, 180],
      [1450, 180],
      [1620, 330],
      [1620, 2220],
      [550, 2220],
      [380, 2070],
    ].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.font = "32px monospace";
    for (let i = 0; i < 35; i++)
      ctx.fillText("SYNTHETIC ITEM 123.45", 470, 400 + i * 43);
    ctx.fillStyle = "#f00000";
    ctx.fillRect(500, 1950, 900, 8);
    const detector = new Worker("/assets/" + worker);
    const run = async () => {
      const bitmap = await createImageBitmap(canvas);
      return new Promise<any>((resolve, reject) => {
        detector.onmessage = (e) =>
          e.data.error ? reject(Error(e.data.error)) : resolve(e.data);
        detector.postMessage({ id: 1, bitmap, full: true, outputs: true }, [
          bitmap,
        ]);
      });
    };
    const first = await run();
    // Reuse the worker for an unrelated original: temporal camera motion must
    // not reject independent saved photos in the desktop preview queue.
    ctx.fillStyle = "#222";
    ctx.fillRect(650, 500, 350, 60);
    const next = await run();
    detector.terminate();
    if (!first.quality.ok || !next.quality.ok)
      throw Error(first.quality.reason + " / " + next.quality.reason);
    const image = await createImageBitmap(first.image);
    const output = document.createElement("canvas");
    output.width = image.width;
    output.height = image.height;
    const out = output.getContext("2d")!;
    out.drawImage(image, 0, 0);
    image.close();
    const pixels = out.getImageData(0, 0, output.width, output.height).data;
    const red: number[][] = [];
    for (let y = 0; y < output.height; y++)
      for (let x = 0; x < output.width; x++) {
        const i = (y * output.width + x) * 4;
        if (pixels[i] > 150 && pixels[i + 1] < 80 && pixels[i + 2] < 80)
          red.push([x, y]);
      }
    const xs = red.map((p) => p[0]),
      ys = red.map((p) => p[1]);
    return {
      source: canvas.toDataURL("image/jpeg", 0.98).split(",")[1],
      quality: next.quality,
      pdf: Array.from(new Uint8Array(await first.pdf.arrayBuffer())),
      redCount: red.length,
      slopeRange:
        (Math.max(...ys) - Math.min(...ys)) /
        (Math.max(...xs) - Math.min(...xs)),
    };
  }, worker);
  expect(fixture.redCount).toBeGreaterThan(1000);
  expect(fixture.slopeRange).toBeLessThan(0.02);
  expect(
    (await PDFDocument.load(new Uint8Array(fixture.pdf))).getPageCount(),
  ).toBe(1);
  const bytes = Buffer.from(fixture.source, "base64");
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const capture = {
    id,
    receipt_id: id,
    retake_of: null,
    take_number: 1,
    is_current: true,
    current_capture_id: id,
    created_at: "2026-09-12T10:00:00Z",
    status: "accepted",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ocr_status: "awaiting Work",
    outputs: { image: false, pdf: false },
    metadata: { sourcePixels: [2000, 2400], quality: fixture.quality },
  };
  let sourceReads = 0;
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/captures"))
      writes.push(r.url());
  });
  await page.route("**/api/captures?*", (r) =>
    r.fulfill({ json: { captures: [capture], next: null } }),
  );
  await page.route("**/api/captures/" + id, (r) =>
    r.fulfill({ json: capture }),
  );
  await page.route("**/api/files/" + id + "/raw", (r) => {
    sourceReads++;
    return r.fulfill({ body: bytes, contentType: "image/jpeg" });
  });
  await page.reload();
  const row = page.locator(".capture-row");
  await row.scrollIntoViewIfNeeded();
  await expect(row.getByText("Original · saved outline")).toBeVisible();
  await expect(
    row.getByText("PDF draft · recalculated from original"),
  ).toBeVisible({ timeout: 30000 });
  await expect(row.locator(".capture-comparison img")).toHaveCount(2);
  const download = await Promise.all([
    page.waitForEvent("download"),
    row.getByRole("link", { name: "Download this PDF draft" }).click(),
  ]);
  expect(download[0].suggestedFilename()).toBe(`capture-${id}-draft.pdf`);
  expect(sourceReads).toBeLessThanOrEqual(2); // Last saved panel + one verified preview read.
  expect(writes).toEqual([]);
  await page.screenshot({
    path: "test-results/pdf-comparison-synthetic.png",
    fullPage: true,
  });
});
