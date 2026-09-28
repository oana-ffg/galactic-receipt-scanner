import sharp from "sharp";
import { PDF_JPEG_QUALITY, pdfImageSize } from "../web/pdf-image.ts";

/** Node codec for half-resolution PDF derivatives; original bytes are untouched. */
export async function cropPdfImage(bytes, type, [left, top, right, bottom]) {
  const [width, height] = pdfImageSize(right - left, bottom - top);
  const image = sharp(bytes)
    .extract({
      left,
      top,
      width: right - left,
      height: bottom - top,
    })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" });
  const output =
    type === "image/png"
      ? image.png()
      : image.jpeg({
          quality: PDF_JPEG_QUALITY,
          chromaSubsampling: "4:4:4",
          mozjpeg: true,
        });
  return Uint8Array.from(await output.toBuffer());
}
