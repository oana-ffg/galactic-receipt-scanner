import { sha256 } from "./checksum";
import { api } from "./api";
import type { Capture } from "./types";

type OriginalSource = Pick<Capture, "id" | "sha256">;

// Originals are immutable per capture ID and verified against their SHA-256, so a
// tab can reuse recently viewed bytes for re-renders, previews and PDF generation.
// Responses stay no-store: the bytes live only in this tab's memory, never on disk.
const RETAINED_ORIGINALS = 12;
const retained = new Map<string, Promise<Blob>>();

async function downloadOriginal(source: OriginalSource): Promise<Blob> {
  const response = await fetch(`/api/files/${source.id}/raw`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error("Could not retrieve the original.");
  const bytes = await response.arrayBuffer();
  if ((await sha256(bytes)) !== source.sha256)
    throw new Error("Original checksum mismatch. No outputs were created.");
  return new Blob([bytes], {
    type: response.headers.get("Content-Type") ?? "application/octet-stream",
  });
}

/** Verified original bytes, downloaded at most once while recently used. */
export function originalBlob(source: OriginalSource): Promise<Blob> {
  const key = `${source.id}/${source.sha256}`;
  const cached = retained.get(key);
  if (cached) {
    retained.delete(key);
    retained.set(key, cached);
    return cached;
  }
  const download = downloadOriginal(source);
  retained.set(key, download);
  // Never retain a failure. Callers still receive the rejection from `download`;
  // this branch only evicts it so that a later read retries the download.
  download.then(undefined, () => {
    if (retained.get(key) === download) retained.delete(key);
  });
  while (retained.size > RETAINED_ORIGINALS)
    retained.delete(retained.keys().next().value!);
  return download;
}

/**
 * Show a verified original in an image element. Lazy images load when they
 * approach the viewport. Returns a function that releases the object URL.
 */
export function showOriginal(
  image: HTMLImageElement,
  source: OriginalSource,
  onError: (error: unknown) => void,
  { lazy = false } = {},
): () => void {
  let released = false;
  let url: string | undefined;
  const load = () =>
    originalBlob(source).then(
      (blob) => {
        if (released) return;
        url = URL.createObjectURL(blob);
        image.src = url;
      },
      (error) => {
        if (!released) onError(error);
      },
    );
  const observer = lazy
    ? new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer!.disconnect();
          void load();
        },
        { rootMargin: "400px" },
      )
    : undefined;
  if (observer) observer.observe(image);
  else void load();
  return () => {
    released = true;
    observer?.disconnect();
    if (url) URL.revokeObjectURL(url);
  };
}

/** Capture detail, including its stored derivative versions. */
export type CaptureDetail = Capture & {
  artifacts: { kind: string; sha256: string; created_at: string }[];
};

export async function readOriginal(id: string) {
  const capture = await api<CaptureDetail>(`/api/captures/${id}`);
  return { capture, blob: await originalBlob(capture) };
}
