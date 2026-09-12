import type { Quality, ScanState } from "./types";
export class CaptureState {
  value: ScanState = {
    type: "state",
    phase: "red",
    message: "Camera ready. Choose Start scanning on your computer.",
    paused: true,
    activeId: null,
    lastSaved: null,
    lastCapture: null,
    retakeOf: null,
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
  private feedback: {
    phase: "red" | "amber";
    message: string;
    since: number;
  } | null = null;
  private latched = false;
  private reset() {
    this.stable = 0;
    this.frames = 0;
  }
  private showFeedback(phase: "red" | "amber", message: string, now: number) {
    if (this.feedback?.phase !== phase || this.feedback.message !== message)
      this.feedback = { phase, message, since: now };
    if (now - this.feedback.since >= 250) {
      this.value.phase = phase;
      this.value.message = message;
    }
  }
  control(action: string) {
    this.feedback = null;
    if (this.value.activeId) return;
    if (
      (action === "start" || action === "retry") &&
      this.value.recovery === "upload"
    )
      return;
    if (
      action === "retry" &&
      !this.value.lastCapture &&
      this.value.recovery !== "retake"
    )
      return;
    this.reset();
    if (action === "pause") {
      this.value.paused = true;
      this.value.phase = "red";
      this.value.message = "Paused.";
    }
    if (action === "start" || action === "retry") {
      this.value.needsAttention = false;
      this.value.recovery = undefined;
      this.value.paused = false;
      this.latched = false;
      if (action === "retry") {
        this.value.retakeOf = this.value.lastCapture;
        this.value.armed = true;
      }
      this.value.phase = "red";
      this.value.message = this.value.retakeOf
        ? "Retaking the same receipt. Keep it in view and hold steady."
        : "Place one receipt on the dark background.";
    }
  }
  observe(q: Quality, now: number): string | null {
    this.value.quality = q;
    if (this.value.activeId) return null;
    // Removal also clears retake intent while paused or waiting after a failed check.
    // A later receipt must never inherit the previous receipt's identity.
    if (this.value.lastCapture || !this.value.armed) {
      if (q.empty && !q.hands.length) {
        this.absent ||= now;
        if (now - this.absent >= 450) {
          this.value.lastCapture = null;
          this.value.retakeOf = null;
          this.value.armed = true;
          this.reset();
          if (!this.latched && !this.value.paused) {
            this.value.phase = "red";
            this.value.message = "Ready for the next receipt.";
          }
        }
      } else this.absent = 0;
    }
    if (this.value.paused || this.latched || !this.value.armed) return null;
    if (q.empty && !q.hands.length) {
      this.reset();
      this.feedback = null;
      this.value.phase = "red";
      this.value.message = this.value.lastSaved
        ? "Ready for the next receipt."
        : q.reason;
      return null;
    }
    if (!q.ok || !q.quad || (q.motion ?? 0) > 3.5) {
      this.reset();
      this.showFeedback("red", q.reason, now);
      return null;
    }
    // The worker compares aligned paper content. Handheld translation must not
    // reset stability merely because the same sharp paper moved in the frame.
    if (this.frames === 0) this.stable = now;
    this.frames++;
    this.showFeedback("amber", "Checking image stability…", now);
    if (now - this.stable >= 900 && this.frames >= 4) {
      this.value.phase = "amber";
      this.value.activeId = crypto.randomUUID();
      this.value.message = "Taking the photo…";
      return this.value.activeId;
    }
    return null;
  }
  saved(id: string, count?: number) {
    this.feedback = null;
    if (count !== undefined) this.value.count = count;
    else if (this.value.lastSaved !== id) this.value.count++;
    this.value.stage = undefined;
    this.value.needsAttention = false;
    this.value.activeId = null;
    this.value.lastSaved = id;
    this.value.lastCapture = id;
    this.value.retakeOf = null;
    this.value.recovery = undefined;
    this.value.armed = false;
    this.absent = 0;
    this.latched = false;
    this.value.phase = "green";
    this.value.message = "Saved privately. Remove the receipt, then next.";
    this.reset();
  }
  failed(message: string, recovery?: "retake" | "upload", retainedId?: string) {
    if (retainedId) {
      this.value.lastCapture = retainedId;
      this.value.retakeOf = null;
      this.value.armed = false;
      this.absent = 0;
    }
    this.value.recovery = recovery;
    this.feedback = null;
    this.value.stage = undefined;
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
