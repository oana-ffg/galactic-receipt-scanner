import { api } from "./api";
import {
  readDocuments,
  saveDocuments,
  generateDocumentPdf,
  processOcr,
} from "./document-processing";
import { registerSiteTools } from "./site-tools";
import {
  newDocument,
  mergeReviewReasons,
  type DocumentCatalog,
  type DocumentView,
  type InvoiceCheck,
} from "./documents";
import { messageOf } from "./errors";
import { inspectImage } from "./image-viewer";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function field(label: string, value: string, multiline = false) {
  const input = multiline ? el("textarea") : el("input");
  input.value = value;
  const wrap = el("label", label, "review-field");
  wrap.append(input);
  return { wrap, input };
}
function amount(value: string): number {
  if (!/^-?\d+$/.test(value.trim()))
    throw Error(
      "Use signed integer minor units, with no decimals or thousands separators.",
    );
  const n = Number(value.trim());
  if (!Number.isSafeInteger(n)) throw Error("Amount is too large.");
  return n;
}

export async function mountReview(app: HTMLElement) {
  app.innerHTML =
    '<header><div><h1>Receipt review</h1><p>Originals and earlier decisions stay intact.</p></div><a href="/">Capture station</a><a href="/issues">Private issues</a></header><p id="review-message" role="status"></p><div class="review-toolbar"><label>Show <select id="review-filter"><option value="attention">Needs attention</option><option value="all">All documents</option><option value="ready">Ready</option><option value="broken">Broken</option><option value="duplicate">Duplicates</option></select></label><label>Search <input id="review-search" type="search"></label><button id="review-refresh" class="secondary">Refresh</button><button id="review-ocr" class="secondary">Transcribe next 20</button></div><p id="review-counts"></p><div class="review-workspace"><nav id="review-list" aria-label="Receipt documents"></nav><section id="review-detail"><p>Select a document to review.</p></section></div>';
  let catalog: DocumentCatalog = { documents: [], captures: [] };
  let selected: string | null = null;
  let busy = false;
  const message = app.querySelector<HTMLElement>("#review-message")!;
  const list = app.querySelector<HTMLElement>("#review-list")!;
  const detail = app.querySelector<HTMLElement>("#review-detail")!;
  const filter = app.querySelector<HTMLSelectElement>("#review-filter")!;
  const search = app.querySelector<HTMLInputElement>("#review-search")!;
  const setMessage = (text: string) => {
    message.textContent = text;
  };
  async function action(task: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await task();
    } catch (e) {
      setMessage(messageOf(e));
    } finally {
      busy = false;
    }
  }
  async function refresh() {
    catalog = await readDocuments();
    renderList();
    if (selected) {
      const d = catalog.documents.find((d) => d.id === selected);
      if (d) renderDetail(d);
    }
  }
  function renderList() {
    list.replaceChildren();
    const counts = catalog.documents.reduce<Record<string, number>>(
      (a, d) => ((a[d.status] = (a[d.status] ?? 0) + 1), a),
      {},
    );
    app.querySelector("#review-counts")!.textContent =
      `${counts.ready ?? 0} ready · ${counts.review ?? 0} need review · ${counts.broken ?? 0} broken · ${counts.duplicate ?? 0} duplicates`;
    for (const d of catalog.documents) {
      if (d.status === "merged") continue;
      if (
        filter.value === "attention" &&
        !["review", "broken"].includes(d.status)
      )
        continue;
      if (
        !["attention", "all"].includes(filter.value) &&
        d.status !== filter.value
      )
        continue;
      const number =
        catalog.captures
          .filter((c) => c.is_current)
          .findIndex((c) => c.id === d.pages[0]?.captureId) + 1;
      const label =
        d.filename ?? `Picture ${number || ""} · vendor/date to identify`;
      if (
        !`${label} ${d.reference ?? ""} ${d.text} ${d.reasons.join(" ")}`
          .toLowerCase()
          .includes(search.value.toLowerCase())
      )
        continue;
      const button = el("button", undefined, `review-item ${d.status}`);
      button.setAttribute("aria-current", String(d.id === selected));
      button.append(
        el("strong", label),
        el(
          "span",
          `${d.status} · ${d.pages.length} page${d.pages.length === 1 ? "" : "s"}`,
        ),
        el(
          "small",
          d.reasons[0] ??
            (d.duplicateOf
              ? "Original retained; excluded from output"
              : "Checks complete"),
        ),
      );
      button.onclick = () => {
        if (busy) return;
        selected = d.id;
        renderList();
        renderDetail(d);
      };
      list.append(button);
    }
    if (!list.childElementCount)
      list.append(el("p", "No documents match this view."));
  }
  function renderDetail(original: DocumentView) {
    const doc = structuredClone(original);
    detail.replaceChildren();
    detail.append(el("h2", doc.filename ?? "Identify this document"));
    const reasons = el("ul", undefined, `review-reasons ${doc.status}`);
    for (const reason of doc.reasons) reasons.append(el("li", reason));
    detail.append(reasons);
    const sources = el("div", undefined, "review-sources");
    doc.pages.forEach((p, index) => {
      const capture = catalog.captures.find((c) => c.id === p.captureId)!;
      const card = el("article");
      card.append(
        el("h3", `Page ${index + 1}`),
        el(
          "p",
          `Scanned ${new Date(capture.created_at).toLocaleString()} · ${capture.is_current ? "current take" : "previous take"}`,
        ),
      );
      const image = el("img");
      image.src = `/api/files/${p.captureId}/raw`;
      image.alt = `Original page ${index + 1}`;
      image.loading = "lazy";
      card.append(image);
      const controls = el("div", undefined, "controls");
      const zoom = el("button", "Inspect original", "secondary");
      zoom.onclick = () =>
        inspectImage({
          title: `Original page ${index + 1}`,
          alt: image.alt,
          image: image.src,
          capture,
          download: { source: image.src, label: "Download original" },
        });
      controls.append(zoom);
      const earlier = el("button", "Move earlier", "secondary");
      earlier.disabled = index === 0;
      earlier.onclick = () => {
        [doc.pages[index - 1], doc.pages[index]] = [
          doc.pages[index],
          doc.pages[index - 1],
        ];
        doc.checks.grouping = false;
        doc.checks.pdf = false;
        renderDetail(doc);
      };
      controls.append(earlier);
      const rotate = el("button", "Rotate 90°", "secondary");
      rotate.onclick = () => {
        p.rotation = ((p.rotation + 90) % 360) as typeof p.rotation;
        doc.checks.pdf = false;
        renderDetail(doc);
      };
      controls.append(rotate);
      card.append(
        controls,
        el(
          "p",
          `PDF rotation: ${p.rotation}° · ${p.crop ? "reviewed crop" : "complete original"}`,
        ),
      );
      sources.append(card);
    });
    detail.append(sources);
    const form = el("form");
    form.className = "review-form";
    const vendor = field("Vendor", doc.vendor ?? "");
    const date = field("Receipt date", doc.receiptDate ?? "");
    (date.input as HTMLInputElement).type = "date";
    const reference = field("Receipt / invoice number", doc.reference ?? "");
    form.append(vendor.wrap, date.wrap, reference.wrap);
    const kind = el("select");
    for (const value of ["unknown", "receipt", "invoice", "credit-note"]) {
      const option = el("option", value);
      option.value = value;
      kind.append(option);
    }
    kind.value = doc.kind;
    const kindLabel = el("label", "Document type", "review-field");
    kindLabel.append(kind);
    form.append(kindLabel);
    const handwriting = el("select");
    for (const value of ["unchecked", "absent", "present", "uncertain"]) {
      const option = el("option", value);
      option.value = value;
      handwriting.append(option);
    }
    handwriting.value = doc.handwriting;
    const handLabel = el("label", "Handwriting", "review-field");
    handLabel.append(handwriting);
    form.append(handLabel);
    const annotationInputs = doc.annotations.map((annotation) => {
      const note = field("Handwritten annotation", annotation.text ?? "", true);
      const uncertain = el("input");
      uncertain.type = "checkbox";
      uncertain.checked = annotation.uncertain;
      const label = el("label", undefined, "toggle");
      label.append(uncertain, "Still uncertain — needs human review");
      form.append(note.wrap, label);
      return { annotation, note, uncertain };
    });
    const newNote = field(
      "New handwritten note on page 1 (leave blank to keep existing annotations)",
      "",
      true,
    );
    form.append(newNote.wrap);
    const text = field("Source-backed transcription", doc.text, true);
    form.append(text.wrap);
    const uncertainties = field(
      "Needs human review — one reason per line",
      doc.uncertainties.join("\n"),
      true,
    );
    const broken = field(
      "Broken — one failure per line",
      doc.broken.join("\n"),
      true,
    );
    const evidence = field("What was checked and resolved", doc.evidence, true);
    form.append(uncertainties.wrap, broken.wrap, evidence.wrap);
    const checks = el("fieldset");
    checks.append(el("legend", "Confirm only what you have inspected"));
    const checkInputs = new Map<string, HTMLInputElement>();
    for (const [key, label] of Object.entries({
      visual: "Every original is legible and complete",
      transcription: "OCR/transcription matches all printed text and notes",
      grouping:
        "Page order, completeness and duplicates checked across the batch",
      pdf: "Generated PDF inspected for clipping and legibility",
    })) {
      const input = el("input");
      input.type = "checkbox";
      input.checked = doc.checks[key as keyof typeof doc.checks];
      if (key === "pdf")
        input.checked =
          doc.checks.pdf && doc.pdf?.sha256 === doc.reviewedPdfSha256;
      if (key === "pdf" && !doc.pdf) {
        input.checked = false;
        input.disabled = true;
      }
      checkInputs.set(key, input);
      const wrap = el("label", undefined, "toggle");
      wrap.append(input, label);
      checks.append(wrap);
    }
    form.append(checks);
    const invoice = el("details");
    invoice.open = doc.kind === "invoice" || doc.kind === "credit-note";
    invoice.append(
      el("summary", "Invoice arithmetic"),
      el(
        "p",
        "Enter printed line amounts after line discounts. Add tax only for net lines. Include signed document discounts, freight and printed rounding; never infer an unreadable digit. Enter integer minor units: DKK 12.34 is 1234; JPY 1000 is 1000.",
      ),
    );
    const currency = field("Currency", doc.invoice?.currency ?? "");
    const total = field(
      "Printed total (minor units)",
      doc.invoice ? String(doc.invoice.total) : "",
    );
    const lines = field(
      "Line amounts (minor units) — one per line",
      doc.invoice?.lines.join("\n") ?? "",
      true,
    );
    const adjustments = field(
      "Adjustments — label = signed minor units, one per line",
      doc.invoice?.adjustments
        .map((a) => `${a.label} = ${a.amount}`)
        .join("\n") ?? "",
      true,
    );
    const basis = el("select");
    for (const [value, label] of [
      ["gross", "Lines include tax"],
      ["net-plus-tax", "Net lines plus explicit tax"],
    ]) {
      const option = el("option", label);
      option.value = value;
      basis.append(option);
    }
    basis.value = doc.invoice?.basis ?? "gross";
    const basisLabel = el("label", "Amounts basis", "review-field");
    basisLabel.append(basis);
    const invoiceEvidence = field(
      "Arithmetic evidence and interpretation",
      doc.invoice?.evidence ?? "",
      true,
    );
    invoice.append(
      currency.wrap,
      total.wrap,
      lines.wrap,
      adjustments.wrap,
      basisLabel,
      invoiceEvidence.wrap,
    );
    form.append(invoice);
    const save = el("button", "Save review");
    save.type = "submit";
    form.append(save);
    form.onsubmit = (event) => {
      event.preventDefault();
      void action(async () => {
        if (
          doc.vendor !== (vendor.input.value.trim() || null) ||
          doc.receiptDate !== (date.input.value || null)
        )
          checkInputs.get("pdf")!.checked = false;
        doc.vendor = vendor.input.value.trim() || null;
        doc.receiptDate = date.input.value || null;
        doc.reference = reference.input.value.trim() || null;
        doc.kind = kind.value as typeof doc.kind;
        doc.handwriting = handwriting.value as typeof doc.handwriting;
        doc.text = text.input.value;
        doc.evidence = evidence.input.value;
        doc.uncertainties = uncertainties.input.value
          .split("\n")
          .filter((v) => v.trim());
        doc.broken = broken.input.value.split("\n").filter((v) => v.trim());
        for (const [key, input] of checkInputs)
          doc.checks[key as keyof typeof doc.checks] = input.checked;
        doc.reviewedPdfSha256 = doc.checks.pdf
          ? (original.pdf?.sha256 ?? null)
          : null;
        for (const item of annotationInputs) {
          item.annotation.text = item.note.input.value.trim() || null;
          item.annotation.uncertain = item.uncertain.checked;
        }
        if (newNote.input.value.trim()) {
          const p = doc.pages[0];
          const dimensions = catalog.captures.find((c) => c.id === p.captureId)
            ?.metadata.sourcePixels;
          if (!dimensions)
            throw Error(
              "Source dimensions unavailable. Record a source region through the processing agent.",
            );
          doc.annotations.push({
            captureId: p.captureId,
            box: [0, 0, dimensions[0], dimensions[1]],
            text: newNote.input.value.trim(),
            uncertain: true,
          });
          doc.handwriting = "present";
        }
        if (total.input.value.trim() || lines.input.value.trim())
          doc.invoice = {
            currency: currency.input.value.trim().toUpperCase(),
            total: amount(total.input.value),
            lines: lines.input.value
              .split("\n")
              .filter((v) => v.trim())
              .map(amount),
            adjustments: adjustments.input.value
              .split("\n")
              .filter((v) => v.trim())
              .map((line) => {
                const split = line.lastIndexOf("=");
                if (split < 1)
                  throw Error("Each adjustment needs label = amount.");
                return {
                  label: line.slice(0, split).trim(),
                  amount: amount(line.slice(split + 1)),
                };
              }),
            basis: basis.value as InvoiceCheck["basis"],
            evidence: invoiceEvidence.input.value,
          };
        if (
          !["invoice", "credit-note"].includes(doc.kind) ||
          (!total.input.value.trim() && !lines.input.value.trim())
        )
          doc.invoice = null;
        await saveDocuments([doc]);
        await refresh();
        setMessage(
          "Review saved. Earlier decisions and originals are preserved.",
        );
      });
    };
    detail.append(form);
    const outputs = el("div", undefined, "controls");
    const generate = el("button", "Generate PDF", "secondary");
    generate.onclick = () =>
      void action(async () => {
        setMessage("Generating from the saved page order…");
        const current = (await readDocuments()).documents.find(
          (d) => d.id === doc.id,
        )!;
        try {
          const result = await generateDocumentPdf(current);
          setMessage(
            `Saved ${result.filename}. Inspect it before confirming the PDF check.`,
          );
        } catch (error) {
          current.broken = [
            ...new Set([...current.broken, `PDF failed: ${messageOf(error)}`]),
          ];
          await saveDocuments([current]);
          throw error;
        } finally {
          await refresh();
        }
      });
    outputs.append(generate);
    if (doc.pdf) {
      const link = el("a", "Download saved PDF");
      link.href = `/api/documents/${doc.id}/pdf?version=${doc.pdf.sha256}&revision=${doc.pdf.revision}`;
      outputs.append(link);
    }
    detail.append(outputs);
    if (doc.duplicateOf) {
      const restore = el(
        "button",
        "Restore as a separate document",
        "secondary",
      );
      restore.onclick = () =>
        void action(async () => {
          const fresh = (await readDocuments()).documents.find(
            (d) => d.id === doc.id,
          )!;
          fresh.duplicateOf = null;
          fresh.checks.grouping = false;
          fresh.evidence +=
            "\nDuplicate relationship removed for renewed review.";
          await saveDocuments([fresh]);
          await refresh();
        });
      detail.append(restore);
    }
    const organize = el("details");
    organize.append(
      el("summary", "Group pages or mark a duplicate"),
      el(
        "p",
        "Choose the matching document using source evidence. Pages can be scanned far apart. Grouping appends this document’s pages; check the order afterward.",
      ),
    );
    const target = el("select");
    const empty = el("option", "Choose document…");
    empty.value = "";
    target.append(empty);
    for (const other of catalog.documents.filter(
      (d) => d.id !== doc.id && !d.mergedInto && !d.duplicateOf,
    )) {
      const option = el(
        "option",
        `${other.filename ?? other.vendor ?? "Unidentified"} · ${other.scannedAt[0] ?? ""} · ${other.id.slice(0, 8)}`,
      );
      option.value = other.id;
      target.append(option);
    }
    const targetLabel = el("label", "Destination document", "review-field");
    targetLabel.append(target);
    organize.append(targetLabel);
    const reason = field("Evidence for the relationship", "", true);
    organize.append(reason.wrap);
    for (const [label, duplicate] of [
      ["Group pages into destination", false],
      ["Mark as duplicate of destination", true],
    ] as const) {
      const button = el("button", label, "secondary");
      button.onclick = () =>
        void action(async () => {
          const fresh = await readDocuments();
          const source = fresh.documents.find((d) => d.id === doc.id)!;
          const destination = fresh.documents.find(
            (d) => d.id === target.value,
          );
          if (!destination || !reason.input.value.trim())
            throw Error(
              "Choose a destination and describe the matching evidence.",
            );
          source.evidence = reason.input.value;
          if (duplicate) {
            source.duplicateOf = destination.id;
            await saveDocuments([source]);
          } else {
            destination.pages.push(...source.pages);
            destination.annotations.push(...source.annotations);
            destination.text = [destination.text, source.text]
              .filter(Boolean)
              .join("\n\n");
            destination.uncertainties.push(...source.uncertainties);
            destination.broken.push(...mergeReviewReasons(source).broken);
            destination.handwriting = destination.annotations.length
              ? "present"
              : "unchecked";
            destination.invoice = null;
            destination.uncertainties.push(
              "After grouping, reconcile transcription and invoice components with every retained page.",
            );
            destination.checks = {
              visual: false,
              transcription: false,
              grouping: false,
              pdf: false,
            };
            destination.evidence += `\n${reason.input.value}`;
            source.pages = [];
            source.annotations = [];
            source.handwriting = "unchecked";
            source.checks = {
              visual: false,
              transcription: false,
              grouping: false,
              pdf: false,
            };
            source.mergedInto = destination.id;
            await saveDocuments([source, destination]);
            selected = destination.id;
          }
          await refresh();
          setMessage("Relationship saved; every source is retained.");
        });
      organize.append(button);
    }
    detail.append(organize);
    if (doc.pages.length > 1) {
      const split = el(
        "button",
        "Split last page into a separate document",
        "secondary",
      );
      split.onclick = () =>
        void action(async () => {
          const source = (await readDocuments()).documents.find(
            (d) => d.id === doc.id,
          )!;
          const page = source.pages.pop()!;
          const capture = catalog.captures.find(
            (c) => c.id === page.captureId,
          )!;
          const separate = newDocument(capture);
          separate.id = crypto.randomUUID();
          separate.pages = [page];
          separate.annotations = source.annotations.filter(
            (a) => a.captureId === page.captureId,
          );
          source.annotations = source.annotations.filter(
            (a) => a.captureId !== page.captureId,
          );
          source.handwriting = source.annotations.length
            ? "present"
            : "unchecked";
          separate.handwriting = separate.annotations.length
            ? "present"
            : "unchecked";
          source.text = "";
          source.invoice = null;
          source.checks = {
            visual: false,
            transcription: false,
            grouping: false,
            pdf: false,
          };
          source.uncertainties.push(
            "After splitting, transcribe the retained pages and recheck invoice arithmetic; previous values remain in decision history.",
          );
          await saveDocuments([source, separate]);
          await refresh();
          setMessage("Page separated; review both documents.");
        });
      detail.append(split);
    }
    const history = el("button", "Show decision history", "secondary");
    history.onclick = () =>
      void action(async () => {
        const rows = await api<
          { revision: number; payload: string; created_at: string }[]
        >(`/api/documents/${doc.id}/history`);
        const historyList = el("div");
        for (const row of rows) {
          const d = JSON.parse(row.payload);
          historyList.append(
            el(
              "p",
              `Revision ${row.revision} · ${new Date(row.created_at).toLocaleString()} · ${d.evidence || "No verification yet"}`,
            ),
          );
        }
        history.replaceWith(historyList);
      });
    detail.append(history);
  }
  filter.onchange = renderList;
  search.oninput = renderList;
  app.querySelector<HTMLButtonElement>("#review-refresh")!.onclick = () =>
    void action(refresh);
  app.querySelector<HTMLButtonElement>("#review-ocr")!.onclick = () =>
    void action(async () => {
      const ids = catalog.captures
        .filter(
          (c) =>
            c.is_current &&
            c.status === "accepted" &&
            c.ocr_status !== "unverified",
        )
        .slice(0, 20)
        .map((c) => c.id);
      if (!ids.length) {
        setMessage(
          "No accepted originals awaiting OCR. Review the saved transcriptions and forced captures.",
        );
        return;
      }
      setMessage(
        "Transcribing up to 20 originals. Keep this tab open; scanning remains independent.",
      );
      const result = await processOcr(ids);
      await refresh();
      setMessage(
        `${result.results.filter((r) => r.ok).length} transcribed; ${result.results.filter((r) => !r.ok).length} failed. All OCR needs visual review.`,
      );
    });
  registerSiteTools(refresh);
  await action(refresh);
}
