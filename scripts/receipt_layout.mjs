// Resolve the same detector geometry as PDF/OCR without downloading image pixels.
import { detectedReceiptCrop } from "../web/receipt-crop.ts";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { pixels, quad, crop } = JSON.parse(input);
if (
  !Array.isArray(pixels) ||
  pixels.length !== 2 ||
  !pixels.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 50000)
)
  throw Error("Invalid source dimensions.");
const bounds =
  crop === undefined
    ? (detectedReceiptCrop(pixels, quad) ?? [0, 0, ...pixels])
    : (crop ?? [0, 0, ...pixels]);
if (
  !Array.isArray(bounds) ||
  bounds.length !== 4 ||
  !bounds.every(Number.isSafeInteger) ||
  bounds[0] < 0 ||
  bounds[1] < 0 ||
  bounds[2] > pixels[0] ||
  bounds[3] > pixels[1] ||
  bounds[2] <= bounds[0] ||
  bounds[3] <= bounds[1]
)
  throw Error("Invalid source crop.");
console.log(JSON.stringify({ pixels, crop: bounds }));
