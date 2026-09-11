import { mkdir, cp, readFile, writeFile } from "node:fs/promises";
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
const model = JSON.parse(await readFile("model-assets.json", "utf8"))[
  "hand_landmarker.task"
];
let data;
try {
  data = await readFile("public/vendor/hand_landmarker.task");
} catch {}
if (!data || createHash("sha256").update(data).digest("hex") !== model.sha256) {
  const response = await fetch(model.url);
  if (!response.ok) throw new Error("Model download failed");
  data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(data).digest("hex") !== model.sha256)
    throw new Error("Model checksum mismatch");
  await writeFile("public/vendor/hand_landmarker.task", data);
}
