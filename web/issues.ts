import { api } from "./api";
import { messageOf } from "./errors";
import type { ScanState } from "./types";
import { diagnosticSnapshot } from "./diagnostics";

interface Issue {
  id: string;
  title: string;
  description: string;
  status: string;
  created_at: string;
  screenshot: string;
  context?: { diagnostics?: ReturnType<typeof diagnosticSnapshot> };
  updates?: { status: string; note: string; created_at: string }[];
}
const button = (text: string, action: () => void) => {
  const result = document.createElement("button");
  result.textContent = text;
  result.className = "secondary";
  result.onclick = action;
  return result;
};

async function screenshot(): Promise<Blob> {
  const { default: render } = await import("html2canvas");
  const videos = [...document.querySelectorAll("video")].map((video) => {
    const frame = document.createElement("canvas");
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    if (frame.width && frame.height)
      frame.getContext("2d")!.drawImage(video, 0, 0);
    return frame;
  });
  const canvas = await render(document.body, {
    logging: false,
    scale: 1,
    backgroundColor: "#10181f",
    width: innerWidth,
    height: innerHeight,
    x: scrollX,
    y: scrollY,
    windowWidth: innerWidth,
    windowHeight: innerHeight,
    onclone(doc) {
      // The renderer does not honour closed details consistently; preserve the visible state.
      doc.querySelectorAll("details:not([open])").forEach((details) => {
        for (const child of [...details.children])
          if (child.tagName !== "SUMMARY") child.remove();
      });
      doc.querySelectorAll("video").forEach((video, index) => {
        const source = videos[index];
        if (!source?.width) return;
        const frame = doc.createElement("canvas");
        frame.width = source.width;
        frame.height = source.height;
        frame.getContext("2d")!.drawImage(source, 0, 0);
        frame.className = video.className;
        frame.id = video.id;
        frame.hidden = video.hidden;
        video.replaceWith(frame);
      });
    },
  });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not capture the scanner screen.")),
      "image/png",
    ),
  );
}

export async function reportIssue(state: ScanState | undefined): Promise<void> {
  // Freeze history before screenshot rendering or form interaction.
  const diagnostics = diagnosticSnapshot();
  // Freeze the displayed page before adding the report form. Nothing is sent externally.
  const shot = await screenshot();
  const id = crypto.randomUUID();
  const context = {
    path: location.pathname,
    viewport: [innerWidth, innerHeight],
    phase: state?.phase,
    stage: state?.stage,
    lastCapture: state?.lastCapture,
    activeId: state?.activeId,
    retakeOf: state?.retakeOf,
    diagnostics,
  };
  const dialog = document.createElement("dialog");
  dialog.className = "issue-dialog";
  dialog.setAttribute("aria-label", "Report a private issue");
  dialog.innerHTML = `<h2>Report an issue privately</h2><p>The screenshot, your description and up to two minutes of diagnostics from this device stay in your private instance. Report before refreshing to preserve the history.</p><form><label>Title<input name="title" required maxlength="160"></label><label>What happened?<textarea name="description" maxlength="8000" rows="4"></textarea></label><img class="issue-screenshot" alt="Screenshot attached to this private report"><label class="toggle"><input type="checkbox" name="github"> Offer a public GitHub issue draft</label><p class="muted">Optional, off by default. Opens a public draft for you to review. Your private description, screenshot and receipt details are never copied to GitHub.</p><p class="issue-feedback" role="status"></p><div class="controls"><button type="submit">Save private issue</button><button type="button" class="secondary" data-close>Cancel</button></div></form>`;
  const objectUrl = URL.createObjectURL(shot);
  dialog.querySelector<HTMLImageElement>("img")!.src = objectUrl;
  dialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () =>
    dialog.close();
  dialog.onclose = () => {
    URL.revokeObjectURL(objectUrl);
    dialog.remove();
  };
  const form = dialog.querySelector("form")!;
  let saving = false;
  let submitted:
    { title: string; description: string; context: typeof context } | undefined;
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    const controls = [
      ...form.querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement
      >("input,button,textarea"),
    ];
    const data = new FormData(form);
    submitted ??= {
      title: String(data.get("title")),
      description: String(data.get("description")),
      context,
    };
    controls.forEach((control) => (control.disabled = true));
    const feedback = form.querySelector<HTMLElement>(".issue-feedback")!;
    feedback.textContent = "Saving screenshot privately…";
    try {
      const upload = new FormData();
      upload.set("metadata", JSON.stringify(submitted));
      upload.set("screenshot", shot, "scanner-screen.png");
      await api(`/api/issues/${id}`, { method: "POST", body: upload });
      if (!data.get("github")) {
        dialog.close();
        return;
      }
      feedback.textContent = "Private issue saved.";
      const link = document.createElement("a");
      link.href = `/issues#${id}`;
      link.textContent = "View private issue";
      feedback.append(" ", link);
      if (data.get("github")) {
        const draft = document.createElement("a");
        const url = new URL(
          "https://github.com/oana-ffg/galactic-receipt-scanner/issues/new",
        );
        url.searchParams.set("title", "Scanner issue");
        url.searchParams.set(
          "body",
          "Please describe the scanner problem and steps to reproduce using synthetic examples. Do not include receipt images, private screenshots, financial details or private instance links.",
        );
        draft.href = url.href;
        draft.target = "_blank";
        draft.rel = "noopener noreferrer";
        draft.textContent = "Review public GitHub draft";
        feedback.append(document.createElement("br"), draft);
      }
      const close = dialog.querySelector<HTMLButtonElement>("[data-close]")!;
      close.disabled = false;
      close.textContent = "Close";
    } catch (problem) {
      feedback.textContent = `${messageOf(problem)} Your screenshot is still in this form. Retry saving before closing.`;
      // Freeze submitted details after an uncertain response so retry is identical.
      form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled =
        false;
      form.querySelector<HTMLButtonElement>("[data-close]")!.disabled = false;
    } finally {
      saving = false;
    }
  };
  document.body.append(dialog);
  dialog.showModal();
}

