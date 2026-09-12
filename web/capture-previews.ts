import { messageOf } from "./errors";
import { readOriginal } from "./original";
import { edgeOverlay } from "./paper-overlay";
import type { Capture } from "./types";
import { Vision } from "./vision";
import { imageZoomButton, inspectImage } from "./image-viewer";

type Preview = {
  capture: Capture;
  element: HTMLElement;
  output: HTMLElement;
  original: HTMLImageElement;
  state: "waiting" | "queued" | "working" | "done";
  urls: string[];
};

async function thumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, { resizeWidth: 600 });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  } finally {
    bitmap.close();
  }
}

// Desktop-only, one original/worker job at a time. Keep only this page's previews;
// never upload drafts or make the phone's save acknowledgement wait for them.
export class CapturePreviews {
  private entries = new Map<string, Preview>();
  private worker: Vision | undefined;
  private working = false;
  private observer = new IntersectionObserver((observations) => {
    for (const observation of observations) {
      if (!observation.isIntersecting) continue;
      const entry = this.entries.get(
        (observation.target as HTMLElement).dataset.capture!,
      );
      if (entry?.state === "waiting") entry.state = "queued";
    }
    void this.drain();
  });

  setPage(captures: Capture[]) {
    const current = new Map(captures.map((c) => [c.id, c]));
    for (const [id, entry] of this.entries) {
      const capture = current.get(id);
      if (
        capture &&
        capture.sha256 === entry.capture.sha256 &&
        capture.status === entry.capture.status &&
        JSON.stringify(capture.metadata) ===
          JSON.stringify(entry.capture.metadata)
      )
        continue;
      this.observer.unobserve(entry.element);
      entry.urls.forEach((url) => URL.revokeObjectURL(url));
      this.entries.delete(id);
    }
    for (const capture of captures) {
      if (this.entries.has(capture.id)) continue;
      const element = document.createElement("div");
      element.className = "capture-comparison";
      element.dataset.capture = capture.id;
      const original = document.createElement("figure");
      const label = document.createElement("figcaption");
      label.textContent = "Original · saved outline";
      const stage = document.createElement("span");
      stage.className = "saved-image";
      const image = document.createElement("img");
      image.alt = "Original photo with saved paper outline";
      image.onerror = () => {
        label.textContent = "Original could not load. Reload to retry.";
      };
      stage.append(image, edgeOverlay(capture));
      original.append(
        label,
        imageZoomButton(stage, "Zoom original photo", () =>
          inspectImage({
            title: "Inspect saved original",
            alt: "Full-resolution saved original receipt",
            image: `/api/files/${capture.id}/raw`,
            capture,
            download: {
              source: `/api/files/${capture.id}/raw`,
              label: "Download original",
            },
          }),
        ),
      );
      const output = document.createElement("figure");
      output.textContent = "PDF preview will load when visible.";
      element.append(original, output);
      this.entries.set(capture.id, {
        capture,
        element,
        output,
        original: image,
        state: "waiting",
        urls: [],
      });
      this.observer.observe(element);
    }
  }

  element(id: string) {
    return this.entries.get(id)!.element;
  }

  private async drain() {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const entry = [...this.entries.values()].find(
          (e) => e.state === "queued",
        );
        if (!entry) break;
        entry.state = "working";
        entry.output.textContent = "Preparing PDF preview…";
        try {
          const { blob } = await readOriginal(entry.capture.id);
          if (this.entries.get(entry.capture.id) !== entry) continue;
          const originalThumbnail = await thumbnail(blob);
          if (this.entries.get(entry.capture.id) !== entry) continue;
          entry.urls.forEach((url) => URL.revokeObjectURL(url));
          entry.urls = [URL.createObjectURL(originalThumbnail)];
          entry.original.src = entry.urls[0];
          this.worker ??= new Vision();
          const result = await this.worker.request(
            await createImageBitmap(blob),
            true,
            true,
          );
          if (this.entries.get(entry.capture.id) !== entry) continue;
          if (!result.quality.ok || !result.image || !result.pdf)
            throw new Error(result.quality.reason);
          const pageThumbnail = await thumbnail(result.image);
          if (this.entries.get(entry.capture.id) !== entry) continue;
          const imageUrl = URL.createObjectURL(pageThumbnail);
          const pdfUrl = URL.createObjectURL(result.pdf);
          entry.urls.push(imageUrl, pdfUrl);
          const label = document.createElement("figcaption");
          label.textContent = "PDF draft · recalculated from original";
          const image = document.createElement("img");
          image.alt = "Image used in the PDF draft";
          image.src = imageUrl;
          const download = document.createElement("a");
          download.textContent = "Download this PDF draft";
          download.href = pdfUrl;
          download.download = `capture-${entry.capture.id}-draft.pdf`;
          const note = document.createElement("p");
          note.textContent =
            "Check straightening and all paper edges. This preview is not saved to your library.";
          const fullImage = result.image;
          const fullPdf = result.pdf;
          const zoom = imageZoomButton(image, "Zoom PDF draft", () =>
            inspectImage({
              title: "Inspect PDF draft",
              alt: "Full-resolution image used in the PDF draft",
              image: fullImage,
              download: {
                source: fullPdf,
                label: "Download this PDF draft",
                filename: `capture-${entry.capture.id}-draft.pdf`,
              },
            }),
          );
          entry.output.replaceChildren(label, zoom, download, note);
          entry.state = "done";
        } catch (error) {
          if (this.entries.get(entry.capture.id) !== entry) continue;
          entry.output.textContent = `PDF preview unavailable: ${messageOf(error)}`;
          const retry = document.createElement("button");
          retry.className = "secondary";
          retry.textContent = "Retry PDF preview";
          retry.onclick = () => {
            entry.state = "queued";
            void this.drain();
          };
          entry.output.append(retry);
          entry.state = "done";
          this.worker?.close();
          this.worker = undefined;
        }
      }
    } finally {
      this.working = false;
    }
  }
}
