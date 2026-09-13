import { outlineOverlay } from "./paper-overlay";
import type { ScanState } from "./types";

/** Desktop-only geometry; never copies video pixels or runs image detection. */
export class PreviewOverlay {
  private svg = outlineOverlay([]);
  private media: HTMLVideoElement | HTMLCanvasElement | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private snapshot = "";
  private observer = new ResizeObserver(() => this.layout());

  constructor(private container: HTMLElement) {
    this.svg.id = "preview-overlay";
    this.svg.style.display = "none";
    container.append(this.svg);
    this.observer.observe(container);
  }

  update(state?: ScanState) {
    if (!state?.cameraConnected || !state.detectorReady || state.activeId) {
      this.clear();
      this.snapshot = "";
      return;
    }
    // Repeated HTTP snapshots must not keep a stopped detector's outline alive.
    const snapshot = `${state.cameraId}:${state.stateRevision}`;
    if (state.stateRevision !== undefined && snapshot === this.snapshot) return;
    this.snapshot = snapshot;
    clearTimeout(this.expiry);
    const quality = state.quality;
    const outlines =
      quality.quad?.length === 4
        ? [{ points: quality.quad, colour: quality.ok ? "#57e0a5" : "#ffbc54" }]
        : [];
    outlines.push(
      ...quality.hands.map((points) => ({ points, colour: "#ff6f7e" })),
    );
    this.svg.replaceChildren(...outlineOverlay(outlines, 3).children);
    this.layout();
    this.expiry = setTimeout(() => this.clear(), 2000);
  }

  setMedia(media: HTMLVideoElement | HTMLCanvasElement | null) {
    if (this.media !== media) {
      if (this.media) this.observer.unobserve(this.media);
      this.media = media;
      if (media) this.observer.observe(media);
    }
    this.layout();
  }

  private clear() {
    clearTimeout(this.expiry);
    this.svg.replaceChildren();
    this.svg.style.display = "none";
  }

  private layout() {
    const media = this.media;
    this.svg.style.display = "none";
    if (!media || media.hidden || !this.svg.childElementCount) return;
    const width =
      media instanceof HTMLVideoElement ? media.videoWidth : media.width;
    const height =
      media instanceof HTMLVideoElement ? media.videoHeight : media.height;
    if (!width || !height) return;
    const box = media.getBoundingClientRect();
    const container = this.container.getBoundingClientRect();
    // Match the actual image inside object-fit: contain, including letterboxing.
    const scale = Math.min(box.width / width, box.height / height);
    this.svg.style.width = `${width * scale}px`;
    this.svg.style.height = `${height * scale}px`;
    this.svg.style.left = `${box.left - container.left - this.container.clientLeft + (box.width - width * scale) / 2}px`;
    this.svg.style.top = `${box.top - container.top - this.container.clientTop + (box.height - height * scale) / 2}px`;
    this.svg.style.display = "block";
  }
}
