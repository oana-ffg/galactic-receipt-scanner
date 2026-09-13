import { clockNow } from "./delivery-timing";
import QRCode from "qrcode";
import { api } from "./api";
import { StateOrder } from "./state-order";
import { PhoneCamera } from "./camera";
import { DirectPreview, type PreviewSession } from "./direct-preview";
import { messageOf } from "./errors";
import type { ScanState } from "./types";
import { CaptureLibrary } from "./library";
import "./style.css";
import { diagnostics, recordScanState, startDiagnostics } from "./diagnostics";
import { MediaRate } from "./media-diagnostics";

startDiagnostics();

const app = document.querySelector<HTMLElement>("#app")!;
const isCamera = location.pathname === "/camera";
let library: CaptureLibrary | undefined;
let lastState: ScanState | undefined;
let retakePending: string | null = null;

if (location.pathname === "/agent-access") {
  void import("./agent-access").then((module) => module.mountAgentAccess(app));
} else if (location.pathname === "/review") {
  void import("./review").then((module) => module.mountReview(app));
} else if (location.pathname === "/issues") {
  void import("./issues").then((module) => module.mountIssues(app));
} else {
  app.classList.toggle("camera-page", isCamera);
  app.innerHTML = `
    <header><div><h1>Galactic receipt scanner</h1><p>${isCamera ? "Phone camera" : "Private capture station"}</p></div><div class="counter" title="Current saved pictures; retakes count once"><strong id="count" aria-label="Saved count not loaded">—</strong><span>saved pics</span></div><a href="/review">Review receipts</a><a href="/issues">Private issues</a><a href="/agent-access">Agent access</a><button id="report-issue" class="secondary">Report issue</button><a href="/signout-with-chatgpt">Sign out</a></header>
    <section id="signal" class="signal red" role="status" aria-live="polite"><span id="light"></span><div><strong id="phase">${isCamera ? "ENABLE CAMERA" : "CONNECTING"}</strong><p id="status">${isCamera ? "Tap Enable camera below, then allow camera access." : "Connecting to your private scanner…"}</p></div></section>
    ${isCamera ? '<div class="camera-start"><button id="enable">Enable camera</button><p>Scanning starts automatically once the camera is ready.</p></div>' : ""}
    ${isCamera ? "" : '<p id="connection-warning" class="connection-warning" role="status"></p>'}
    <div class="workspace"><section class="capture-panel"><div class="preview" id="preview"><${isCamera ? "video autoplay muted playsinline" : "canvas"} id="feed"></${isCamera ? "video" : "canvas"}>${isCamera ? "" : '<video id="live-feed" autoplay muted playsinline hidden></video>'}<span id="empty-preview">${isCamera ? "Enable the rear camera to begin" : "Waiting for phone preview"}</span></div>
    <p id="detail" class="detail">Keep one receipt on a dark, matte background, with all edges visible.</p>
    <div class="controls">${isCamera ? '<button id="retake" class="secondary" disabled>Retake photo</button><button id="recover" disabled>Retry upload</button>' : '<button id="start">Start scanning</button><button id="pause" class="secondary">Pause</button><button id="retry" class="secondary">Retake photo</button><button id="recover" class="secondary">Retry upload</button><label class="toggle"><input id="audio" type="checkbox"> Audio</label>'}<button id="force" class="secondary" disabled>Force take</button><button id="set-background" class="secondary" title="Clear all paper and hands first. Set again after moving the phone or changing the lighting." disabled>Set empty desk</button><button id="clear-background" class="secondary" hidden disabled>Disable empty-desk calibration</button><button id="cancel-retake" class="secondary" hidden>Cancel retake</button></div>
    <p id="background-status" class="detail" role="status" hidden></p>
    <p id="save-recovery" class="error save-recovery" role="alert" hidden></p><p id="error" class="error" role="alert"></p>${isCamera ? '<p id="connection-warning" class="connection-warning" role="status"></p>' : ""}</section>
    ${isCamera ? "" : '<aside><section id="saved-photo" class="saved-photo"><h2>Last photo saved</h2><p>No photo saved yet.</p></section><details><summary>Connect your phone</summary><canvas id="qr"></canvas><p>Scan with the phone camera, then tap <strong>Enable camera</strong>.</p><a id="phone-link">Open camera page</a><p class="muted">Sign in with your owner account on both devices.</p></details><details><summary>Capture checks</summary><p>Paper outline, stable view, detected hands, print contrast, focus and saved image dimensions.</p><p>Green means the image passed these checks and was saved. Check your first few scans for missed fingers, glare and tiny print.</p></details></aside>'}
    </div>
    ${isCamera ? "" : '<section class="library"><div class="library-heading"><h2>Recent captures</h2><span>Originals stay intact · OCR is unverified</span></div><div id="captures"><p class="muted">No captures yet.</p></div><nav class="pagination" aria-label="Capture pages"><button id="captures-previous" class="secondary" disabled>Newer</button><span id="captures-page">Page 1</span><button id="captures-next" class="secondary" disabled>Older</button></nav></section>'}`;
  element("report-issue").onclick = async () => {
    const button = element<HTMLButtonElement>("report-issue");
    button.disabled = true;
    try {
      await (await import("./issues")).reportIssue(lastState);
    } catch (problem) {
      error(`Could not prepare the screenshot: ${messageOf(problem)}`);
    } finally {
      button.disabled = false;
    }
  };
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

function renderCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) return;
  element("count").textContent = String(count);
  element("count").setAttribute("aria-label", `${count} saved pictures`);
}

