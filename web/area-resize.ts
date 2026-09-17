/** Bound native pixel materialization independently of the original's dimensions. */
export const AREA_TILE = { width: 1024, height: 256 } as const;

/**
 * Area-average downsampling, equivalent to INTER_AREA (within 8-bit rounding).
 * Read grayscale tiles at native resolution; accumulate fractional pixel overlap
 * so non-integer scales and tile seams cannot change the sampling footprint.
 */
export function resizeGrayArea(
  width: number,
  height: number,
  outputWidth: number,
  outputHeight: number,
  readTile: (x: number, y: number, width: number, height: number) => Uint8Array,
): Uint8Array {
  if (
    ![width, height, outputWidth, outputHeight].every(
      (v) => Number.isInteger(v) && v > 0,
    ) ||
    outputWidth > width ||
    outputHeight > height
  )
    throw new Error(
      "Area resize requires positive dimensions and no upscaling.",
    );
  const sums = new Float64Array(outputWidth * outputHeight);
  const scaleX = width / outputWidth,
    scaleY = height / outputHeight;
  for (let tx = 0; tx < width; tx += AREA_TILE.width) {
    const tw = Math.min(AREA_TILE.width, width - tx);
    const bins = [];
    for (
      let dx = Math.floor(tx / scaleX);
      dx < Math.min(outputWidth, Math.ceil((tx + tw) / scaleX));
      dx++
    ) {
      const left = Math.max(tx, dx * scaleX),
        right = Math.min(tx + tw, (dx + 1) * scaleX);
      const first = Math.floor(left),
        last = Math.ceil(right) - 1;
      bins.push({
        dx,
        first: first - tx,
        last: last - tx,
        firstWeight: Math.min(first + 1, right) - left,
        lastWeight: right - last,
      });
    }
    for (let ty = 0; ty < height; ty += AREA_TILE.height) {
      const th = Math.min(AREA_TILE.height, height - ty);
      const gray = readTile(tx, ty, tw, th);
      if (gray.length !== tw * th) throw new Error("Invalid grayscale tile.");
      for (let y = 0; y < th; y++) {
        const sy = ty + y,
          row = y * tw;
        const firstY = Math.floor(sy / scaleY);
        const lastY = Math.min(
          outputHeight - 1,
          Math.ceil((sy + 1) / scaleY) - 1,
        );
        for (const bin of bins) {
          let sum = gray[row + bin.first] * bin.firstWeight;
          if (bin.first !== bin.last) {
            for (let x = bin.first + 1; x < bin.last; x++) sum += gray[row + x];
            sum += gray[row + bin.last] * bin.lastWeight;
          }
          for (let dy = firstY; dy <= lastY; dy++) {
            const overlap =
              Math.min(sy + 1, (dy + 1) * scaleY) - Math.max(sy, dy * scaleY);
            sums[dy * outputWidth + bin.dx] += sum * overlap;
          }
        }
      }
    }
  }
  return Uint8Array.from(sums, (value) =>
    Math.round(value / (scaleX * scaleY)),
  );
}
