import { describe, it, expect, vi, afterEach } from "vitest";
import { DiagnosticHistory, requestCategory, diagnostics } from "./diagnostics";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("private diagnostic history", () => {
  it("samples repeated request failures without hiding different routes or outcomes", () => {
    const history = new DiagnosticHistory(() => 0);
    for (let i = 0; i < 1000; i++)
      history.record(
        "request",
        {
          route: "station/heartbeat",
          status: 503,
          ok: false,
        },
        2000,
        "station/heartbeat:POST:503:failed",
      );
    history.record(
      "request",
      { route: "captures", status: 503, ok: false },
      2000,
      "captures:POST:503:failed",
    );
    history.record(
      "request",
      { route: "captures", status: 201, ok: true },
      2000,
      "captures:POST:201:ok",
    );
    expect(history.snapshot().map((entry) => entry.data)).toEqual([
      { route: "station/heartbeat", status: 503, ok: false },
      { route: "captures", status: 503, ok: false },
      { route: "captures", status: 201, ok: true },
    ]);
  });
  it("expires old history and bounds both event count and serialized size", () => {
    let now = 0;
    const history = new DiagnosticHistory(() => now);
    for (let i = 0; i < 1000; i++) history.record("vision", { ms: i });
    expect(history.snapshot()).toHaveLength(180);
    expect(history.snapshot()[0].data.ms).toBe(820);
    for (let i = 0; i < 1000; i++)
      history.record("scan.state", { reason: "x".repeat(1000) });
    expect(JSON.stringify(history.snapshot()).length).toBeLessThanOrEqual(
      24002,
    );
    expect(history.snapshot().at(-1)!.data.reason).toHaveLength(180);
    now = 120001;
    expect(history.snapshot()).toEqual([]);
  });
  it("samples repeated events and freezes a report independently of future events", () => {
    let now = 0;
    const history = new DiagnosticHistory(() => now);
    history.record("camera.frames", { analyzed: 0 }, 2000);
    now = 1000;
    history.record("camera.frames", { analyzed: 5 }, 2000);
    const report = history.snapshot();
    now = 2000;
    history.record("camera.frames", { analyzed: 10 }, 2000);
    expect(report).toHaveLength(1);
    report[0].data.analyzed = 999;
    expect(history.snapshot()[0].data.analyzed).toBe(0);
    expect(history.snapshot()).toHaveLength(2);
  });
  it("records failed requests without bodies, credentials, URLs or server detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "private receipt text" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(
      api("/api/captures/private-id?token=secret", {
        method: "POST",
        headers: { Authorization: "secret" },
        body: "private image",
      }),
    ).rejects.toThrow("private receipt text");
    const event = diagnostics.snapshot().at(-1)!;
    expect(event.data).toMatchObject({
      route: "captures",
      method: "POST",
      status: 409,
      ok: false,
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private|secret|token|Authorization/,
    );
    expect(requestCategory("/api/station/heartbeat?secret=123")).toBe(
      "station/heartbeat",
    );
    expect(requestCategory("/api/station/unknown-secret")).toBe("other");
  });
});
