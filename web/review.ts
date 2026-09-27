import { documentPreview } from "./document-preview";
import { reviewOcrSource } from "./review-ocr";
import { processingReview, categorySetup } from "./processing-review";
import { documentTypes, type PurchaseCategory } from "./extraction";
import { api } from "./api";
import {
  readDocuments,
  readDocument,
  readDocumentSummaries,
  type DocumentSummary,
  saveDocuments,
  generateDocumentPdf,
  OcrPendingError,
} from "./document-processing";
import { registerSiteTools } from "./site-tools";
import {
  newDocument,
  needsSourceIntervention,
  pendingSourceIntervention,
  completenessUncertain,
  mergeReviewReasons,
  retargetAbsorbedAliases,
  type DocumentCatalog,
  type DocumentView,
  type InvoiceCheck,
} from "./documents";
import { messageOf, RequestError } from "./errors";
import { inspectImage } from "./image-viewer";
import { captureNotes } from "./capture-notes";
import { receiptHandoff } from "./receipt-handoff";

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
type PaymentMatch = {
  assessment_id: string;
  matched_at: string;
  match_pass: "date" | "amount" | "likely";
  receipt_document_id: string;
  payment_document_id: string;
  original_receipt_document_id: string;
  original_payment_document_id: string;
  receipt_label: string;
  payment_label: string;
  human_reviewed: boolean;
  status: "attached" | "needs-review" | "changed";
  evidence_current: boolean;
  probability: number;
  confidence: number;
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
    '<header><div><h1>Receipt review</h1><p>Originals and earlier decisions stay intact.</p></div><a href="/">Capture station</a><a href="/issues">Private issues</a><a href="/agent-access">Agent access</a></header><p id="review-message" role="status"></p><p id="review-intervention-alert" role="alert"></p><div class="review-toolbar"><label>Show <select id="review-filter"><option value="all">All documents</option><option value="human-reviewed">Human reviewed</option><option value="payment-matches">Payment matches</option><option value="source-intervention">Needs source intervention</option><option value="scan-review">Completeness scan review</option><option value="luna-reparse">Needs Luna reparse</option><option value="non-receipt">Non-receipt documents</option><option value="attention">Human review and broken</option><option value="processing">Awaiting processing</option><option value="awaiting-pages">Waiting for pages</option><option value="model-review">Astra review</option><option value="review">Human review</option><option value="ready">Ready</option><option value="broken">Broken</option><option value="duplicate">Duplicates</option></select></label><label>Confidence <select id="review-confidence"><option value="low-medium">Low or medium</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="unknown">Not assessed</option><option value="all">Any confidence</option></select></label><label>Model review <select id="review-model"><option value="astra">Astra available</option><option value="luna">Luna available</option><option value="luna-only">Luna only</option><option value="none">No model review</option><option value="all">Any model</option></select></label><label>Human review <select id="review-human"><option value="pending">Not yet reviewed</option><option value="reviewed">Reviewed</option><option value="all">Any</option></select></label><label>Search <input id="review-search" type="search"></label><button id="review-refresh" class="secondary">Refresh</button></div><div id="review-categories"></div><p id="review-counts"></p><div class="review-workspace"><nav id="review-list" aria-label="Receipt documents"></nav><section id="review-detail"><p>Select a document to review.</p></section></div>';
  let catalog: DocumentCatalog = { documents: [], captures: [] };
  let summaries: DocumentSummary[] = [];
  let nextPage: string | null = null;
  let cursors = [""];
  let pageIndex = 0;
  let listRequest = 0;
  let navigationGeneration = 0;
  let navigationLoading = false;
  let paymentMatches: PaymentMatch[] = [];
  let selected = new URL(location.href).searchParams.get("document");
  let categories: PurchaseCategory[] = [];
  let busy = false;
  let disposeDetail = () => {};
  const message = app.querySelector<HTMLElement>("#review-message")!;
  const list = app.querySelector<HTMLElement>("#review-list")!;
  const detail = app.querySelector<HTMLElement>("#review-detail")!;
  const filter = app.querySelector<HTMLSelectElement>("#review-filter")!;
  const initialView = new URL(location.href).searchParams.get("view");
  if (
    [
      "source-intervention",
      "payment-matches",
      "scan-review",
      "luna-reparse",
      "non-receipt",
      "human-reviewed",
    ].includes(initialView ?? "")
  )
    filter.value = initialView!;
  const search = app.querySelector<HTMLInputElement>("#review-search")!;
  const confidence =
    app.querySelector<HTMLSelectElement>("#review-confidence")!;
  const model = app.querySelector<HTMLSelectElement>("#review-model")!;
  const human = app.querySelector<HTMLSelectElement>("#review-human")!;
  if (selected) {
    confidence.value = model.value = human.value = "all";
  }
  if (filter.value === "human-reviewed")
    confidence.value = model.value = human.value = "all";
  const setMessage = (text: string) => {
    message.textContent = text;
  };
  const counts = app.querySelector<HTMLElement>("#review-counts")!;
  const listControls = el("div", undefined, "review-list-controls");
  const previousPage = el("button", "Previous", "secondary");
  const nextPageButton = el("button", "Next", "secondary");
  const pageLabel = el("span");
  listControls.append(previousPage, pageLabel, nextPageButton);
  const listColumn = el("div", undefined, "review-list-column");
  list.before(listColumn);
  listColumn.append(list, listControls);
  const interventionAlert = app.querySelector<HTMLElement>(
    "#review-intervention-alert",
  )!;
  const interventionLink = el("a", "View documents needing source review");
  interventionLink.href = "/review?view=source-intervention";
  interventionAlert.append(interventionLink);
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
  function listParams(after: string) {
    const params = new URLSearchParams({
      review: "1",
      limit: "50",
      view: filter.value,
      confidence: confidence.value,
      model: model.value,
      human: human.value,
    });
    if (search.value.trim()) params.set("q", search.value.trim());
    if (after) params.set("after", after);
    return params;
  }
  async function loadList() {
    const request = ++listRequest;
    const query = search.value.trim();
    if (
      filter.value !== "payment-matches" &&
      query &&
      [...query].length < 3 &&
      /[^\x00-\x7f]/.test(query)
    ) {
      summaries = [];
      nextPage = null;
      renderList();
      counts.textContent =
        "Type at least three characters to search accented text.";
      return;
    }
    if (filter.value === "payment-matches") {
      paymentMatches = (
        await api<{ matches: PaymentMatch[] }>("/api/payment-matches")
      ).matches;
      if (request === listRequest) renderList();
      return;
    }
    let after = cursors[pageIndex];
    // A status filter can leave an otherwise valid cursor page empty.
    // Skip one empty candidate page, keeping each UI load bounded.
    for (let scanned = 0; scanned < 2; scanned++) {
      const page = await readDocumentSummaries(listParams(after));
      if (request !== listRequest) return;
      if (page.documents.length || !page.next || scanned === 1) {
        summaries = page.documents;
        nextPage = page.next;
        cursors[pageIndex] = after;
        renderList();
        return;
      }
      after = page.next;
      cursors[pageIndex] = after;
    }
  }
  async function loadSelected(
    preloaded?: Awaited<ReturnType<typeof readDocument>>,
  ) {
    if (!selected) return;
    try {
      const result = preloaded ?? (await readDocument(selected));
      catalog = { documents: [result.document], captures: result.captures };
      if (result.document.mergedInto) {
        selected = result.document.mergedInto;
        const destination = await readDocument(selected);
        catalog = {
          documents: [destination.document],
          captures: destination.captures,
        };
        const url = new URL(location.href);
        url.searchParams.set("document", selected);
        history.replaceState(null, "", url);
      }
      renderList();
      renderDetail(catalog.documents[0]);
    } catch (error) {
      disposeDetail();
      detail.replaceChildren(
        el(
          "p",
          error instanceof RequestError && error.status === 404
            ? "The linked document was not found in this instance."
            : "The linked document could not be loaded.",
        ),
      );
      throw error;
    }
  }
  async function refresh() {
    navigationGeneration++;
    navigationLoading = false;
    if (selected && !/^[0-9a-f-]{36}$/.test(selected)) {
      selected = null;
      disposeDetail();
      detail.replaceChildren(
        el("p", "The linked document was not found in this instance."),
      );
    }
    const selectedRequest = selected
      ? readDocument(selected).catch((error) => {
          disposeDetail();
          detail.replaceChildren(
            el(
              "p",
              error instanceof RequestError && error.status === 404
                ? "The linked document was not found in this instance."
                : "The linked document could not be loaded.",
            ),
          );
          throw error;
        })
      : Promise.resolve(null);
    const [loadedCategories, , selectedDocument] = await Promise.all([
      api<PurchaseCategory[]>("/api/processing/categories?include_archived=1"),
      loadList(),
      selectedRequest,
    ]);
    categories = loadedCategories;
    app
      .querySelector("#review-categories")!
      .replaceChildren(categorySetup(categories, action, refresh));
    if (selectedDocument) await loadSelected(selectedDocument);
  }
  function renderList() {
    list.replaceChildren();
    const paymentView = filter.value === "payment-matches";
    listControls.hidden = paymentView;
    interventionAlert.hidden = filter.value === "source-intervention";
    if (paymentView) {
      const needle = search.value.toLowerCase();
      let shown = 0;
      for (const match of paymentMatches) {
        if (match.human_reviewed) continue;
        const receiptLabel = match.receipt_label;
        const slipLabel = match.payment_label;
        if (
          !`${receiptLabel} ${slipLabel} ${match.status} ${match.match_pass}`
            .toLowerCase()
            .includes(needle)
        )
          continue;
        const card = el("article", undefined, "review-item");
        card.append(el("strong", `${receiptLabel} ↔ ${slipLabel}`));
        card.append(
          el(
            "span",
            `${match.status.replaceAll("-", " ")}${match.status === "changed" ? " · pages or OCR changed since Jev checked it" : match.evidence_current ? "" : " · OCR changed since Jev checked it"} · ${match.match_pass} pass · ${new Date(match.matched_at).toLocaleString()} · Jev ${Math.round(match.probability * 100)}% probability, ${Math.round(match.confidence * 100)}% confidence`,
          ),
        );
        const links = el("span");
        const receiptLink = el("a", "Open receipt");
        receiptLink.href = `/review?document=${encodeURIComponent(match.receipt_document_id)}&view=payment-matches`;
        const slipLink = el("a", "Open payment slip");
        slipLink.href = `/review?document=${encodeURIComponent(match.payment_document_id)}&view=payment-matches`;
        links.append(receiptLink, " · ", slipLink);
        card.append(links);
        list.append(card);
        shown++;
      }
      if (!shown) list.append(el("p", "No payment matches found."));
      counts.textContent = `${shown} payment matches in current list · ${paymentMatches.length} total · ${paymentMatches.filter((item) => item.status === "needs-review").length} need verification`;
      return;
    }
    for (const document of summaries) {
      const label =
        document.filename ??
        document.vendor ??
        "Unidentified scan · vendor/date to identify";
      const button = el("button", undefined, `review-item ${document.status}`);
      const reviewed = document.processing?.has_human_review === true;
      button.setAttribute("aria-current", String(document.id === selected));
      button.append(
        el("strong", label),
        el(
          "span",
          reviewed
            ? `Human reviewed · ${document.pageIds.length} page${document.pageIds.length === 1 ? "" : "s"} · ${document.pdf ? "PDF ready for download" : "PDF needs retry"}`
            : `${document.processing?.needs_reparse ? "Needs Luna reparse · " : pendingSourceIntervention(document) ? "Needs source intervention · " : completenessUncertain(document) ? "Completeness needs scan review · " : ""}${document.processing?.luna_needs_human_review ? "Luna requests human review · " : ""}${document.kind}${document.kind === "unknown" && document.completenessAudit?.result === "not_receipt" ? " · Jev: not a receipt" : ""}${document.kind === "unknown" && document.jevRole ? ` · Jev: ${document.jevRole.replaceAll("_", " ")}` : ""} · ${document.status} · ${document.pageIds.length} page${document.pageIds.length === 1 ? "" : "s"} · Luna: ${document.processing?.small_model_certainty ?? "—"} · Astra: ${document.processing?.large_model_confidence ?? "—"}`,
        ),
        el(
          "small",
          reviewed
            ? "Open to edit values or download the PDF"
            : (document.reasons[0] ??
                (document.duplicateOf
                  ? "Original retained; excluded from output"
                  : "Checks complete")),
        ),
      );
      button.onclick = () => {
        if (busy) return;
        setMessage("");
        selected = document.id;
        const url = new URL(location.href);
        url.searchParams.set("document", document.id);
        history.replaceState(null, "", url);
        renderList();
        void action(async () => {
          await loadSelected();
          const current = catalog.documents[0];
          detail
            .querySelector(
              needsSourceIntervention(current)
                ? ".source-review-controls"
                : ".receipt-review-panes",
            )
            ?.scrollIntoView({ block: "start" });
        });
      };
      list.append(button);
    }
    if (!summaries.length)
      list.append(
        el(
          "p",
          nextPage
            ? "No matches in this part of the list. Continue to the next page."
            : "No documents match this view.",
        ),
      );
    counts.textContent = `${summaries.length} documents in current list`;
    previousPage.disabled = navigationLoading || pageIndex === 0;
    nextPageButton.disabled = navigationLoading || !nextPage;
    pageLabel.textContent = `Page ${pageIndex + 1}`;
  }
  function navigatePage(direction: -1 | 1) {
    if (navigationLoading || (direction < 0 ? pageIndex === 0 : !nextPage))
      return;
    const previousIndex = pageIndex;
    const generation = ++navigationGeneration;
    navigationLoading = true;
    pageIndex += direction;
    if (direction > 0) cursors[pageIndex] = nextPage!;
    renderList();
    const request = listRequest + 1;
    void loadList().then(
      () => {
        if (generation !== navigationGeneration || request !== listRequest)
          return;
        navigationLoading = false;
        renderList();
      },
      (error) => {
        if (generation !== navigationGeneration || request !== listRequest)
          return;
        pageIndex = previousIndex;
        navigationLoading = false;
        setMessage(messageOf(error));
        renderList();
      },
    );
  }
  previousPage.onclick = () => navigatePage(-1);
  nextPageButton.onclick = () => navigatePage(1);
  function resetList() {
    navigationGeneration++;
    navigationLoading = false;
    cursors = [""];
    pageIndex = 0;
    nextPage = null;
    void loadList().catch((error) => setMessage(messageOf(error)));
  }
  function renderDetail(original: DocumentView) {
    const doc = structuredClone(original);
    disposeDetail();
    detail.replaceChildren();
    detail.append(el("h2", doc.filename ?? "Identify this document"));
    const ownerNotes = el("section", undefined, "review-owner-notes");
    const renderOwnerNotes = () => {
      const sourceNotes = new Map<string, { page: number; text: string }>();
      doc.pages.forEach((page, index) => {
        const capture = catalog.captures.find(
          (item) => item.id === page.captureId,
        );
        for (const note of capture?.owner_notes ?? [])
          if (!sourceNotes.has(note.id))
            sourceNotes.set(note.id, { page: index + 1, text: note.text });
      });
      ownerNotes.replaceChildren();
      ownerNotes.hidden = sourceNotes.size === 0;
      if (!ownerNotes.hidden) {
        ownerNotes.append(el("strong", "Your notes about the original paper"));
        for (const note of sourceNotes.values())
          ownerNotes.append(el("p", `Page ${note.page}: ${note.text}`));
      }
    };
    renderOwnerNotes();
    detail.append(ownerNotes);
    if (doc.duplicateOf) {
      const primary = catalog.documents.find(
        (item) => item.id === doc.duplicateOf,
      );
      const notice = el("p", undefined, "review-duplicate-notice");
      const link = el(
        "a",
        primary?.filename
          ? `Open primary document: ${primary.filename}`
          : "Open primary document",
      );
      link.href = `/review?document=${encodeURIComponent(doc.duplicateOf)}`;
      notice.append(
        el("strong", "Duplicate scan. "),
        "This original is preserved but excluded from document output. ",
        link,
      );
      detail.append(notice);
    }
    if (pendingSourceIntervention(doc) && !doc.processing?.has_human_review)
      detail.append(
        el(
          "p",
          `Needs source intervention: ${doc.completenessAudit?.result === "no" ? doc.completenessAudit.issue.replaceAll("_", " ") : "Jev could not confirm completeness confidently"}. Inspect the saved scans and page grouping; look for the original paper if a page or printed total is absent.`,
          "review-intervention-warning",
        ),
      );
    else if (completenessUncertain(doc) && !doc.processing?.has_human_review)
      detail.append(
        el(
          "p",
          doc.completenessAudit?.issue === "evidence_too_long"
            ? "The combined OCR was too long for Jev to assess at once. Review the saved pages in sections; no missing paper has been identified."
            : "Completeness is uncertain. Inspect the saved scans before relying on this receipt; no missing paper has been identified.",
          "review-intervention-warning",
        ),
      );
    if (needsSourceIntervention(doc)) {
      const decision = el("div", undefined, "controls source-review-controls");
      if (doc.sourceInterventionFine)
        decision.append(el("span", "Human says the source is fine."));
      const fine = el(
        "button",
        doc.sourceInterventionFine ? "Reopen source review" : "It's fine",
        "secondary",
      );
      fine.onclick = () =>
        void action(async () => {
          await api(
            `/api/documents/${encodeURIComponent(doc.id)}/source-review`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                assessmentId: doc.completenessAudit!.assessmentId,
                decision: doc.sourceInterventionFine ? "needs-review" : "fine",
              }),
            },
          );
          await refresh();
          setMessage(
            doc.sourceInterventionFine
              ? "Source review reopened."
              : "Marked human says it's fine. Removed from Needs source intervention.",
          );
        });
      decision.append(fine);
      detail.append(decision);
    }
    detail.append(
      receiptHandoff(catalog.documents.find((saved) => saved.id === doc.id)!),
    );
    const reasons = el("ul", undefined, `review-reasons ${doc.status}`);
    for (const reason of doc.reasons) reasons.append(el("li", reason));
    const sourceWarnings = el("details");
    sourceWarnings.append(
      el("summary", `Source review notes (${doc.reasons.length})`),
      reasons,
    );
    detail.append(doc.processing ? sourceWarnings : reasons);
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
      image.style.cursor = "zoom-in";
      image.onclick = () => zoom.click();
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
        if (doc.processing)
          void action(async () => {
            await saveDocuments([doc]);
            await refresh();
          });
        else renderDetail(doc);
      };
      controls.append(earlier);
      const rotate = el("button", "Rotate 90°", "secondary");
      rotate.onclick = () => {
        p.rotation = ((p.rotation + 90) % 360) as typeof p.rotation;
        doc.checks.pdf = false;
        if (doc.processing)
          void action(async () => {
            await saveDocuments([doc]);
            await refresh();
          });
        else renderDetail(doc);
      };
      controls.append(rotate);
      const detach = el("button", "This page belongs elsewhere", "secondary");
      detach.disabled = doc.pages.length < 2;
      const reason = el("input");
      reason.placeholder = "Why does this page not belong?";
      reason.setAttribute("aria-label", "Reason for detaching page");
      detach.onclick = () =>
        void action(async () => {
          if (!reason.value.trim())
            throw Error("Describe the mismatching page before detaching it.");
          await api("/api/processing/detach", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              document_id: doc.id,
              revision: doc.revision,
              capture_id: p.captureId,
              reason: reason.value,
            }),
          });
          await refresh();
          setMessage(
            "Page detached and returned to the matching pool. Original preserved.",
          );
        });
      controls.append(reason, detach);
      card.append(
        controls,
        el("p", `PDF rotation: ${p.rotation}° · scan crop`),
        captureNotes(capture, renderOwnerNotes),
      );
      sources.append(card);
    });
    if (!doc.processing && doc.pages.length) {
      const ocrSource = reviewOcrSource(doc);
      const preview = documentPreview(doc, catalog.captures, ocrSource);
      preview.element.classList.add("receipt-source-preview");
      disposeDetail = () => {
        preview.destroy();
        ocrSource.destroy();
      };
      detail.append(preview.element);
    }
    detail.append(sources);
    const form = el("form");
    form.className = "review-form";
    const vendor = field("Vendor", doc.vendor ?? "");
    const date = field("Receipt date", doc.receiptDate ?? "");
    (date.input as HTMLInputElement).type = "date";
    const reference = field("Receipt / invoice number", doc.reference ?? "");
    form.append(vendor.wrap, date.wrap, reference.wrap);
    const kind = el("select");
    for (const value of documentTypes) {
      const option = el("option", value);
      option.value = value;
      kind.append(option);
    }
    kind.value = doc.kind;
    const kindLabel = el("label", "Document type", "review-field");
    kindLabel.append(kind);
    kindLabel.append(
      el(
        "small",
        "Unknown = not classified yet. Other = identified but no specific type fits. Not-receipt = confirmed no purchase receipt or invoice.",
      ),
    );
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
    const evidence = field(
      "Processing observations and verification evidence",
      doc.evidence,
      true,
    );
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
    if (doc.processing) {
      const workspace = el("div", undefined, "receipt-review-panes");
      const ocrSource = reviewOcrSource(doc);
      const preview = documentPreview(doc, catalog.captures, ocrSource);
      const review = processingReview(
        doc,
        categories,
        action,
        async (outcome?: string) => {
          await refresh();
          const reviewed = catalog.documents[0]?.processing?.has_human_review;
          if (reviewed) {
            filter.value = "human-reviewed";
            resetList();
          }
          setMessage(
            outcome ??
              "Receipt changes saved. Agent readings and originals are preserved.",
          );
        },
        ocrSource,
      );
      disposeDetail = () => {
        preview.destroy();
        review.destroy();
        ocrSource.destroy();
      };
      workspace.append(preview.element, review.element);
      const sourceDetails = el("details");
      sourceDetails.append(
        el("summary", "Originals and page organisation"),
        sources,
      );
      detail.append(workspace, sourceDetails);
    } else detail.append(form);
    const outputs = el("div", undefined, "controls");
    const generate = el("button", "Generate PDF", "secondary");
    generate.onclick = () =>
      void action(async () => {
        setMessage("Generating from the saved page order…");
        const current = (await readDocument(doc.id)).document;
        try {
          const result = await generateDocumentPdf(
            current,
            current.processing?.has_human_review === true,
          );
          setMessage(
            `Saved ${result.filename}${result.imageOnlyPages ? ` with ${result.imageOnlyPages} image-only page${result.imageOnlyPages === 1 ? "" : "s"}` : ""}. Inspect it before confirming the PDF check.`,
          );
        } catch (error) {
          if (error instanceof OcrPendingError) throw error;
          if (!current.processing?.has_human_review) {
            current.broken = [
              ...new Set([
                ...current.broken,
                `PDF failed: ${messageOf(error)}`,
              ]),
            ];
            await saveDocuments([current]);
          }
          throw error;
        } finally {
          await refresh();
        }
      });
    outputs.append(generate);
    if (doc.pdf) {
      const link = el("a", "Download saved PDF");
      link.href = `/api/documents/${doc.id}/pdf?version=${doc.pdf.sha256}&revision=${doc.pdf.revision}`;
      const preview = el("button", "Preview saved PDF", "secondary");
      preview.onclick = () =>
        void action(async () => {
          const { inspectPdf } = await import("./pdf-preview");
          await inspectPdf(link.href, doc.pdf!.sha256, doc.filename!);
        });
      outputs.append(preview, link);
      if (doc.processing) {
        const checked = el(
          "button",
          "PDF inspected — confirm legibility",
          "secondary",
        );
        checked.onclick = () =>
          void action(async () => {
            const fresh = (await readDocument(doc.id)).document;
            if (fresh.pdf?.sha256 !== doc.pdf?.sha256)
              throw Error("PDF changed; inspect the current version first.");
            fresh.checks.pdf = true;
            fresh.reviewedPdfSha256 = fresh.pdf!.sha256;
            await saveDocuments([fresh]);
            await refresh();
          });
        outputs.append(checked);
      }
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
          const fresh = (await readDocument(doc.id)).document;
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
    const targetSearch = field(
      "Find destination by vendor, date, reference, text or document ID",
      "",
    );
    const loadMoreTargets = el("button", "Load more destinations", "secondary");
    loadMoreTargets.type = "button";
    loadMoreTargets.hidden = true;
    let targetNext: string | null = null;
    let targetGeneration = 0;
    let targetTimer: ReturnType<typeof setTimeout> | undefined;
    function appendTarget(id: string, label: string) {
      if (
        id === doc.id ||
        [...target.options].some((option) => option.value === id)
      )
        return;
      const option = el("option", label);
      option.value = id;
      target.append(option);
    }
    async function loadTargets(reset: boolean, generation: number) {
      const query = targetSearch.input.value.trim();
      if (reset) target.replaceChildren(empty);
      loadMoreTargets.disabled = true;
      if (/^[0-9a-f-]{36}$/.test(query)) {
        const { document: found } = await readDocument(query);
        if (generation !== targetGeneration) return;
        if (!found.mergedInto && !found.duplicateOf)
          appendTarget(
            found.id,
            `${found.filename ?? found.vendor ?? "Unidentified"} · ${found.id.slice(0, 8)}`,
          );
        targetNext = null;
      } else {
        const params = new URLSearchParams({ limit: "50" });
        if (query) params.set("q", query);
        if (!reset && targetNext) params.set("after", targetNext);
        const page = await readDocumentSummaries(params);
        if (generation !== targetGeneration) return;
        for (const other of page.documents.filter((item) => !item.duplicateOf))
          appendTarget(
            other.id,
            `${other.filename ?? other.vendor ?? "Unidentified"} · ${other.scannedAt[0] ?? ""} · ${other.id.slice(0, 8)}`,
          );
        targetNext = page.next;
      }
      loadMoreTargets.hidden = !targetNext;
      loadMoreTargets.disabled = false;
    }
    targetSearch.input.oninput = () => {
      clearTimeout(targetTimer);
      const generation = ++targetGeneration;
      targetNext = null;
      target.replaceChildren(empty);
      loadMoreTargets.hidden = true;
      targetTimer = setTimeout(() => {
        void loadTargets(true, generation).catch((error) =>
          setMessage(messageOf(error)),
        );
      }, 250);
    };
    organize.addEventListener("toggle", () => {
      if (!organize.open || targetSearch.input.value.trim()) return;
      const generation = ++targetGeneration;
      void loadTargets(true, generation).catch((error) =>
        setMessage(messageOf(error)),
      );
    });
    loadMoreTargets.onclick = () => {
      if (!targetNext || loadMoreTargets.disabled) return;
      void loadTargets(false, targetGeneration).catch((error) =>
        setMessage(messageOf(error)),
      );
    };
    const targetLabel = el("label", "Destination document", "review-field");
    targetLabel.append(target);
    organize.append(targetSearch.wrap, targetLabel, loadMoreTargets);
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
            const changes = [source, destination];
            retargetAbsorbedAliases(changes, fresh.documents, destination.id);
            await saveDocuments(changes);
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
          const source = (await readDocument(doc.id)).document;
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
        const historyList = el("details");
        historyList.open = true;
        historyList.append(el("summary", "Decision history"));
        for (const row of rows) {
          const d = JSON.parse(row.payload);
          const entry = el("details");
          entry.append(
            el(
              "summary",
              `Revision ${row.revision} · ${new Date(row.created_at).toLocaleString()}`,
            ),
            el("p", d.evidence || "No verification yet"),
          );
          historyList.append(entry);
        }
        history.replaceWith(historyList);
      });
    detail.append(history);
  }
  filter.onchange = () => {
    const url = new URL(location.href);
    if (
      [
        "source-intervention",
        "payment-matches",
        "scan-review",
        "luna-reparse",
        "non-receipt",
        "human-reviewed",
      ].includes(filter.value)
    )
      url.searchParams.set("view", filter.value);
    else url.searchParams.delete("view");
    history.replaceState(null, "", url);
    resetList();
  };
  confidence.onchange = resetList;
  model.onchange = resetList;
  human.onchange = resetList;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(resetList, 250);
  };
  app.querySelector<HTMLButtonElement>("#review-refresh")!.onclick = () =>
    void action(refresh);
  registerSiteTools(refresh);
  await action(refresh);
}
