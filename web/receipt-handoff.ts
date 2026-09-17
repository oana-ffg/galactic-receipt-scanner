import type { DocumentView } from "./documents";

/** References the saved record, never unsaved form edits or access credentials. */
export function receiptHandoff(doc: DocumentView) {
  const url = new URL("/review", location.origin);
  url.searchParams.set("document", doc.id);
  const prompt = [
    "Investigate what went wrong in the parsing of this receipt.",
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
    "Compare the original scans with the saved OCR, model readings and decision history for this revision. If the document has changed, distinguish the referenced result from the current one. Explain where the error first appeared and what evidence supports the diagnosis.",
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
  fallback.setAttribute("aria-label", "Receipt investigation prompt");
  fallback.readOnly = true;
  fallback.rows = 6;
  fallback.hidden = true;
  fallback.value = prompt;
  copy.onclick = async () => {
    status.hidden = false;
    try {
      await navigator.clipboard.writeText(prompt);
      fallback.hidden = true;
      status.textContent = "Copied. Paste into Codex and add what looks wrong.";
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
