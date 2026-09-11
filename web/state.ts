import type { Quality, ScanState } from "./types";
export class CaptureState {
  value: ScanState = {
    type: "state",
    phase: "red",
    message: "Camera ready. Choose Start scanning on your computer.",
    paused: true,
    activeId: null,
    lastSaved: null,
    armed: true,
    cameraConnected: true,
    streamFresh: true,
    detectorReady: false,
    count: 0,
    quality: {
      ok: false,
      quad: null,
      hands: [],
      reason: "Loading image checks.",
    },
  };
  private stable = 0;
  private frames = 0;
  private absent = 0;
  private previous: number[][] | null = null;
  private latched = false;
  private reset() {
    this.stable = 0;
    this.frames = 0;
    this.previous = null;
  }
  control(action: string) {
    if (this.value.activeId) return;
    this.reset();
    if (action === "pause") {
      this.value.paused = true;
      this.value.phase = "red";
      this.value.message = "Paused.";
    }
    if (action === "start" || action === "retry") {
      this.value.needsAttention = false;
      this.value.paused = false;
      this.latched = false;
      if (action === "retry") this.value.armed = true;
      this.value.phase = "red";
      this.value.message = "Place one receipt on the dark background.";
    }
  }
  observe(q: Quality, now: number): string | null {
    this.value.quality = q;
    if (this.value.activeId || this.value.paused || this.latched) return null;
    if (!this.value.armed) {
      if (q.empty) {
        this.absent ||= now;
        if (now - this.absent >= 450) {
          this.value.armed = true;
          this.reset();
          this.value.phase = "red";
          this.value.message = "Ready for the next receipt.";
        }
      } else this.absent = 0;
      return null;
    }
    if (!q.ok || !q.quad) {
      this.reset();
      this.value.phase = "red";
      this.value.message = q.reason;
      return null;
    }
    const changed =
      !this.previous ||
      q.quad.some((p, i) =>
        p.some((v, j) => Math.abs(v - this.previous![i][j]) > 0.012),
      );
    if (changed || (q.motion ?? 0) > 3.5) {
      this.stable = now;
      this.frames = 0;
    }
    this.previous = q.quad;
    this.frames++;
    this.value.phase = "amber";
    this.value.message = "Hold still—checking the receipt.";
    if (now - this.stable >= 900 && this.frames >= 4) {
      this.value.activeId = crypto.randomUUID();
      this.value.message = "Capturing and saving—do not move the receipt.";
      return this.value.activeId;
    }
    return null;
  }
  saved(id: string) {
    this.value.needsAttention = false;
    this.value.activeId = null;
    this.value.lastSaved = id;
    this.value.armed = false;
    this.absent = 0;
    this.latched = false;
    this.value.phase = "green";
    this.value.message = "Saved privately. Remove the receipt, then next.";
    this.reset();
  }
  failed(message: string) {
    this.value.needsAttention = true;
    this.value.activeId = null;
    this.latched = true;
    this.value.phase = "red";
    this.value.message = message;
    this.reset();
  }

  interrupt() {
    // Re-establish stability and continuous paper removal after a connection gap.
    // Keep saved/failed captures and the removal latch intact.
    this.absent = 0;
    this.reset();
  }
}
