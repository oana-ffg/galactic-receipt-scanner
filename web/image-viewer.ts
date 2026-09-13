import { edgeOverlay } from "./paper-overlay";
import type { Capture } from "./types";

export function inspectImage(options: {
  title: string;
  alt: string;
  image: string | Blob;
  download: { source: string | Blob; label: string; filename?: string };
  capture?: Capture;
}) {
  const urls: string[] = [];
  const url = (source: string | Blob) => {
    if (typeof source === "string") return source;
    const value = URL.createObjectURL(source);
    urls.push(value);
    return value;
  };
  const dialog = document.createElement("dialog");
  dialog.className = "photo-dialog";
  dialog.setAttribute("aria-label", options.title);
  const controls = document.createElement("div");
  controls.className = "controls";
  const close = document.createElement("button");
  close.textContent = "Close";
  close.onclick = () => dialog.close();
  const zoom = document.createElement("button");
  zoom.textContent = "Actual pixels";
  zoom.className = "secondary";
  zoom.disabled = true;
  const download = document.createElement("a");
  download.textContent = options.download.label;
  download.href = url(options.download.source);
  if (options.download.filename) download.download = options.download.filename;
  controls.append(close, zoom, download);
  const viewport = document.createElement("div");
  viewport.className = "photo-viewport";
  const stage = document.createElement("div");
  stage.className = "saved-image";
  const img = document.createElement("img");
  img.alt = options.alt;
  img.src = url(options.image);
  const svg = options.capture ? edgeOverlay(options.capture) : undefined;
  if (svg) {
    const edges = document.createElement("label");
    edges.className = "toggle";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.onchange = () => {
      svg.style.visibility = check.checked ? "visible" : "hidden";
    };
    edges.append(
      check,
      options.capture?.manual_outline ? "Corrected outline" : "Detected edges",
    );
    controls.append(edges);
  }
  const fit = () => {
    if (
      !stage.classList.contains("actual-size") &&
      img.naturalWidth &&
      img.naturalHeight
    ) {
      stage.style.width = `${Math.min(viewport.clientWidth, (viewport.clientHeight * img.naturalWidth) / img.naturalHeight)}px`;
    }
  };
  const observer = new ResizeObserver(fit);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Loading full-resolution image…";
  img.onload = () => {
    status.remove();
    zoom.disabled = false;
    fit();
  };
  img.onerror = () => {
    status.textContent =
      "Could not load this image. Close the viewer and try again.";
    stage.hidden = true;
  };
  zoom.onclick = () => {
    const actual = stage.classList.toggle("actual-size");
    stage.style.width = actual ? `${img.naturalWidth}px` : "";
    zoom.textContent = actual ? "Fit image" : "Actual pixels";
    fit();
  };
  stage.append(img);
  if (svg) stage.append(svg);
  viewport.append(stage);
  dialog.append(controls, status, viewport);
  dialog.onclose = () => {
    observer.disconnect();
    urls.forEach((value) => URL.revokeObjectURL(value));
    dialog.remove();
  };
  document.body.append(dialog);
  dialog.showModal();
  observer.observe(viewport);
  fit();
}

export function imageZoomButton(
  content: HTMLElement,
  label: string,
  open: () => void,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "image-zoom";
  button.setAttribute("aria-label", label);
  button.title = "Click to zoom";
  button.append(content);
  button.onclick = open;
  return button;
}
