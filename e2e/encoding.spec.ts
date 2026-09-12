import { readdir } from "node:fs/promises";
import { chromium, webkit, expect, test } from "@playwright/test";

for (const browserName of ["chromium", "webkit"] as const) {
  test.describe(`${browserName} repeated camera encoding`, () => {
    test("1000 full-resolution photos keep their dimensions and unique pixels", async () => {
      const browser = await (
        browserName === "chromium" ? chromium : webkit
      ).launch(
        browserName === "chromium" ? { channel: "chrome" } : { channel: "" },
      );
      const page = await browser.newPage();
      try {
        test.setTimeout(600000);
        const file = (await readdir("dist/client/assets")).find(
          (name) => name.startsWith("vision.worker-") && name.endsWith(".js"),
        )!;
        await page.goto("http://127.0.0.1:8766/");
        page.on("console", (message) => {
          if (message.text().startsWith("Encoding checkpoint"))
            console.log(browserName, message.text());
        });
        const result = await page.evaluate(async (file) => {
          const worker = new Worker(`/assets/${file}`);
          const canvas = document.createElement("canvas");
          canvas.width = 2160;
          canvas.height = 3840;
          const ctx = canvas.getContext("2d")!;
          const sample = new OffscreenCanvas(1, 1);
          const sampleCtx = sample.getContext("2d", {
            willReadFrequently: true,
          })!;
          const times: number[] = [];
          for (let i = 0; i < 1000; i++) {
            ctx.fillStyle = "#191919";
            ctx.fillRect(0, 0, 2160, 3840);
            ctx.fillStyle = "#eeeeee";
            ctx.fillRect(280, 220, 1600, 3300);
            ctx.fillStyle = "#252525";
            ctx.font = "60px monospace";
            for (let row = 0; row < 30; row++)
              ctx.fillText(
                `SYNTHETIC ${i} ROW ${row} 123,45`,
                330,
                380 + row * 95,
              );
            // Exact per-photo marker: detect stale or black output after decoding.
            const red = (i % 20) * 12,
              green = Math.floor(i / 20) * 5;
            ctx.fillStyle = `rgb(${red},${green},100)`;
            ctx.fillRect(0, 0, 160, 160);
            const start = performance.now();
            const bitmap = await createImageBitmap(canvas);
            const blob = await new Promise<Blob>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error(`Encoding stalled on photo ${i}`)),
                15000,
              );
              worker.onmessage = ({ data }) => {
                clearTimeout(timeout);
                data.error
                  ? reject(new Error(data.error))
                  : resolve(data.original);
              };
              worker.onerror = (e) => reject(new Error(e.message));
              worker.postMessage({ id: i, bitmap, encode: true }, [bitmap]);
            });
            if (!blob?.size || blob.type !== "image/jpeg")
              throw new Error(`Invalid JPEG on ${i}`);
            const decoded = await createImageBitmap(blob);
            if (decoded.width !== 2160 || decoded.height !== 3840)
              throw new Error(`Wrong dimensions on ${i}`);
            sampleCtx.drawImage(decoded, 40, 40, 1, 1, 0, 0, 1, 1);
            decoded.close();
            const pixel = sampleCtx.getImageData(0, 0, 1, 1).data;
            if (
              Math.abs(pixel[0] - red) > 5 ||
              Math.abs(pixel[1] - green) > 5 ||
              Math.abs(pixel[2] - 100) > 5
            )
              throw new Error(`Stale or black photo ${i}: ${pixel}`);
            times.push(performance.now() - start);
            if ((i + 1) % 100 === 0)
              console.log(`Encoding checkpoint ${i + 1}/1000`);
          }
          worker.terminate();
          canvas.width = canvas.height = 0;
          const mean = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
          return {
            count: times.length,
            first100Ms: mean(times.slice(0, 100)),
            last100Ms: mean(times.slice(-100)),
            p95Ms: [...times].sort((a, b) => a - b)[949],
          };
        }, file);
        console.log("Full-resolution encoding benchmark", browserName, result);
        expect(result.count).toBe(1000);
        expect(result.last100Ms).toBeLessThan(
          Math.max(1000, result.first100Ms * 3),
        );
      } finally {
        await browser.close();
      }
    });
  });
}
