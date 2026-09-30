import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { addReceiptPage } from "../web/receipt-pdf.ts";
import { cropPdfImage } from "./pdf_image.mjs";
import { detectedReceiptCrop } from "../web/receipt-crop.ts";
import {
  RECEIPT_GEOMETRY_VERSION,
  receiptRectification,
} from "../web/receipt-rectification.ts";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const width = 160;
const height = 240;
const crop = [40, 30, 120, 210];

async function source(format) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const inside = x >= crop[0] && x < crop[2] && y >= crop[1] && y < crop[3];
      data.set(inside ? [235, 235, 235] : [x % 256, y % 256, 70], offset);
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .toFormat(format)
    .toBuffer();
}

async function generate(bytes, type, bounds, ocr) {
  const pdf = await PDFDocument.create();
  const layout = await addReceiptPage(
    pdf,
    bytes,
    type,
    90,
    bounds,
    ocr,
    undefined,
    !ocr,
    cropPdfImage,
  );
  return { pdf: await PDFDocument.load(await pdf.save()), layout };
}

function images(pdf) {
  return pdf.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter(
      (object) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"),
    );
}

for (const format of ["png", "jpeg"])
  test(`${format} PDF embeds only the half-resolution crop and preserves original bytes`, async () => {
    const bytes = await source(format);
    const before = hash(bytes);
    const { pdf, layout } = await generate(bytes, `image/${format}`, crop);
    const embedded = images(pdf);
    assert.equal(embedded.length, 1);
    const image = embedded[0];
    assert.equal(image.dict.get(PDFName.of("Width")).asNumber(), 40);
    assert.equal(image.dict.get(PDFName.of("Height")).asNumber(), 90);
    assert.deepEqual(layout, { pixels: [width, height], crop, rotation: 90 });
    assert.deepEqual(pdf.getPage(0).getSize(), { width: 116, height: 216 });
    assert.equal(pdf.getPage(0).getRotation().angle, 90);
    assert.equal(hash(bytes), before);
    const encodedCrop = await cropPdfImage(bytes, `image/${format}`, crop);
    if (format === "jpeg") {
      assert.equal(hash(image.contents), hash(encodedCrop));
      assert.notEqual(hash(image.contents), before);
    } else {
      const actual = decodePDFRawStream(image).decode();
      const expected = await sharp(bytes)
        .extract({ left: 40, top: 30, width: 80, height: 180 })
        .resize(40, 90, { fit: "fill", kernel: "lanczos3" })
        .removeAlpha()
        .raw()
        .toBuffer();
      assert.deepEqual(Buffer.from(actual), expected);
    }
  });

test("fractional crop bounds round outward while the reviewed layout stays unchanged", async () => {
  const bytes = await source("png");
  const bounds = [40.25, 30.75, 119.5, 209.25];
  const { pdf, layout } = await generate(bytes, "image/png", bounds);
  const [image] = images(pdf);
  assert.equal(image.dict.get(PDFName.of("Width")).asNumber(), 40);
  assert.equal(image.dict.get(PDFName.of("Height")).asNumber(), 90);
  assert.deepEqual(layout.crop, bounds);
  assert.deepEqual(pdf.getPage(0).getSize(), {
    width: 115.25,
    height: 214.5,
  });
});

test("uncropped JPEGs also use the half-resolution derivative", async () => {
  const bytes = await source("jpeg");
  const { pdf } = await generate(bytes, "image/jpeg", null);
  const [image] = images(pdf);
  assert.equal(image.dict.get(PDFName.of("Width")).asNumber(), width / 2);
  assert.equal(image.dict.get(PDFName.of("Height")).asNumber(), height / 2);
  assert.notEqual(hash(image.contents), hash(bytes));
});

test("searchable crops keep the full-source OCR coordinate transform", async () => {
  const bytes = await source("png");
  const layer = await PDFDocument.create();
  layer
    .addPage([width, height])
    .drawText("SYNTHETIC", { x: 50, y: 150, size: 8 });
  const textBytes = await layer.save();
  const ocr = {
    source: { pixels: [width, height] },
    text_only_pdf_layers: [
      {
        base64: Buffer.from(textBytes).toString("base64"),
        sha256: hash(textBytes),
      },
    ],
  };
  const { pdf } = await generate(bytes, "image/png", crop, ocr);
  assert.equal(images(pdf).length, 1);
  const page = pdf.getPage(0);
  const contents = page.node.Contents();
  const operators = contents
    .asArray()
    .map((ref) => {
      const stream = pdf.context.lookup(ref);
      return Buffer.from(decodePDFRawStream(stream).decode()).toString();
    })
    .join("");
  assert.match(operators, /1 0 0 1 18 18 cm/); // Cropped image starts at the margin.
  assert.match(operators, /1 0 0 1 -22 -12 cm/); // OCR still uses the original canvas.
});

test("a codec returning the uncropped image fails instead of embedding the desk", async () => {
  const bytes = await source("png");
  await assert.rejects(
    addReceiptPage(
      await PDFDocument.create(),
      bytes,
      "image/png",
      0,
      crop,
      undefined,
      undefined,
      true,
      async () => bytes,
    ),
    /crop dimensions differ/,
  );
});

test("perspective outline rectifies image and OCR together and retains reviewed page rotation", async () => {
  const bytes = await source("png");
  const quad = [
    [0.28, 0.12],
    [0.73, 0.16],
    [0.68, 0.86],
    [0.32, 0.82],
  ];
  const bounds = detectedReceiptCrop([width, height], quad);
  const rectification = receiptRectification([width, height], quad);
  assert.ok(rectification);
  const text = await PDFDocument.create();
  text
    .addPage(rectification.outputPixels)
    .drawText("SYNTHETIC", { x: 10, y: 20, size: 8 });
  const textBytes = await text.save();
  const originalHash = hash(bytes);
  const pdf = await PDFDocument.create();
  await addReceiptPage(
    pdf,
    bytes,
    "image/png",
    270,
    bounds,
    {
      source: {
        pixels: rectification.outputPixels,
        sourcePixels: [width, height],
        sourceCrop: bounds,
        geometryVersion: RECEIPT_GEOMETRY_VERSION,
        rectification,
      },
      text_only_pdf_layers: [
        {
          base64: Buffer.from(textBytes).toString("base64"),
          sha256: hash(textBytes),
        },
      ],
    },
    quad,
    false,
    cropPdfImage,
  );
  const page = (await PDFDocument.load(await pdf.save())).getPage(0);
  assert.equal(page.getRotation().angle, 270);
  assert.equal(page.getWidth(), rectification.outputPixels[0] + 36);
  assert.equal(page.getHeight(), rectification.outputPixels[1] + 36);
  const operators = page.node
    .Contents()
    .asArray()
    .map((ref) =>
      Buffer.from(
        decodePDFRawStream(page.doc.context.lookup(ref)).decode(),
      ).toString(),
    )
    .join("");
  assert.match(operators, /1 0 0 1 18 18 cm/);
  assert.match(
    operators,
    /1 0 0 1 18 18 cm[\s\S]*?\/EmbeddedPdfPage/,
    "saved OCR uses the rectified crop canvas",
  );
  assert.equal(hash(bytes), originalHash);
  const loading = getDocument({
    data: await pdf.save(),
    useSystemFonts: true,
  });
  const searchable = await loading.promise;
  const content = await (await searchable.getPage(1)).getTextContent();
  assert.ok(content.items.some((item) => item.str === "SYNTHETIC"));
  await loading.destroy();
});
