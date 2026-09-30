import sharp from "sharp";
import { PDF_JPEG_QUALITY, pdfImageSize } from "../web/pdf-image.ts";

/** Node codec for half-resolution PDF derivatives; original bytes are untouched. */
export async function cropPdfImage(
  bytes,
  type,
  [left, top, right, bottom],
  rectification,
) {
  let image;
  if (rectification) {
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    const cvModule = await import("@techstark/opencv-js");
    const cv = await cvModule.default;
    const input = cv.matFromArray(info.height, info.width, cv.CV_8UC3, data);
    const [width, height] = rectification.outputPixels;
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, rectification.quad.flat());
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [
      rectification.marginPixels,
      rectification.marginPixels,
      width - 1 - rectification.marginPixels,
      rectification.marginPixels,
      width - 1 - rectification.marginPixels,
      height - 1 - rectification.marginPixels,
      rectification.marginPixels,
      height - 1 - rectification.marginPixels,
    ]);
    const transform = cv.getPerspectiveTransform(from, to);
    const output = new cv.Mat();
    try {
      cv.warpPerspective(
        input,
        output,
        transform,
        new cv.Size(width, height),
        cv.INTER_CUBIC,
        cv.BORDER_REPLICATE,
      );
      image = sharp(Buffer.from(output.data), {
        raw: { width, height, channels: 3 },
      }).resize(...pdfImageSize(width, height), {
        fit: "fill",
        kernel: "lanczos3",
      });
    } finally {
      input.delete();
      from.delete();
      to.delete();
      transform.delete();
      output.delete();
    }
  } else {
    const [width, height] = pdfImageSize(right - left, bottom - top);
    image = sharp(bytes)
      .extract({
        left,
        top,
        width: right - left,
        height: bottom - top,
      })
      .resize(width, height, { fit: "fill", kernel: "lanczos3" });
  }
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
