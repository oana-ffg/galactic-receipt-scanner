import { inspectImage } from "./image-viewer";
import { CapturePreviews } from "./capture-previews";
import { edgeOverlay } from "./paper-overlay";
import { api } from "./api";
import { messageOf } from "./errors";
import type { Capture, ScanState } from "./types";

type Page = { captures: Capture[]; next: string | null };
const rawUrl = (id: string) => `/api/files/${id}/raw`;

export class CaptureLibrary {
  private previews = new CapturePreviews();
  private before: (string | null)[] = [null];
  private next: string | null = null;
  private busy = false;
  private dirty = false;
  private generation = 0;
  private latest: Capture | undefined;
  private selected: Capture | undefined;
  private followLatest = true;
  private state: ScanState | undefined;
  private selectionGeneration = 0;
  private panel: HTMLElement;
  private list: HTMLElement;
  private previousButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private pageLabel: HTMLElement;
  constructor(private onRetake: (id: string) => Promise<void>) {
    this.panel = document.getElementById("saved-photo")!;
    this.list = document.getElementById("captures")!;
    this.previousButton = document.getElementById(
      "captures-previous",
    ) as HTMLButtonElement;
    this.nextButton = document.getElementById(
      "captures-next",
    ) as HTMLButtonElement;
    this.pageLabel = document.getElementById("captures-page")!;
    this.previousButton.onclick = () => {
      if (this.before.length > 1) {
        this.before.pop();
        this.generation++;
        void this.refresh();
      }
    };
    this.nextButton.onclick = () => {
      if (this.next) {
        this.before.push(this.next);
        this.generation++;
        void this.refresh();
      }
    };
  }
  updateState(state: ScanState) {
    this.state = state;
    this.list
      .querySelectorAll<HTMLButtonElement>("[data-retake]")
      .forEach((button) => {
        button.disabled =
          !state.supportsTargetedRetake ||
          !state.cameraConnected ||
          !state.detectorReady ||
          Boolean(state.activeId) ||
          state.recovery === "upload";
        button.title = !state.supportsTargetedRetake
          ? "Reload the phone camera page to enable targeted retakes."
          : "Retake this same physical receipt; previous takes stay intact.";
      });
  }
  async refresh(): Promise<void> {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    const generation = this.generation;
    this.previousButton.disabled = this.nextButton.disabled = true;
    try {
      const cursor = this.before.at(-1);
      const path = `/api/captures?limit=10${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`;
      const [page, latestPage] = await Promise.all([
        api<Page>(path),
        cursor ? api<Page>("/api/captures?limit=1") : Promise.resolve(null),
      ]);
      if (generation !== this.generation) {
        this.dirty = true;
        return;
      }
      this.latest = (latestPage ?? page).captures[0];
      if (this.latest?.retake_of === this.selected?.id && this.latest)
        this.followLatest = true;
      if (
        this.followLatest &&
        this.latest &&
        this.latest.id !== this.selected?.id
      )
        void this.show(this.latest);
      this.next = page.next;
      this.previews.setPage(page.captures);
      this.list.replaceChildren();
      if (!page.captures.length)
        this.list.textContent =
          this.before.length === 1
            ? "No captures yet."
            : "No captures on this page.";
      for (const capture of page.captures) this.list.append(this.row(capture));
      if (this.state) this.updateState(this.state);
      this.pageLabel.textContent = `Page ${this.before.length} · up to 10 captures`;
    } catch (error) {
      this.pageLabel.textContent = messageOf(error);
    } finally {
      this.busy = false;
      this.previousButton.disabled = this.before.length === 1;
      this.nextButton.disabled = !this.next;
      if (this.dirty) {
        this.dirty = false;
        void this.refresh();
      }
    }
  }
  private row(capture: Capture): HTMLElement {
    const row = document.createElement("article");
    row.className = "capture-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    const label =
      capture.status === "accepted"
        ? capture.is_current
          ? "Saved · Current take"
          : "Previous take · Not counted"
        : capture.status === "manual-review"
          ? "Saved for review · Quality overridden"
          : capture.status === "rejected"
            ? capture.current_capture_id
              ? "Rejected take · Not counted"
              : "Retake needed"
            : "Interrupted check";
    title.textContent = `${new Date(capture.created_at).toLocaleTimeString()} · ${label}`;
    const identity = document.createElement("p");
    identity.textContent = `Receipt ${capture.receipt_id.slice(0, 8)} · ${capture.retake_of ? "Retake" : "Take"} ${capture.take_number}`;
    identity.title = `Receipt ${capture.receipt_id}${capture.retake_of ? ` · Retake of ${capture.retake_of}` : ""}`;
    const detail = document.createElement("p");
    detail.textContent =
      capture.status === "accepted"
        ? `${capture.metadata.sourcePixels?.join(" × ") ?? ""} source · ${capture.outputs.pdf ? "PDF ready" : "PDF later"} · OCR ${capture.ocr_status}`
        : (capture.metadata.quality?.reason ??
          "Original retained. Retry this receipt.");
    info.append(title, identity, detail);
    const links = document.createElement("div");
    links.className = "file-links";
    const retake = document.createElement("button");
    retake.className = "secondary";
    retake.dataset.retake = capture.id;
    retake.textContent = "Retake";
    retake.disabled = true;
    retake.onclick = async () => {
      retake.disabled = true;
      try {
        await this.onRetake(capture.id);
        this.followLatest = false;
        await this.show(capture);
        this.panel.scrollIntoView({ block: "nearest" });
      } catch (error) {
        this.pageLabel.textContent = messageOf(error);
      } finally {
        if (this.state) this.updateState(this.state);
      }
    };
    links.append(retake);
    for (const [kind, label] of [
      ...(capture.outputs.image ? [["image", "Crop"]] : []),
      ...(capture.outputs.pdf ? [["pdf", "PDF"]] : []),
      ...(capture.ocr_status === "unverified" ? [["ocr", "Extraction"]] : []),
    ]) {
      const link = document.createElement("a");
      link.textContent = label;
      link.href = `/api/files/${capture.id}/${kind}`;
      links.append(link);
    }
    const heading = document.createElement("div");
    heading.className = "capture-heading";
    heading.append(info, links);
    row.append(heading, this.previews.element(capture.id));
    return row;
  }
  private async show(capture: Capture) {
    this.selected = capture;
    const generation = ++this.selectionGeneration;
    this.panel.replaceChildren();
    const title = document.createElement("h2");
    title.textContent = this.followLatest
      ? "Last photo saved"
      : "Selected photo";
    const details = document.createElement("p");
    details.textContent = `${new Date(capture.created_at).toLocaleTimeString()} · ${capture.metadata.sourcePixels?.join(" × ") ?? ""} · ${capture.status === "accepted" ? "Saved" : "Needs attention"}`;
    const stage = document.createElement("div");
    stage.className = "saved-image";
    const img = document.createElement("img");
    img.alt = "Saved original receipt";
    img.src = rawUrl(capture.id);
    const svg = edgeOverlay(capture);
    stage.append(img, svg);
    const controls = document.createElement("div");
    controls.className = "controls saved-controls";
    const zoom = document.createElement("button");
    zoom.textContent = "Inspect full size";
    zoom.className = "secondary";
    zoom.disabled = true;
    zoom.onclick = () =>
      inspectImage({
        title: "Inspect saved original",
        alt: "Full-resolution saved original receipt",
        image: rawUrl(capture.id),
        capture,
        download: { source: rawUrl(capture.id), label: "Download original" },
      });
    const edges = document.createElement("label");
    edges.className = "toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.onchange = () => {
      svg.style.visibility = checkbox.checked ? "visible" : "hidden";
    };
    edges.append(checkbox, "Detected edges");
    controls.append(zoom, edges);
    if (!this.followLatest) {
      const latest = document.createElement("button");
      latest.className = "secondary";
      latest.textContent = "Show latest";
      latest.onclick = () => {
        this.followLatest = true;
        if (this.latest) void this.show(this.latest);
      };
      controls.append(latest);
    }
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = capture.metadata.quality?.quad
      ? "Outline from this saved photo. Original pixels stay intact."
      : "No paper outline was recorded for this photo.";
    this.panel.append(title, details, stage, controls, note);
    try {
      await img.decode();
      if (generation === this.selectionGeneration) zoom.disabled = false;
    } catch {
      if (generation === this.selectionGeneration) {
        stage.remove();
        note.textContent = "Could not load this original. Reload to retry.";
      }
    }
  }
}
