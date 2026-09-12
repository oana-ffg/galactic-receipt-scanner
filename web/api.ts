import { messageOf, RequestError } from "./errors";
import { diagnostics, requestCategory } from "./diagnostics";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const started = performance.now();
  const route = requestCategory(path);
  const method = init.method ?? "GET";
  let status = 0;
  try {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Scanner-Request": "1", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(45000),
    });
    status = response.status;
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
    const result = (await response.json()) as T;
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
  }
}
