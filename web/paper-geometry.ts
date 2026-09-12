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

function signedArea(points: number[][]): number {
  return (
    points.reduce((area, p, i) => {
      const next = points[(i + 1) % points.length];
      return area + p[0] * next[1] - next[0] * p[1];
    }, 0) / 2
  );
}

// Douglas–Peucker corners may sit inside a folded boundary. Move their four
// supporting lines only outward, using this contour alone. Reject large changes
// rather than fitting a generic rectangle to a potentially merged reflection.
export function enclosePaperContour(
  quad: number[][],
  contour: number[][],
): number[][] | null {
  if (
    !hasPlausiblePaperCorners(quad) ||
    !contour.length ||
    contour.some((p) => p.length !== 2 || !p.every(Number.isFinite))
  )
    return null;
  const area = signedArea(quad);
  const winding = Math.sign(area);
  if (!winding) return null;
  const lengths = quad.map((p, i) =>
    Math.hypot(quad[(i + 1) % 4][0] - p[0], quad[(i + 1) % 4][1] - p[1]),
  );
  const maxShift = Math.min(...lengths) * 0.2;
  const lines = quad.map((p, i) => {
    const next = quad[(i + 1) % 4];
    const nx = (winding * (p[1] - next[1])) / lengths[i];
    const ny = (winding * (next[0] - p[0])) / lengths[i];
    const original = nx * p[0] + ny * p[1];
    let offset = original;
    for (const c of contour) offset = Math.min(offset, nx * c[0] + ny * c[1]);
    return { nx, ny, offset, shift: original - offset };
  });
  if (lines.some((line) => line.shift > maxShift)) return null;
  const expanded = lines.map((line, i) => {
    const before = lines[(i + 3) % 4];
    const determinant = before.nx * line.ny - line.nx * before.ny;
    return [
      (before.offset * line.ny - line.offset * before.ny) / determinant,
      (before.nx * line.offset - line.nx * before.offset) / determinant,
    ];
  });
  const growth = signedArea(expanded) / area;
  return hasPlausiblePaperCorners(expanded) &&
    growth >= 1 - 1e-9 &&
    growth <= 4 / 3
    ? expanded
    : null;
}

// Fit each long edge independently of folded corner tips. Approximation corners
// define the search band; only the middle of an edge contributes to its angle.
export function refinePaperEdges(
  quad: number[][],
  contour: number[][],
): number[][] {
  if (!hasPlausiblePaperCorners(quad)) return quad;
  const winding = Math.sign(signedArea(quad));
  const lengths = quad.map((p, i) =>
    Math.hypot(quad[(i + 1) % 4][0] - p[0], quad[(i + 1) % 4][1] - p[1]),
  );
  const band = Math.min(...lengths) * 0.1;
  const lines = quad.map((p, i) => {
    const next = quad[(i + 1) % 4],
      length = lengths[i];
    const ux = (next[0] - p[0]) / length,
      uy = (next[1] - p[1]) / length;
    const original = { nx: -winding * uy, ny: winding * ux, offset: 0 };
    original.offset = original.nx * p[0] + original.ny * p[1];
    const samples: number[][] = [];
    for (let j = 0; j < contour.length; j++) {
      const a = contour[j],
        b = contour[(j + 1) % contour.length];
      const steps = Math.max(
        1,
        Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2),
      );
      for (let k = 0; k < steps; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / steps;
        const y = a[1] + ((b[1] - a[1]) * k) / steps;
        const along = ((x - p[0]) * ux + (y - p[1]) * uy) / length;
        if (
          along > 0.2 &&
          along < 0.8 &&
          Math.abs((x - p[0]) * uy - (y - p[1]) * ux) < band
        )
          samples.push([x, y]);
      }
    }
    if (samples.length < 8) return original;
    const center = samples.reduce(
      (a, p) => [a[0] + p[0] / samples.length, a[1] + p[1] / samples.length],
      [0, 0],
    );
    let xx = 0,
      yy = 0,
      xy = 0;
    for (const [x, y] of samples) {
      xx += (x - center[0]) ** 2;
      yy += (y - center[1]) ** 2;
      xy += (x - center[0]) * (y - center[1]);
    }
    const angle = Math.atan2(2 * xy, xx - yy) / 2;
    let nx = -Math.sin(angle),
      ny = Math.cos(angle);
    if (nx * original.nx + ny * original.ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const offset = nx * center[0] + ny * center[1];
    const residual =
      samples.reduce(
        (sum, [x, y]) => sum + (nx * x + ny * y - offset) ** 2,
        0,
      ) / samples.length;
    const spread = (xx + yy) / samples.length - residual;
    if (
      nx * original.nx + ny * original.ny < Math.cos(Math.PI / 12) ||
      residual > (band * 0.2) ** 2 ||
      spread < (length * 0.12) ** 2
    )
      return original;
    return { nx, ny, offset };
  });
  const refined = lines.map((line, i) => {
    const before = lines[(i + 3) % 4];
    const determinant = before.nx * line.ny - line.nx * before.ny;
    return [
      (before.offset * line.ny - line.offset * before.ny) / determinant,
      (before.nx * line.offset - line.nx * before.offset) / determinant,
    ];
  });
  return hasPlausiblePaperCorners(refined) ? refined : quad;
}
