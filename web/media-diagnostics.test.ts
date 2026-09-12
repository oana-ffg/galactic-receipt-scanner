import { expect, it } from "vitest";
import {
  cameraSettings,
  MediaRate,
  RtpTelemetry,
  mediaErrorName,
} from "./media-diagnostics";

it("measures delivered FPS and treats counter resets or missing counters as unknown", () => {
  const rate = new MediaRate();
  expect(rate.sample(10, 1000)).toBeUndefined();
  expect(rate.sample(40, 3000)).toBe(15);
  expect(rate.sample(40, 5000)).toBe(0);
  expect(rate.sample(2, 6000)).toBeUndefined();
  expect(rate.sample(undefined, 7000)).toBeUndefined();
  expect(rate.sample(100, 8000)).toBeUndefined();
});

it("selects camera settings without logging device identifiers", () => {
  const track = {
    readyState: "live",
    muted: false,
    getSettings: () => ({
      width: 2160,
      height: 3840,
      frameRate: 30,
      deviceId: "private-device",
      groupId: "private-group",
    }),
    getCapabilities: () => ({
      width: { min: 320, max: 3840 },
      frameRate: { min: 1, max: 60 },
      deviceId: "private-device",
    }),
  } as unknown as MediaStreamTrack;
  const data = cameraSettings(track);
  expect(data).toMatchObject({
    width: 2160,
    height: 3840,
    fps: 30,
    minWidth: 320,
    maxWidth: 3840,
    maxFps: 60,
  });
  expect(JSON.stringify(data)).not.toContain("private");
});

it("reports media throughput without exposing connection IDs, addresses or transport details", () => {
  const telemetry = new RtpTelemetry();
  const sample = (
    timestamp: number,
    framesEncoded: number,
    bytesSent: number,
    totalEncodeTime: number,
  ) =>
    telemetry.sample(
      new Map([
        [
          "private-connection",
          {
            id: "private-connection",
            type: "outbound-rtp",
            kind: "video",
            timestamp,
            framesEncoded,
            bytesSent,
            totalEncodeTime,
            frameWidth: 640,
            frameHeight: 360,
            qualityLimitationReason: "cpu",
            localAddress: "private-address",
          },
        ],
        [
          "private-candidate",
          {
            id: "private-candidate",
            type: "candidate-pair",
            address: "private-address",
          },
        ],
      ]) as unknown as RTCStatsReport,
    );
  expect(sample(1000, 100, 1000, 1)[0].fps).toBeUndefined();
  const result = sample(3000, 130, 6000, 1.06);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    direction: "send",
    fps: 15,
    kbps: 20,
    width: 640,
    height: 360,
    limitation: "cpu",
  });
  expect(result[0].encodeMs).toBeCloseTo(2);
  expect(JSON.stringify(result)).not.toMatch(/private|address|candidate/);
  telemetry.sample(new Map() as RTCStatsReport);
  expect(sample(5000, 200, 9000, 2)[0].fps).toBeUndefined();
});

it("retains only recognized media error names, never arbitrary error contents", () => {
  expect(
    mediaErrorName(new DOMException("private content", "NotSupportedError")),
  ).toBe("NotSupportedError");
  const error = new Error("private content");
  error.name = "private error category";
  expect(mediaErrorName(error)).toBe("other");
});
