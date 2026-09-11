import QRCode from "qrcode";
import { api, Connection, token } from "./api";
import { messageOf, PhoneCamera } from "./camera";
import type { Capture, ScanState } from "./types";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app")!;
const isCamera = location.pathname === "/camera";
let libraryBusy = false;
let libraryDirty = false;
let lastState: ScanState | undefined;

if (!token) {
  app.innerHTML = `<section class="pair"><h1>Receipt Scanner</h1><p>Open the launch link from this project's start command, or scan the pairing QR code on your Mac.</p><form><label>Pairing key<input id="key" type="password" autocomplete="off" required></label><button>Pair this browser</button></form></section>`;
  app.querySelector("form")!.onsubmit = (event) => {
    event.preventDefault();
    localStorage.setItem("receipt-scanner-key", input("key").value.trim());
    location.reload();
  };
} else {
  app.innerHTML = `
    <header><div><h1>Receipt Scanner</h1><p>${isCamera ? "Phone camera" : "Local capture station"}</p></div><div class="counter"><strong id="count">0</strong><span>saved receipts</span></div></header>
    <section id="signal" class="signal red" role="status" aria-live="polite"><span id="light"></span><div><strong id="phase">CONNECT</strong><p id="status">Connecting…</p></div></section>
    <div class="workspace"><section class="capture-panel"><div class="preview" id="preview"><${isCamera ? "video autoplay muted playsinline" : "canvas"} id="feed"></${isCamera ? "video" : "canvas"}><span id="empty-preview">${isCamera ? "Enable the rear camera to begin" : "Waiting for phone preview"}</span></div>
    <p id="detail" class="detail">Keep one receipt on a dark, matte background, with all edges visible.</p>
    <div class="controls">${isCamera ? '<button id="enable">Enable camera</button><button id="recover">Retry upload</button>' : '<button id="start">Start scanning</button><button id="pause" class="secondary">Pause</button><button id="retry" class="secondary">Retry this receipt</button><button id="recover" class="secondary">Retry upload</button><label class="toggle"><input id="audio" type="checkbox"> Audio</label>'}</div>
    <p id="error" class="error" role="alert"></p></section>
    ${isCamera ? "" : '<aside><details open><summary>Connect your phone</summary><canvas id="qr"></canvas><p>Scan with the phone camera, then tap <strong>Enable camera</strong>.</p><a id="phone-link">Open camera page</a><p class="muted">First time on this phone? <a id="setup-link">Set up local HTTPS</a>.</p></details><details><summary>Capture checks</summary><p>Paper outline, stable view, detected hands, print contrast, focus and saved image dimensions.</p><p>Green means the image passed these checks and was saved. Check your first few scans for missed fingers, glare and tiny print.</p></details></aside>'}
    </div>
    ${isCamera ? "" : '<section class="library"><div class="library-heading"><h2>Recent captures</h2><span>Originals stay intact · OCR is unverified</span></div><div id="captures"><p class="muted">No captures yet.</p></div></section>'}`;
  if (isCamera) mountCamera();
  else mountDashboard();
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function input(id: string): HTMLInputElement {
  return element<HTMLInputElement>(id);
}
function error(message: string): void {
  element("error").textContent = message;
}

function renderState(state: ScanState): void {
  lastState = state;
  element("signal").className = `signal ${state.phase}`;
  element("phase").textContent =
    state.phase === "green"
      ? "SAVED · NEXT"
      : state.phase === "amber"
        ? "HOLD STILL"
        : state.paused
          ? "PAUSED"
          : "WAIT";
  element("status").textContent = state.message;
  element("count").textContent = String(state.count);
  if (!isCamera) {
    for (const id of ["start", "pause", "retry"]) {
      element<HTMLButtonElement>(id).disabled =
        Boolean(state.activeId) || !state.detectorReady;
    }
    element<HTMLButtonElement>("start").disabled ||= !state.paused;
    element<HTMLButtonElement>("pause").disabled ||= state.paused;
    if (state.quality.focus !== undefined)
      element("detail").textContent =
        `Focus score ${state.quality.focus.toFixed(0)} · ${state.quality.reason} · Remove each receipt completely before the next.`;
  }
}

function disconnected(reason = "Connection lost. Waiting to reconnect…"): void {
  element("signal").className = "signal red";
  element("phase").textContent = "DISCONNECTED";
  element("status").textContent = reason;
}

function mountCamera(): void {
  const camera = new PhoneCamera(
    element<HTMLVideoElement>("feed"),
    (message) => {
      element("detail").textContent = message;
    },
    renderState,
    () => {
      element<HTMLButtonElement>("enable").disabled = false;
    },
  );
  element("enable").onclick = async () => {
    error("");
    try {
      await camera.start();
      element("empty-preview").hidden = true;
      element<HTMLButtonElement>("enable").disabled = true;
    } catch (problem) {
      error(messageOf(problem));
    }
  };
  element("recover").onclick = () => void camera.recover();
}

function mountDashboard(): void {
  const phone = new URL("/camera", location.origin);
  phone.hash = `key=${encodeURIComponent(token)}`;
  element<HTMLAnchorElement>("phone-link").href = phone.href;
  const setup = new URL(location.origin);
  setup.protocol = "http:";
  setup.port = "8764";
  element<HTMLAnchorElement>("setup-link").href = setup.href;
  void QRCode.toCanvas(element<HTMLCanvasElement>("qr"), phone.href, {
    width: 188,
    margin: 1,
  });
  let lastSaved: string | null = null;
  let lastError = "";
  let audio: AudioContext | null = null;
  let previewBusy = false;
  const audioToggle = input("audio");
  audioToggle.onchange = () => {
    if (audioToggle.checked) {
      audio ??= new AudioContext();
      void audio.resume();
    }
  };
  function sound(success: boolean): void {
    if (!audioToggle.checked || !audio) return;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = success ? 880 : 220;
    gain.gain.setValueAtTime(0.12, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.2);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.22);
  }
  const connection = new Connection(
    "dashboard",
    (message) => {
      if (message instanceof Blob) {
        if (previewBusy) return;
        previewBusy = true;
        void drawPreview(message).finally(() => {
          previewBusy = false;
        });
      } else if (message.type === "state") {
        if (message.lastSaved && message.lastSaved !== lastSaved) {
          if (lastState) sound(true);
          void refreshLibrary();
        }
        if (
          message.phase === "red" &&
          message.message !== lastError &&
          lastState?.phase === "amber"
        )
          sound(false);
        lastSaved = message.lastSaved;
        lastError = message.message;
        renderState(message);
      } else if (message.type === "libraryChanged") void refreshLibrary();
    },
    (connected, reason) => {
      if (!connected) disconnected(reason);
    },
  );
  connection.start();
  for (const id of ["start", "pause", "retry", "recover"]) {
    element(id).onclick = async () => {
      error("");
      try {
        await api(`/api/control/${id === "recover" ? "retry-upload" : id}`, {
          method: "POST",
        });
      } catch (problem) {
        error(messageOf(problem));
      }
    };
  }
  void refreshLibrary();
}

