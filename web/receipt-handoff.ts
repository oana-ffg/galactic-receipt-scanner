import type { DocumentView } from "./documents";

/** References the saved record, never unsaved form edits or access credentials. */
export function receiptHandoff(doc: DocumentView) {
  const url = new URL("/review", location.origin);
  url.searchParams.set("document", doc.id);
  const details = [
    `Receipt viewer: ${url.href}`,
    `Document ID: ${doc.id}`,
    `Saved document revision: ${doc.revision}`,
    ...(doc.filename
      ? [`Displayed filename: ${JSON.stringify(doc.filename)}`]
      : []),
    ...(doc.pdf
      ? [`Saved PDF: revision ${doc.pdf.revision}, SHA-256 ${doc.pdf.sha256}`]
      : []),
    "Source pages (in saved order):",
    ...doc.pages.map(
      (page, index) =>
        `${index + 1}. Capture ${page.captureId}, SHA-256 ${page.sha256}`,
    ),
  ].join("\n");
  const element = document.createElement("div");
  const controls = document.createElement("div");
  controls.className = "controls";
  const copy = document.createElement("button");
  copy.className = "secondary";
  copy.textContent = "Copy for Codex";
  const link = document.createElement("a");
  link.href = url.href;
  link.textContent = "Receipt link";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.hidden = true;
  const fallback = document.createElement("textarea");
  fallback.setAttribute("aria-label", "Receipt details");
  fallback.readOnly = true;
  fallback.rows = 6;
  fallback.hidden = true;
  fallback.value = details;
  copy.onclick = async () => {
    status.hidden = false;
    try {
      await navigator.clipboard.writeText(details);
      fallback.hidden = true;
      status.textContent = "Copied receipt details.";
    } catch {
      status.textContent =
        "Clipboard unavailable. Copy the selected text below and paste into Codex.";
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
    }
  };
  controls.append(copy, link);
  element.append(controls, status, fallback);
  return element;
}
