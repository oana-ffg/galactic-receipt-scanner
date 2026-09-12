import type { Quality, ScanState } from "./types";
import { retakeTarget } from "./control-command";
import type { PreviewChecks } from "./hand-checks";
import { RemovalEvidence } from "./removal";
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
    supportsTargetedRetake: true,
    supportsForce: true,
    supportsBackground: true,
    selectedRetake: false,
    armed: true,
    cameraConnected: true,
    streamFresh: true,
    detectorReady: false,
    count: 0,
    countKnown: false,
    quality: {
      ok: false,
      quad: null,
      hands: [],
      reason: "Loading image checks.",
    },
  };
  private stable = 0;
  private frames = 0;
  private removal = new RemovalEvidence();
  private feedback: {
    phase: "red" | "amber";
    message: string;
    since: number;
  } | null = null;
  private latched = false;
  get previewChecks(): PreviewChecks {
    return {
      capture:
        !this.value.paused &&
        !this.latched &&
        this.value.armed &&
        !this.value.activeId,
      removal:
        !this.value.manualReview &&
        Boolean(this.value.lastCapture || !this.value.armed),
    };
  }
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
    const afterManual = this.value.manualReview === true;
    this.value.manualReview = false;
    if (action === "start" && afterManual) {
      this.value.lastCapture = null;
      this.value.retakeOf = null;
      this.value.armed = true;
    }
    const target =
      retakeTarget(action) ??
      (action === "retry" && afterManual ? this.value.lastCapture : null);
    if (target || action === "cancel-retake") {
      if (this.value.recovery === "upload") return;
      this.reset();
      this.removal.reset();
      this.latched = false;
      this.value.lastCapture = null;
      this.value.retakeOf = target;
      this.value.selectedRetake = Boolean(target);
      this.value.armed = true;
      this.value.paused = true;
      this.value.recovery = undefined;
      this.value.needsAttention = false;
      this.value.phase = "red";
      this.value.message = target
        ? "Retake selected. Place that same receipt under the camera, then choose Start scanning."
        : "Retake cancelled. Choose Start scanning for a new receipt.";
      return;
    }
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
  force(): string | null {
    if (
      this.value.activeId ||
      this.value.recovery === "upload" ||
      !this.value.cameraConnected ||
      !this.value.detectorReady
    )
      return null;
    this.reset();
    this.feedback = null;
    this.value.retakeOf ??= this.value.lastCapture;
    this.value.activeId = crypto.randomUUID();
    this.value.manualReview = false;
    this.value.needsAttention = false;
    this.value.phase = "amber";
    this.value.message = "Taking a photo for manual review…";
    return this.value.activeId;
  }
  observe(q: Quality, now: number): string | null {
    this.value.quality = q;
    if (this.value.activeId) return null;
    // Removal also clears retake intent while paused or waiting after a failed check.
    // A later receipt must never inherit the previous receipt's identity.
    if (
      !this.value.manualReview &&
      (this.value.lastCapture || !this.value.armed)
    ) {
      if (this.removal.observe(q, now)) {
        this.value.lastCapture = null;
        if (!this.value.paused) this.value.manualReview = false;
        this.value.retakeOf = null;
        this.value.armed = true;
        this.reset();
        if (!this.latched && !this.value.paused) {
          this.value.phase = "red";
          this.value.message = "Ready for the next receipt.";
        }
        this.removal.reset();
      }
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
    if (
      (!q.ok && !q.candidateReady) ||
      q.hands.length ||
      !q.quad ||
      (q.motion ?? 0) > 3.5
    ) {
      this.reset();
      this.showFeedback("red", q.reason, now);
      return null;
    }
    // The worker compares aligned paper content. Handheld translation must not
    // reset stability merely because the same sharp paper moved in the frame.
    if (this.frames === 0) this.stable = now;
    this.frames++;
    this.showFeedback("amber", "Checking image stability…", now);
    if (
      now - this.stable >= 900 &&
      this.frames >= 4 &&
      q.ok &&
      q.handsChecked === true
    ) {
      this.value.phase = "amber";
      this.value.activeId = crypto.randomUUID();
      this.value.message = "Taking the photo…";
      return this.value.activeId;
    }
    return null;
  }
  saved(id: string, count?: number, manual = false) {
    this.feedback = null;
    if (count !== undefined) this.value.count = count;
    else if (this.value.lastSaved !== id) this.value.count++;
    this.value.countKnown = true;
    this.value.stage = undefined;
    this.value.needsAttention = false;
    this.value.activeId = null;
    this.value.lastSaved = id;
    this.value.lastCapture = id;
    this.value.retakeOf = null;
    this.value.selectedRetake = false;
    this.value.recovery = undefined;
    this.value.armed = false;
    this.removal.reset();
    this.latched = false;
    this.value.manualReview = manual;
    if (manual) this.value.paused = true;
    this.value.phase = manual ? "amber" : "green";
    this.value.message = manual
      ? "Saved for review. Force take again to retake this receipt, or replace it and choose Start scanning for the next."
      : "Saved privately. Remove the receipt, then next.";
    this.reset();
  }
  failed(message: string, recovery?: "retake" | "upload", retainedId?: string) {
    if (retainedId) {
      this.value.lastCapture = retainedId;
      this.value.retakeOf = null;
      this.value.armed = false;
      this.removal.reset();
    }
    this.value.selectedRetake = Boolean(this.value.retakeOf);
    this.value.manualReview = false;
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
    this.removal.reset();
    this.reset();
  }
}
