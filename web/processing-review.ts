import { api } from "./api";
import {
  arithmetic,
  documentTypes,
  type Extraction,
  type PurchaseCategory,
} from "./extraction";
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
export function processingReview(
  doc: DocumentView,
  categories: PurchaseCategory[],
  act: (task: () => Promise<void>) => Promise<void>,
  refresh: () => Promise<void>,
) {
  const p = doc.processing!,
    e = structuredClone(p.extraction),
    section = el("section");
  section.append(
    el("h3", "Extracted receipt"),
    el(
      "p",
      `Luna: ${p.small_model_certainty ?? "not parsed"} · Astra: ${p.large_model_confidence ?? "not reviewed"} · Human reviewed: ${p.has_human_review ? "yes" : "no"}`,
    ),
  );
  const a = arithmetic(e);
  section.append(
    el(
      "p",
      `Printed arithmetic: ${a.status}${a.difference !== null ? ` (${a.difference} minor units difference)` : ""}`,
    ),
  );
  if (p.ocr_comparison) {
    section.append(
      el(
        "p",
        `Plain OCR comparison: ${p.ocr_comparison.status}. The original image is the source of truth.`,
      ),
    );
    const discrepancies = el("ul");
    for (const reason of p.ocr_comparison.disagreements)
      discrepancies.append(el("li", reason));
    section.append(discrepancies);
    if (p.ocr_comparison.resolution)
      section.append(el("p", p.ocr_comparison.resolution));
  }
  const form = el("form");
  form.className = "review-form";
  const scalar = new Map<keyof Extraction, ReturnType<typeof input>>();
  for (const [key, label] of [
    ["vendor", "Vendor"],
    ["receipt_date", "Purchase date"],
    ["reference", "Reference"],
    ["currency", "Currency"],
    ["total_minor", "Printed total (minor units)"],
    ["charged_total_minor", "Charged total (minor units)"],
    ["vat_minor", "VAT shown (minor units)"],
    ["card_last_four", "Last four card digits"],
  ] as const) {
    const field = input(label, e[key] === null ? "" : String(e[key]));
    scalar.set(key, field);
    if (key === "receipt_date")
      (field.control as HTMLInputElement).type = "date";
    form.append(field.wrap);
  }
  const selects = new Map<keyof Extraction, HTMLSelectElement>();
  for (const [key, label, values] of [
    ["type", "Document type", documentTypes],
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
    form.append(wrap);
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
  form.append(categoryLabel);
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
    form.append(wrap);
    bools.set(key, check);
  }
  const lineSection = el("div");
  lineSection.append(
    el("h4", "Line items"),
    el(
      "p",
      "Amounts use minor units: 12.34 is 1234 for DKK. Leave unreadable values blank.",
    ),
  );
  const lineRows: {
    description: HTMLInputElement;
    quantity: HTMLInputElement;
    unit: HTMLInputElement;
    amount: HTMLInputElement;
    row: HTMLElement;
  }[] = [];
  const addLine = (l: Extraction["line_items"][number]) => {
    const row = el("div");
    row.className = "review-form";
    const description = input("Item", l.description),
      quantity = input(
        "Quantity",
        l.quantity === null ? "" : String(l.quantity),
      ),
      unit = input(
        "Unit price",
        l.unit_price_minor === null ? "" : String(l.unit_price_minor),
      ),
      amount = input(
        "Line amount",
        l.amount_minor === null ? "" : String(l.amount_minor),
      );
    row.append(description.wrap, quantity.wrap, unit.wrap, amount.wrap);
    const remove = el("button", "Remove line");
    remove.type = "button";
    remove.className = "secondary";
    remove.onclick = () => row.remove();
    row.append(remove);
    lineSection.append(row);
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
      "Document adjustments — description = signed minor units, one per line",
    ],
    [
      "payment_adjustments",
      "Payment fees / adjustments — description = signed minor units, one per line",
    ],
  ] as const) {
    const field = input(
      label,
      e[key].map((a) => `${a.description} = ${a.amount_minor}`).join("\n"),
      true,
    );
    adjustments.set(key, field);
    form.append(field.wrap);
  }
  const uncertainty = input(
      "Remaining uncertainties",
      e.uncertainties.join("\n"),
      true,
    ),
    broken = input("Broken reasons", e.broken_reasons.join("\n"), true),
    evidence = input("Review findings", e.evidence, true);
  form.append(uncertainty.wrap, broken.wrap, evidence.wrap);
  const save = el("button", "Save and mark human reviewed");
  save.type = "submit";
  form.append(save);
  form.onsubmit = (event) => {
    event.preventDefault();
    void act(async () => {
      for (const [key, field] of scalar) {
        const value = field.control.value.trim();
        (e as unknown as Record<string, unknown>)[key] = [
          "total_minor",
          "charged_total_minor",
          "vat_minor",
        ].includes(key)
          ? number(value)
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
          unit_price_minor: number(l.unit.value),
          amount_minor: number(l.amount.value),
        }));
      for (const [key, field] of adjustments)
        e[key] = field.control.value
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => {
            const i = l.lastIndexOf("=");
            const amount = number(l.slice(i + 1));
            if (i < 1 || amount === null)
              throw Error(
                "Use description = signed amount for each adjustment.",
              );
            return { description: l.slice(0, i).trim(), amount_minor: amount };
          });
      e.uncertainties = uncertainty.control.value
        .split("\n")
        .filter((l) => l.trim());
      e.broken_reasons = broken.control.value
        .split("\n")
        .filter((l) => l.trim());
      e.evidence = evidence.control.value;
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
    });
  };
  section.append(form);
  return section;
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