export async function mountIssues(app: HTMLElement): Promise<void> {
  app.innerHTML =
    '<header><h1>Private issues</h1><a href="/">Back to scanner</a></header><p>Reports and screenshots are visible only to the instance owner.</p><section id="issue-list"></section><button id="older-issues" hidden>Older reports</button>';
  const list = app.querySelector<HTMLElement>("#issue-list")!;
  const older = app.querySelector<HTMLButtonElement>("#older-issues")!;
  let before: string | null = null;
  const show = async (issue: Issue) => {
    const details = await api<Issue>(`/api/issues/${issue.id}`);
    const dialog = document.createElement("dialog");
    dialog.className = "issue-dialog";
    dialog.setAttribute("aria-label", "Private issue details");
    const title = document.createElement("h2");
    title.textContent = details.title;
    const description = document.createElement("p");
    description.textContent = details.description;
    const image = document.createElement("img");
    image.src = details.screenshot;
    image.alt = "Private issue screenshot";
    image.className = "issue-screenshot";
    const history = document.createElement("div");
    for (const update of details.updates ?? []) {
      const p = document.createElement("p");
      p.textContent = `${update.created_at} · ${update.status}: ${update.note}`;
      history.append(p);
    }
    const form = document.createElement("form");
    form.innerHTML =
      '<label>Status<select name="status"><option value="open">Open</option><option value="in-progress">In progress</option><option value="resolved">Resolved</option></select></label><label>Progress or verification note<textarea name="note" required maxlength="4000"></textarea></label><button>Save update</button><p role="status"></p>';
    form.querySelector("select")!.value = details.status;
    form.onsubmit = async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button")!;
      submit.disabled = true;
      const values = new FormData(form);
      try {
        await api(`/api/issues/${issue.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: values.get("status"),
            note: values.get("note"),
          }),
        });
        dialog.close();
        list.replaceChildren();
        before = null;
        await load();
      } catch (error) {
        form.querySelector("p")!.textContent = messageOf(error);
      } finally {
        submit.disabled = false;
      }
    };
    dialog.append(
      button("Close", () => dialog.close()),
      title,
      description,
      image,
      history,
      form,
    );
    if (details.context?.diagnostics) {
      const diagnostics = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Diagnostic history";
      const data = document.createElement("pre");
      data.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere";
      data.textContent = JSON.stringify(details.context.diagnostics, null, 2);
      diagnostics.append(summary, data);
      dialog.append(diagnostics);
    }
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  };
  const load = async () => {
    older.disabled = true;
    try {
      const page = await api<{ issues: Issue[]; next: string | null }>(
        `/api/issues${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      );
      for (const issue of page.issues) {
        const row = document.createElement("article");
        row.className = "capture-row";
        const text = document.createElement("p");
        text.textContent = `${issue.status} · ${new Date(issue.created_at).toLocaleString()} · ${issue.title}`;
        row.append(
          text,
          button(
            "View report",
            () =>
              void show(issue).catch((problem) => {
                text.textContent = messageOf(problem);
              }),
          ),
        );
        list.append(row);
      }
      before = page.next;
      older.hidden = !before;
      if (!list.childElementCount)
        list.textContent = "No private issues reported.";
    } catch (problem) {
      list.textContent = messageOf(problem);
    } finally {
      older.disabled = false;
    }
  };
  older.onclick = () => void load();
  await load();
  const selected = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/i.test(selected)) {
    try {
      await show(await api<Issue>(`/api/issues/${selected}`));
    } catch (problem) {
      list.textContent = messageOf(problem);
    }
  }
}
