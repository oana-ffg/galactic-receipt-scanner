import { api } from "./api";
import { RequestError } from "./errors";
import { acknowledge, retainedCaptures, type PendingCapture } from "./pending";
import {
  assertAcknowledgement,
  expectedAcknowledgement,
  uploadCapture,
} from "./capture-upload";
import { diagnostics } from "./diagnostics";

import type { CaptureAcknowledgement, SaveRecoveryState } from "./types";

export class SaveRecovery {
  private active = false;
  private working = false;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = new Map<
    string,
    { attempts: number; next: number; blocked: boolean }
  >();
  constructor(
    private canRun: () => boolean,
    private changed: (state: SaveRecoveryState) => void,
    private verified: (id: string, count: number) => void,
  ) {}
  start(): void {
    this.active = true;
    this.wake();
  }
  stop(): void {
    this.active = false;
    clearTimeout(this.timer);
  }
  async refresh(): Promise<void> {
    // This inventory check also runs before green, independently of a slow
    // background request. New captures cannot outrun the recovery bound.
    try {
      this.report(await retainedCaptures());
    } catch {
      this.storageUnavailable();
    }
  }
  private storageUnavailable(): void {
    if (this.active)
      this.changed({
        pending: 0,
        bytes: 0,
        blocked: true,
        warning:
          "SCANNING ON HOLD: phone storage could not be checked. Keep this page open and report the issue. Do not clear this site's data.",
      });
  }
  wake(retryNow = false): void {
    if (retryNow)
      for (const failure of this.failures.values()) failure.next = 0;
    if (!this.active || this.working) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), 100);
  }
  private async check(capture: PendingCapture): Promise<void> {
    const expected = await expectedAcknowledgement(capture);
    assertAcknowledgement(capture.acknowledgement!, expected);
    const verify = () =>
      api<
        CaptureAcknowledgement & { verified: boolean; acceptedCount: number }
      >(`/api/captures/${capture.id}/verify`);
    let result;
    try {
      result = await verify();
    } catch (error) {
      if (!(error instanceof RequestError) || error.status !== 404) throw error;
      // Only missing data is repaired. Conflicting stored bytes or metadata are
      // preserved for investigation, never overwritten by a background retry.
      diagnostics.record("upload.recovery", { action: "resend" });
      assertAcknowledgement(
        await uploadCapture(capture),
        capture.acknowledgement!,
      );
      result = await verify();
    }
    assertAcknowledgement(result, capture.acknowledgement!);
    if (
      result.verified !== true ||
      !Number.isSafeInteger(result.acceptedCount) ||
      result.acceptedCount < 0
    )
      throw new Error("Saved photo readback was incomplete.");
    // Delete only after an independent readback of both metadata and original
    // bytes matches the exact source still stored in this IndexedDB record.
    await acknowledge(capture.id);
    this.failures.delete(capture.id);
    diagnostics.record("upload.recovery", { action: "verified" });
    if (this.active) this.verified(capture.id, result.acceptedCount);
  }
  private report(captures: PendingCapture[]): void {
    const waiting = captures.filter((capture) => capture.acknowledgement);
    const bytes = waiting.reduce((sum, capture) => sum + capture.blob.size, 0);
    const failed = waiting.some((capture) => this.failures.has(capture.id));
    const blocked =
      waiting.length >= 8 ||
      bytes >= 96 * 1024 * 1024 ||
      waiting.some((capture) => this.failures.get(capture.id)?.blocked);
    if (this.active)
      this.changed({
        pending: waiting.length,
        bytes,
        blocked,
        warning: blocked
          ? "SCANNING ON HOLD: saved-photo verification needs attention. Originals are retained on this phone. Keep this page open, check the connection and use Retry upload. If it persists, report the issue before clearing any site data."
          : failed
            ? "Saved-photo verification is delayed. The phone still holds the originals and is retrying automatically. Keep this page open."
            : undefined,
      });
  }
  private async run(): Promise<void> {
    if (!this.active || this.working) return;
    this.working = true;
    let remaining = false;
    try {
      const captures = await retainedCaptures();
      this.report(captures);
      for (const capture of captures) {
        if (!this.active || !this.canRun()) break;
        if (
          !capture.acknowledgement ||
          (this.failures.get(capture.id)?.next ?? 0) > Date.now()
        )
          continue;
        try {
          await this.check(capture);
        } catch (error) {
          const attempts = (this.failures.get(capture.id)?.attempts ?? 0) + 1;
          const status = error instanceof RequestError ? error.status : -1;
          this.failures.set(capture.id, {
            attempts,
            next:
              Date.now() +
              Math.min(30000, 2000 * 2 ** Math.min(attempts - 1, 4)),
            blocked:
              status === -1 ||
              (status >= 400 &&
                status < 500 &&
                status !== 408 &&
                status !== 429),
          });
          diagnostics.record("upload.recovery", {
            action: "retry",
            attempts,
            status,
          });
        }
      }
      const current = await retainedCaptures();
      this.report(current);
      remaining = current.some((capture) => capture.acknowledgement);
    } catch {
      remaining = true;
      this.storageUnavailable();
    } finally {
      this.working = false;
      if (this.active && remaining)
        this.timer = setTimeout(() => void this.run(), 1000);
    }
  }
}
