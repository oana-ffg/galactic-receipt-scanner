export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_IMAGE = 24 * 1024 * 1024;
export const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  status: number,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
export async function bytes(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  requireThat(
    Number(request.headers.get("content-length") || 0) <= limit,
    413,
    "Upload too large.",
  );
  const reader = request.body?.getReader();
  requireThat(reader, 400, "Missing body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      requireThat(size <= limit, 413, "Upload too large.");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  requireThat(size > 0, 400, "Empty upload.");
  return data;
}
export const digest = async (data: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export function imageType(data: Uint8Array): string {
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
    return "image/png";
  throw new HttpError(415, "Use JPEG or PNG images.");
}
export async function bodyJson(
  request: Request,
  limit = 24000,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await bytes(request, limit)),
    );
    requireThat(
      value && typeof value === "object" && !Array.isArray(value),
      400,
      "Expected an object.",
    );
    return value as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON.");
  }
}
