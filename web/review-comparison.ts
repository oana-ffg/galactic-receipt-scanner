import type { PurchaseCategory } from "./extraction";
import type { DocumentView } from "./documents";
import { displayMoney } from "./review-money";
import { messageOf } from "./errors";
import {
  ocrExcerpts,
  type ReviewOcrSource,
  type ReviewOcr,
} from "./review-ocr";
import type { reviewValues, SavedReading } from "./review-values";
import { formatOcrConfidence } from "./ocr-confidence";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
};
const money = (value: number | null, currency: string | null) =>
  value === null
    ? "Unknown"
    : `${displayMoney(value, currency)} ${currency ?? "(currency unknown)"}`;
const date = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
const modelName = (model: string) =>
  model === "human"
    ? "Human review"
    : /(?:^|-)luna$/.test(model)
      ? "Luna"
      : /(?:^|-)astra$/.test(model)
        ? "Astra"
        : model;
const fields = [
  ["vendor", "Vendor"],
  ["category_id", "Purchase category"],
  ["receipt_date", "Purchase date"],
  ["reference", "Reference"],
  ["currency", "Currency"],
  ["total_minor", "Total"],
  ["charged_total_minor", "Charged total"],
  ["vat_minor", "VAT"],
  ["card_last_four", "Last four card digits"],
] as const;
type Column = { name: string; reading?: SavedReading; ocr?: ReviewOcr };

