/** Sample cumulative counters without confusing resets with negative throughput. */
export class MediaRate {
  private previous: { at: number; count: number } | undefined;
  sample(count: number | undefined, at: number): number | undefined {
    if (count === undefined || !Number.isFinite(count) || count < 0) {
      this.previous = undefined;
      return undefined;
    }
    const previous = this.previous;
    this.previous = { at, count };
    if (!previous || at <= previous.at || count < previous.count)
      return undefined;
    return ((count - previous.count) * 1000) / (at - previous.at);
  }
}

// Explicit fields only: settings also contain persistent device/group IDs.
export function cameraSettings(track: MediaStreamTrack) {
  const settings = track.getSettings();
  const capabilities = track.getCapabilities?.();
  return {
    width: settings.width,
    height: settings.height,
    fps: settings.frameRate,
    facingMode: settings.facingMode,
    readyState: track.readyState,
    muted: track.muted,
    minWidth: capabilities?.width?.min,
    maxWidth: capabilities?.width?.max,
    minHeight: capabilities?.height?.min,
    maxHeight: capabilities?.height?.max,
    minFps: capabilities?.frameRate?.min,
    maxFps: capabilities?.frameRate?.max,
  };
}

export class RtpTelemetry {
  private streams = new Map<
    string,
    { frames: MediaRate; bytes: MediaRate; encode: MediaRate }
  >();
  sample(report: RTCStatsReport) {
    const result = [];
    const current = new Set<string>();
    for (const stats of report.values()) {
      if (
        !["inbound-rtp", "outbound-rtp"].includes(stats.type) ||
        (stats.kind ?? stats.mediaType) !== "video"
      )
        continue;
      current.add(stats.id);
      let rates = this.streams.get(stats.id);
      if (!rates) {
        rates = {
          frames: new MediaRate(),
          bytes: new MediaRate(),
          encode: new MediaRate(),
        };
        this.streams.set(stats.id, rates);
      }
      const sending = stats.type === "outbound-rtp";
      const fps = rates.frames.sample(
        sending ? stats.framesEncoded : stats.framesDecoded,
        stats.timestamp,
      );
      const bytesPerSecond = rates.bytes.sample(
        sending ? stats.bytesSent : stats.bytesReceived,
        stats.timestamp,
      );
      const encodeSecondsPerSecond = rates.encode.sample(
        stats.totalEncodeTime,
        stats.timestamp,
      );
      result.push({
        direction: sending ? "send" : "receive",
        fps,
        reportedFps: stats.framesPerSecond,
        width: stats.frameWidth,
        height: stats.frameHeight,
        kbps:
          bytesPerSecond === undefined
            ? undefined
            : (bytesPerSecond * 8) / 1000,
        encodeMs:
          fps && encodeSecondsPerSecond !== undefined
            ? (encodeSecondsPerSecond * 1000) / fps
            : undefined,
        framesDropped: stats.framesDropped,
        packetsLost: stats.packetsLost,
        jitterMs: stats.jitter === undefined ? undefined : stats.jitter * 1000,
        freezes: stats.freezeCount,
        freezeSeconds: stats.totalFreezesDuration,
        limitation: ["none", "cpu", "bandwidth", "other"].includes(
          stats.qualityLimitationReason,
        )
          ? stats.qualityLimitationReason
          : undefined,
      });
    }
    for (const id of this.streams.keys())
      if (!current.has(id)) this.streams.delete(id);
    return result;
  }
}

export function mediaErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return [
    "NotSupportedError",
    "NotAllowedError",
    "InvalidStateError",
    "OperationError",
    "UnknownError",
    "OverconstrainedError",
    "NotReadableError",
    "AbortError",
    "TypeError",
  ].includes(name)
    ? name
    : "other";
}
