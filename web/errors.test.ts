import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { messageOf } from "./errors";

afterEach(() => vi.unstubAllGlobals());

it("explains Safari cancellation, network errors and denied camera permission", () => {
  expect(
    messageOf(new DOMException("Fetch is aborted", "AbortError")),
  ).toContain("connection");
  expect(messageOf(new TypeError("Load failed"))).toContain("Internet");
  expect(
    messageOf(new DOMException("Not allowed", "NotAllowedError")),
  ).toContain("Allow camera access");
});

it("keeps HTTP status for camera recovery and hides raw service failures", async () => {
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
    message: expect.stringContaining("temporarily unavailable"),
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
    "connection was interrupted",
  );
});
