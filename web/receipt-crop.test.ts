import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { detectedReceiptCrop } from "./receipt-crop";
import { addReceiptPage } from "./receipt-pdf";
import { receiptRectification } from "./receipt-rectification";
import sharp from "sharp";

describe("saved detector outlines in document layouts", () => {
  it("retains a paper margin and clamps it to the source", () => {
    expect(
      detectedReceiptCrop(
        [1000, 2000],
        [
          [0.1, 0.2],
          [0.9, 0.2],
          [0.9, 0.8],
          [0.1, 0.8],
        ],
      ),
    ).toEqual([90, 390, 910, 1610]);
    expect(
      detectedReceiptCrop(
        [1000, 2000],
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ),
    ).toEqual([0, 0, 1000, 2000]);
  });
  it("keeps absent or malformed detection explicit", () => {
    expect(detectedReceiptCrop([1000, 2000], null)).toBeNull();
    expect(
      detectedReceiptCrop(
        [1000, 2000],
        [
          [-1, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ),
    ).toBeNull();
    expect(() => detectedReceiptCrop([0, 2000], null)).toThrow();
  });
  it("retains reviewed geometry in image-only output and rejects invalid searchable input", async () => {
    const image = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const blind = await PDFDocument.create();
    const layout = await addReceiptPage(
      blind,
      image,
      "image/png",
      90,
      [0, 0, 1, 1],
      undefined,
      undefined,
      true,
      async () => image,
    );
    const loaded = await PDFDocument.load(await blind.save());
    expect(layout).toEqual({
      pixels: [1, 1],
      crop: [0, 0, 1, 1],
      rotation: 90,
    });
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getPage(0).getRotation().angle).toBe(90);
    expect(loaded.getPage(0).getSize()).toEqual({ width: 37, height: 37 });
    // A supplied but empty OCR artifact cannot silently produce a 'searchable' page.
    await expect(
      addReceiptPage(await PDFDocument.create(), image, "image/png", 0, null, {
        text_only_pdf_layers: [],
      } as never),
    ).rejects.toThrow("plain OCR");
    await expect(
      addReceiptPage(
        await PDFDocument.create(),
        image,
        "image/png",
        0,
        [0, 0, 2, 1],
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow("crop");
  });
});

it("rejects searchable OCR pinned to a different perspective outline", async () => {
  const image = new Uint8Array(
    await sharp({
      create: { width: 300, height: 500, channels: 3, background: "white" },
    })
      .png()
      .toBuffer(),
  );
  const first = receiptRectification(
    [300, 500],
    [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.8, 0.9],
      [0.2, 0.9],
    ],
  )!;
  const second = receiptRectification(
    [300, 500],
    [
      [0.2, 0.1],
      [0.8, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ],
  )!;
  expect(second.outputPixels).toEqual(first.outputPixels);
  const layer = await PDFDocument.create();
  layer.addPage(first.outputPixels);
  const layerBytes = await layer.save();
  const artifact = {
    source: {
      pixels: first.outputPixels,
      sourcePixels: [300, 500],
      sourceCrop: [27, 40, 273, 460],
      geometryVersion: 1,
      rectification: first,
    },
    text_only_pdf_layers: [
      {
        base64: Buffer.from(layerBytes).toString("base64"),
        sha256: Buffer.from(
          await crypto.subtle.digest(
            "SHA-256",
            layerBytes as Uint8Array<ArrayBuffer>,
          ),
        ).toString("hex"),
      },
    ],
  } as never;
  await expect(
    addReceiptPage(
      await PDFDocument.create(),
      image,
      "image/png",
      0,
      [27, 40, 273, 460],
      artifact,
      [
        [0.2, 0.1],
        [0.8, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
      false,
      async (_bytes, _type, _crop, geometry) =>
        sharp({
          create: {
            width: Math.max(1, Math.round(geometry!.outputPixels[0] / 2)),
            height: Math.max(1, Math.round(geometry!.outputPixels[1] / 2)),
            channels: 3,
            background: "white",
          },
        })
          .png()
          .toBuffer(),
    ),
  ).rejects.toThrow("saved receipt geometry");
});

it("accepts the full-source OCR canvas and rejects a crop-sized canvas", async () => {
  const image = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const artifact = async (width: number, height: number) => {
    const text = await PDFDocument.create();
    text.addPage([width, height]).drawText("Synthetic OCR only");
    const bytes = await text.save();
    return {
      source: { pixels: [1, 1] },
      text_only_pdf_layers: [
        {
          base64: Buffer.from(bytes).toString("base64"),
          sha256: Buffer.from(
            await crypto.subtle.digest(
              "SHA-256",
              bytes as Uint8Array<ArrayBuffer>,
            ),
          ).toString("hex"),
        },
      ],
    } as never;
  };
  const destination = await PDFDocument.create();
  expect(
    await addReceiptPage(
      destination,
      image,
      "image/png",
      0,
      [0, 0, 1, 1],
      await artifact(100, 100),
      undefined,
      false,
      async () => image,
    ),
  ).toEqual({ pixels: [1, 1], crop: [0, 0, 1, 1], rotation: 0 });
  await expect(
    addReceiptPage(
      await PDFDocument.create(),
      image,
      "image/png",
      0,
      [0, 0, 1, 1],
      await artifact(50, 100),
      undefined,
      false,
      async () => image,
    ),
  ).rejects.toThrow("saved receipt geometry");
  await expect(
    addReceiptPage(
      await PDFDocument.create(),
      image,
      "image/png",
      0,
      null,
      await artifact(100, 100),
      undefined,
      true,
    ),
  ).rejects.toThrow("must not contain");
});
