import type { Capture } from "./types";

export function edgeOverlay(capture: Capture): SVGSVGElement {
  const points = capture.manual_outline?.quad ?? capture.metadata.quality?.quad;
  return outlineOverlay(
    points?.length === 4
      ? [
          {
            points,
            colour: capture.status === "accepted" ? "#64e3ac" : "#ffc568",
          },
        ]
      : [],
  );
}

export function outlineOverlay(
  outlines: { points: number[][]; colour: string }[],
  width = 2,
): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const { points, colour } of outlines) {
    if (
      points.length < 3 ||
      !points.every((p) => p.length === 2 && p.every(Number.isFinite))
    )
      continue;
    const polygon = document.createElementNS(svg.namespaceURI, "polygon");
    polygon.setAttribute(
      "points",
      points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" "),
    );
    polygon.setAttribute("fill", "none");
    polygon.setAttribute("stroke", colour);
    polygon.setAttribute("stroke-width", String(width));
    polygon.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(polygon);
  }
  return svg;
}
