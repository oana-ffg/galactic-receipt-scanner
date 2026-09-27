export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export async function responseError(
  response: Response,
  method: string,
  route: string,
): Promise<RequestError> {
  const error = await response.json().catch(() => null);
  const scannerTrace = response.headers.get("X-Scanner-Trace-Id");
  const traceId =
    scannerTrace &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      scannerTrace,
    )
      ? scannerTrace
      : undefined;
  const serverDetail =
    error &&
    typeof error === "object" &&
    "detail" in error &&
    typeof error.detail === "string"
      ? error.detail.slice(0, 400)
      : undefined;
  const message =
    response.status === 401 || response.status === 403
      ? "Access could not be verified. Reopen the scanner and sign in with the owner account."
      : response.status >= 500
        ? traceId && serverDetail
          ? serverDetail
          : `${method} ${route} returned HTTP ${response.status} without a scanner diagnostic response. Retry and report the time if it continues.`
        : (serverDetail ??
          `${method} ${route} returned HTTP ${response.status}.`);
  return new RequestError(message, response.status, traceId);
}

export function messageOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || name === "TimeoutError")
    return "The request was interrupted or timed out before a response. The scanner Site or network path may be unavailable.";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access is blocked. Allow camera access in your browser’s website settings, then tap Enable camera.";
  if (name === "NotFoundError")
    return "No camera was found. Open this page on your camera phone.";
  if (name === "NotReadableError")
    return "The camera could not start. Close other apps using it, then tap Enable camera.";
  if (name === "OverconstrainedError")
    return "This camera cannot use the requested settings. Try another camera or browser.";
  if (name === "QuotaExceededError")
    return "The phone could not save the image locally. Free up storage without clearing this site’s data, then retry.";
  if (
    /fetch is aborted|failed to fetch|load failed|networkerror|network request failed/i.test(
      message,
    )
  )
    return "Could not reach the scanner Site. The Site or network path may be unavailable.";
  return message || "Something went wrong. Please try again.";
}
