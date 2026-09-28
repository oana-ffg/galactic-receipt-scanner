import sharp from "sharp";
import { PDF_JPEG_QUALITY } from "../web/pdf-image.ts";

/** Node codec for the same full-resolution PDF crop used by the browser. */
export async function cropPdfImage(bytes, type, [left, top, right, bottom]) {
  const image = sharp(bytes).extract({
    left,
    top,
    width: right - left,
    height: bottom - top,
  });
  const output =
    type === "image/png"
      ? image.png()
      : image.jpeg({ quality: PDF_JPEG_QUALITY, chromaSubsampling: "4:4:4" });
  return Uint8Array.from(await output.toBuffer());
}
