import { Timing, serverStages } from "./save-timing";
import { messageOf, RequestError, responseError } from "./errors";
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
    if (!response.ok) throw await responseError(response, method, route);
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
    const rawCode = (error as { code?: unknown } | null)?.code;
    const errorCode =
      (typeof rawCode === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(rawCode)) ||
      (typeof rawCode === "number" && Number.isFinite(rawCode))
        ? rawCode
        : undefined;
    if (requestTiming)
      requestTiming.data.failedStage ??=
        status >= 400
          ? "requestMs"
          : status
            ? "responseParseMs"
            : "requestHeadersMs";
    const failedStage =
      requestTiming?.data.failedStage ??
      (status >= 400
        ? "requestMs"
        : status
          ? "responseParseMs"
          : "requestHeadersMs");
    diagnostics.record(
      "request",
      {
        route,
        method,
        status,
        ok: false,
        ms: performance.now() - started,
        traceId: error instanceof RequestError ? error.traceId : undefined,
        errorType: error instanceof Error ? error.name : typeof error,
        errorCode,
        failedStage,
      },
      2000,
      `${route}:${method}:${status}:failed`,
    );
    if (error instanceof RequestError) throw error;
    throw new RequestError(`${method} ${route}: ${messageOf(error)}`);
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
