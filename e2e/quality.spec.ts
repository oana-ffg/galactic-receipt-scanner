import { installImageFixtures } from "./image-fixtures";
import { readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Quality } from "../web/types";

test("quality checks distinguish faint and dim text from blank, noisy and blurred paper", async ({
  page,
}) => {
  const workerFile = (await readdir("dist/client/assets")).find(
    (name) => name.startsWith("vision.worker-") && name.endsWith(".js"),
  )!;
  await installImageFixtures(page);
  await page.goto("/");
  const results = await page.evaluate(async (workerUrl) => {
    const worker = new Worker(workerUrl);
    const canvas = document.createElement("canvas");
    canvas.width = 2000;
    canvas.height = 2400;
    const ctx = canvas.getContext("2d")!;
    const results: Record<string, Quality> = {};
    let id = 0;
    for (const kind of [
      "bright",
      "white",
      "washed-out",
      "edge-glare",
      "merged-glare",
      "glare-after-removal",
      "clutter-after-removal",
      "two-papers",
      "ambiguous-soft-region",
      "dim",
      "faint",
      "sparse",
      "blurred",
      "blank",
      "gradient",
      "noise",
      "clipped",
      "thin",
      "thin-faint",
      "thin-blurred",
      "small",
      "empty",
      "lit-empty",
      "textured-wedge-empty",
      "wedge-and-paper-empty",
      "perspective",
    ]) {
      ctx.filter = "none";
      ctx.fillStyle = kind === "lit-empty" ? "#727272" : "#181818";
      ctx.fillRect(0, 0, 2000, 2400);
      if (kind.includes("wedge")) {
        // Synthetic lit/texture region: four convex corners do not prove paper.
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(300, 200);
        ctx.lineTo(1100, 1300);
        ctx.lineTo(1000, 2150);
        ctx.lineTo(430, 2250);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = "#c8c8c8";
        ctx.fillRect(0, 0, 2000, 2400);
        ctx.fillStyle = "#333333";
        for (let y = 240; y < 2240; y += 40)
          for (let x = 320; x < 1120; x += 40) ctx.fillRect(x, y, 12, 16);
        ctx.restore();
        if (kind === "wedge-and-paper-empty") {
          ctx.fillStyle = "#dddddd";
          ctx.fillRect(1400, 300, 400, 1200);
        }
      }
      if (kind === "ambiguous-soft-region") {
        ctx.fillStyle = "#dddddd";
        ctx.fillRect(50, 300, 250, 1500);
        window.blurFixture(canvas, 32);
      }
      if (kind === "merged-glare") {
        ctx.fillStyle = "#969696";
        ctx.beginPath();
        ctx.ellipse(1000, 2200, 600, 500, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (kind === "edge-glare" || kind === "glare-after-removal") {
        ctx.fillStyle = "#dddddd";
        ctx.fillRect(0, 1000, 240, 1400);
      }
      if (kind === "clutter-after-removal") {
        const glare = ctx.createRadialGradient(1000, 2000, 10, 1000, 2000, 750);
        glare.addColorStop(0, "#eeeeee");
        glare.addColorStop(1, "#181818");
        ctx.fillStyle = glare;
        ctx.fillRect(0, 1200, 2000, 1200);
        ctx.fillStyle = "#999999";
        ctx.fillRect(0, 0, 2000, 800);
        ctx.fillStyle = "#444444";
        for (let y = 50; y < 750; y += 140)
          for (let x = 0; x < 2000; x += 150) ctx.fillRect(x, y, 125, 110);
      }
      if (!kind.includes("empty") && !kind.endsWith("after-removal")) {
        ctx.save();
        if (kind === "perspective") ctx.transform(0.85, 0.1, 0.15, 0.85, 0, 0);
        const paper = kind === "dim" ? 84 : kind === "white" ? 255 : 200;
        ctx.fillStyle = `rgb(${paper},${paper},${paper})`;
        const x = kind === "clipped" ? -50 : 380;
        const width =
          kind === "small" ? 400 : kind.startsWith("thin") ? 600 : 1240;
        ctx.fillRect(x, 180, width, 2040);
        if (kind === "gradient") {
          const gradient = ctx.createLinearGradient(380, 180, 1620, 2220);
          gradient.addColorStop(0, "#888888");
          gradient.addColorStop(1, "#dddddd");
          ctx.fillStyle = gradient;
          ctx.fillRect(380, 180, 1240, 2040);
        } else if (kind === "noise") {
          const data = ctx.getImageData(380, 180, 1240, 2040);
          let seed = 17;
          for (let i = 0; i < data.data.length; i += 4) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const value = 200 + (seed % 41) - 20;
            data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
          }
          ctx.putImageData(data, 380, 180);
        } else if (kind !== "blank") {
          const ink = kind === "dim" ? 24 : kind.includes("faint") ? 170 : 35;
          ctx.fillStyle = `rgb(${ink},${ink},${ink})`;
          ctx.font =
            kind === "sparse" ? "italic 56px serif" : "56px sans-serif";
          const lines =
            kind === "sparse"
              ? ["Synthetic handwritten note", "Total 123.45"]
              : [
                  "SYNTHETIC RECEIPT",
                  "Test item 123.45",
                  "Tax 24.69",
                  "Total 123.45",
                  "TEST DATA ONLY",
                ];
          for (let i = 0; i < lines.length; i++)
            ctx.fillText(lines[i], x + 70, 420 + i * 210);
        }
        if (kind === "washed-out") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(600, 500, 800, 500);
        }
        if (kind === "two-papers") {
          ctx.fillStyle = "#eeeeee";
          ctx.fillRect(50, 300, 250, 1500);
        }
        if (kind.includes("blurred")) {
          window.blurFixture(canvas, 16);
        }
        ctx.restore();
      }
      const bitmap = await createImageBitmap(canvas);
      results[kind] = await new Promise<Quality>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Worker timed out: ${kind}`)),
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
        worker.postMessage({ id: ++id, bitmap, full: true }, [bitmap]);
      });
    }
    worker.terminate();
    return results;
  }, `/assets/${workerFile}`);
  console.log("Synthetic quality cases", JSON.stringify(results));
  for (const kind of [
    "bright",
    "white",
    "dim",
    "faint",
    "sparse",
    "edge-glare",
    "merged-glare",
    "thin",
    "thin-faint",
    "perspective",
  ])
    expect(results[kind].ok, `${kind}: ${results[kind].reason}`).toBe(true);
  for (const kind of [
    "two-papers",
    "washed-out",
    "blurred",
    "blank",
    "gradient",
    "noise",
    "clipped",
    "small",
    "thin-blurred",
    "ambiguous-soft-region",
    "textured-wedge-empty",
    "wedge-and-paper-empty",
  ])
    expect(results[kind].ok, kind).toBe(false);
  // A diffuse reflection and a blurred second sheet can look alike.
  // Keep rejecting this ambiguous scene rather than silently dropping a sheet.
  expect(results["ambiguous-soft-region"].reason).toContain("More than one");
  expect(results["two-papers"].reason).toContain("More than one");
  expect(results["wedge-and-paper-empty"].reason).toContain("More than one");
  expect(results["textured-wedge-empty"].reason).toContain("distorted");
  expect(results["glare-after-removal"].empty).toBe(true);
  expect(results["clutter-after-removal"].empty).toBe(true);
  expect(results.blurred.reason).toContain("blurred");
  for (const kind of ["empty", "lit-empty"])
    expect(results[kind].empty, kind).toBe(true);
});
