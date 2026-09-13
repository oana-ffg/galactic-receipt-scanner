// Monotonic epoch timestamps remain comparable after estimating remote offset.
export const clockNow = () => performance.timeOrigin + performance.now();
export class DeliveryClock {
  private sample?: { offset: number; uncertainty: number; at: number };
  observe(
    sent: number,
    remoteReceived: number,
    remoteSent: number,
    received: number,
  ) {
    if (
      ![sent, remoteReceived, remoteSent, received].every(Number.isFinite) ||
      received < sent ||
      remoteSent < remoteReceived
    )
      return;
    const uncertainty = (received - sent - (remoteSent - remoteReceived)) / 2;
    if (uncertainty < 0 || uncertainty > 5000) return;
    if (
      this.sample &&
      received - this.sample.at < 30000 &&
      uncertainty > this.sample.uncertainty
    )
      return;
    this.sample = {
      offset: (remoteReceived - sent + (remoteSent - received)) / 2,
      uncertainty,
      at: received,
    };
  }
  age(remoteAt: number | undefined, received = clockNow()) {
    const sample = this.sample;
    if (!sample || received - sample.at > 30000 || !Number.isFinite(remoteAt))
      return { clockSynced: false };
    return {
      clockSynced: true,
      ageEstimateMs: received - remoteAt! + sample.offset,
      clockUncertaintyMs: sample.uncertainty,
      clockSampleAgeMs: received - sample.at,
    };
  }
}
