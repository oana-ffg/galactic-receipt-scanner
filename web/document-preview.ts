import type { DocumentView } from "./documents";
import type { Capture } from "./types";
import { detectedReceiptCrop } from "./receipt-crop";
import { messageOf } from "./errors";

/** Display-only crop. Originals and stored derivatives are never modified. */
export function documentPreview(doc: DocumentView, captures: Capture[]) {
  const element = document.createElement("section");
  element.className = "document-preview";
  element.setAttribute("aria-label", "Receipt preview");
  const controls = document.createElement("div");
  controls.className = "controls";
  const source = document.createElement("select");
  source.setAttribute("aria-label", "Preview source");
  for (const [value, label] of [
    ...(doc.pdf ? [["pdf", "Saved final PDF"]] : []),
    ["crop", "Cropped scan"],
    ["original", "Full original"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    source.append(option);
  }
  controls.append(source);
  const content = document.createElement("div");
  content.className = "document-preview-content";
  element.append(controls, content);
  let dispose = () => {};
  let generation = 0;
  const show = async () => {
    const current = ++generation;
    dispose();
    content.replaceChildren();
    if (source.value === "pdf" && doc.pdf) {
      content.textContent = "Loading saved PDF…";
      try {
        const { pdfPreview } = await import("./pdf-preview");
        if (current !== generation) return;
        const preview = pdfPreview(
          `/api/documents/${doc.id}/pdf?version=${doc.pdf.sha256}&revision=${doc.pdf.revision}`,
          doc.pdf.sha256,
          doc.filename ?? "Receipt",
        );
        dispose = preview.destroy;
        content.replaceChildren(preview.element);
      } catch (error) {
        if (current === generation)
          content.textContent = `PDF preview unavailable: ${messageOf(error)}. Choose Cropped scan above.`;
      }
      return;
    }
    let pageIndex = 0;
    let zoomed = false;
    const toolbar = document.createElement("div");
    toolbar.className = "controls";
    const button = (label: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      toolbar.append(b);
      return b;
    };
    const previous = button("Previous scan"),
      next = button("Next scan"),
      zoom = button("Zoom in");
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const viewport = document.createElement("div");
    viewport.className = "document-preview-viewport";
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    viewport.append(canvas);
    content.append(toolbar, status, viewport);
    const fit = () => {
      if (!canvas.width || !canvas.height) return;
      canvas.style.width = `${zoomed ? canvas.width : viewport.clientWidth}px`;
      canvas.style.height = "auto";
    };
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    let image: HTMLImageElement | undefined;
    dispose = () => {
      observer.disconnect();
      if (image) {
        image.onload = image.onerror = null;
        image.src = "";
      }
      canvas.width = canvas.height = 0;
    };
    const render = () => {
      const page = doc.pages[pageIndex];
      const capture = captures.find((c) => c.id === page.captureId);
      previous.disabled = next.disabled = zoom.disabled = true;
      canvas.hidden = true;
      status.textContent = `Loading scan ${pageIndex + 1} of ${doc.pages.length}…`;
      image = new Image();
      image.onload = () => {
        if (current !== generation || !image) return;
        try {
          const width = image.naturalWidth,
            height = image.naturalHeight;
          const quad =
            capture?.manual_outline?.source_sha256 === page.sha256
              ? capture.manual_outline.quad
              : capture?.metadata.quality?.quad;
          const crop =
            source.value === "crop"
              ? (page.crop ?? detectedReceiptCrop([width, height], quad))
              : null;
          const [left, top, right, bottom] = crop ?? [0, 0, width, height];
          if (
            left < 0 ||
            top < 0 ||
            right > width ||
            bottom > height ||
            right <= left ||
            bottom <= top
          )
            throw Error(
              "Saved crop is outside the original. Choose Full original.",
            );
          const w = right - left,
            h = bottom - top,
            rotated = page.rotation === 90 || page.rotation === 270;
          canvas.width = rotated ? h : w;
          canvas.height = rotated ? w : h;
          const ctx = canvas.getContext("2d")!;
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.rotate((page.rotation * Math.PI) / 180);
          ctx.drawImage(image, left, top, w, h, -w / 2, -h / 2, w, h);
          canvas.setAttribute(
            "aria-label",
            `${crop ? "Cropped scan" : "Original scan"} ${pageIndex + 1} of ${doc.pages.length}`,
          );
          canvas.hidden = false;
          status.textContent = `Scan ${pageIndex + 1} of ${doc.pages.length} · ${crop ? "display crop" : "full original; no crop applied"}`;
          fit();
          viewport.scrollTo(0, 0);
          zoom.disabled = false;
        } catch (error) {
          status.textContent = messageOf(error);
        }
        previous.disabled = pageIndex === 0;
        next.disabled = pageIndex === doc.pages.length - 1;
      };
      image.onerror = () => {
        if (current === generation) {
          status.textContent =
            "Scan could not load. Choose another preview source to retry.";
          previous.disabled = pageIndex === 0;
          next.disabled = pageIndex === doc.pages.length - 1;
        }
      };
      image.src = `/api/files/${page.captureId}/raw`;
    };
    previous.onclick = () => {
      pageIndex--;
      render();
    };
    next.onclick = () => {
      pageIndex++;
      render();
    };
    zoom.onclick = () => {
      zoomed = !zoomed;
      zoom.textContent = zoomed ? "Fit width" : "Zoom in";
      fit();
    };
    render();
  };
  source.onchange = () => void show();
  void show();
  return {
    element,
    destroy: () => {
      generation++;
      dispose();
      element.remove();
    },
  };
}
