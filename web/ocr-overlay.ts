export type OcrBox = [number, number, number, number];
export interface PositionedOcr {
  pixels: [number, number];
  rotation: number;
  items: { text: string; box: OcrBox; confidence: number | null }[];
  skipped: number;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
/** Only coordinates explicitly tied to the original image are safe to overlay. */
export function positionedOcr(value: unknown): PositionedOcr | null {
  const data = record(value),
    source = record(data?.source);
  const pixels = source?.pixels,
    rotation = source?.rotation ?? 0,
    lines = data?.lines;
  if (
    source?.coordinates !== "original image pixels; top-left origin" ||
    !Array.isArray(pixels) ||
    pixels.length !== 2 ||
    !pixels.every((n) => finite(n) && n > 0) ||
    !finite(rotation) ||
    ![0, 90, 180, 270].includes(rotation) ||
    !Array.isArray(lines)
  )
    return null;
  const result: PositionedOcr = {
    pixels: pixels as [number, number],
    rotation,
    items: [],
    skipped: 0,
  };
  for (const rawLine of lines) {
    const line = record(rawLine);
    const items =
      Array.isArray(line?.words) && line.words.length ? line.words : [line];
    for (const rawItem of items) {
      const item = record(rawItem);
      if (typeof item?.text !== "string" || !item.text.trim()) continue;
      const b = record(item.box),
        box = [b?.x0, b?.y0, b?.x1, b?.y1];
      if (
        !box.every(finite) ||
        box[0] < 0 ||
        box[1] < 0 ||
        box[2] > pixels[0] ||
        box[3] > pixels[1] ||
        box[2] <= box[0] ||
        box[3] <= box[1]
      ) {
        result.skipped++;
        continue;
      }
      result.items.push({
        text: item.text,
        box: box as OcrBox,
        confidence:
          finite(item.confidence) &&
          item.confidence >= 0 &&
          item.confidence <= 100
            ? item.confidence
            : null,
      });
    }
  }
  return result;
}
export function projectOcrBox(
  box: OcrBox,
  crop: OcrBox,
  rotation: number,
): OcrBox {
  const [left, top, right, bottom] = crop,
    w = right - left,
    h = bottom - top;
  const points = [
    [box[0] - left, box[1] - top],
    [box[2] - left, box[3] - top],
  ].map(([x, y]) =>
    rotation === 90
      ? [h - y, x]
      : rotation === 180
        ? [w - x, h - y]
        : rotation === 270
          ? [y, w - x]
          : [x, y],
  );
  return [
    Math.min(...points.map((p) => p[0])),
    Math.min(...points.map((p) => p[1])),
    Math.max(...points.map((p) => p[0])),
    Math.max(...points.map((p) => p[1])),
  ];
}
/** The SVG shares the image canvas dimensions, so zoom and scrolling keep them aligned. */
export function ocrOverlay(ocr: PositionedOcr, crop: OcrBox, rotation: number) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const rotated = rotation === 90 || rotation === 270;
  const width = rotated ? crop[3] - crop[1] : crop[2] - crop[0],
    height = rotated ? crop[2] - crop[0] : crop[3] - crop[1];
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", "Saved OCR overlay");
  svg.setAttribute("role", "img");
  svg.classList.add("ocr-overlay");
  const angle = (rotation - ocr.rotation + 360) % 360;
  for (const item of ocr.items) {
    const [x0, y0, x1, y1] = projectOcrBox(item.box, crop, rotation);
    if (x1 <= 0 || y1 <= 0 || x0 >= width || y0 >= height) continue;
    const group = document.createElementNS(ns, "g"),
      rect = document.createElementNS(ns, "rect"),
      text = document.createElementNS(ns, "text");
    const w = x1 - x0,
      h = y1 - y0,
      cx = (x0 + x1) / 2,
      cy = (y0 + y1) / 2;
    const textWidth = angle === 90 || angle === 270 ? h : w,
      textHeight = angle === 90 || angle === 270 ? w : h;
    rect.setAttribute("x", String(x0));
    rect.setAttribute("y", String(y0));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    group.classList.toggle(
      "ocr-uncertain",
      item.confidence === null || item.confidence < 85,
    );
    text.setAttribute("x", String(cx - textWidth / 2));
    text.setAttribute("y", String(cy + textHeight * 0.32));
    text.setAttribute("font-size", String(textHeight * 0.86));
    text.setAttribute("textLength", String(textWidth));
    text.setAttribute("lengthAdjust", "spacingAndGlyphs");
    text.setAttribute("transform", `rotate(${angle} ${cx} ${cy})`);
    text.textContent = item.text;
    const title = document.createElementNS(ns, "title");
    title.textContent = `${item.text}${item.confidence === null ? " · OCR confidence unavailable" : ` · OCR confidence ${item.confidence.toFixed(0)}%`}`;
    group.append(title, rect, text);
    svg.append(group);
  }
  return svg;
}
