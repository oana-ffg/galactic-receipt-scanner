import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { messageOf, responseError } from "./errors";

afterEach(() => vi.unstubAllGlobals());

it("explains Safari cancellation, network errors and denied camera permission", () => {
  expect(
    messageOf(new DOMException("Fetch is aborted", "AbortError")),
  ).toContain("timed out");
  expect(messageOf(new TypeError("Load failed"))).toContain("scanner Site");
  expect(
    messageOf(new DOMException("Not allowed", "NotAllowedError")),
  ).toContain("Allow camera access");
});

it("shows scanner diagnostics, but identifies gateway failures without guessing a cause", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("internal storage error", { status: 503 }),
      ),
  );
  await expect(api("/api/station/preview")).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining(
      "GET station/preview returned HTTP 503 without a scanner diagnostic response",
    ),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        {
          detail:
            "GET /api/station/preview failed during R2 preview-frame-read. Reference 11111111-1111-4111-8111-111111111111.",
        },
        {
          status: 503,
          headers: {
            "X-Scanner-Trace-Id": "11111111-1111-4111-8111-111111111111",
          },
        },
      ),
    ),
  );
  await expect(api("/api/station/preview")).rejects.toMatchObject({
    status: 503,
    message: expect.stringContaining("R2 preview-frame-read"),
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ detail: "Camera lease expired." }, { status: 409 }),
      ),
  );
  await expect(api("/api/station/heartbeat")).rejects.toMatchObject({
    status: 409,
  });
});

it("explains a timeout while reading the response body, not just connecting", async () => {
  const response = new Response(null, {
    headers: { "Content-Type": "application/json" },
  });
  vi.spyOn(response, "json").mockRejectedValue(
    new DOMException("Fetch is aborted", "AbortError"),
  );
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(api("/api/captures")).rejects.toThrow(
    "request was interrupted or timed out",
  );
});

it("preserves a preview failure trace for the raw image request", async () => {
  const traceId = "11111111-1111-4111-8111-111111111111";
  const failure = await responseError(
    Response.json(
      {
        detail: `GET /api/station/preview failed during R2 preview-frame-read. Reference ${traceId}.`,
      },
      { status: 503, headers: { "X-Scanner-Trace-Id": traceId } },
    ),
    "GET",
    "station/preview",
  );
  expect(failure.status).toBe(503);
  expect(failure.traceId).toBe(traceId);
  expect(failure.message).toContain("R2 preview-frame-read");
});
