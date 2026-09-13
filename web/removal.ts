import type { Quality, ScanState } from "./types";

/** Confirm observed removal, never infer it from motion or elapsed blind time. */
export class RemovalEvidence {
  private since: number | undefined;
  private strongSince: number | undefined;
  private last: number | undefined;
  private started: number | undefined;
  private lastObserved: number | undefined;
  private samples = 0;
  private resets = 0;
  diagnostics?: ScanState["removalDiagnostics"];

  reset() {
    this.since = this.strongSince = this.last = undefined;
    this.started = undefined;
    this.lastObserved = undefined;
    this.samples = this.resets = 0;
    this.diagnostics = undefined;
  }

  private clearEvidence() {
    if (this.since !== undefined) this.resets++;
    this.since = this.strongSince = this.last = undefined;
  }

  observe(q: Quality, now: number): boolean {
    this.started ??= now;
    this.samples++;
    const gapMs =
      this.lastObserved === undefined ? undefined : now - this.lastObserved;
    this.lastObserved = now;
    const record = (
      gate: NonNullable<ScanState["removalDiagnostics"]>["gate"],
    ) => {
      this.diagnostics = {
        gate,
        gapMs,
        elapsedMs: now - this.started!,
        clearMs: this.since === undefined ? 0 : now - this.since,
        strongMs: this.strongSince === undefined ? 0 : now - this.strongSince,
        samples: this.samples,
        resets: this.resets,
      };
    };
    if (!q.empty || q.handsChecked !== true || q.hands.length) {
      this.clearEvidence();
      record(
        q.hands.length
          ? "hands-present"
          : !q.empty
            ? "not-empty"
            : "hands-unchecked",
      );
      return false;
    }
    if (this.last !== undefined && (now <= this.last || now - this.last > 750))
      this.clearEvidence();
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