function renderState(state: ScanState): void {
  recordScanState(state);
  lastState = state;
  if (retakePending && state.selectedRetake && state.retakeOf === retakePending)
    retakePending = null;
  library?.updateState(state);
  element<HTMLButtonElement>("force").disabled =
    state.saveRecovery?.blocked === true ||
    !state.supportsForce ||
    !state.detectorReady ||
    !state.cameraConnected ||
    Boolean(state.activeId) ||
    state.recovery === "upload" ||
    Boolean(retakePending);
  element<HTMLButtonElement>("set-background").disabled =
    !state.supportsBackground ||
    !state.cameraConnected ||
    !state.detectorReady ||
    Boolean(state.activeId) ||
    state.recovery === "upload";
  element<HTMLButtonElement>("clear-background").hidden =
    !state.backgroundReady || !state.supportsBackgroundReset;
  element<HTMLButtonElement>("clear-background").disabled =
    element<HTMLButtonElement>("set-background").disabled ||
    !state.supportsBackgroundReset;
  element<HTMLButtonElement>("set-background").textContent =
    state.backgroundReady ? "Recalibrate empty desk" : "Set empty desk";
  element("background-status").textContent = state.backgroundMessage ?? "";
  element("background-status").hidden = !state.backgroundMessage;
  element<HTMLButtonElement>("cancel-retake").hidden = !state.selectedRetake;
  element<HTMLButtonElement>("cancel-retake").disabled =
    Boolean(state.activeId) || state.recovery === "upload";

  element("save-recovery").textContent = state.saveRecovery?.warning ?? "";
  element("save-recovery").hidden = !state.saveRecovery?.warning;
  element("signal").className =
    `signal ${state.saveRecovery?.blocked ? "red" : state.phase}`;
  element("connection-warning").textContent = state.previewWarning ?? "";
  element("phase").textContent =
    state.saveRecovery?.blocked && !state.activeId
      ? "SAVE RECOVERY NEEDED"
      : !state.cameraConnected
        ? state.detectorReady
          ? "RECONNECTING"
          : "CAMERA STOPPED"
        : state.manualReview && !state.activeId
          ? "SAVED FOR REVIEW"
          : state.needsAttention
            ? "NEEDS ATTENTION"
            : state.phase === "green"
              ? "SAVED · NEXT"
              : state.phase === "amber"
                ? state.stage === "uploading"
                  ? "SAVING ORIGINAL"
                  : state.stage === "photo"
                    ? "TAKING PHOTO"
                    : state.stage === "checking"
                      ? "CHECKING PHOTO"
                      : "CHECKING STABILITY"
                : state.paused
                  ? "PAUSED"
                  : "WAIT";
  element("status").textContent =
    state.saveRecovery?.blocked && !state.activeId
      ? "New captures are waiting while saved-photo recovery needs attention."
      : retakePending
        ? "Waiting for the phone to select this retake. Do not start scanning yet."
        : state.message;
  if (state.countKnown !== false) renderCount(state.count);
  if (state.phase === "green" && state.timings) {
    const seconds =
      Object.values(state.timings).reduce((sum, ms) => sum + (ms ?? 0), 0) /
      1000;
    element("detail").textContent =
      `Original checked and saved in ${seconds.toFixed(1)} s. PDFs and OCR are processed later.`;
  }
  if (isCamera) {
    element<HTMLButtonElement>("retake").disabled =
      !state.detectorReady ||
      !state.cameraConnected ||
      state.recovery === "upload" ||
      Boolean(state.activeId) ||
      (state.recovery !== "retake" && !state.lastCapture);
    element<HTMLButtonElement>("recover").disabled =
      Boolean(state.activeId) ||
      (state.recovery !== "upload" && !state.saveRecovery?.warning);
  }
  if (!isCamera) {
    for (const id of ["start", "pause", "retry"]) {
      element<HTMLButtonElement>(id).disabled =
        Boolean(state.activeId) ||
        !state.detectorReady ||
        Boolean(retakePending);
    }
    element<HTMLButtonElement>("retry").disabled ||=
      state.recovery === "upload" ||
      (!state.lastCapture && state.recovery !== "retake");
    element<HTMLButtonElement>("recover").disabled =
      Boolean(state.activeId) ||
      (state.recovery !== "upload" && !state.saveRecovery?.warning);
    element<HTMLButtonElement>("start").disabled ||= !state.paused;
    element<HTMLButtonElement>("pause").disabled ||= state.paused;
    if (state.phase !== "green")
      element("detail").textContent = state.activeId
        ? "Wait for the saved acknowledgement before removing this receipt."
        : "Keep all paper edges visible. Remove each saved receipt completely before the next.";
  }
}

