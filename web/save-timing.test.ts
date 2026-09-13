import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { Timing } from "./save-timing";
import { DeliveryClock } from "./delivery-timing";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("separates response arrival, parsing and server stages without retaining arbitrary headers", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const timing = new Timing();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      now = 800;
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "Content-Type": "application/json",
          "Server-Timing":
            "serverBodyMs;dur=250,serverObjectMs;dur=40,serverTotalMs;dur=350,secret;dur=123",
        }),
        json: async () => {
          now = 820;
          return { ok: true };
        },
      };
    }),
  );
  expect(await api("/api/captures/synthetic", {}, timing)).toEqual({
    ok: true,
  });
  expect(timing.data.values).toMatchObject({
    requestHeadersMs: 800,
    responseParseMs: 20,
    requestMs: 820,
    serverBodyMs: 250,
    serverObjectMs: 40,
    serverTotalMs: 350,
  });
  expect(JSON.stringify(timing.data)).not.toContain("secret");
});
it("keeps elapsed timing and the failed stage on network and backend failures", async () => {
  const timing = new Timing();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response('{"detail":"private"}', {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Server-Timing": "serverObjectMs;dur=700,serverTotalMs;dur=900",
          "X-Scanner-Timing-Failure": "serverObjectMs",
        },
      }),
    ),
  );
  await expect(api("/api/captures/synthetic", {}, timing)).rejects.toThrow();
  expect(timing.data).toMatchObject({
    status: 503,
    failedStage: "serverObjectMs",
    values: {
      serverObjectMs: 700,
      serverTotalMs: 900,
      requestMs: expect.any(Number),
    },
  });
  expect(JSON.stringify(timing.data)).not.toContain("private");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const offline = new Timing();
  await expect(api("/api/captures/synthetic", {}, offline)).rejects.toThrow();
  expect(offline.data.failedStage).toBe("requestHeadersMs");
  expect(offline.data.values.requestMs).toBeGreaterThanOrEqual(0);
});
it("estimates delivery with clock offset and uncertainty, and expires calibration", () => {
  const clock = new DeliveryClock();
  expect(clock.age(1000, 1000)).toEqual({ clockSynced: false });
  // Phone is 10 seconds ahead. 40ms round trip, 10ms remote processing.
  clock.observe(1000, 11015, 11025, 1040);
  expect(clock.age(11100, 1125)).toMatchObject({
    clockSynced: true,
    ageEstimateMs: 25,
    clockUncertaintyMs: 15,
  });
  // A noisier sample must not replace the more precise one.
  clock.observe(1100, 11150, 11160, 1250);
  expect(clock.age(11100, 1300).clockUncertaintyMs).toBe(15);
  expect(clock.age(41100, 31100)).toEqual({ clockSynced: false });
  clock.observe(0, 0, 100, 10); // impossible ordering
  expect(clock.age(41100, 31100)).toEqual({ clockSynced: false });
});
