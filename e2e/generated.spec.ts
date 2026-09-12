import { installImageFixtures } from "./image-fixtures";
import { readFile, readdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Quality } from "../web/types";
import { CaptureState } from "../web/state";

test("generated photographs cover real paper texture, creases, fingers and blur", async ({
  page,
}) => {
  const worker = (await readdir("dist/client/assets")).find(
    (name) => name.startsWith("vision.worker-") && name.endsWith(".js"),
  )!;
  const images = Object.fromEntries(
    await Promise.all(
      ["flat", "creased", "hand", "glare"].map(async (name) => [
        name,
        `data:image/png;base64,${(await readFile(`e2e/fixtures/generated/${name}.png`)).toString("base64")}`,
      ]),
    ),
  );
  await installImageFixtures(page);
  await page.goto("/");
  const result = await page.evaluate(
    async ({ images, worker }) => {
      const detector = new Worker(`/assets/${worker}`);
      const result: Record<string, Quality> = {};
      for (const kind of [
        "flat",
        "creased",
        "glare",
        "hand",
        "blurred",
        "native-resolution",
      ]) {
        const image = new Image();
        image.src =
          images[
            kind === "blurred" || kind === "native-resolution" ? "flat" : kind
          ];
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        if (kind === "blurred") window.blurFixture(canvas, 12);
        // A changed receipt must settle across consecutive frames.
        for (let frame = 0; frame < 2; frame++) {
          const bitmap = await createImageBitmap(canvas);
          result[kind] = await new Promise<Quality>((resolve, reject) => {
            detector.onmessage = ({ data }) =>
              data.error
                ? reject(new Error(data.error))
                : resolve(data.quality);
            detector.onerror = (e) => reject(new Error(e.message));
            detector.postMessage(
              { id: 1, bitmap, full: kind === "native-resolution" },
              [bitmap],
            );
          });
        }
      }
      detector.terminate();
      return result;
    },
    { images, worker },
  );
  console.log("Generated photo checks", JSON.stringify(result));
  expect(result.flat.ok, result.flat.reason).toBe(true);
  expect(result.creased.ok, result.creased.reason).toBe(true);
  expect(result.glare.ok, result.glare.reason).toBe(true);
  expect(result.hand.ok).toBe(false);
  // Partial fingers can evade landmarks; paper/obstruction checks must still reject.
  expect(result.hand.empty).toBe(false);
  expect(result.blurred.ok).toBe(false);
  expect(result["native-resolution"].ok).toBe(true);
  expect(
    Math.min(...result["native-resolution"].receiptPixels!),
  ).toBeGreaterThanOrEqual(450);
  expect(Math.min(...result["native-resolution"].receiptPixels!)).toBeLessThan(
    900,
  );
});

test("textured photographs settle promptly with handheld jitter and exposure changes", async ({
  page,
}) => {
  const workerFile = (await readdir("dist/client/assets")).find(
    (name) => name.startsWith("vision.worker-") && name.endsWith(".js"),
  )!;
  const images = Object.fromEntries(
    await Promise.all(
      ["flat", "creased", "glare"].map(async (name) => [
        name,
        `data:image/png;base64,${(await readFile(`e2e/fixtures/generated/${name}.png`)).toString("base64")}`,
      ]),
    ),
  );
  await page.goto("/");
  const sequences = await page.evaluate(
    async ({ images, workerFile }) => {
      const sequences: Record<string, Quality[]> = {};
      for (const [name, url] of Object.entries(images)) {
        const worker = new Worker(`/assets/${workerFile}`);
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        sequences[name] = [];
        for (let frame = 0; frame < 12; frame++) {
          const direction = frame % 2 ? 1 : -1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = "#242424";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.translate(
            canvas.width / 2 + direction * 6,
            canvas.height / 2 + direction * 4,
          );
          ctx.rotate(direction * 0.005);
          ctx.drawImage(image, -canvas.width / 2, -canvas.height / 2);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle =
            frame % 2 ? "rgba(255,255,255,.035)" : "rgba(0,0,0,.035)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          const bitmap = await createImageBitmap(canvas);
          sequences[name].push(
            await new Promise<Quality>((resolve, reject) => {
              worker.onmessage = ({ data }) =>
                data.error
                  ? reject(new Error(data.error))
                  : resolve(data.quality);
              worker.onerror = (e) => reject(new Error(e.message));
              worker.postMessage({ id: frame, bitmap }, [bitmap]);
            }),
          );
        }
        worker.terminate();
      }
      return sequences;
    },
    { images, workerFile },
  );
  for (const [name, frames] of Object.entries(sequences)) {
    const state = new CaptureState();
    state.control("start");
    let capturedAt = 0;
    for (let i = 0; i < frames.length; i++)
      if (state.observe(frames[i], 100 + i * 150)) {
        capturedAt = i * 150;
        break;
      }
    console.log("Handheld photograph", name, {
      capturedAt,
      motion: frames.map((q) => q.motion),
      reasons: [...new Set(frames.map((q) => q.reason))],
    });
    expect(
      capturedAt,
      `${name}: ${frames.map((q) => q.reason).join("; ")}`,
    ).toBeGreaterThan(0);
    expect(capturedAt).toBeLessThanOrEqual(1500);
  }
});
