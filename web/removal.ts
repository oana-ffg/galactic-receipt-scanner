import type { Quality, ScanState, RemovalTransition } from "./types";

/** Confirm observed removal, never infer it from motion or elapsed blind time. */
export class RemovalEvidence {
  private since: number | undefined;
  private strongSince: number | undefined;
  private last: number | undefined;
  private bridged = false;
  private uncertain = false;
  private started: number | undefined;
  private lastObserved: number | undefined;
  private samples = 0;
  private resets = 0;
  private epoch = 0;
  private maxClearMs = 0;
  private emptySamples = 0;
  private minBrightness?: number;
  private minCoverage?: number;
  private noOutlineSince?: number;
  private maxNoOutlineMs = 0;
  private resetReason?: string;
  private resetClearMs?: number;
  private transitions: RemovalTransition[] = [];
  private transitionKey = "";
  diagnostics?: ScanState["removalDiagnostics"];

  reset() {
    this.epoch++;
    this.since = this.strongSince = this.last = undefined;
    this.bridged = this.uncertain = false;
    this.started = undefined;
    this.lastObserved = undefined;
    this.samples =
      this.resets =
      this.maxClearMs =
      this.emptySamples =
      this.maxNoOutlineMs =
        0;
    this.minBrightness =
      this.minCoverage =
      this.noOutlineSince =
      this.resetClearMs =
        undefined;
    this.resetReason = undefined;
    this.transitions = [];
    this.transitionKey = "";
    this.diagnostics = undefined;
  }

  private clearEvidence(reason: string) {
    if (this.since !== undefined) {
      this.resets++;
      this.resetReason = reason;
      // Only the last qualifying observation counts, never the blind gap.
      this.resetClearMs = (this.last ?? this.since) - this.since;
    }
    this.since = this.strongSince = this.last = undefined;
    this.bridged = this.uncertain = false;
  }

  observe(q: Quality, now: number): boolean {
    this.started ??= now;
    this.samples++;
    const gapMs =
      this.lastObserved === undefined ? undefined : now - this.lastObserved;
    this.lastObserved = now;
    if (q.empty) this.emptySamples++;
    const brightness = q.removalDiagnostics?.areaBrightness;
    const coverage = q.removalDiagnostics?.coverage;
    if (brightness !== undefined)
      this.minBrightness = Math.min(
        this.minBrightness ?? brightness,
        brightness,
      );
    if (coverage !== undefined)
      this.minCoverage = Math.min(this.minCoverage ?? coverage, coverage);
    if (!q.quad) {
      if (gapMs === undefined || gapMs > 750 || gapMs <= 0)
        this.noOutlineSince = now;
      this.noOutlineSince ??= now;
      this.maxNoOutlineMs = Math.max(
        this.maxNoOutlineMs,
        now - this.noOutlineSince,
      );
    } else this.noOutlineSince = undefined;
    const record = (
      gate: NonNullable<ScanState["removalDiagnostics"]>["gate"],
    ) => {
      const clearMs =
        this.since === undefined ? 0 : (this.last ?? this.since) - this.since;
      this.maxClearMs = Math.max(this.maxClearMs, clearMs);
      const key = `${gate}:${q.removalDiagnostics?.geometry}:${this.resets}`;
      if (key !== this.transitionKey) {
        this.transitionKey = key;
        this.transitions.push({
          sample: this.samples,
          elapsedMs: now - this.started!,
          gate,
          geometry: q.removalDiagnostics?.geometry,
          coverage,
          brightness,
          clearMs,
          resetReason: this.resetReason,
          resetClearMs: this.resetClearMs,
        });
        if (this.transitions.length > 8) this.transitions.shift();
      }
      this.diagnostics = {
        epoch: this.epoch,
        transitions: [...this.transitions],
        maxClearMs: this.maxClearMs,
        emptySamples: this.emptySamples,
        minBrightness: this.minBrightness,
        minCoverage: this.minCoverage,
        maxNoOutlineMs: this.maxNoOutlineMs,
        resetReason: this.resetReason,
        resetClearMs: this.resetClearMs,
        gate,
        gapMs,
        elapsedMs: now - this.started!,
        clearMs,
        strongMs: this.strongSince === undefined ? 0 : now - this.strongSince,
        samples: this.samples,
        resets: this.resets,
      };
    };
    // One near-cutoff sample may interrupt an already established clear run.
    // It cannot start or complete removal, extend freshness, or use the fast path.
    if (
      !q.empty &&
      q.emptyUncertain &&
      !q.quad &&
      q.handsChecked === true &&
      !q.hands.length &&
      !this.bridged &&
      this.since !== undefined &&
      this.last !== undefined &&
      this.last - this.since >= 150 &&
      now > this.last &&
      now - this.last <= 350
    ) {
      this.bridged = this.uncertain = true;
      this.strongSince = undefined;
      record("uncertain");
      return false;
    }
    if (!q.empty || q.handsChecked !== true || q.hands.length) {
      this.clearEvidence(
        q.hands.length
          ? "hands-present"
          : !q.empty
            ? "not-empty"
            : "hands-unchecked",
      );
      record(
        q.hands.length
          ? "hands-present"
          : !q.empty
            ? "not-empty"
            : "hands-unchecked",
      );
      return false;
    }
    if (this.uncertain && this.last !== undefined) {
      if (gapMs !== undefined && gapMs <= 0)
        this.clearEvidence("nonmonotonic-frame");
      else if (now - this.last > 350) this.clearEvidence("frame-gap");
    }
    this.uncertain = false;
    if (this.last !== undefined && (now <= this.last || now - this.last > 750))
      this.clearEvidence(now <= this.last ? "nonmonotonic-frame" : "frame-gap");
    // The fast path requires consecutive strong frames close together. Slower
    // devices and ambiguous backgrounds retain the 450ms confirmation.
    if (this.last !== undefined && now - this.last > 350)
      this.strongSince = undefined;
    this.since ??= now;
    this.strongSince = q.emptyStrong ? (this.strongSince ?? now) : undefined;
    this.last = now;
    const removed =
      (this.strongSince !== undefined && now - this.strongSince >= 150) ||
      now - this.since >= 450;
    record(removed ? "removed" : "confirming");
    return removed;
  }
}
