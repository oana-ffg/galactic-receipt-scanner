/** Orientation-independent source dimensions, measured along the detected paper edges. */
export function hasReceiptResolution(pixels: unknown): boolean {
  return (
    Array.isArray(pixels) &&
    pixels.length === 2 &&
    pixels.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) &&
    Math.min(...pixels) >= 450 &&
    Math.max(...pixels) >= 900
  );
}
