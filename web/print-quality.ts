// Measure local ink contrast, noise and glare independently of perceptual blur.
export function measurePrint(
  gray: Uint8Array,
  background: Uint8Array,
  laplacian: Float64Array,
  width: number,
  height: number,
) {
  const histogram = new Uint32Array(1021);
  for (const value of laplacian) histogram[Math.min(1020, Math.abs(value))]++;
  let cumulative = 0;
  let median = 0;
  for (; median < histogram.length - 1; median++) {
    cumulative += histogram[median];
    if (cumulative >= gray.length / 2) break;
  }
  // A noise-adaptive floor keeps sensor noise from masquerading as faint ink.
  const noiseFloor = Math.max(8, median * 2);
  const paperLevels = new Uint32Array(256);
  let saturated = 0;
  for (let i = 0; i < gray.length; i++) {
    paperLevels[background[i]]++;
    if (gray[i] >= 250) saturated++;
  }
  let paperMedian = 0,
    total = 0;
  for (; paperMedian < 255; paperMedian++) {
    total += paperLevels[paperMedian];
    if (total >= gray.length / 2) break;
  }
  let ink = 0;
  let contrast = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const difference = background[i] - gray[i];
      if (difference < Math.max(noiseFloor, background[i] * 0.06)) continue;
      ink++;
      contrast += difference;
    }
  }
  return {
    inkFraction: ink / gray.length,
    contrast: ink ? contrast / ink : 0,
    noiseFloor,
    glare: paperMedian < 235 && saturated / gray.length > 0.03,
  };
}