function disconnected(reason = "Connection lost. Waiting to reconnect…"): void {
  diagnostics.record("network", { connected: false, source: "station" }, 2000);
  for (const id of [
    "start",
    "pause",
    "retry",
    "recover",
    "force",
    "cancel-retake",
    "set-background",
    "clear-background",
  ]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = true;
  }
  if (lastState) library?.updateState({ ...lastState, cameraConnected: false });
  element("signal").className = "signal red";
  element("connection-warning").textContent = "";
  element("feed").hidden = true;
  element("empty-preview").hidden = false;
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
      element<HTMLButtonElement>("enable").textContent = "Enable camera";
      element("empty-preview").hidden = false;
    },
  );
  // A claim may finish before startup emits state; its newer count wins.
  // This read itself never claims the lease or enables the camera.
  void api<{ count: number }>("/api/station", {
    signal: AbortSignal.timeout(4000),
  }).then(
    ({ count }) => renderCount(camera.savedCount ?? count),
    () => {
      if (camera.savedCount !== null) renderCount(camera.savedCount);
      else
        element("count").setAttribute("aria-label", "Saved count unavailable");
    },
  );
  element("enable").onclick = async () => {
    element<HTMLButtonElement>("enable").disabled = true;
    element<HTMLButtonElement>("enable").textContent = "Starting camera…";
    element("phase").textContent = "STARTING CAMERA";
    element("status").textContent =
      "Loading image checks, then requesting camera access…";
    error("");
    try {
      await camera.start();
      element("empty-preview").hidden = true;
      element<HTMLButtonElement>("enable").disabled = true;
      element<HTMLButtonElement>("enable").textContent = "Camera enabled";
    } catch (problem) {
      diagnostics.record("camera.error", { stage: "start" });
      camera.stop(messageOf(problem));
    }
  };
  element("recover").onclick = () => void camera.recover();
  element("set-background").onclick = () => camera.setBackground();
  element("clear-background").onclick = () => camera.clearBackground();
  element("retake").onclick = () => camera.retake();
  element("force").onclick = () => void camera.force();
  element("cancel-retake").onclick = () =>
    void api("/api/control/cancel-retake", { method: "POST" }).catch(
      (problem) => error(messageOf(problem)),
    );
}

