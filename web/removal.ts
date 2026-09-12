import type { Quality } from "./types";

/** Confirm observed removal, never infer it from motion or elapsed blind time. */
export class RemovalEvidence {
  private since: number | undefined;
  private strongSince: number | undefined;
  private last: number | undefined;

  reset() {
    this.since = this.strongSince = this.last = undefined;
  }

  observe(q: Quality, now: number): boolean {
    if (!q.empty || q.handsChecked !== true || q.hands.length) {
      this.reset();
      return false;
    }
    if (this.last !== undefined && (now <= this.last || now - this.last > 750))
      this.reset();
    // The fast path requires consecutive strong frames close together. Slower
    // devices and ambiguous backgrounds retain the 450ms confirmation.
    if (this.last !== undefined && now - this.last > 350)
      this.strongSince = undefined;
    this.since ??= now;
    this.strongSince = q.emptyStrong ? (this.strongSince ?? now) : undefined;
    this.last = now;
    return (
      (this.strongSince !== undefined && now - this.strongSince >= 150) ||
      now - this.since >= 450
    );
  }
}
