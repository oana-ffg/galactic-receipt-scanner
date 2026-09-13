import { Timing, serverStages } from "./save-timing";
import { messageOf, RequestError } from "./errors";
import { diagnostics, requestCategory } from "./diagnostics";

export async function api<T>(
  path: string,
  init: RequestInit = {},
  timing?: Timing,
): Promise<T> {
  const started = performance.now();
  const requestTiming = timing ? new Timing(timing.data.kind) : undefined;
  const route = requestCategory(path);
  const method = init.method ?? "GET";
  let status = 0;
  try {
    const headersStarted = performance.now();
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Scanner-Request": "1", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(45000),
    });
    requestTiming?.set("requestHeadersMs", performance.now() - headersStarted);
    requestTiming?.readServer(response.headers.get("Server-Timing"));
    const failed = response.headers.get("X-Scanner-Timing-Failure");
    if (
      requestTiming &&
      serverStages.includes(failed as (typeof serverStages)[number])
    )
      requestTiming.data.failedStage = failed as (typeof serverStages)[number];
    status = response.status;
    if (requestTiming) requestTiming.data.status = status;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message =
        response.status === 401 || response.status === 403
          ? "Access could not be verified. Reopen the scanner and sign in with the owner account."
          : response.status >= 500
            ? "The scanner service is temporarily unavailable. Please try again shortly."
            : String(
                error.detail ??
                  "The request could not be completed. Please try again.",
              );
      throw new RequestError(message, response.status);
    }
    if (!response.headers.get("Content-Type")?.includes("application/json"))
      throw new RequestError(
        "Your session may have ended. Reopen the scanner and sign in with the owner account.",
        401,
      );
    const result = (
      requestTiming
        ? await requestTiming.measure("responseParseMs", () => response.json())
        : await response.json()
    ) as T;
    diagnostics.record(
      "request",
      {
        route,
        method,
        status,
        ok: true,
        ms: performance.now() - started,
      },
      2000,
      `${route}:${method}:${status}:ok`,
    );
    return result;
  } catch (error) {
    if (requestTiming)
      requestTiming.data.failedStage ??=
        status >= 400
          ? "requestMs"
          : status
            ? "responseParseMs"
            : "requestHeadersMs";
    diagnostics.record(
      "request",
      {
        route,
        method,
        status,
        ok: false,
        ms: performance.now() - started,
      },
      2000,
      `${route}:${method}:${status}:failed`,
    );
    if (error instanceof RequestError) throw error;
    throw new RequestError(messageOf(error));
  } finally {
    requestTiming?.set("requestMs", performance.now() - started);
    if (timing && requestTiming) {
      const data = requestTiming.data;
      timing.data.status = data.status;
      if (data.failedStage) timing.data.failedStage = data.failedStage;
      else if (
        timing.data.failedStage &&
        (serverStages.includes(
          timing.data.failedStage as (typeof serverStages)[number],
        ) ||
          ["requestMs", "requestHeadersMs", "responseParseMs"].includes(
            timing.data.failedStage,
          ))
      )
        delete timing.data.failedStage;
      for (const key of [
        ...serverStages,
        "requestMs",
        "requestHeadersMs",
        "responseParseMs",
      ] as const)
        delete timing.data.values[key];
      Object.assign(timing.data.values, data.values);
      timing.data.requests ??= [];
      timing.data.requests.push({
        at: data.at,
        status: data.status,
        failedStage: data.failedStage,
        values: { ...data.values },
      });
      if (timing.data.requests.length > 4) timing.data.requests.shift();
    }
  }
}