async function drawPreview(blob: Blob): Promise<void> {
  const bitmap = await createImageBitmap(blob);
  const canvas = element<HTMLCanvasElement>("feed");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  element("empty-preview").hidden = true;
  // The overlay and preview share the same pixel coordinate system and aspect ratio.
  const quality = lastState?.quality;
  if (!quality) return;
  ctx.lineWidth = 3;
  function polygon(points: number[][], colour: string) {
    ctx.strokeStyle = colour;
    ctx.beginPath();
    points.forEach(([x, y], i) =>
      i === 0
        ? ctx.moveTo(x * canvas.width, y * canvas.height)
        : ctx.lineTo(x * canvas.width, y * canvas.height),
    );
    ctx.closePath();
    ctx.stroke();
  }
  if (quality.quad) polygon(quality.quad, quality.ok ? "#57e0a5" : "#ffbc54");
  quality.hands?.forEach((points) => polygon(points, "#ff6f7e"));
}

async function refreshLibrary(): Promise<void> {
  if (libraryBusy) {
    libraryDirty = true;
    return;
  }
  libraryBusy = true;
  try {
    const result = await api<{ captures: Capture[] }>("/api/captures");
    const container = element("captures");
    if (!result.captures.length) return;
    container.replaceChildren();
    for (const capture of result.captures) {
      const row = document.createElement("article");
      row.className = "capture-row";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${new Date(capture.created_at).toLocaleTimeString()} · ${capture.status === "accepted" ? "Saved" : capture.status === "rejected" ? "Retake needed" : "Interrupted check"}`;
      const detail = document.createElement("p");
      detail.textContent =
        capture.status === "accepted"
          ? `${capture.metadata.sourcePixels?.join(" × ") ?? ""} source · OCR ${capture.ocr_status}${capture.ocr_error ? ": " + capture.ocr_error : ""}`
          : (capture.metadata.quality?.reason ??
            "Original retained. Retry this receipt.");
      info.append(title, detail);
      row.append(info);
      const links = document.createElement("div");
      links.className = "file-links";
      for (const [kind, label] of [
        ["raw", "Original"],
        ...(capture.status === "accepted"
          ? [
              ["image", "Crop"],
              ["pdf", "PDF"],
            ]
          : []),
      ]) {
        const button = document.createElement("button");
        button.className = "secondary";
        button.textContent = label;
        button.onclick = () => void openFile(capture.id, kind);
        links.append(button);
      }
      if (
        capture.status === "accepted" &&
        ["error", "unavailable"].includes(capture.ocr_status)
      ) {
        const retry = document.createElement("button");
        retry.textContent = "Retry OCR";
        retry.className = "secondary";
        retry.onclick = () => {
          void api(`/api/ocr/${capture.id}`, { method: "POST" }).catch(
            (problem) => error(messageOf(problem)),
          );
        };
        links.append(retry);
      }
      row.append(links);
      container.append(row);
    }
  } catch (problem) {
    error(messageOf(problem));
  } finally {
    libraryBusy = false;
    if (libraryDirty) {
      libraryDirty = false;
      void refreshLibrary();
    }
  }
}

async function openFile(id: string, kind: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const response = await fetch(`/api/files/${id}/${kind}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("File is not available yet.");
    const url = URL.createObjectURL(await response.blob());
    if (tab) tab.location.href = url;
    else {
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.${kind === "pdf" ? "pdf" : "jpg"}`;
      link.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (problem) {
    tab?.close();
    error(messageOf(problem));
  }
}
