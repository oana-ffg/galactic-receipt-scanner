/** PDF derivatives use the approved half-resolution, color-preserving JPEG settings. */
export const PDF_JPEG_QUALITY = 85;

export function pdfImageSize(width: number, height: number): [number, number] {
  return [
    Math.max(1, Math.round(width / 2)),
    Math.max(1, Math.round(height / 2)),
  ];
}

let jpegEncoder:
  Promise<typeof import("@jsquash/jpeg/encode.js").default> | undefined;
function loadJpegEncoder() {
  return (jpegEncoder ??= Promise.all([
    import("@jsquash/jpeg/encode.js"),
    import("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url"),
  ]).then(async ([{ default: encode, init }, { default: wasmUrl }]) => {
    await init({ locateFile: () => wasmUrl });
    return encode;
  }));
}

export async function encodePdfJpeg(pixels: ImageData): Promise<Uint8Array> {
  const encode = await loadJpegEncoder();
  return new Uint8Array(
    await encode(pixels, {
      quality: PDF_JPEG_QUALITY,
      auto_subsample: false,
      chroma_subsample: 1,
    }),
  );
}

export type PdfImageCropper = (
  bytes: Uint8Array,
  type: string,
  crop: [number, number, number, number],
) => Promise<Uint8Array>;

/** Decode in encoded pixel coordinates, matching PDF/OCR rather than EXIF orientation.
 * Browsers can apply EXIF even with imageOrientation: "none". Remove camera EXIF
 * from this derivative's input only; retain color profiles and original source bytes.
 */
export function pdfPixelBytes(bytes: Uint8Array, type: string): Uint8Array {
  const parts: Uint8Array[] = [];
  let kept = 0;
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      const start = offset++;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = (bytes[offset] << 8) | bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if (
        marker === 0xe1 &&
        length >= 8 &&
        bytes[offset + 2] === 0x45 &&
        bytes[offset + 3] === 0x78 &&
        bytes[offset + 4] === 0x69 &&
        bytes[offset + 5] === 0x66 &&
        bytes[offset + 6] === 0 &&
        bytes[offset + 7] === 0
      ) {
        parts.push(bytes.subarray(kept, start));
        kept = offset + length;
      }
      offset += length;
    }
  } else if (type === "image/png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const end = offset + 12 + view.getUint32(offset);
      if (end > bytes.length) break;
      if (view.getUint32(offset + 4) === 0x65584966) {
        // eXIf
        parts.push(bytes.subarray(kept, offset));
        kept = end;
      }
      offset = end;
    }
  }
  if (!kept) return bytes;
  parts.push(bytes.subarray(kept));
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Browser codec. Only PDF derivatives pass through this canvas. */
export const cropPdfImage: PdfImageCropper = async (bytes, type, crop) => {
  const [left, top, right, bottom] = crop;
  const bitmap = await createImageBitmap(
    new Blob([pdfPixelBytes(bytes, type) as Uint8Array<ArrayBuffer>], { type }),
    { imageOrientation: "none" },
  );
  try {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = pdfImageSize(right - left, bottom - top);
    const context = canvas.getContext("2d");
    if (!context) throw Error("PDF image crop could not create a canvas.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      left,
      top,
      right - left,
      bottom - top,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    if (type === "image/jpeg") {
      // Load only during downstream PDF creation, never in the capture path.
      return encodePdfJpeg(
        context.getImageData(0, 0, canvas.width, canvas.height),
      );
    }
    const result = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob && blob.type === type
            ? resolve(blob)
            : reject(Error("PDF image crop encoding failed.")),
        type,
        PDF_JPEG_QUALITY / 100,
      );
    });
    return new Uint8Array(await result.arrayBuffer());
  } finally {
    bitmap.close();
  }
};
