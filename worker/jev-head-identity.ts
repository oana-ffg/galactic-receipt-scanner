import type { ReceiptDocument } from "../web/documents";

export async function hashJson(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function pageFingerprint(document: ReceiptDocument) {
  return hashJson(
    document.pages.map((page) => ({
      capture_id: page.captureId,
      source_sha256: page.sha256,
      rotation: page.rotation,
    })),
  );
}

function pageSources(document: ReceiptDocument) {
  return document.pages.map((page) => ({
    captureId: page.captureId,
    sha256: page.sha256,
    rotation: page.rotation,
  }));
}

export async function legacyHeadMatches(
  document: ReceiptDocument,
  head: { document_revision: number; page_fingerprint: string },
  savedPayload: string | undefined,
) {
  // Revision zero is the implicit one-page document for a fresh capture; it
  // has no document_versions row until the owner or worker first saves it.
  const saved = savedPayload
    ? (JSON.parse(savedPayload) as ReceiptDocument)
    : null;
  if (saved) {
    if (
      saved.id !== document.id ||
      saved.revision !== head.document_revision ||
      JSON.stringify(pageSources(saved)) !==
        JSON.stringify(pageSources(document))
    )
      return false;
  } else if (
    head.document_revision !== 0 ||
    document.pages.length !== 1 ||
    document.pages[0].captureId !== document.id ||
    document.pages[0].rotation !== 0
  )
    return false;
  const legacyPages = saved?.pages ?? document.pages;
  return (
    head.page_fingerprint ===
    (await hashJson(
      legacyPages.map((page) => ({
        capture_id: page.captureId,
        source_sha256: page.sha256,
        crop: saved ? (page as { crop?: unknown }).crop : null,
        rotation: page.rotation,
      })),
    ))
  );
}
