import type { Capture } from "./types";

export function edgeOverlay(capture: Capture): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const points = capture.metadata.quality?.quad;
  if (
    points?.length === 4 &&
    points.every((p) => p.length === 2 && p.every(Number.isFinite))
  ) {
    const polygon = document.createElementNS(svg.namespaceURI, "polygon");
    polygon.setAttribute(
      "points",
      points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(" "),
    );
    polygon.setAttribute("fill", "none");
    polygon.setAttribute(
      "stroke",
      capture.status === "accepted" ? "#64e3ac" : "#ffc568",
    );
    polygon.setAttribute("stroke-width", "2");
    polygon.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(polygon);
  }
  return svg;
}
