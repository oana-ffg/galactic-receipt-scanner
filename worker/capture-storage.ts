import { digest, HttpError, requireThat } from "./http";

export function recoveryProvenance(
  raw: string | null,
  expected: Record<string, unknown>,
): { created_at: string; take_number: number } | undefined {
  if (raw === null) return;
  requireThat(raw.length <= 2000, 400, "Invalid recovery acknowledgement.");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid recovery acknowledgement.");
  }
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    400,
    "Invalid recovery acknowledgement.",
  );
  requireThat(
    Object.entries(expected).every(([key, wanted]) => value[key] === wanted),
    409,
    "Recovery acknowledgement does not match this original.",
  );
  requireThat(
    typeof value.created_at === "string" &&
      Number.isFinite(Date.parse(value.created_at)) &&
      new Date(value.created_at).toISOString() === value.created_at &&
      Number.isSafeInteger(value.take_number) &&
      Number(value.take_number) > 0,
    400,
    "Invalid recovery provenance.",
  );
  return {
    created_at: value.created_at,
    take_number: Number(value.take_number),
  };
}

// A retry must verify the existing bytes, including legacy objects that have no
// service-validated checksum. Custom metadata alone is never proof of content.
export async function verifyOriginal(
  bucket: R2Bucket,
  key: string,
  sha: string,
  size: number,
): Promise<void> {
  const object = await bucket.get(key);
  requireThat(object, 404, "Saved original is missing. Resend the phone copy.");
  requireThat(
    object.size === size,
    409,
    "Saved original size differs. Phone copy must be retained.",
  );
  const data = new Uint8Array(await object.arrayBuffer());
  requireThat(
    data.length === size && (await digest(data)) === sha,
    409,
    "Saved original checksum differs. Phone copy must be retained.",
  );
}

export async function storeOriginal(
  bucket: R2Bucket,
  key: string,
  data: Uint8Array<ArrayBuffer>,
  sha: string,
  contentType: string,
): Promise<void> {
  const object = await bucket.put(key, data, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: sha,
    httpMetadata: { contentType },
    customMetadata: { sha256: sha },
  });
  if (!object) {
    await verifyOriginal(bucket, key, sha, data.length);
    return;
  }
  const checksum = object.checksums.sha256;
  requireThat(
    object.size === data.length &&
      checksum &&
      Array.from(new Uint8Array(checksum))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("") === sha,
    503,
    "Original storage checksum was not confirmed.",
  );
}