/** Saved values remain independent of the editable human draft. */
export function reviewComparison(
  doc: DocumentView,
  categories: PurchaseCategory[],
  values: ReturnType<typeof reviewValues>,
  signal: AbortSignal,
  ocrSource: ReviewOcrSource,
) {
  const section = el("section");
  section.className = "review-comparison";
  section.setAttribute("aria-label", "Model comparison");
  const status = el("p", "Open comparison to load saved OCR.");
  status.setAttribute("role", "status");
  const content = el("div");
  const modelColumns = values.models.map((reading) => ({
    name: modelName(reading.model),
    reading,
  }));
  let ocr: ReviewOcr[] = [];
  let loaded = false,
    loading = false;
  const selected = new Set(modelColumns.map((c) => c.reading.model));
  const render = () => {
    const columns: Column[] = [
      ...modelColumns,
      ...ocr.map((o) => ({ name: `OCR · ${o.engine}`, ocr: o })),
    ];
    const controls = el("fieldset");
    controls.className = "comparison-sources";
    controls.append(el("legend", "Sources to compare"));
    for (const column of columns) {
      const key = column.reading?.model ?? `ocr:${column.ocr!.engine}`;
      const label = el("label");
      const check = el("input");
      check.type = "checkbox";
      check.checked = selected.has(key);
      check.onchange = () => {
        if (check.checked) selected.add(key);
        else selected.delete(key);
        render();
      };
      label.append(check, column.name);
      controls.append(label);
    }
    const visible = columns.filter((c) =>
      selected.has(c.reading?.model ?? `ocr:${c.ocr!.engine}`),
    );
    const scroll = el("div");
    scroll.className = "comparison-table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("aria-label", "Saved values comparison table");
    const table = el("table");
    table.style.minWidth =
      visible.length > 3 ? `${120 + visible.length * 140}px` : "0";
    table.append(el("caption", "Saved values by source"));
    const head = el("thead"),
      header = el("tr"),
      first = el("th", "Field");
    first.scope = "col";
    header.append(first);
    for (const column of visible) {
      const heading = el("th", column.name);
      heading.scope = "col";
      if (column.reading) {
        const r = column.reading;
        const superseded =
          r.stage === "small"
            ? doc.processing!.small_model_certainty === null
            : r.stage === "large"
              ? doc.processing!.large_model_confidence === null
              : r.stage === "human" && !doc.processing!.has_human_review;
        heading.append(
          el(
            "small",
            `${r.model} · revision ${r.revision}${superseded ? " · superseded" : ""}`,
          ),
        );
      } else
        heading.append(
          el(
            "small",
            `Verbatim text excerpts · ${column.ocr!.pages.length}/${doc.pages.length} pages`,
          ),
        );
      if (column.ocr?.pages.some((p) => !p.sameRegion))
        heading.append(
          el("small", "Includes a different or unknown crop/rotation"),
        );
      for (const page of column.ocr?.pages ?? [])
        heading.append(
          el(
            "small",
            `Page ${page.number} OCR confidence: ${formatOcrConfidence(page.confidence)}`,
          ),
        );
      header.append(heading);
    }
    head.append(header);
    const body = el("tbody");
    for (const [key, label] of fields) {
      const row = el("tr"),
        heading = el("th", label);
      heading.scope = "row";
      row.append(heading);
      const known = visible.flatMap(({ reading }) =>
        reading
          ? [
              JSON.stringify([
                reading.extraction[key],
                key.endsWith("_minor") ? reading.extraction.currency : null,
              ]),
            ]
          : [],
      );
      if (new Set(known).size > 1) {
        row.className = "review-difference";
        heading.append(el("small", "Different"));
      }
      for (const column of visible) {
        const cell = el("td");
        if (column.reading) {
          const e = column.reading.extraction,
            value = e[key];
          cell.textContent =
            key === "category_id"
              ? value === null
                ? "Unclassified"
                : (categories.find((c) => c.id === value)?.name ??
                  "Unknown category")
              : value === null
                ? "Unknown"
                : key.endsWith("_minor")
                  ? money(value as number, e.currency)
                  : key === "receipt_date"
                    ? date(value as string)
                    : String(value);
        } else if (key === "category_id") {
          cell.textContent = "Not assigned by OCR";
        } else {
          const excerpts = ocrExcerpts(column.ocr!, key);
          cell.className = "ocr-excerpts";
          if (excerpts.length)
            for (const excerpt of excerpts) cell.append(el("p", excerpt));
          else
            cell.append(el("span", "No structured field. See OCR text below."));
        }
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    scroll.append(table);
    const lines = el("details");
    lines.append(
      el("summary", "Compare line items and adjustments"),
      el(
        "p",
        "Lists use each model’s saved order; positions are not matched across models. OCR line items are in OCR text below.",
      ),
    );
    const lists = el("div");
    lists.className = "model-line-lists";
    for (const { name, reading } of visible) {
      if (!reading) continue;
      const column = el("section"),
        e = reading.extraction;
      column.setAttribute("aria-label", `${name} line items`);
      column.append(
        el("h4", name),
        el("p", `${e.line_items.length} line items`),
      );
      const list = el("ol");
      for (const line of e.line_items) {
        const item = el("li");
        item.append(
          el("strong", line.description),
          el("div", `Amount: ${money(line.amount_minor, e.currency)}`),
          el(
            "small",
            `Qty: ${line.quantity ?? "Unknown"} · Unit price: ${money(line.unit_price_minor, e.currency)}`,
          ),
        );
        list.append(item);
      }
      column.append(list);
      for (const [key, label] of [
        ["adjustments", "Document adjustments"],
        ["payment_adjustments", "Payment adjustments"],
      ] as const) {
        column.append(el("h5", label));
        if (!e[key].length) column.append(el("p", "None recorded"));
        for (const a of e[key])
          column.append(
            el("p", `${a.description}: ${money(a.amount_minor, e.currency)}`),
          );
      }
      lists.append(column);
    }
    lines.append(lists);
    const transcript = el("details");
    transcript.append(
      el("summary", "OCR text"),
      el(
        "p",
        "OCR confidence measures text recognition, not verified accuracy. PP-OCRv6 page confidence is the mean of its line scores. Amber marks scores below 85% or unavailable scores.",
      ),
    );
    const searchLabel = el("label", "Find in OCR text"),
      search = el("input");
    search.type = "search";
    searchLabel.className = "review-field";
    searchLabel.append(search);
    const results = el("div");
    results.className = "ocr-transcript";
    const showText = () => {
      results.replaceChildren();
      for (const o of ocr)
        for (const page of o.pages) {
          const group = el("section");
          group.append(
            el("h4", `${o.engine} · Page ${page.number}`),
            el(
              "small",
              `${new Date(page.createdAt).toLocaleString()} · ${page.sameRegion ? "Current crop" : "Different or unknown crop/rotation"} · checksum verified`,
            ),
          );
          group.append(
            el(
              "p",
              `Page OCR confidence: ${formatOcrConfidence(page.confidence)}`,
            ),
          );
          const rows = page.lines.filter((line) =>
            line.text.toLowerCase().includes(search.value.toLowerCase()),
          );
          if (rows.length) {
            const table = el("table");
            table.className = "ocr-confidence-table";
            table.append(
              el(
                "caption",
                `${o.engine} · Page ${page.number} line confidence`,
              ),
            );
            const head = el("thead"),
              header = el("tr"),
              body = el("tbody");
            for (const label of ["Recognized text", "Confidence"]) {
              const cell = el("th", label);
              cell.scope = "col";
              header.append(cell);
            }
            head.append(header);
            for (const line of rows) {
              const row = el("tr");
              row.classList.toggle(
                "ocr-uncertain",
                line.confidence === null || line.confidence < 85,
              );
              row.append(
                el("td", line.text),
                el("td", formatOcrConfidence(line.confidence)),
              );
              body.append(row);
            }
            table.append(head, body);
            group.append(table);
          } else group.append(el("p", "No matching text."));
          results.append(group);
        }
    };
    search.oninput = showText;
    showText();
    transcript.append(searchLabel, results);
    content.replaceChildren(
      controls,
      el(
        "p",
        `Highlighted model values differ. OCR shows verbatim candidate lines.${visible.length > 3 ? " Scroll horizontally for more sources." : ""}`,
      ),
      scroll,
      lines,
      transcript,
    );
  };
  section.append(
    el("h3", "Compare readings"),
    el(
      "p",
      "Saved results for these source pages. Your edits remain in Edit receipt.",
    ),
    status,
    content,
  );
  render();
  const loadOcr = async () => {
    if (loaded || loading) return;
    loading = true;
    status.replaceChildren(el("span", "Loading saved OCR…"));
    try {
      const result = await ocrSource.load();
      if (!section.isConnected || signal.aborted) return;
      ocr = result.engines;
      loaded = result.errors.length === 0;
      for (const o of ocr) selected.add(`ocr:${o.engine}`);
      status.textContent = ocr.length
        ? ""
        : "No saved OCR for these source pages.";
      render();
      if (result.errors.length) {
        const failures = el("details");
        failures.append(
          el(
            "summary",
            `OCR incomplete: ${result.errors.length} saved artifact/page loads failed`,
          ),
        );
        for (const error of result.errors) failures.append(el("p", error));
        const retry = el("button", "Retry loading OCR");
        retry.type = "button";
        retry.onclick = () => void loadOcr();
        status.replaceChildren(failures, retry);
      }
    } catch (error) {
      if (!section.isConnected || signal.aborted) return;
      const retry = el("button", "Retry loading OCR");
      retry.type = "button";
      retry.onclick = () => void loadOcr();
      status.replaceChildren(el("span", messageOf(error)), retry);
    } finally {
      loading = false;
    }
  };
  return { element: section, loadOcr };
}
