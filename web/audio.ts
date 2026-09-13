import { audioDiagnostics } from "./diagnostics";

type Cause =
  | "startup"
  | "gesture"
  | "focus"
  | "visible"
  | "device-change"
  | "toggle"
  | "saved"
  | "rejected"
  | "test";
// Explicit tests may wait for device startup; saved alerts must remain timely.
const deadlineMs = (cause: Cause) => (cause === "test" ? 5000 : 1200);

type Fields = Record<string, string | number | boolean | null | undefined>;

/** Dashboard feedback only. Audio failure must never delay or break saved-state rendering. */
export class ScannerAudio {
  private context: AudioContext | null = null;
  private generation = 0;
  private sequence = 0;
  private missedAlert = "";
  private active = new Set<() => void>();

  constructor(
    private enabled: boolean,
    private warning: (message: string) => void,
    private create = () => new AudioContext(),
  ) {
    this.status();
  }

  private record(action: string, fields: Fields = {}) {
    const context = this.context;
    audioDiagnostics.record("audio", {
      action,
      enabled: this.enabled,
      state: context?.state ?? "uninitialized",
      contextTime: context?.currentTime,
      baseLatency: context?.baseLatency,
      outputLatency: context?.outputLatency,
      visibility: document.visibilityState,
      ...fields,
    });
  }

  private status() {
    this.warning(
      !this.enabled
        ? ""
        : this.missedAlert ||
            (this.context?.state === "running"
              ? ""
              : "Audio is not ready. Click Test audio to enable it; keep watching the saved indicator."),
    );
  }

  private failed(message: string) {
    this.missedAlert = message;
    this.status();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.generation++;
    for (const cancel of this.active) cancel();
    this.record("toggle");
    this.status();
    if (enabled) void this.recover("toggle");
  }

  async recover(cause: Cause): Promise<boolean> {
    if (["focus", "visible", "device-change"].includes(cause))
      this.record("recovery-check", { cause });
    if (!this.enabled) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.context || this.context.state === "closed") {
        this.context = this.create();
        const context = this.context;
        context.onstatechange = () => {
          if (this.context !== context) return;
          this.record("state-change");
          this.status();
        };
        this.record("initialized", { cause });
      }
      const context = this.context;
      if (context.state !== "running") {
        this.record("resume-request", { cause });
        // Autoplay-blocked resume() can stay pending until a later user gesture.
        // Bound each attempt, and never schedule a delayed saved acknowledgement.
        await Promise.race([
          context.resume(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new DOMException("", "TimeoutError")),
              deadlineMs(cause),
            );
          }),
        ]);
        this.record("resume-result", { cause });
      }
      this.status();
      return (
        this.enabled && context === this.context && context.state === "running"
      );
    } catch (error) {
      this.record("recovery-failed", {
        cause,
        error: error instanceof Error ? error.name : "unknown",
      });
      this.status();
      return false;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async play(
    success: boolean,
    cause: "saved" | "rejected" | "test",
    revision?: number,
  ) {
    const sequence = ++this.sequence;
    const generation = this.generation;
    const requestedAt = performance.now();
    this.record("requested", { sequence, cause, revision, success });
    if (!this.enabled) {
      this.record("skipped", { sequence, reason: "disabled" });
      return;
    }
    const ready = await this.recover(cause);
    const reason =
      generation !== this.generation
        ? "superseded"
        : performance.now() - requestedAt >= deadlineMs(cause)
          ? "expired"
          : !ready
            ? "not-ready"
            : null;
    if (reason) {
      this.record("skipped", {
        sequence,
        reason,
        waitMs: performance.now() - requestedAt,
      });
      if (reason !== "superseded" && this.enabled)
        this.failed(
          "Audio missed this alert. Click Test audio to verify sound; check the saved indicator.",
        );
      return;
    }
    const context = this.context!;
    const nodes: { oscillator: OscillatorNode; gain: GainNode }[] = [];
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      for (const { oscillator, gain } of nodes) {
        oscillator.onended = null;
        try {
          oscillator.stop();
        } catch {
          /* Already stopped. */
        }
        oscillator.disconnect();
        gain.disconnect();
      }
      this.active.delete(cancel);
    };
    const cancel = () => {
      this.record("cancelled", { sequence });
      cleanup();
    };
    this.active.add(cancel);
    const start = context.currentTime + 0.02;
    const count = success ? 1 : 3;
    let ended = 0;
    try {
      for (let i = 0; i < count; i++) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        nodes.push({ oscillator, gain });
        const at = start + i * 0.3;
        oscillator.type = success ? "sine" : "sawtooth";
        oscillator.frequency.setValueAtTime(success ? 880 : 180, at);
        if (!success)
          oscillator.frequency.exponentialRampToValueAtTime(80, at + 0.22);
        gain.gain.setValueAtTime(0.001, at);
        gain.gain.linearRampToValueAtTime(success ? 0.12 : 0.09, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          if (++ended !== count) return;
          this.missedAlert = "";
          this.status();
          this.record("ended", {
            sequence,
            elapsedMs: performance.now() - requestedAt,
            advancedSeconds: context.currentTime - start,
          });
          cleanup();
        };
        oscillator.start(at);
        oscillator.stop(at + 0.24);
      }
      this.record("scheduled", {
        sequence,
        start,
        count,
        waitMs: performance.now() - requestedAt,
      });
      watchdog = setTimeout(() => {
        this.record("playback-timeout", {
          sequence,
          advancedSeconds: context.currentTime - start,
        });
        cleanup();
        this.failed(
          "Audio playback did not finish. Click Test audio and check your sound output; keep watching the saved indicator.",
        );
      }, 1800);
    } catch (error) {
      this.record("playback-failed", {
        sequence,
        error: error instanceof Error ? error.name : "unknown",
      });
      cleanup();
      this.failed(
        "Audio could not play. Click Test audio and check your sound output; keep watching the saved indicator.",
      );
    }
  }
}
