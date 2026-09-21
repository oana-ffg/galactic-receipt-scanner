import type { DocumentView } from "./documents";
import { ocrOverlay, type OcrBox, type PositionedOcr } from "./ocr-overlay";
import type { ReviewOcr, ReviewOcrSource } from "./review-ocr";
import type { Capture } from "./types";
import { detectedReceiptCrop } from "./receipt-crop";
import { messageOf } from "./errors";
import { formatOcrConfidence } from "./ocr-confidence";

/** Display-only crop. Originals and stored derivatives are never modified. */
export function documentPreview(
  doc: DocumentView,
  captures: Capture[],
  ocrSource: ReviewOcrSource,
) {
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
  const overlayLabel = document.createElement("label");
  overlayLabel.className = "ocr-overlay-toggle";
  const overlayToggle = document.createElement("input");
  overlayToggle.type = "checkbox";
  overlayLabel.append(overlayToggle, "OCR overlay");
  const overlayEngine = document.createElement("select");
  overlayEngine.setAttribute("aria-label", "Overlay OCR engine");
  overlayEngine.hidden = true;
  const overlayMessage = document.createElement("p");
  overlayMessage.setAttribute("role", "status");
  const transcript = document.createElement("details");
  transcript.className = "document-preview-transcript";
  transcript.append(document.createElement("summary"));
  transcript.firstElementChild!.textContent = "Saved OCR text";
  const transcriptContent = document.createElement("div");
  transcriptContent.textContent = "Open to load saved OCR text.";
  transcript.append(transcriptContent);
  const retryOcr = document.createElement("button");
  retryOcr.textContent = "Retry saved OCR";
  retryOcr.hidden = true;
  controls.append(source, overlayLabel, overlayEngine, retryOcr);
  const content = document.createElement("div");
  content.className = "document-preview-content";
  element.append(controls, overlayMessage, transcript, content);
  let ocr: ReviewOcr[] | undefined;
  let ocrErrors = 0;
  let loadingOcr = false;
  let closed = false;
  let activePage = 0;
  let updateOverlay = () => {};
  const updateRetry = () => {
    retryOcr.hidden =
      loadingOcr || !ocrErrors || !(overlayToggle.checked || transcript.open);
  };
  const loadOverlay = async () => {
    if (loadingOcr) return;
    loadingOcr = true;
    updateRetry();
    overlayMessage.textContent = "Loading saved OCR positions…";
    transcriptContent.textContent = "Loading saved OCR text…";
    try {
      const result = await ocrSource.load();
      if (closed) return;
      ocr = result.engines;
      ocrErrors = result.errors.length;
      transcriptContent.replaceChildren();
      for (const engine of ocr) {
        for (const page of engine.pages) {
          const heading = document.createElement("h4");
          heading.textContent = `${engine.engine} · Page ${page.number}`;
          const text = document.createElement("pre");
          text.textContent = page.text || "No recognized text.";
          transcriptContent.append(heading, text);
        }
      }
      if (!ocr.length)
        transcriptContent.textContent = "No saved OCR for these source pages.";
      if (ocrErrors) {
        const warning = document.createElement("p");
        warning.textContent = `${ocrErrors} saved OCR artifact/page loads failed. Retry above.`;
        transcriptContent.append(warning);
      }
      const selected = overlayEngine.value;
      overlayEngine.replaceChildren();
      for (const engine of ocr) {
        const option = document.createElement("option");
        option.value = option.textContent = engine.engine;
        overlayEngine.append(option);
      }
      if (ocr.some((o) => o.engine === selected))
        overlayEngine.value = selected;
      overlayEngine.hidden = source.value === "pdf" || ocr.length < 2;
      updateOverlay();
    } catch (error) {
      if (!closed) {
        ocrErrors = 1;
        transcriptContent.textContent = `Could not load saved OCR: ${messageOf(error)}`;
        overlayMessage.textContent = messageOf(error);
      }
    } finally {
      loadingOcr = false;
      if (!closed) updateRetry();
    }
  };
  retryOcr.onclick = () => void loadOverlay();
  transcript.ontoggle = () => {
    updateRetry();
    if (transcript.open && !ocr) void loadOverlay();
  };
  overlayEngine.onchange = () => updateOverlay();
  let dispose = () => {};
  let generation = 0;
  const show = async () => {
    const current = ++generation;
    dispose();
    updateOverlay = () => {};
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
          {
            initialPage: activePage + 1,
            onPageChange: (page) => {
              activePage = page - 1;
            },
          },
        );
        dispose = preview.destroy;
        content.replaceChildren(preview.element);
      } catch (error) {
        if (current === generation)
          content.textContent = `PDF preview unavailable: ${messageOf(error)}. Choose Cropped scan above.`;
      }
      return;
    }
    let pageIndex = Math.min(activePage, doc.pages.length - 1);
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
    const stage = document.createElement("div");
    stage.className = "document-preview-stage";
    stage.append(canvas);
    viewport.append(stage);
    let displayed: { crop: OcrBox; pixels: number[] } | undefined;
    let renderedOverlay:
      { positioned: PositionedOcr; element: SVGSVGElement } | undefined;
    updateOverlay = () => {
      overlayMessage.style.visibility = overlayToggle.checked ? "" : "hidden";
      if (renderedOverlay)
        renderedOverlay.element.style.display = overlayToggle.checked
          ? ""
          : "none";
      if (!overlayToggle.checked) return;

      if (!ocr) {
        overlayMessage.textContent = "Loading saved OCR positions…";
        return;
      }
      const engine = ocr.find((o) => o.engine === overlayEngine.value);
      const reading = engine?.pages.find((p) => p.number === pageIndex + 1);
      const positioned = reading?.positioned;
      if (renderedOverlay && renderedOverlay.positioned !== positioned) {
        renderedOverlay.element.remove();
        renderedOverlay = undefined;
      }
      if (!positioned?.items.length) {
        overlayMessage.textContent = `${engine?.engine ?? "OCR"}: no saved word/line positions for this page. View the saved OCR text above.${ocrErrors ? " Some OCR loads failed; retry above." : ""}`;
        return;
      }
      if (!displayed) return;
      if (positioned.pixels.some((n, i) => n !== displayed!.pixels[i])) {
        overlayMessage.textContent =
          "OCR image dimensions do not match this scan; overlay cannot be aligned.";
        return;
      }
      if (!renderedOverlay) {
        renderedOverlay = {
          positioned,
          element: ocrOverlay(
            positioned,
            displayed.crop,
            doc.pages[pageIndex].rotation,
          ),
        };
        stage.append(renderedOverlay.element);
      }
      overlayMessage.textContent = `${engine!.engine} · Page OCR confidence: ${formatOcrConfidence(reading!.confidence)}${engine!.engine === "PP-OCRv6" ? " (mean of lines)" : ""}. Amber = below 85% or unknown. See each line’s score in Compare readings → OCR text. Scores are not proof of correct text.${!reading!.sameRegion ? " Different or unknown OCR crop/rotation." : ""}${positioned.skipped ? ` ${positioned.skipped} invalid text boxes omitted.` : ""}${ocrErrors ? " Some OCR loads failed; retry above." : ""}`;
    };
    content.append(toolbar, status, viewport);
    const fit = () => {
      if (!canvas.width || !canvas.height) return;
      stage.style.width = `${zoomed ? canvas.width : viewport.clientWidth}px`;
      canvas.style.width = "100%";
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
      activePage = pageIndex;
      const page = doc.pages[pageIndex];
      const capture = captures.find((c) => c.id === page.captureId);
      previous.disabled = next.disabled = zoom.disabled = true;
      canvas.hidden = true;
      displayed = undefined;
      renderedOverlay?.element.remove();
      renderedOverlay = undefined;
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
          displayed = {
            crop: [left, top, right, bottom],
            pixels: [width, height],
          };
          updateOverlay();
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
  overlayToggle.onchange = () => {
    overlayEngine.hidden = (ocr?.length ?? 0) < 2;
    overlayMessage.style.visibility = overlayToggle.checked ? "" : "hidden";
    updateRetry();
    if (overlayToggle.checked) {
      if (source.value === "pdf") {
        source.value = "crop";
        void show();
      } else updateOverlay();
      if (!ocr) void loadOverlay();
    } else updateOverlay();
  };
  source.onchange = () => {
    if (source.value === "pdf") {
      overlayToggle.checked = false;
      overlayEngine.hidden = true;
      overlayMessage.textContent = "";
    }
    updateRetry();
    void show();
  };
  void show();
  return {
    element,
    destroy: () => {
      closed = true;
      generation++;
      dispose();
      element.remove();
    },
  };
}
