import { mkdir, cp, readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
await mkdir("public/vendor", { recursive: true });
await cp(
  "node_modules/@mediapipe/tasks-vision/wasm",
  "public/vendor/mediapipe",
  { recursive: true },
);
await cp(
  "node_modules/@techstark/opencv-js/dist/opencv.js",
  "public/vendor/opencv.js",
);
await mkdir("public/vendor/ocr/core", { recursive: true });
await cp(
  "node_modules/tesseract.js/LICENSE.md",
  "public/vendor/ocr/LICENSE.md",
);
await cp(
  "node_modules/tesseract.js-core/LICENSE",
  "public/vendor/ocr/core/LICENSE",
);
await cp(
  "node_modules/tesseract.js/dist/worker.min.js",
  "public/vendor/ocr/worker.min.js",
);
for (const file of await readdir("node_modules/tesseract.js-core")) {
  if (file.endsWith(".wasm.js"))
    await cp(
      `node_modules/tesseract.js-core/${file}`,
      `public/vendor/ocr/core/${file}`,
    );
}
const models = JSON.parse(await readFile("model-assets.json", "utf8"));
for (const [name, model] of Object.entries(models)) {
  let data;
  try {
    data = await readFile(`public/vendor/${name}`);
  } catch {}
  if (
    !data ||
    createHash("sha256").update(data).digest("hex") !== model.sha256
  ) {
    const response = await fetch(model.url);
    if (!response.ok) throw new Error(`Model download failed: ${name}`);
    data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== model.sha256)
      throw new Error(`Model checksum mismatch: ${name}`);
    await writeFile(`public/vendor/${name}`, data);
  }
}
