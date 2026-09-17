/// <reference lib="webworker" />
import { hasReceiptResolution } from "./capture-resolution";
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type CV from "@techstark/opencv-js";
import { PDFDocument } from "pdf-lib";
import type { Quality } from "./types";
import { measurePrint } from "./print-quality";
import { measureCapturedBlur } from "./blur-image";
import { HandChecks, type PreviewChecks } from "./hand-checks";
import {
  enclosePaperContour,
  refinePaperEdges,
  hasPlausiblePaperCorners,
} from "./paper-geometry";
let cv: typeof CV;
let hands: HandLandmarker;
const handChecks = new HandChecks();
const sceneCanvas = new OffscreenCanvas(32, 32);
const sceneContext = sceneCanvas.getContext("2d", {
  willReadFrequently: true,
})!;
let previous: Uint8Array | undefined;
let paperBounds: number[] | undefined;
let paperBrightness: number | undefined;
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
type OutputQuality = Quality & {
  outputQuad?: number[][];
  paperBrightness?: number;
};
function analyze(
  bitmap: ImageBitmap,
  full: boolean,
  outputs = false,
  removalOnly = false,
): OutputQuality {
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const allocated: { delete(): void }[] = [];
  const use = <T extends { delete(): void }>(mat: T): T => {
    allocated.push(mat);
    return mat;
  };
  const q: OutputQuality = {
    ok: false,
    quad: null,
    hands: [],
    reason: "Place one receipt on a dark, matte background.",
    empty: false,
    motion: 0,
  };
  const removal = removalOnly
    ? (q.removalDiagnostics = {
        geometry: "no-candidates",
        bounds: paperBounds?.map((v) => Number(v.toFixed(4))).join(","),
        previousBrightness: paperBrightness,
      } satisfies import("./types").RemovalDiagnostics)
    : undefined;
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
    // Separate paper from the actual background, including underexposed scenes.
    // The relative floor leaves an empty, uniformly lit desk empty.
    const levels = new Uint32Array(256);
    for (const pixel of smooth.data) levels[pixel]++;
    let seen = 0;
    let dark = 0;
    for (; dark < 255; dark++) {
      seen += levels[dark];
      if (seen >= smooth.data.length * 0.1) break;
    }
    let bright = 0;
    seen = 0;
    for (; bright < 255; bright++) {
      seen += levels[bright];
      if (seen >= smooth.data.length * 0.9) break;
    }
    const base = Math.max(dark + 12, threshold);
    const cuts = [
      ...new Set(
        [
          base,
          Math.max(base, (base + bright) / 2),
          Math.max(base, bright * 0.9),
        ].map(Math.round),
      ),
    ].sort((a, b) => a - b);
    if (removal)
      Object.assign(removal, {
        dark,
        bright,
        cutLow: cuts[0],
        cutHigh: cuts.at(-1),
      });
    const kernel = use(cv.Mat.ones(7, 7, cv.CV_8U));
    const contours = use(new cv.MatVector()),
      hierarchy = use(new cv.Mat());
    const candidates: {
      area: number;
      points: number[][];
      contour: number[][];
    }[] = [];
    const regions: number[][] = [];
    let large = false;
    let areaBrightness = 255;
    const paperOccupancy = () => {
      if (!paperBounds) return 1;
      const [left, top, right, bottom] = paperBounds;
      const insetX = (right - left) * 0.1;
      const insetY = (bottom - top) * 0.1;
      let occupied = 0,
        brightness = 0,
        samples = 0;
      for (
        let y = Math.ceil((top + insetY) * height);
        y < (bottom - insetY) * height;
        y++
      )
        for (
          let x = Math.ceil((left + insetX) * width);
          x < (right - insetX) * width;
          x++
        ) {
          occupied += mask.data[y * width + x] > 0 ? 1 : 0;
          brightness += gray.data[y * width + x];
          samples++;
        }
      areaBrightness = samples ? brightness / samples : 255;
      if (removal)
        Object.assign(removal, {
          areaBrightness,
          coverage: samples ? occupied / samples : 1,
        });
      return samples ? occupied / samples : 1;
    };
    let inclusiveOccupancy = 1;
    for (const cut of cuts) {
      cv.threshold(smooth, mask, cut, 255, cv.THRESH_BINARY);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
      if (cut === cuts[0]) inclusiveOccupancy = paperOccupancy();
      cv.findContours(
        mask,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE,
      );
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        try {
          const area = cv.contourArea(contour) / (canvas.width * canvas.height);
          if (area < 0.025) continue;
          large = true;
          const bounds = cv.boundingRect(contour);
          regions.push([
            bounds.x / canvas.width,
            bounds.y / canvas.height,
            (bounds.x + bounds.width) / canvas.width,
            (bounds.y + bounds.height) / canvas.height,
          ]);
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
              candidates.push({
                area,
                points: ordered(pts),
                contour: Array.from({ length: contour.rows }, (_, j) => [
                  contour.data32S[j * 2],
                  contour.data32S[j * 2 + 1],
                ]),
              });
            }
          } finally {
            approx.delete();
          }
        } finally {
          contour.delete();
        }
      }
    }
    if (removal)
      Object.assign(removal, {
        regions: regions.length,
        candidates: candidates.length,
        inclusiveCoverage: inclusiveOccupancy,
      });
    const clearOfPaper = () => {
      if (
        regions.every(
          (region) =>
            paperBounds &&
            (region[2] < paperBounds[0] ||
              region[0] > paperBounds[2] ||
              region[3] < paperBounds[1] ||
              region[1] > paperBounds[3]),
        )
      )
        return true;
      if (!paperBounds) return false;
      // A region's bounding box can cover an empty desk (glare, keyboard,
      // cables). Measure actual foreground occupancy where paper was seen.
      // Use the highest segmentation cut, which separates paper from glare.
      return paperOccupancy() < 0.3;
    };
    // A uniformly bright/washed-out frame can have no segmented regions too.
    // Fast removal also needs the old paper area to become substantially darker.
    const substantiallyDarker = () =>
      paperBrightness !== undefined &&
      paperBrightness - areaBrightness > Math.max(30, paperBrightness * 0.35);
    const removalQuality = () => {
      q.empty = clearOfPaper();
      q.emptyStrong =
        q.empty && inclusiveOccupancy < 0.08 && substantiallyDarker();
      // An exposure/segmentation fluctuation close to the normal cutoff is
      // uncertainty, not positive paper presence. Only the temporal gate can
      // bridge one such hand-checked frame between clear observations.
      q.emptyUncertain =
        !q.empty && paperOccupancy() <= 0.35 && substantiallyDarker();
    };
    if (!candidates.length) {
      removalQuality();
      if (large)
        q.reason =
          "Paper outline is unclear. Reduce glare and leave space around the paper.";
      return q;
    }
    const complete = candidates.filter(
      ({ area, points }) =>
        area <= 0.9 &&
        points.every(
          (p) =>
            p[0] >= 5 &&
            p[1] >= 5 &&
            p[0] <= canvas.width - 6 &&
            p[1] <= canvas.height - 6,
        ),
    );
    if (!complete.length) {
      if (removal)
        Object.assign(removal, { geometry: "incomplete", complete: 0 });
      // Peripheral glare must not prevent rearming after the last paper's area
      // is clear. An edge region overlapping that area still blocks removal.
      removalQuality();
      q.reason =
        "No complete paper outline. Keep the whole receipt inside the preview, away from glare.";
      return q;
    }
    complete.sort((a, b) => b.area - a.area);
    if (removal)
      Object.assign(removal, {
        geometry: "outline",
        complete: complete.length,
      });
    const papers = complete.filter(
      (candidate, i) =>
        !complete.slice(0, i).some((other) => {
          const bounds = (points: number[][]) => [
            Math.min(...points.map((p) => p[0])),
            Math.min(...points.map((p) => p[1])),
            Math.max(...points.map((p) => p[0])),
            Math.max(...points.map((p) => p[1])),
          ];
          const a = bounds(candidate.points),
            b = bounds(other.points);
          const overlap =
            Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
            Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
          return overlap / ((a[2] - a[0]) * (a[3] - a[1])) > 0.85;
        }),
    );
    const { points } = papers[0];
    q.quad = points.map((p) => [p[0] / canvas.width, p[1] / canvas.height]);
    // A saved receipt only needs presence checks. Print quality and aligned
    // motion cannot unlock it; run them again after confirmed removal.
    if (removalOnly) return q;
    if (papers[1]?.area > 0.05) {
      q.reason =
        "More than one paper-like region detected. Separate overlapping paper and move bright objects out of view.";
      return q;
    }
    // Check only after the multiple-region check: discarding distorted candidates
    // earlier could hide a second sheet. Texture can pass the print checks below.
    if (!hasPlausiblePaperCorners(points)) {
      q.reason =
        "Paper outline is too distorted. Flatten the paper and keep the camera above it, or use Force take for manual review.";
      return q;
    }
    const enclosed = enclosePaperContour(
      refinePaperEdges(points, papers[0].contour),
      papers[0].contour,
    );
    if (!enclosed) {
      q.reason =
        "Paper boundary is too irregular to enclose safely. Flatten the paper or use Force take for manual review.";
      return q;
    }
    q.quad = enclosed.map((p) => [p[0] / canvas.width, p[1] / canvas.height]);
    if (
      enclosed.some(
        ([x, y]) =>
          x < 5 || y < 5 || x > canvas.width - 6 || y > canvas.height - 6,
      )
    ) {
      q.reason =
        "Complete paper bounds need more space. Move the receipt away from the preview edges.";
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
    const lap = use(new cv.Mat());
    cv.Laplacian(interior, lap, cv.CV_64F);
    if (!full) {
      // Compare aligned paper interiors, not the desk or automatic exposure.
      const mini = use(new cv.Mat());
      cv.resize(interior, mini, new cv.Size(160, 160));
      cv.GaussianBlur(mini, mini, new cv.Size(3, 3), 0);
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
    const localBackground = use(new cv.Mat());
    const strokeKernel = use(cv.Mat.ones(15, 15, cv.CV_8U));
    cv.morphologyEx(interior, localBackground, cv.MORPH_CLOSE, strokeKernel);
    // ROI rows can have a stride; copy before reading packed pixel arrays.
    const pixels = use(new cv.Mat());
    interior.copyTo(pixels);
    const print = measurePrint(
      pixels.data,
      localBackground.data,
      lap.data64F,
      interior.cols,
      interior.rows,
    );
    Object.assign(q, print);
    if (print.glare) {
      q.reason =
        "Glare is washing out part of the paper. Move the light or tilt the phone slightly.";
      return q;
    }
    if (print.inkFraction < 0.004) {
      q.reason =
        "Writing is too faint to check reliably. Add even light or move the phone closer.";
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
      if (!hasReceiptResolution(q.receiptPixels)) {
        q.reason =
          "Receipt needs at least 450 pixels on the short side and 900 on the long side. Move closer or raise resolution.";
        return q;
      }
    }
    if ((q.motion ?? 0) > 3.5) {
      q.reason = "The paper image is changing. Hold the camera steady briefly.";
      return q;
    }
    q.ok = true;
    q.paperBrightness = cv.mean(interior)[0];
    q.reason = "Image checks passed.";
    if (outputs) {
      // Containment corners may bridge folds and must not be treated as true
      // perspective correspondences. A rotated rectangle preserves text shape.
      // This output-only fit cannot make a rejected camera frame pass.
      const boundary = use(
        cv.matFromArray(
          papers[0].contour.length,
          1,
          cv.CV_32SC2,
          papers[0].contour.flat(),
        ),
      );
      q.outputQuad = ordered(
        cv.RotatedRect.points(cv.minAreaRect(boundary)).map(({ x, y }) => [
          x,
          y,
        ]),
      ).map(([x, y]) => [x / canvas.width, y / canvas.height]);
    }
    return q;
  } finally {
    allocated.reverse().forEach((m) => m.delete());
  }
}
async function process(
  bitmap: ImageBitmap,
  full: boolean,
  outputs: boolean,
  preview?: PreviewChecks,
) {
  if (outputs) {
    // Saved originals are independent documents, not consecutive camera frames.
    previous = undefined;
    paperBounds = undefined;
    paperBrightness = undefined;
  }
  const quality = analyze(
    bitmap,
    full,
    outputs,
    !full && !outputs && preview?.removal === true && !preview.capture,
  );
  // Preview geometry/motion checks are cheap readiness evidence. Score the
  // actual captured bitmap before accepting; never score its 800px preview.
  if (full || outputs) {
    quality.blur = measureCapturedBlur(cv, bitmap, quality.quad);
    if (quality.ok) {
      if (quality.blur.category === "likely-blurry") {
        quality.ok = false;
        quality.reason =
          "The captured text looks blurred. Hold steady or adjust the phone height, then retake.";
      } else if (quality.blur.category === "unavailable") {
        quality.ok = false;
        quality.reason =
          "Could not check captured-image blur. Retake this photo.";
      } else if (quality.blur.category === "uncertain") {
        quality.reason =
          "Image checks passed; borderline blur flagged for later review.";
      }
    }
  }
  if (quality.removalDiagnostics)
    Object.assign(quality.removalDiagnostics, {
      naturalEmpty: quality.empty,
      naturalStrong: quality.emptyStrong,
      calibration: "disabled",
    });
  handChecks.apply(
    quality,
    full || outputs ? undefined : preview,
    performance.now(),
    () => {
      sceneContext.drawImage(canvas, 0, 0, 32, 32);
      return sceneContext.getImageData(0, 0, 32, 32).data;
    },
    () =>
      hands.detect(canvas).landmarks.map((hand) => hand.map((p) => [p.x, p.y])),
  );
  if (quality.ok && quality.quad) {
    paperBrightness = quality.paperBrightness;
    paperBounds = [
      Math.min(...quality.quad.map((p) => p[0])),
      Math.min(...quality.quad.map((p) => p[1])),
      Math.max(...quality.quad.map((p) => p[0])),
      Math.max(...quality.quad.map((p) => p[1])),
    ];
  }
  delete quality.paperBrightness;
  if (!outputs || !quality.ok) return { quality };
  const frame = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = frame.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const source = cv.matFromImageData(
    context.getImageData(0, 0, bitmap.width, bitmap.height),
  );
  let cropped: CV.Mat | undefined;
  try {
    const outputQuad = quality.outputQuad!;
    const center = outputQuad.reduce(
      (s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4],
      [0, 0],
    );
    if (
      outputQuad.some((p) =>
        p.some((v, i) => {
          const edge = center[i] + (v - center[i]) * 1.025;
          return edge < 0 || edge > 1;
        }),
      )
    )
      throw new Error(
        "The PDF crop needs more space around the paper. Review the original.",
      );
    cropped = crop(source, outputQuad);
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
    encode?: boolean;
    preview?: PreviewChecks;
  }>,
) => {
  const { id, bitmap, full, outputs, encode, preview } = event.data;
  try {
    if (encode && bitmap) {
      const photo = new OffscreenCanvas(bitmap.width, bitmap.height);
      try {
        photo
          .getContext("2d", { willReadFrequently: true })!
          .drawImage(bitmap, 0, 0);
        const original = await photo.convertToBlob({
          type: "image/jpeg",
          quality: 0.98,
        });
        self.postMessage({ id, original });
      } finally {
        photo.width = photo.height = 0;
      }
      return;
    }
    ready ??= initialize();
    await ready;
    const result = bitmap
      ? await process(bitmap, !!full, !!outputs, preview)
      : {};
    self.postMessage({
      id,
      ...result,
    });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap?.close();
  }
};
