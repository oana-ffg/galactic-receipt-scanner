import { getDocument, GlobalWorkerOptions, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { sha256 } from "./checksum";
import { messageOf } from "./errors";

GlobalWorkerOptions.workerSrc = workerUrl;

export function pdfPreview(
  source: string,
  expectedHash: string,
  filename: string,
) {
  const element = document.createElement("section");
  element.className = "pdf-preview";
  element.setAttribute("aria-label", `Saved PDF: ${filename}`);
  const controls = document.createElement("div");
  controls.className = "controls";
  const button = (label: string) => {
    const node = document.createElement("button");
    node.textContent = label;
    controls.append(node);
    return node;
  };
  const previous = button("Previous page");
  const next = button("Next page");
  const zoom = button("Zoom in");
  const pageFit = button("Fit page");
  previous.disabled = next.disabled = zoom.disabled = true;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Loading and verifying saved PDF…";
  const viewport = document.createElement("div");
  viewport.className = "document-preview-viewport";
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.hidden = true;
  viewport.append(canvas);
  element.append(controls, status, viewport);
  const abort = new AbortController();
  let task: ReturnType<typeof getDocument> | undefined;
  let rendering: RenderTask | undefined;
  let actual = false;
  let wholePage = false;
  let closed = false;
  const fit = () => {
    canvas.style.width = `${actual ? canvas.width : wholePage ? Math.min(viewport.clientWidth, (viewport.clientHeight * canvas.width) / canvas.height) : viewport.clientWidth}px`;
    canvas.style.height = "auto";
  };
  const observer = new ResizeObserver(fit);
  observer.observe(viewport);
  const destroy = () => {
    closed = true;
    abort.abort();
    rendering?.cancel();
    void task?.destroy();
    observer.disconnect();
    canvas.width = canvas.height = 0;
    element.remove();
  };
  const load = async () => {
    try {
      const response = await fetch(source, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
      });
      if (!response.ok)
        throw Error("Could not retrieve the saved PDF. Close and try again.");
      const data = await response.arrayBuffer();
      if ((await sha256(data)) !== expectedHash)
        throw Error(
          "PDF checksum mismatch. Regenerate and inspect the saved version.",
        );
      if (closed) return;
      task = getDocument({ data, useSystemFonts: false });
      const pdf = await task.promise;
      let pageNumber = 1;
      const render = async () => {
        previous.disabled = next.disabled = zoom.disabled = true;
        canvas.hidden = true;
        status.textContent = `Rendering page ${pageNumber} of ${pdf.numPages}…`;
        try {
          const page = await pdf.getPage(pageNumber);
          if (closed) return;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(
            2,
            Math.sqrt(16_000_000 / (base.width * base.height)),
          );
          const size = page.getViewport({ scale });
          canvas.width = Math.ceil(size.width);
          canvas.height = Math.ceil(size.height);
          canvas.setAttribute(
            "aria-label",
            `PDF page ${pageNumber} of ${pdf.numPages}`,
          );
          rendering = page.render({ canvas, viewport: size });
          await rendering.promise;
          if (closed) return;
          canvas.hidden = false;
          fit();
          viewport.scrollTo(0, 0);
          status.textContent = `Page ${pageNumber} of ${pdf.numPages} · saved PDF checksum verified`;
          previous.disabled = pageNumber === 1;
          next.disabled = pageNumber === pdf.numPages;
          zoom.disabled = false;
          page.cleanup();
        } catch (error) {
          if (!closed)
            status.textContent = `PDF preview failed: ${messageOf(error)}`;
        }
      };
      previous.onclick = () => {
        pageNumber--;
        void render();
      };
      next.onclick = () => {
        pageNumber++;
        void render();
      };
      zoom.onclick = () => {
        actual = !actual;
        zoom.textContent = actual ? "Fit width" : "Zoom in";
        wholePage = false;
        pageFit.textContent = "Fit page";
        fit();
      };
      pageFit.onclick = () => {
        actual = false;
        wholePage = !wholePage;
        pageFit.textContent = wholePage ? "Fit width" : "Fit page";
        zoom.textContent = "Zoom in";
        fit();
      };
      await render();
    } catch (error) {
      if (!closed)
        status.textContent = `PDF preview failed: ${messageOf(error)}`;
    }
  };
  void load();
  return { element, destroy };
}

export async function inspectPdf(
  source: string,
  expectedHash: string,
  filename: string,
) {
  const dialog = document.createElement("dialog");
  dialog.className = "photo-dialog pdf-dialog";
  dialog.setAttribute("aria-label", `Saved PDF: ${filename}`);
  const close = document.createElement("button");
  close.textContent = "Close PDF";
  const preview = pdfPreview(source, expectedHash, filename);
  close.onclick = () => dialog.close();
  dialog.onclose = () => {
    preview.destroy();
    dialog.remove();
  };
  dialog.append(close, preview.element);
  document.body.append(dialog);
  dialog.showModal();
}
