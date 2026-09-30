import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

test("browser PDFs embed receipt pixels only and keep searchable text aligned", async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `export { addReceiptPage } from './web/receipt-pdf.ts';
        export { receiptRectification, rectifyReceiptCanvas } from './web/receipt-rectification.ts';
        export { ocrOverlay } from './web/ocr-overlay.ts';
        export { PDFDocument, setTextRenderingMode, TextRenderingMode } from 'pdf-lib';
        export { cropPdfImage } from './web/pdf-image.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins: [
      {
        name: "synthetic-mozjpeg-url",
        setup(build) {
          build.onResolve({ filter: /mozjpeg_enc\.wasm\?url$/ }, () => ({
            path: "synthetic-mozjpeg",
            namespace: "synthetic",
          }));
          build.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
            contents: 'export default "/synthetic-mozjpeg.wasm";',
            loader: "js",
          }));
        },
      },
    ],
  });
  await page.route("**/synthetic-mozjpeg.wasm", async (route) =>
    route.fulfill({
      body: await readFile(
        "node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
      ),
      contentType: "application/wasm",
    }),
  );
  await page.route("**/synthetic-pdf-crop.js", (route) =>
    route.fulfill({
      body: bundle.outputFiles[0].text,
      contentType: "application/javascript",
    }),
  );
  await page.goto("/camera");
  const fixtures = await page.evaluate(async () => {
    const modulePath = "/synthetic-pdf-crop.js";
    const {
      addReceiptPage,
      receiptRectification,
      rectifyReceiptCanvas,
      ocrOverlay,
      PDFDocument,
      setTextRenderingMode,
      TextRenderingMode,
    } = await import(modulePath);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 384;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#244769";
    context.fillRect(0, 0, 256, 384);
    context.fillStyle = "white";
    context.fillRect(64, 48, 128, 288);
    context.fillStyle = "#222222";
    context.font = "12px monospace";
    context.fillText("TOTAL 123.45", 70, 120);
    const hash = async (bytes: Uint8Array) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            bytes as Uint8Array<ArrayBuffer>,
          ),
        ),
      ).join(",");
    const results = [];
    const perspective = document.createElement("canvas");
    perspective.width = 256;
    perspective.height = 384;
    const perspectiveContext = perspective.getContext("2d")!;
    perspectiveContext.fillStyle = "#244769";
    perspectiveContext.fillRect(0, 0, perspective.width, perspective.height);
    perspectiveContext.beginPath();
    perspectiveContext.moveTo(64, 48);
    perspectiveContext.lineTo(192, 56);
    perspectiveContext.lineTo(184, 336);
    perspectiveContext.lineTo(58, 330);
    perspectiveContext.closePath();
    perspectiveContext.fillStyle = "white";
    perspectiveContext.fill();
    perspectiveContext.fillStyle = "black";
    perspectiveContext.fillRect(90, 145, 70, 8);
    for (const [x, y] of [
      [70, 55],
      [186, 63],
      [178, 329],
      [64, 324],
    ])
      perspectiveContext.fillRect(x, y, 4, 4);
    const quad = [
      [64 / 256, 48 / 384],
      [192 / 256, 56 / 384],
      [184 / 256, 336 / 384],
      [58 / 256, 330 / 384],
    ];
    const rectification = receiptRectification(
      [perspective.width, perspective.height],
      quad,
    )!;
    const rectified = await rectifyReceiptCanvas(perspective, rectification);
    const rectifiedHalf = await rectifyReceiptCanvas(
      perspective,
      rectification,
      [
        Math.max(1, Math.round(rectification.outputPixels[0] / 2)),
        Math.max(1, Math.round(rectification.outputPixels[1] / 2)),
      ],
    );
    const cornerMarkerCenters = (surface: HTMLCanvasElement) => {
      const data = surface
        .getContext("2d")!
        .getImageData(0, 0, surface.width, surface.height).data;
      const centers = [];
      for (const [left, top] of [
        [0, 0],
        [surface.width / 2, 0],
        [surface.width / 2, surface.height / 2],
        [0, surface.height / 2],
      ]) {
        let xSum = 0,
          ySum = 0,
          count = 0;
        const startX = Math.floor(left),
          endX = Math.floor(left + surface.width / 2),
          startY = Math.floor(top),
          endY = Math.floor(top + surface.height / 2);
        for (let y = startY; y < endY; y++)
          for (let x = startX; x < endX; x++) {
            const offset = (y * surface.width + x) * 4;
            if (
              data[offset] < 60 &&
              data[offset + 1] < 60 &&
              data[offset + 2] < 60
            ) {
              xSum += x;
              ySum += y;
              count++;
            }
          }
        centers.push([xSum / count, ySum / count]);
      }
      return centers;
    };
    const fullMarkerCenters = cornerMarkerCenters(rectified);
    const halfMarkerCenters = cornerMarkerCenters(rectifiedHalf);
    const scaleX = (rectifiedHalf.width - 1) / (rectified.width - 1);
    const scaleY = (rectifiedHalf.height - 1) / (rectified.height - 1);
    const alignmentDeltaPixels = Math.max(
      ...fullMarkerCenters.flatMap(([x, y], index) => [
        Math.abs(x * scaleX - halfMarkerCenters[index][0]),
        Math.abs(y * scaleY - halfMarkerCenters[index][1]),
      ]),
    );
    rectifiedHalf.width = rectifiedHalf.height = 0;
    const rectifiedContext = rectified.getContext("2d")!;
    const corners = [
      rectifiedContext.getImageData(4, 4, 1, 1).data,
      rectifiedContext.getImageData(rectified.width - 5, 4, 1, 1).data,
      rectifiedContext.getImageData(
        rectified.width - 5,
        rectified.height - 5,
        1,
        1,
      ).data,
      rectifiedContext.getImageData(4, rectified.height - 5, 1, 1).data,
    ].map((pixel) => Array.from(pixel));
    const overlay = ocrOverlay(
      {
        pixels: rectification.outputPixels,
        rotation: 0,
        items: [
          {
            text: "TOTAL",
            box: [20, 80, 80, 100],
            confidence: 99,
          },
        ],
        skipped: 0,
      },
      [0, 0, ...rectification.outputPixels],
      0,
    );
    const geometry = {
      output: [rectified.width, rectified.height],
      expected: rectification.outputPixels,
      corners,
      alignmentDeltaPixels,
      overlayViewBox: overlay.getAttribute("viewBox"),
    };
    rectified.width = rectified.height = 0;
    for (const type of ["image/png", "image/jpeg"]) {
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), type, 0.98),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const before = await hash(bytes);
      const layer = await PDFDocument.create();
      const text = layer.addPage([128, 288]);
      text.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
      text.drawText("TOTAL 123.45", { x: 6, y: 216, size: 12 });
      const textBytes = await layer.save();
      const digest = await crypto.subtle.digest("SHA-256", textBytes);
      const ocr = {
        source: {
          pixels: [128, 288],
          sourcePixels: [256, 384],
          sourceCrop: [64, 48, 192, 336],
          geometryVersion: 1,
          rectification: null,
          region: { left: 0, top: 0, width: 128, height: 288 },
        },
        text_only_pdf_layers: [
          {
            base64: btoa(String.fromCharCode(...textBytes)),
            sha256: Array.from(new Uint8Array(digest))
              .map((value) => value.toString(16).padStart(2, "0"))
              .join(""),
          },
        ],
      };
      for (const rotation of [0, 90, 180, 270]) {
        const pdf = await PDFDocument.create();
        const layout = await addReceiptPage(
          pdf,
          bytes,
          type,
          rotation,
          [64, 48, 192, 336],
          ocr,
        );
        results.push({
          type,
          rotation,
          layout,
          unchanged: before === (await hash(bytes)),
          pdf: Array.from(await pdf.save()),
        });
      }
    }
    return { results, geometry };
  });
  expect(fixtures.geometry.output).toEqual(fixtures.geometry.expected);
  expect(fixtures.geometry.expected[0]).toBeGreaterThan(120);
  expect(fixtures.geometry.expected[1]).toBeGreaterThan(270);
  expect(fixtures.geometry.corners.every((pixel) => pixel[0] > 220)).toBe(true);
  expect(fixtures.geometry.alignmentDeltaPixels).toBeLessThan(1.2);
  expect(fixtures.geometry.overlayViewBox).toBe(
    `0 0 ${fixtures.geometry.expected[0]} ${fixtures.geometry.expected[1]}`,
  );
  for (const fixture of fixtures.results) {
    expect(fixture.unchanged).toBe(true);
    expect(fixture.layout).toEqual({
      pixels: [256, 384],
      crop: [64, 48, 192, 336],
      rotation: fixture.rotation,
    });
    const bytes = Uint8Array.from(fixture.pdf);
    const pdf = await PDFDocument.load(bytes);
    const images = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object)
      .filter(
        (object): object is PDFRawStream =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
      );
    expect(images).toHaveLength(1);
    expect(images[0].dict.get(PDFName.of("Width"))?.toString()).toBe("64");
    expect(images[0].dict.get(PDFName.of("Height"))?.toString()).toBe("144");
    if (fixture.type === "image/jpeg") {
      expect(
        (await sharp(images[0].contents).metadata()).chromaSubsampling,
      ).toBe("4:4:4");
    }
    expect(pdf.getPage(0).getRotation().angle).toBe(fixture.rotation);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 164, height: 324 });
    const loading = getDocument({ data: bytes, useSystemFonts: true });
    const searchable = await loading.promise;
    const text = await (await searchable.getPage(1)).getTextContent();
    const item = text.items.find(
      (value) => "str" in value && value.str === "TOTAL 123.45",
    );
    expect(item).toBeDefined();
    if (item && "transform" in item) {
      expect(item.transform[4]).toBeCloseTo(24);
      expect(item.transform[5]).toBeCloseTo(234);
    }
    await loading.destroy();
  }

  // Asymmetric pixels detect both axis swaps and 180-degree/mirrored decoding.
  const raw = Buffer.alloc(80 * 120 * 3);
  for (let y = 0; y < 120; y++)
    for (let x = 0; x < 80; x++) raw.set([x * 3, y * 2, 60], (y * 80 + x) * 3);
  for (const format of ["jpeg", "png"] as const) {
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const source = await sharp(raw, {
        raw: { width: 80, height: 120, channels: 3 },
      })
        .withMetadata({ orientation })
        .toFormat(format)
        .toBuffer();
      const result = await page.evaluate(
        async ({ data, type }) => {
          const modulePath = "/synthetic-pdf-crop.js";
          const { cropPdfImage } = await import(modulePath);
          const bytes = Uint8Array.from(data);
          const before = Array.from(bytes).join(",");
          const cropped = await cropPdfImage(bytes, type, [10, 20, 60, 100]);
          return {
            data: Array.from(cropped),
            unchanged: before === Array.from(bytes).join(","),
          };
        },
        { data: Array.from(source), type: `image/${format}` },
      );
      expect(result.unchanged).toBe(true);
      const { data: actual, info } = await sharp(Buffer.from(result.data))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const expected = await sharp(source)
        .extract({ left: 10, top: 20, width: 50, height: 80 })
        .resize(25, 40)
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(info.width).toBe(25);
      expect(info.height).toBe(40);
      const meanError =
        actual.reduce(
          (sum, value, index) => sum + Math.abs(value - expected[index]),
          0,
        ) / actual.length;
      expect(
        meanError,
        `${format} EXIF orientation ${orientation}`,
      ).toBeLessThan(2);
    }
  }
});
