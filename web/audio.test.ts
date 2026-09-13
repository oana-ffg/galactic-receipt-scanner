import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import { ScannerAudio } from "./audio";
import { audioDiagnostics } from "./diagnostics";

let context: AudioContext;
let state: AudioContextState;
let oscillators: OscillatorNode[];
let warning: Mock<(message: string) => void>;
let record: MockInstance<typeof audioDiagnostics.record>;
let audio: ScannerAudio;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible" });
  state = "suspended";
  oscillators = [];
  const param = () => ({
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  context = {
    get state() {
      return state;
    },
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => {
      state = "running";
    }),
    createOscillator: vi.fn(() => {
      const oscillator = {
        frequency: param(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      } as unknown as OscillatorNode;
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => ({
      gain: param(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
  } as unknown as AudioContext;
  warning = vi.fn();
  record = vi.spyOn(audioDiagnostics, "record");
  audio = new ScannerAudio(true, warning, () => context);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("initializes on demand, resumes, schedules once and cleans up ended audio", async () => {
  await audio.play(true, "saved", 7);
  expect(context.resume).toHaveBeenCalledOnce();
  expect(oscillators).toHaveLength(1);
  expect(warning).toHaveBeenLastCalledWith("");
  oscillators[0].onended?.call(oscillators[0], new Event("ended"));
  expect(oscillators[0].disconnect).toHaveBeenCalledOnce();
  expect(record.mock.calls.map((c) => c[1]?.action)).toEqual(
    expect.arrayContaining([
      "requested",
      "initialized",
      "resume-result",
      "scheduled",
      "ended",
    ]),
  );
});
it("recovers audio suspended after earlier successful playback", async () => {
  await audio.recover("gesture");
  state = "suspended";
  await audio.play(true, "saved");
  expect(context.resume).toHaveBeenCalledTimes(2);
  expect(oscillators).toHaveLength(1);
});
it("bounds a blocked resume and never plays an expired ding after a later gesture", async () => {
  let resume!: () => void;
  vi.mocked(context.resume).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
  );
  const pending = audio.play(true, "saved");
  await vi.advanceTimersByTimeAsync(1201);
  await pending;
  state = "running";
  resume();
  await Promise.resolve();
  expect(oscillators).toHaveLength(0);
  expect(warning).toHaveBeenLastCalledWith(
    expect.stringContaining("Test audio"),
  );
});
it("a gesture can unblock a startup resume without replaying any acknowledgement", async () => {
  vi.mocked(context.resume).mockImplementationOnce(() => new Promise(() => {}));
  const startup = audio.recover("startup");
  await audio.recover("gesture");
  await vi.advanceTimersByTimeAsync(1201);
  await startup;
  expect(oscillators).toHaveLength(0);
  expect(warning).toHaveBeenLastCalledWith("");
  await audio.play(true, "test");
  expect(oscillators).toHaveLength(1);
});
it("mute cancels active nodes and invalidates a pending sound even if re-enabled", async () => {
  await audio.play(true, "saved");
  audio.setEnabled(false);
  expect(oscillators[0].disconnect).toHaveBeenCalledOnce();
  state = "suspended";
  let finish!: () => void;
  vi.mocked(context.resume).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  audio.setEnabled(true);
  const pending = audio.play(true, "saved");
  audio.setEnabled(false);
  state = "running";
  finish();
  await pending;
  expect(oscillators).toHaveLength(1);
});
it("constructor and resume failures do not reject playback or log error messages", async () => {
  audio = new ScannerAudio(true, warning, () => {
    throw new Error("private device details");
  });
  await expect(audio.play(true, "saved")).resolves.toBeUndefined();
  audio = new ScannerAudio(true, warning, () => context);
  vi.mocked(context.resume).mockRejectedValue(
    new Error("private device details"),
  );
  await expect(audio.play(true, "saved")).resolves.toBeUndefined();
  expect(JSON.stringify(record.mock.calls)).not.toContain(
    "private device details",
  );
  expect(oscillators).toHaveLength(0);
});
it("removes tones stalled mid-play so they cannot sound much later", async () => {
  await audio.play(false, "rejected");
  expect(oscillators).toHaveLength(3);
  state = "suspended";
  await vi.advanceTimersByTimeAsync(1800);
  expect(
    oscillators.every((o) => vi.mocked(o.disconnect).mock.calls.length === 1),
  ).toBe(true);
  expect(warning).toHaveBeenLastCalledWith(
    expect.stringContaining("did not finish"),
  );
});
it("disabled audio neither initializes nor schedules", async () => {
  audio.setEnabled(false);
  await audio.play(true, "saved");
  expect(context.resume).not.toHaveBeenCalled();
  expect(oscillators).toHaveLength(0);
});

it("keeps a missed-alert warning when recovery succeeds after the sound deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(context.resume).mockImplementation(async () => {
    state = "running";
    now = 1201;
  });
  await audio.play(true, "saved");
  expect(oscillators).toHaveLength(0);
  await audio.recover("focus");
  expect(warning).toHaveBeenLastCalledWith(
    expect.stringContaining("missed this alert"),
  );
  expect(record).toHaveBeenCalledWith(
    "audio",
    expect.objectContaining({ action: "skipped", reason: "expired" }),
  );
  await audio.play(true, "test");
  oscillators[0].onended?.call(oscillators[0], new Event("ended"));
  expect(warning).toHaveBeenLastCalledWith("");
});
it("retains a missed-alert warning after a failed resume even if a concurrent recovery starts audio", async () => {
  vi.mocked(context.resume).mockImplementationOnce(async () => {
    state = "running";
    throw new Error("synthetic");
  });
  await audio.play(true, "saved");
  await audio.recover("gesture");
  expect(oscillators).toHaveLength(0);
  expect(warning).toHaveBeenLastCalledWith(
    expect.stringContaining("missed this alert"),
  );
  expect(record).toHaveBeenCalledWith(
    "audio",
    expect.objectContaining({ action: "skipped", reason: "not-ready" }),
  );
});

it("allows an explicit test to wait for slow audio-device startup without extending saved-alert deadlines", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(context.resume).mockImplementation(async () => {
    state = "running";
    now = 3000;
  });
  await audio.play(true, "test");
  expect(oscillators).toHaveLength(1);
  expect(record).toHaveBeenCalledWith(
    "audio",
    expect.objectContaining({ action: "scheduled", waitMs: 3000 }),
  );
});
