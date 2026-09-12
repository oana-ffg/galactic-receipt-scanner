// Pixel coordinates in perimeter order: normalized x/y would distort angles
// on portrait frames. This is an overhead-capture heuristic, not proof of paper.
export function hasPlausiblePaperCorners(points: number[][]): boolean {
  if (
    points.length !== 4 ||
    points.some((p) => p.length !== 2 || !p.every(Number.isFinite))
  )
    return false;
  return points.every((p, i) => {
    const before = points[(i + 3) % 4];
    const after = points[(i + 1) % 4];
    const a = [before[0] - p[0], before[1] - p[1]];
    const b = [after[0] - p[0], after[1] - p[1]];
    const lengths = Math.hypot(...a) * Math.hypot(...b);
    const cosine = (a[0] * b[0] + a[1] * b[1]) / lengths;
    // Keep 45–135 degree corners, allowing rounding at the inclusive boundary.
    return Number.isFinite(cosine) && Math.abs(cosine) <= Math.SQRT1_2 + 1e-12;
  });
}
