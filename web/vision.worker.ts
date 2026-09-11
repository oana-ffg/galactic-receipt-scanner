/// <reference lib="webworker" />
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type CV from "@techstark/opencv-js";
import { PDFDocument } from "pdf-lib";
import type { Quality } from "./types";
let cv: typeof CV;
let hands: HandLandmarker;
let previous: Uint8Array | undefined;
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
// OpenCV's browser bundle publishes a promise on self.cv, including its WASM payload.
async function initialize() {
  importScripts("/vendor/opencv.js");
  cv = await (self as unknown as { cv: Promise<typeof CV> }).cv;
  if (!cv?.Mat) throw new Error("OpenCV initialization failed.");
  const files = await FilesetResolver.forVisionTasks("/vendor/mediapipe");
  hands = await HandLandmarker.createFromOptions(files, {
    baseOptions: {
      modelAssetPath: "/vendor/hand_landmarker.task",
      delegate: "CPU",
    },
    runningMode: "IMAGE",
    numHands: 2,
    minHandDetectionConfidence: 0.35,
    minHandPresenceConfidence: 0.35,
  });
}
function ordered(points: number[][]): number[][] {
  const center = points.reduce(
    (s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4],
    [0, 0],
  );
  points.sort(
    (a, b) =>
      Math.atan2(a[1] - center[1], a[0] - center[0]) -
      Math.atan2(b[1] - center[1], b[0] - center[0]),
  );
  const sums = points.map((p) => p[0] + p[1]);
  const start = sums.indexOf(Math.min(...sums));
  return [...points.slice(start), ...points.slice(0, start)];
}
function crop(src: CV.Mat, quad: number[][]): CV.Mat {
  const pts = quad.map((p) => [p[0] * src.cols, p[1] * src.rows]);
  const center = pts.reduce(
    (s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4],
    [0, 0],
  );
  const expanded = pts.map((p) => [
    center[0] + (p[0] - center[0]) * 1.025,
    center[1] + (p[1] - center[1]) * 1.025,
  ]);
  const edges = expanded.map((p, i) =>
    Math.hypot(
      p[0] - expanded[(i + 1) % 4][0],
      p[1] - expanded[(i + 1) % 4][1],
    ),
  );
  const w = Math.round(Math.max(edges[0], edges[2])),
    h = Math.round(Math.max(edges[1], edges[3]));
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, expanded.flat()),
    to = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      w - 1,
      0,
      w - 1,
      h - 1,
      0,
      h - 1,
    ]);
  const transform = cv.getPerspectiveTransform(from, to);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(
      src,
      out,
      transform,
      new cv.Size(w, h),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    );
    return out;
  } finally {
    from.delete();
    to.delete();
    transform.delete();
  }
}
function analyze(bitmap: ImageBitmap, full: boolean): Quality {
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const detection = hands.detect(canvas);
  const handPoints = detection.landmarks.map((hand) =>
    hand.map((p) => [p.x, p.y]),
  );
  const allocated: { delete(): void }[] = [];
  const use = <T extends { delete(): void }>(mat: T): T => {
    allocated.push(mat);
    return mat;
  };
  const q: Quality = {
    ok: false,
    quad: null,
    hands: handPoints,
    reason: "Place one receipt on a dark, matte background.",
    empty: false,
    motion: 0,
  };
  try {
    const source = use(
      cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height)),
    );
    const gray = use(new cv.Mat()),
      smooth = use(new cv.Mat());
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, smooth, new cv.Size(5, 5), 0);
    const mask = use(new cv.Mat());
    const threshold = cv.threshold(
      smooth,
      mask,
      0,
      255,
      cv.THRESH_BINARY + cv.THRESH_OTSU,
    );
    cv.threshold(smooth, mask, Math.max(100, threshold), 255, cv.THRESH_BINARY);
    const kernel = use(cv.Mat.ones(7, 7, cv.CV_8U));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
    const contours = use(new cv.MatVector()),
      hierarchy = use(new cv.Mat());
    cv.findContours(
      mask,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    );
    const candidates: { area: number; points: number[][] }[] = [];
    let large = false;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      try {
        const area = cv.contourArea(contour) / (canvas.width * canvas.height);
        if (area < 0.025) continue;
        large = true;
        const approx = new cv.Mat();
        try {
          cv.approxPolyDP(
            contour,
            approx,
            0.025 * cv.arcLength(contour, true),
            true,
          );
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const pts = Array.from({ length: 4 }, (_, j) => [
              approx.data32S[j * 2],
              approx.data32S[j * 2 + 1],
            ]);
            candidates.push({ area, points: ordered(pts) });
          }
        } finally {
          approx.delete();
        }
      } finally {
        contour.delete();
      }
    }
    if (!candidates.length) {
      q.empty = !large && !handPoints.length && (q.motion ?? 0) < 2;
      if (handPoints.length) q.reason = "Move your hands clear.";
      else if (large)
        q.reason =
          "Paper outline is unclear. Reduce glare and leave space around the paper.";
      return q;
    }
    candidates.sort((a, b) => b.area - a.area);
    const { area, points } = candidates[0];
    q.quad = points.map((p) => [p[0] / canvas.width, p[1] / canvas.height]);
    if (candidates[1]?.area > 0.05) {
      q.reason = "More than one paper region detected.";
      return q;
    }
    if (
      area > 0.9 ||
      points.some(
        (p) =>
          p[0] < 5 ||
          p[1] < 5 ||
          p[0] > canvas.width - 6 ||
          p[1] > canvas.height - 6,
      )
    ) {
      q.reason =
        "Paper is too close to the frame edge. Leave a visible margin.";
      return q;
    }
    // Conservative: any detected hand blocks capture, including fingertips near the boundary.
    if (handPoints.length) {
      q.reason = "Hand or fingers detected. Move them out of view.";
      return q;
    }
    const cropped = use(crop(source, q.quad));
    const cg = use(new cv.Mat());
    cv.cvtColor(cropped, cg, cv.COLOR_RGBA2GRAY);
    const inset = Math.max(3, Math.round(Math.min(cg.rows, cg.cols) * 0.05));
    if (cg.rows <= 2 * inset || cg.cols <= 2 * inset) {
      q.reason = "Receipt is too small.";
      return q;
    }
    const interior = use(
      cg.roi(
        new cv.Rect(inset, inset, cg.cols - 2 * inset, cg.rows - 2 * inset),
      ),
    );
    const lap = use(new cv.Mat()),
      mean = use(new cv.Mat()),
      std = use(new cv.Mat());
    cv.Laplacian(interior, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std);
    q.focus = std.data64F[0] ** 2;
    if (!full) {
      // Compare aligned paper interiors, not the desk or automatic exposure.
      const mini = use(new cv.Mat());
      cv.resize(interior, mini, new cv.Size(160, 160));
      if (previous) {
        let offset = 0;
        for (let i = 0; i < mini.data.length; i++)
          offset += mini.data[i] - previous[i];
        offset /= mini.data.length;
        let change = 0;
        for (let i = 0; i < mini.data.length; i++)
          change += Math.abs(mini.data[i] - previous[i] - offset);
        q.motion = change / mini.data.length;
      }
      previous = mini.data.slice();
    }
    const histogram = new Uint32Array(256);
    for (let y = 0; y < interior.rows; y++)
      for (let x = 0; x < interior.cols; x++)
        histogram[interior.ucharAt(y, x)]++;
    const count = interior.rows * interior.cols;
    const percentile = (fraction: number) => {
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        sum += histogram[i];
        if (sum >= count * fraction) return i;
      }
      return 255;
    };
    const bright = percentile(0.9);
    q.contrast = bright - percentile(0.05);
    let ink = 0;
    for (let i = 0; i < bright - 45; i++) ink += histogram[i];
    if (ink / count < 0.004) {
      q.reason =
        "No clear print detected. Check the printed side and lighting.";
      return q;
    }
    if (q.focus < 65) {
      q.reason =
        "Print looks blurred. Wait for focus or adjust the phone height.";
      return q;
    }
    if (percentile(0.8) < 90) {
      q.reason = "Receipt is too dark. Add even lighting.";
      return q;
    }
    if (full) {
      const native = q.quad.map((p) => [
        p[0] * bitmap.width,
        p[1] * bitmap.height,
      ]);
      const edges = native.map((p, i) =>
        Math.hypot(
          p[0] - native[(i + 1) % 4][0],
          p[1] - native[(i + 1) % 4][1],
        ),
      );
      q.receiptPixels = [
        Math.round(Math.max(edges[0], edges[2])),
        Math.round(Math.max(edges[1], edges[3])),
      ];
      if (Math.min(...q.receiptPixels) < 900) {
        q.reason =
          "Receipt is under 900 pixels across. Move closer or raise resolution.";
        return q;
      }
    }
    if ((q.motion ?? 0) > 3.5) {
      q.reason = "The paper image is changing. Hold the camera steady briefly.";
      return q;
    }
    q.ok = true;
    q.reason = "Image checks passed.";
    return q;
  } finally {
    allocated.reverse().forEach((m) => m.delete());
  }
}
async function process(bitmap: ImageBitmap, full: boolean, outputs: boolean) {
  const quality = analyze(bitmap, full);
  if (!outputs || !quality.ok) return { quality };
  const frame = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = frame.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const source = cv.matFromImageData(
    context.getImageData(0, 0, bitmap.width, bitmap.height),
  );
  let cropped: CV.Mat | undefined;
  try {
    cropped = crop(source, quality.quad!);
    frame.width = cropped.cols;
    frame.height = cropped.rows;
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(cropped.data),
        cropped.cols,
        cropped.rows,
      ),
      0,
      0,
    );
    const image = await frame.convertToBlob({
      type: "image/jpeg",
      quality: 0.95,
    });
    const pdf = await PDFDocument.create();
    const embedded = await pdf.embedJpg(await image.arrayBuffer());
    const page = pdf.addPage([
      (embedded.width * 72) / 300,
      (embedded.height * 72) / 300,
    ]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
    });
    const pdfBytes = await pdf.save();
    return {
      quality,
      image,
      pdf: new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }),
    };
  } finally {
    source.delete();
    cropped?.delete();
  }
}
let ready: Promise<void> | undefined;
self.onmessage = async (
  event: MessageEvent<{
    id: number;
    bitmap?: ImageBitmap;
    full?: boolean;
    outputs?: boolean;
  }>,
) => {
  const { id, bitmap, full, outputs } = event.data;
  try {
    ready ??= initialize();
    await ready;
    const result = bitmap ? await process(bitmap, !!full, !!outputs) : {};
    self.postMessage({ id, ...result });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap?.close();
  }
};
