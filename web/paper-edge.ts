// A brightness threshold can turn a reflection into a convincing quadrilateral.
// Require a localized light-to-dark transition along each proposed paper edge.
export function hasPaperEdges(
  pixels: Uint8Array,
  width: number,
  height: number,
  points: number[][],
  outline: number[][],
): boolean {
  const center = points.reduce(
    (sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4],
    [0, 0],
  );
  const sample = (x: number, y: number) =>
    pixels[
      Math.max(0, Math.min(height - 1, Math.round(y))) * width +
        Math.max(0, Math.min(width - 1, Math.round(x)))
    ];
  return points.every((a, i) => {
    const b = points[(i + 1) % 4];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / length;
    let ny = (b[0] - a[0]) / length;
    if ((center[0] - a[0]) * nx + (center[1] - a[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    let supported = 0;
    for (let j = 0; j < 20; j++) {
      // Follow the segmented boundary: a creased edge can bow away from
      // its simplified quadrilateral without being blurred.
      const t = 0.1 + (0.8 * (j + 0.5)) / 20;
      const targetX = a[0] + (b[0] - a[0]) * t;
      const targetY = a[1] + (b[1] - a[1]) * t;
      let x = targetX,
        y = targetY,
        nearest = Infinity;
      for (let k = 0; k < outline.length; k++) {
        const c = outline[k],
          d = outline[(k + 1) % outline.length];
        const dx = d[0] - c[0],
          dy = d[1] - c[1];
        const projection = Math.max(
          0,
          Math.min(
            1,
            ((targetX - c[0]) * dx + (targetY - c[1]) * dy) /
              (dx * dx + dy * dy || 1),
          ),
        );
        const px = c[0] + projection * dx,
          py = c[1] + projection * dy;
        const distance = (px - targetX) ** 2 + (py - targetY) ** 2;
        if (distance < nearest) {
          nearest = distance;
          x = px;
          y = py;
        }
      }
      for (let offset = -3; offset <= 3; offset++) {
        const at = (distance: number) =>
          sample(x + nx * (offset + distance), y + ny * (offset + distance));
        const narrow = at(2) - at(-2);
        const wide = at(8) - at(-8);
        if (narrow >= 8 && narrow >= wide * 0.55) {
          supported++;
          break;
        }
      }
    }
    return supported >= 12;
  });
}
