export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { "X-Scanner-Request": "1", ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: `HTTP ${response.status}` }));
    throw new Error(String(error.detail ?? "Request failed."));
  }
  return response.json() as Promise<T>;
}
