export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export function messageOf(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "AbortError" || name === "TimeoutError")
    return "The connection was interrupted or took too long. Check your Internet connection.";
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
    return "Could not reach the scanner. Check your Internet connection.";
  return message || "Something went wrong. Please try again.";
}
