import { sha256 } from "./checksum";
import { api } from "./api";
import type { Capture } from "./types";

export async function readOriginal(id: string) {
  const capture = await api<Capture>(`/api/captures/${id}`);
  const response = await fetch(`/api/files/${id}/raw`, {
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Could not retrieve the original.");
  const bytes = await response.arrayBuffer();
  const hash = await sha256(bytes);
  if (hash !== capture.sha256)
    throw new Error("Original checksum mismatch. No outputs were created.");
  return {
    capture,
    blob: new Blob([bytes], {
      type: response.headers.get("Content-Type") ?? "application/octet-stream",
    }),
  };
}
