export async function sha256(
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
