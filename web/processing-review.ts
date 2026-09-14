import { currencyDigits, displayMoney, readMoney } from "./review-money";
import type { ReviewOcrSource } from "./review-ocr";
import { reviewComparison } from "./review-comparison";
import { api } from "./api";
import {
  arithmetic,
  documentTypes,
  type Extraction,
  type PurchaseCategory,
} from "./extraction";
import { reviewValues, type ReviewReadings } from "./review-values";
import { messageOf } from "./errors";
import type { DocumentView } from "./documents";
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const n = document.createElement(tag);
  if (text) n.textContent = text;
  return n;
};
function input(label: string, value: string, multiline = false) {
  const wrap = el("label", label);
  wrap.className = "review-field";
  const control = multiline ? el("textarea") : el("input");
  control.value = value;
  wrap.append(control);
  return { wrap, control };
}
const number = (v: string) => {
  if (!v.trim()) return null;
  const n = Number(v);
  if (!Number.isFinite(n))
    throw Error("Enter a number or leave unknown values blank.");
  return n;
};
function reviewForm(
  doc: DocumentView,
  categories: PurchaseCategory[],
  act: (task: () => Promise<void>) => Promise<void>,
  refresh: () => Promise<void>,
  extraction: Extraction,
  source: string,
  cancel: () => void,
) {
  const p = doc.processing!,
    e = structuredClone(extraction),
    section = el("section");
  section.append(
    el("h3", "Receipt values"),
    el(
      "p",
      `Prefilled from ${source}. Edit the fields, then accept or cancel.`,
    ),
  );
  const notes = el("details");
  notes.append(
    el("summary", "Review notes and document details"),
    el(
      "p",
      `Luna: ${p.small_model_certainty ?? "not parsed"} · Astra: ${p.large_model_confidence ?? "not reviewed"} · Human reviewed: ${p.has_human_review ? "yes" : "no"}`,
    ),
  );
  const a = arithmetic(e);
  notes.append(
    el(
      "p",
      `Saved reading arithmetic: ${a.status}${a.difference !== null ? ` (${a.difference} minor units difference)` : ""}`,
    ),
  );
  if (p.ocr_comparison) {
    notes.append(
      el(
        "p",
        `Plain OCR comparison: ${p.ocr_comparison.status}. The original image is the source of truth.`,
      ),
    );
    const discrepancies = el("ul");
    for (const reason of p.ocr_comparison.disagreements)
      discrepancies.append(el("li", reason));
    notes.append(discrepancies);
    if (p.ocr_comparison.resolution)
      notes.append(el("p", p.ocr_comparison.resolution));
  }
  const form = el("form");
  form.className = "review-form";
  form.setAttribute("aria-label", "Human review fields");
  const summary = el("div");
  summary.className = "review-summary-fields";
  form.append(summary);
  const scalar = new Map<keyof Extraction, ReturnType<typeof input>>();
  for (const [key, label] of [
    ["vendor", "Vendor"],
    ["receipt_date", "Purchase date"],
    ["reference", "Reference"],
    ["currency", "Currency"],
    ["total_minor", "Total"],
    ["charged_total_minor", "Charged total"],
    ["vat_minor", "VAT"],
    ["card_last_four", "Last four card digits"],
  ] as const) {
    const money = key.endsWith("_minor");
    const field = input(
      label,
      money
        ? displayMoney(e[key] as number | null, e.currency)
        : e[key] === null
          ? ""
          : String(e[key]),
    );
    if (money) (field.control as HTMLInputElement).inputMode = "decimal";
    scalar.set(key, field);
    if (key === "receipt_date")
      (field.control as HTMLInputElement).type = "date";
    (key === "card_last_four" ? notes : summary).append(field.wrap);
  }
  const selects = new Map<keyof Extraction, HTMLSelectElement>();
  for (const [key, label, values] of [
    ["type", "Document type", documentTypes],
    ["certainty", "Review confidence", ["low", "medium", "high"]],
    [
      "completeness",
      "Page completeness",
      ["complete", "fragment", "uncertain"],
    ],
    ["tax_basis", "Amounts basis", ["gross", "net-plus-tax", "unknown"]],
    [
      "payment_status",
      "Payment status",
      ["approved", "declined", "unknown", "not-applicable"],
    ],
  ] as const) {
    const wrap = el("label", label);
    wrap.className = "review-field";
    const select = el("select");
    for (const value of values) {
      const option = el("option", value);
      option.value = value;
      select.append(option);
    }
    select.value = e[key];
    wrap.append(select);
    notes.append(wrap);
    selects.set(key, select);
  }
  const category = el("select");
  category.append(el("option", "Unclassified"));
  category.firstElementChild!.setAttribute("value", "");
  for (const c of categories) {
    const option = el("option", c.name);
    option.value = c.id;
    option.title = c.description;
    category.append(option);
  }
  category.value = e.category_id ?? "";
  const categoryLabel = el("label", "Purchase category");
  categoryLabel.className = "review-field";
  categoryLabel.append(category);
  notes.append(categoryLabel);
  const bools = new Map<keyof Extraction, HTMLInputElement>();
  for (const [key, label] of [
    ["has_handwriting", "Handwriting is present"],
    ["has_payment_slip", "Payment slip is attached"],
    [
      "confirmed_arithmetic_mismatch",
      "I checked the complete original and its printed amounts do not balance",
    ],
  ] as const) {
    const check = el("input");
    check.type = "checkbox";
    check.checked = e[key];
    const wrap = el("label");
    wrap.className = "toggle";
    wrap.append(check, label);
    notes.append(wrap);
    bools.set(key, check);
  }
  const lineSection = el("div");
  const currencyHint = el(
    "p",
    `Amounts in ${e.currency ?? "currency units (2 decimal places)"}. Leave unreadable values blank.`,
  );
  lineSection.append(el("h4", "Line items"), currencyHint);
  const table = el("table");
  table.className = "review-line-items";
  const header = el("tr");
  for (const title of ["Item", "Qty", "Unit price", "Amount", ""])
    header.append(el("th", title));
  const tableHead = el("thead");
  tableHead.append(header);
  const tableBody = el("tbody");
  table.append(tableHead, tableBody);
  lineSection.append(table);
  const lineRows: {
    description: HTMLInputElement;
    quantity: HTMLInputElement;
    unit: HTMLInputElement;
    amount: HTMLInputElement;
    row: HTMLElement;
  }[] = [];
  const addLine = (l: Extraction["line_items"][number]) => {
    const row = el("tr");
    const description = input("Item", l.description),
      quantity = input(
        "Quantity",
        l.quantity === null ? "" : String(l.quantity),
      ),
      unit = input("Unit price", displayMoney(l.unit_price_minor, e.currency)),
      amount = input("Line amount", displayMoney(l.amount_minor, e.currency));
    for (const [label, field] of [
      ["Item", description],
      ["Quantity", quantity],
      ["Unit price", unit],
      ["Line amount", amount],
    ] as const) {
      field.control.setAttribute("aria-label", label);
      if (label !== "Item")
        (field.control as HTMLInputElement).inputMode = "decimal";
      const cell = el("td");
      cell.append(field.control);
      row.append(cell);
    }
    const remove = el("button", "×");
    remove.setAttribute("aria-label", "Remove line");
    remove.type = "button";
    remove.className = "secondary";
    remove.onclick = () => row.remove();
    const removeCell = el("td");
    removeCell.append(remove);
    row.append(removeCell);
    tableBody.append(row);
    lineRows.push({
      description: description.control as HTMLInputElement,
      quantity: quantity.control as HTMLInputElement,
      unit: unit.control as HTMLInputElement,
      amount: amount.control as HTMLInputElement,
      row,
    });
  };
  e.line_items.forEach(addLine);
  const add = el("button", "Add line");
  add.type = "button";
  add.className = "secondary";
  add.onclick = () =>
    addLine({
      description: "",
      quantity: null,
      unit_price_minor: null,
      amount_minor: null,
    });
  lineSection.append(add);
  form.append(lineSection);
  const adjustments = new Map<
    "adjustments" | "payment_adjustments",
    ReturnType<typeof input>
  >();
  for (const [key, label] of [
    [
      "adjustments",
      "Document adjustments — description = signed amount, one per line",
    ],
    [
      "payment_adjustments",
      "Payment fees / adjustments — description = signed amount, one per line",
    ],
  ] as const) {
    const field = input(
      label,
      e[key]
        .map(
          (a) =>
            `${a.description} = ${displayMoney(a.amount_minor, e.currency)}`,
        )
        .join("\n"),
      true,
    );
    adjustments.set(key, field);
    form.append(field.wrap);
  }
  let displayedCurrency = e.currency;
  const currencyControl = scalar.get("currency")!.control;
  const syncCurrency = () => {
    const next = currencyControl.value.trim().toUpperCase() || null;
    if (next === displayedCurrency) return;
    currencyDigits(next);
    const controls = [
      ...["total_minor", "charged_total_minor", "vat_minor"].map(
        (key) => scalar.get(key as keyof Extraction)!.control,
      ),
      ...lineRows
        .filter((l) => l.row.isConnected)
        .flatMap((l) => [l.unit, l.amount]),
    ];
    const updates = controls.map((control) => ({
      control,
      value: displayMoney(readMoney(control.value, displayedCurrency), next),
    }));
    for (const field of adjustments.values()) {
      const value = field.control.value
        .split("\n")
        .map((line) => {
          if (!line.trim()) return line;
          const split = line.lastIndexOf("=");
          if (split < 1)
            throw Error(
              "Use description = signed amount for each adjustment before changing currency.",
            );
          return `${line.slice(0, split).trim()} = ${displayMoney(readMoney(line.slice(split + 1), displayedCurrency), next)}`;
        })
        .join("\n");
      updates.push({ control: field.control, value });
    }
    for (const update of updates) update.control.value = update.value;
    displayedCurrency = next;
    currencyControl.value = next ?? "";
    currencyHint.textContent = `Amounts reformatted for ${next ?? "currency units (2 decimal places)"}, preserving the saved minor-unit values. Check the displayed amounts before accepting.`;
  };
  const currencyError = el("p");
  currencyError.setAttribute("role", "alert");
  scalar.get("currency")!.wrap.append(currencyError);
  currencyControl.onchange = () => {
    try {
      syncCurrency();
      currencyError.textContent = "";
    } catch (error) {
      currencyError.textContent = messageOf(error);
    }
  };
  const uncertainty = input(
      "Remaining uncertainties",
      e.uncertainties.join("\n"),
      true,
    ),
    broken = input("Broken reasons", e.broken_reasons.join("\n"), true),
    evidence = input("Review findings", e.evidence, true);
  notes.append(uncertainty.wrap, broken.wrap, evidence.wrap);
  form.append(notes);
  const save = el("button", "Accept human review");
  save.type = "submit";
  const cancelButton = el("button", "Cancel");
  cancelButton.type = "button";
  cancelButton.className = "secondary";
  cancelButton.onclick = cancel;
  const actions = el("div");
  actions.className = "review-actions controls";
  const saveMessage = el("p");
  saveMessage.setAttribute("role", "status");
  actions.append(save, cancelButton, saveMessage);
  form.append(actions);
  form.onsubmit = (event) => {
    event.preventDefault();
    void act(async () => {
      saveMessage.textContent = "";
      try {
        syncCurrency();
        currencyError.textContent = "";
        const currency =
          scalar.get("currency")!.control.value.trim().toUpperCase() || null;
        for (const [key, field] of scalar) {
          const value = field.control.value.trim();
          (e as unknown as Record<string, unknown>)[key] = [
            "total_minor",
            "charged_total_minor",
            "vat_minor",
          ].includes(key)
            ? readMoney(value, currency)
            : key === "currency"
              ? currency
              : value || null;
        }
        for (const [key, select] of selects)
          (e as unknown as Record<string, unknown>)[key] = select.value;
        for (const [key, check] of bools)
          (e as unknown as Record<string, unknown>)[key] = check.checked;
        e.category_id = category.value || null;
        e.line_items = lineRows
          .filter((l) => l.row.isConnected)
          .map((l) => ({
            description: l.description.value,
            quantity: number(l.quantity.value),
            unit_price_minor: readMoney(l.unit.value, currency),
            amount_minor: readMoney(l.amount.value, currency),
          }));
        for (const [key, field] of adjustments)
          e[key] = field.control.value
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => {
              const i = l.lastIndexOf("=");
              const amount = readMoney(l.slice(i + 1), currency);
              if (i < 1 || amount === null)
                throw Error(
                  "Use description = signed amount for each adjustment.",
                );
              return {
                description: l.slice(0, i).trim(),
                amount_minor: amount,
              };
            });
        e.uncertainties = uncertainty.control.value
          .split("\n")
          .filter((l) => l.trim());
        e.broken_reasons = broken.control.value
          .split("\n")
          .filter((l) => l.trim());
        e.evidence = evidence.control.value;
        save.disabled = true;
        cancelButton.disabled = true;
        try {
          await api("/api/processing/human-review", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              document_id: doc.id,
              revision: doc.revision,
              extraction: e,
            }),
          });
          await refresh();
        } finally {
          save.disabled = false;
          cancelButton.disabled = false;
        }
      } catch (error) {
        saveMessage.textContent = messageOf(error);
        throw error;
      }
    });
  };
  section.append(form);
  return section;
}
/** Load immutable model values before enabling approval. */
export function processingReview(
  doc: DocumentView,
  categories: PurchaseCategory[],
  act: (task: () => Promise<void>) => Promise<void>,
  refresh: () => Promise<void>,
  ocrSource: ReviewOcrSource,
) {
  const panel = el("section");
  panel.className = "processing-review";
  const controller = new AbortController();
  const load = async () => {
    panel.replaceChildren(el("p", "Loading saved agent readings…"));
    try {
      const data = await api<ReviewReadings>(
        `/api/processing/readings?document_id=${doc.id}`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(45000),
          ]),
        },
      );
      if (!panel.isConnected) return;
      const values = reviewValues(doc, data.attempts);
      const comparisonView = reviewComparison(
        doc,
        values,
        controller.signal,
        ocrSource,
      );
      const comparison = comparisonView.element;
      const history = el("details");
      history.append(
        el("summary", "All agent readings and confirmation evidence"),
      );
      for (const attempt of data.attempts) {
        const entry = el("details");
        entry.append(
          el(
            "summary",
            `${attempt.model} · revision ${attempt.revision} · ${new Date(attempt.created_at).toLocaleString()}`,
          ),
          el("pre", JSON.stringify(attempt.extraction, null, 2)),
        );
        history.append(entry);
      }
      for (const reading of data.readings) {
        const entry = el("details");
        entry.append(
          el(
            "summary",
            `${reading.model} draft and confirmation · ${new Date(reading.created_at).toLocaleString()}`,
          ),
          el("pre", JSON.stringify(reading, null, 2)),
        );
        history.append(entry);
      }
      const editor = el("div");
      const reset = () =>
        editor.replaceChildren(
          reviewForm(
            doc,
            categories,
            act,
            refresh,
            values.extraction,
            values.source,
            () => {
              reset();
              const status = el("p", "Edits cancelled. No review saved.");
              status.setAttribute("role", "status");
              editor.prepend(status);
            },
          ),
        );
      reset();
      comparison.append(history);
      const toolbar = el("div");
      toolbar.className = "review-view-toggle controls";
      toolbar.setAttribute("role", "group");
      toolbar.setAttribute("aria-label", "Review view");
      const editButton = el("button", "Edit receipt");
      const compareButton = el("button", "Compare readings");
      const showComparison = (compare: boolean) => {
        editor.hidden = compare;
        comparison.hidden = !compare;
        editButton.setAttribute("aria-pressed", String(!compare));
        compareButton.setAttribute("aria-pressed", String(compare));
        // Switching views never rebuilds the form or changes its draft values.
        panel.scrollTop = 0;
        if (compare) void comparisonView.loadOcr();
      };
      editButton.type = compareButton.type = "button";
      editButton.onclick = () => showComparison(false);
      compareButton.onclick = () => showComparison(true);
      toolbar.append(editButton, compareButton);
      showComparison(false);
      panel.replaceChildren(toolbar, editor, comparison);
    } catch (error) {
      if (!panel.isConnected) return;
      const retry = el("button", "Retry loading readings");
      retry.onclick = () => void load();
      panel.replaceChildren(el("p", messageOf(error)), retry);
    }
  };
  void load();
  return { element: panel, destroy: () => controller.abort() };
}
export function categorySetup(
  categories: PurchaseCategory[],
  act: (task: () => Promise<void>) => Promise<void>,
  refresh: () => Promise<void>,
) {
  const panel = el("details");
  panel.open = categories.length === 0;
  panel.append(
    el(
      "summary",
      categories.length
        ? "Purchase categories"
        : "Which purchase categories would you like classified?",
    ),
    el(
      "p",
      "Add any specific categories and describe what belongs in each. Processing workers can also add categories for new kinds of purchases.",
    ),
  );
  for (const c of categories)
    panel.append(el("p", `${c.name}: ${c.description}`));
  const form = el("form");
  form.className = "review-form";
  const name = input("Category name", ""),
    description = input("What belongs in this category?", "", true),
    save = el("button", "Add category");
  save.type = "submit";
  form.append(name.wrap, description.wrap, save);
  form.onsubmit = (event) => {
    event.preventDefault();
    void act(async () => {
      await api("/api/processing/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.control.value,
          description: description.control.value,
        }),
      });
      await refresh();
    });
  };
  panel.append(form);
  return panel;
}
