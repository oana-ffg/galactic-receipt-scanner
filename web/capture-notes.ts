import { api } from "./api";
import { messageOf } from "./errors";
import type { Capture } from "./types";

type OwnerNote = NonNullable<Capture["owner_notes"]>[number];
type Draft = {
  text: string;
  open: boolean;
  saving: boolean;
  status: string;
  pendingId?: string;
};
const drafts = new Map<string, Draft>();
const notes = new Map<string, OwnerNote[]>();
const widgets = new WeakMap<HTMLElement, () => void>();

function mergeNotes(receiptId: string, incoming: OwnerNote[]) {
  const merged = new Map(
    (notes.get(receiptId) ?? []).map((note) => [note.id, note]),
  );
  for (const note of incoming) merged.set(note.id, note);
  notes.set(
    receiptId,
    [...merged.values()].sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    ),
  );
}

function updateVisible(receiptId: string) {
  document.querySelectorAll<HTMLElement>(".capture-notes").forEach((widget) => {
    if (widget.dataset.receiptId === receiptId) widgets.get(widget)?.();
  });
}

/** Notes describe the physical source and stay with it across retakes. */
export function captureNotes(
  capture: Capture,
  onSaved?: (note: OwnerNote) => void,
): HTMLElement {
  const receiptId = capture.receipt_id;
  mergeNotes(receiptId, capture.owner_notes ?? []);
  const draft = drafts.get(receiptId) ?? {
    text: "",
    open: false,
    saving: false,
    status: "",
  };
  drafts.set(receiptId, draft);
  const section = document.createElement("section");
  section.className = "capture-notes";
  section.dataset.receiptId = receiptId;
  const heading = document.createElement("strong");
  heading.textContent = "Your notes about this receipt";
  const list = document.createElement("div");
  const comment = document.createElement("button");
  comment.className = "secondary";
  comment.textContent = "Comment";
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "What should review know about the original paper?";
  const input = document.createElement("textarea");
  input.maxLength = 2000;
  input.required = true;
  label.append(input);
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save comment";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  form.append(label, save, status);
  const render = () => {
    list.replaceChildren();
    for (const note of notes.get(receiptId) ?? []) {
      const item = document.createElement("p");
      item.textContent = note.text;
      item.title = new Date(note.created_at).toLocaleString();
      list.append(item);
    }
    if (input.value !== draft.text) input.value = draft.text;
    form.hidden = !draft.open;
    input.disabled = save.disabled = comment.disabled = draft.saving;
    status.textContent = draft.status;
  };
  widgets.set(section, render);
  render();
  input.oninput = () => {
    draft.text = input.value;
    draft.pendingId = undefined;
    updateVisible(receiptId);
  };
  comment.onclick = () => {
    draft.open = !draft.open;
    updateVisible(receiptId);
    if (draft.open) input.focus();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!draft.text.trim() || draft.saving) return;
    draft.pendingId ??= crypto.randomUUID();
    const submittedText = draft.text;
    draft.saving = true;
    draft.status = "Saving…";
    updateVisible(receiptId);
    try {
      const note = await api<OwnerNote>(`/api/captures/${capture.id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draft.pendingId, text: submittedText }),
      });
      mergeNotes(receiptId, [note]);
      capture.owner_notes ??= [];
      if (!capture.owner_notes.some((saved) => saved.id === note.id))
        capture.owner_notes.push(note);
      onSaved?.(note);
      draft.text = "";
      draft.pendingId = undefined;
      draft.open = false;
      draft.status = "";
    } catch (error) {
      draft.status = `Could not save comment: ${messageOf(error)}`;
    } finally {
      draft.saving = false;
      updateVisible(receiptId);
    }
  };
  section.append(heading, list, comment, form);
  return section;
}
