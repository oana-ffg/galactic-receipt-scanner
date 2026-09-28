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
    for (const type of ["image/png", "image/jpeg"]) {
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), type, 0.98),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const before = await hash(bytes);
      const layer = await PDFDocument.create();
      const text = layer.addPage([256, 384]);
      text.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
      text.drawText("TOTAL 123.45", { x: 70, y: 264, size: 12 });
      const textBytes = await layer.save();
      const digest = await crypto.subtle.digest("SHA-256", textBytes);
      const ocr = {
        source: { pixels: [256, 384] },
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
    return results;
  });
  for (const fixture of fixtures) {
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