function mountDashboard(): void {
  library = new CaptureLibrary(async (id) => {
    if (retakePending)
      throw new Error("Wait for the phone to acknowledge the selected retake.");
    retakePending = id;
    if (lastState) renderState(lastState);
    try {
      await api("/api/control/retake", {
        method: "POST",
        body: JSON.stringify({ captureId: id }),
      });
    } catch (problem) {
      retakePending = null;
      if (lastState) renderState(lastState);
      throw problem;
    }
  });
  const phone = new URL("/camera", location.origin);
  element<HTMLAnchorElement>("phone-link").href = phone.href;
  void QRCode.toCanvas(element<HTMLCanvasElement>("qr"), phone.href, {
    width: 188,
    margin: 1,
  });
  let lastSaved: string | null = null;
  let lastError = "";
  let needsAttention = false;
  let audio: AudioContext | null = null;
  const live = element<HTMLVideoElement>("live-feed");
  const stateOrder = new StateOrder();
  diagnostics.record("preview.latency", {
    frameCallbackAvailable:
      typeof live.requestVideoFrameCallback === "function",
  });
  let previewLatencyAt = -Infinity;
  if (typeof live.requestVideoFrameCallback === "function") {
    const frame = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (now - previewLatencyAt >= 2000) {
        previewLatencyAt = now;
        const extra = metadata as VideoFrameCallbackMetadata & {
          captureTime?: number;
          receiveTime?: number;
        };
        diagnostics.record("preview.latency", {
          captureTimeAvailable: Number.isFinite(extra.captureTime),
          receiveTimeAvailable: Number.isFinite(extra.receiveTime),
          mediaTime: metadata.mediaTime,
          captureToPresentMs: Number.isFinite(extra.captureTime)
            ? metadata.expectedDisplayTime - extra.captureTime!
            : undefined,
          receiveToPresentMs: Number.isFinite(extra.receiveTime)
            ? metadata.expectedDisplayTime - extra.receiveTime!
            : undefined,
          processingMs:
            metadata.processingDuration === undefined
              ? undefined
              : metadata.processingDuration * 1000,
        });
      }
      live.requestVideoFrameCallback(frame);
    };
    live.requestVideoFrameCallback(frame);
  }
  let lastVideoFrame = 0;
  let decodedFrames = 0;
  let httpFrames = 0;
  let lastHttpFrame = "";
  let deliverySampleAt = -Infinity;
  const directRate = new MediaRate();
  const httpRate = new MediaRate();
  const videoFresh = () => {
    const frames = live.getVideoPlaybackQuality().totalVideoFrames;
    if (frames !== decodedFrames) {
      decodedFrames = frames;
      lastVideoFrame = performance.now();
    }
    return (
      direct.fresh &&
      lastVideoFrame > 0 &&
      performance.now() - lastVideoFrame < 2000
    );
  };
  const direct = new DirectPreview(
    (state, sentAt) => acceptState(state, "direct", sentAt),
    () => {},
    (stream) => {
      live.srcObject = stream;
      lastVideoFrame = 0;
      decodedFrames = 0;
      live.hidden = !stream;
      if (stream) {
        element("feed").hidden = true;
        element("empty-preview").hidden = true;
        void live.play().catch(() => {
          lastVideoFrame = 0;
          live.hidden = true;
        });
      }
    },
  );
  const audioToggle = input("audio");
  try {
    audioToggle.checked = localStorage.getItem("scanner-audio") !== "off";
  } catch {
    audioToggle.checked = true;
  }
  function enableAudio() {
    if (audioToggle.checked) {
      audio ??= new AudioContext();
      void audio.resume().catch(() => {});
    }
  }
  document.addEventListener("pointerdown", enableAudio, { once: true });
  document.addEventListener("keydown", enableAudio, { once: true });
  audioToggle.onchange = () => {
    try {
      localStorage.setItem("scanner-audio", audioToggle.checked ? "on" : "off");
    } catch {
      /* Keep the current choice when browser storage is unavailable. */
    }
    enableAudio();
  };
  function sound(success: boolean): void {
    if (!audioToggle.checked || !audio) return;
    for (let i = 0; i < (success ? 1 : 3); i++) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const start = audio.currentTime + i * 0.3;
      oscillator.type = success ? "sine" : "sawtooth";
      oscillator.frequency.setValueAtTime(success ? 880 : 180, start);
      if (!success)
        oscillator.frequency.exponentialRampToValueAtTime(80, start + 0.22);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(success ? 0.12 : 0.09, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.24);
    }
  }
  let deliveryPhase = "";
  function acceptState(
    state: ScanState,
    path: "direct" | "http" = "http",
    sentAt?: number,
  ) {
    const receivedAt = clockNow();
    const accepted = stateOrder.accept(state);
    const key = `${path}:${state.phase}:${state.stage}:${state.armed}:${accepted}`;
    diagnostics.record(
      "state.delivery",
      {
        path,
        accepted,
        revision: state.stateRevision,
        phoneEmittedAt: state.emittedAt,
        desktopReceivedAt: receivedAt,
        phoneSentAt: sentAt,
        ...direct.deliveryAge(state.emittedAt, receivedAt),
        transportAgeEstimateMs: direct.deliveryAge(sentAt, receivedAt)
          .ageEstimateMs,
      },
      key === deliveryPhase ? 2000 : 0,
    );
    deliveryPhase = key;
    if (!accepted) return;
    if (state.needsAttention && !needsAttention) void refreshLibrary();
    needsAttention = !!state.needsAttention;
    if (state.lastSaved && state.lastSaved !== lastSaved) {
      if (lastState) sound(!state.manualReview);
      void refreshLibrary();
    }
    if (
      state.phase === "red" &&
      state.message !== lastError &&
      lastState?.phase === "amber" &&
      !lastState.manualReview
    )
      sound(false);
    lastSaved = state.lastSaved;
    lastError = state.message;
    renderState(state);
    diagnostics.record(
      "state.delivery",
      {
        path,
        revision: state.stateRevision,
        renderedAt: clockNow(),
        renderMs: clockNow() - receivedAt,
      },
      2000,
      "render",
    );
  }
  let fallbackRequestedAt = -Infinity;
  let fallbackRequestPending = false;
  async function requestFallback(camera: string) {
    if (
      fallbackRequestPending ||
      performance.now() - fallbackRequestedAt < 2000
    )
      return;
    fallbackRequestPending = true;
    fallbackRequestedAt = performance.now();
    try {
      await api("/api/station/preview-request", {
        method: "POST",
        body: JSON.stringify({ camera }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      // Preview retrieval reports availability; retry this short demand lease.
    } finally {
      fallbackRequestPending = false;
    }
  }
  async function poll() {
    try {
      const result = await api<{
        state: ScanState | null;
        camera: string | null;
        previewSession: PreviewSession | null;
        count: number;
        fresh: boolean;
      }>("/api/station", { signal: AbortSignal.timeout(4000) });
      stateOrder.setCamera(result.camera);
      void direct.sync(result.camera, result.previewSession);
      if (
        result.camera &&
        document.visibilityState === "visible" &&
        !videoFresh()
      )
        void requestFallback(result.camera);
      if (result.state && result.fresh) {
        const message = { ...result.state, count: result.count };
        if (message.stateRevision !== undefined || !direct.fresh)
          acceptState(message);
      } else {
        if (!direct.fresh)
          disconnected(
            "Phone preview paused or disconnected. Reopen the camera page on your phone; it will reconnect.",
          );
        renderCount(result.count);
      }
    } catch (problem) {
      if (!direct.fresh) disconnected(messageOf(problem));
    }
    setTimeout(() => void poll(), 700);
  }
  void poll();
  async function preview() {
    const started = performance.now();
    if (!videoFresh()) {
      live.hidden = true;
      let status = 0;
      try {
        const response = await fetch("/api/station/preview", {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        });
        status = response.status;
        if (!response.ok) throw new Error("Waiting for a fresh phone preview.");
        const blob = await response.blob();
        let newFrame = false;
        if (!videoFresh()) {
          await drawPreview(blob);
          const frame = response.headers.get("X-Preview-Received-At");
          if (frame && frame !== lastHttpFrame) {
            lastHttpFrame = frame;
            httpFrames++;
            newFrame = true;
          }
        }
        const age = response.headers.get("X-Preview-Age-Ms");
        diagnostics.record(
          "preview.http",
          {
            ok: true,
            status,
            newFrame,
            ms: performance.now() - started,
            serverAgeMs: age === null ? undefined : Number(age),
          },
          2000,
          "success",
        );
      } catch (problem) {
        diagnostics.record(
          "preview.http",
          { ok: false, status, ms: performance.now() - started },
          2000,
          `failure-${status}`,
        );
        if (!videoFresh()) {
          element("feed").hidden = true;
          element("empty-preview").hidden = false;
          element("connection-warning").textContent =
            `Preview unavailable. ${messageOf(problem)}`;
        }
      }
    } else {
      live.hidden = false;
      element("feed").hidden = true;
      element("empty-preview").hidden = true;
    }
    if (started - deliverySampleAt >= 2000) {
      deliverySampleAt = started;
      try {
        const playback = live.getVideoPlaybackQuality();
        diagnostics.record("preview.delivery", {
          path:
            !live.hidden && videoFresh()
              ? "direct"
              : element("feed").hidden
                ? "none"
                : "http",
          directConnected: direct.connected,
          stateFresh: direct.fresh,
          width: live.videoWidth,
          height: live.videoHeight,
          decodedFrames: playback.totalVideoFrames,
          decodedFps: directRate.sample(playback.totalVideoFrames, started),
          droppedFrames: playback.droppedVideoFrames,
          httpFrames,
          httpFps: lastHttpFrame
            ? httpRate.sample(httpFrames, started)
            : undefined,
        });
      } catch {
        // Telemetry failure must not affect the preview loop.
      }
    }
    setTimeout(
      () => void preview(),
      Math.max(50, 250 - (performance.now() - started)),
    );
  }
  void preview();
  for (const id of [
    "start",
    "pause",
    "retry",
    "recover",
    "force",
    "cancel-retake",
    "set-background",
    "clear-background",
  ]) {
    element(id).onclick = async () => {
      error("");
      try {
        const command = id === "recover" ? "retry-upload" : id;
        if (direct.command(command)) return;
        await api(`/api/control/${command}`, {
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
  canvas.hidden = false;
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
  await library?.refresh();
}

import { registerSiteTools } from "./site-tools";
if (!isCamera && location.pathname !== "/review")
  registerSiteTools(refreshLibrary);
