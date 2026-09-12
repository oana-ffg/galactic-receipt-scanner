import { expect, it, vi } from "vitest";
import { CameraFrames } from "./camera-frames";

it("uses presented frames despite zero playback counts and ignores clock-only progress", () => {
  let presented!: () => void;
  const video = {
    currentTime: 0,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }),
    requestVideoFrameCallback: vi.fn((callback: () => void) => {
      presented = callback;
      return 7;
    }),
    cancelVideoFrameCallback: vi.fn(),
  };
  const frames = new CameraFrames(video as unknown as HTMLVideoElement);
  expect(frames.confirmed).toBe(true);
  expect(frames.take()).toBe(false);
  presented();
  expect(frames.take()).toBe(true);
  expect(frames.presentedFrames).toBe(1);
  for (const time of [1, 2, 3]) {
    video.currentTime = time;
    expect(frames.take()).toBe(false);
  }
  presented();
  expect(frames.take()).toBe(true);
  expect(frames.take()).toBe(false);
  frames.close();
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
});

it("marks media-clock fallback as unconfirmed so it cannot enable fast removal", () => {
  const video = { currentTime: 0 };
  const frames = new CameraFrames(video as HTMLVideoElement);
  expect(frames.confirmed).toBe(false);
  expect(frames.presentedFrames).toBeUndefined();
  expect(frames.take()).toBe(true);
  expect(frames.take()).toBe(false);
  video.currentTime = 1;
  expect(frames.take()).toBe(true);
  frames.close();
});
