import { messageOf, RequestError } from "./errors";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Scanner-Request": "1", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(45000),
    });
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
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(messageOf(error));
  }
}
