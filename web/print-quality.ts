// Measure stroke edges relative to their local contrast. Blank margins and
// exposure changes must not turn a sharp, sparse document into a blurry one.
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
  const region = new Uint8Array(gray.length);
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
  let strokeEnergy = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const difference = background[i] - gray[i];
      if (difference < Math.max(noiseFloor, background[i] * 0.06)) continue;
      ink++;
      contrast += difference;
      strokeEnergy += difference * difference;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) region[i + dy * width + dx] = 1;
    }
  }
  let edgeEnergy = 0;
  for (let i = 0; i < region.length; i++)
    if (region[i]) edgeEnergy += laplacian[i] ** 2;
  return {
    inkFraction: ink / gray.length,
    contrast: ink ? contrast / ink : 0,
    sharpness: strokeEnergy ? edgeEnergy / strokeEnergy : 0,
    noiseFloor,
    glare: paperMedian < 235 && saturated / gray.length > 0.03,
  };
}
