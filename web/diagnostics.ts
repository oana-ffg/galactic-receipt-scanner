import type { ScanState } from "./types";

type Event =
  | "audio"
  | "page"
  | "visibility"
  | "network"
  | "runtime.error"
  | "request"
  | "scan.state"
  | "scan.transition"
  | "scan.removal"
  | "scan.removal.change"
  | "save.timing"
  | "save.request"
  | "state.delivery"
  | "preview.latency"
  | "camera.start"
  | "camera.stop"
  | "camera.frames"
  | "camera.settings"
  | "camera.photo"
  | "camera.error"
  | "vision"
  | "preview.peer"
  | "preview.channel"
  | "preview.http"
  | "preview.delivery"
  | "preview.rtp"
  | "upload.start"
  | "upload.recovery"
  | "upload.saved";
type Fields = Record<string, string | number | boolean | null | undefined>;
interface Entry {
  at: number;
  event: Event;
  data: Fields;
}

/** Local, bounded structured diagnostics. Never collect bodies, headers or images. */
export class DiagnosticHistory {
  private entries: Entry[] = [];
  private size = 0;
  private last = new Map<string, number>();
  constructor(
    private now = () => Date.now(),
    private maxSize = 24000,
  ) {}

  record(
    event: Event,
    fields: Fields = {},
    intervalMs = 0,
    discriminator = "",
  ) {
    const at = this.now();
    this.prune(at);
    const key = `${event}:${discriminator.slice(0, 120)}`;
    if (at - (this.last.get(key) ?? -Infinity) < intervalMs) return;
    this.last.delete(key);
    this.last.set(key, at);
    if (this.last.size > 64) this.last.delete(this.last.keys().next().value!);
    const data: Fields = {};
    for (const [key, value] of Object.entries(fields).slice(0, 48)) {
      if (typeof value === "string") data[key] = value.slice(0, 180);
      else if (typeof value === "number" && Number.isFinite(value))
        data[key] = Math.round(value * 100) / 100;
      else if (typeof value === "boolean" || value === null) data[key] = value;
    }
    const entry = { at, event, data };
    this.entries.push(entry);
    this.size += JSON.stringify(entry).length + 1;
    this.prune(at);
  }
  private prune(at: number) {
    while (
      this.entries.length &&
      (this.entries[0].at < at - 120000 ||
        this.entries.length > 180 ||
        this.size > this.maxSize)
    ) {
      this.size -= JSON.stringify(this.entries.shift()!).length + 1;
    }
  }
  snapshot() {
    this.prune(this.now());
    return this.entries.map((entry) => ({ ...entry, data: { ...entry.data } }));
  }
}

export const diagnostics = new DiagnosticHistory(() => Date.now(), 12000);
export const audioDiagnostics = new DiagnosticHistory(() => Date.now(), 4000);
// A separate budget prevents network chatter from evicting removal evidence.
export const removalDiagnostics = new DiagnosticHistory(
  () => Date.now(),
  12000,
);

const removalTransitions = new DiagnosticHistory(() => Date.now(), 6000);
const saveTimings = new DiagnosticHistory(() => Date.now(), 8000);
let removalCycle = "";
let removalSample = 0;
let removalGate = "";
const saveKeys = new Map<string, string>();

// Only a route category is retained: no capture IDs, query strings or file names.
export function requestCategory(path: string): string {
  const route = path.split(/[?#]/)[0];
  if (route.startsWith("/api/station/")) {
    const action = route.slice(13);
    if (
      [
        "claim",
        "release",
        "heartbeat",
        "preview",
        "preview-request",
        "direct-preview",
      ].includes(action)
    )
      return `station/${action}`;
  }
  if (route === "/api/station") return "station";
  for (const category of ["captures", "issues", "files", "control"])
    if (route === `/api/${category}` || route.startsWith(`/api/${category}/`))
      return category;
  return "other";
}

let transition = "";
export function recordScanState(state: ScanState) {
  const q = state.quality;
  for (const timing of [
    state.saveTiming,
    state.saveRecovery?.timing,
    state.saveRecovery?.resendTiming,
  ]) {
    if (!timing) continue;
    const key = JSON.stringify(timing);
    if (saveKeys.get(timing.kind) === key) continue;
    saveKeys.set(timing.kind, key);
    for (const [index, request] of (timing.requests ?? []).entries()) {
      const requestKey = `${timing.at}:${index}:${JSON.stringify(request)}`;
      const slot = `${timing.kind}:${index}`;
      if (saveKeys.get(slot) === requestKey) continue;
      saveKeys.set(slot, requestKey);
      saveTimings.record("save.request", {
        attemptAt: timing.at,
        kind: timing.kind,
        request: index + 1,
        at: request.at,
        status: request.status,
        failedStage: request.failedStage,
        ...request.values,
      });
    }
    saveTimings.record("save.timing", {
      at: timing.at,
      kind: timing.kind,
      outcome: timing.outcome,
      bytes: timing.bytes,
      status: timing.status,
      failedStage: timing.failedStage,
      ...timing.values,
    });
  }
  if (state.removalDiagnostics && !state.activeId) {
    const cycle = state.lastCapture
      ? `${state.cameraId}:${state.lastCapture}:${state.removalDiagnostics.epoch}`
      : removalCycle;
    if (cycle !== removalCycle) {
      removalCycle = cycle;
      removalSample = 0;
      removalGate = "";
    }
    const { transitions, ...removalSummary } = state.removalDiagnostics;
    for (const change of transitions ?? []) {
      if (change.sample <= removalSample) continue;
      removalSample = change.sample;
      removalTransitions.record("scan.removal.change", { ...change });
    }
    const gate = `${state.removalDiagnostics.gate}:${q.removalDiagnostics?.geometry}:${state.removalDiagnostics.resets}`;
    const changed = gate !== removalGate;
    removalGate = gate;
    removalDiagnostics.record(
      "scan.removal",
      {
        ...q.removalDiagnostics,
        ...removalSummary,
        armed: state.armed,
        empty: q.empty,
        strong: q.emptyStrong,
        handsChecked: q.handsChecked,
        hands: q.hands.length,
      },
      changed ? 0 : 1000,
    );
  }
  const data = {
    phase: state.phase,
    stage: state.stage ?? null,
    armed: state.armed,
    paused: state.paused,
    connected: state.cameraConnected,
    detectorReady: state.detectorReady,
    recovery: state.recovery ?? null,
    activeId: state.activeId,
    lastCapture: state.lastCapture,
    revision: state.stateRevision,
    previewFresh: state.streamFresh,
    previewWarning: Boolean(state.previewWarning),
    ok: q.ok,
    paper: Boolean(q.quad),
    reason: q.reason,
    hands: q.hands?.length,
    handsChecked: q.handsChecked,
    candidateReady: q.candidateReady,
    empty: q.empty,
    emptyStrong: q.emptyStrong,
    motion: q.motion,
    focus: q.focus,
    contrast: q.contrast,
    sharpness: q.sharpness,
    photoMs: state.timings?.photoMs,
    checksMs: state.timings?.checksMs,
    saveMs: state.timings?.saveMs,
    verificationPending: state.saveRecovery?.pending,
    retainedBytes: state.saveRecovery?.bytes,
    verificationBlocked: state.saveRecovery?.blocked,
  };
  const key = JSON.stringify([
    state.phase,
    state.stage,
    state.armed,
    state.paused,
    state.cameraConnected,
    state.detectorReady,
    state.recovery,
    state.activeId,
    state.lastCapture,
    Boolean(state.previewWarning),
    state.saveRecovery?.blocked,
  ]);
  if (key !== transition) {
    transition = key;
    diagnostics.record("scan.transition", data);
  } else diagnostics.record("scan.state", data, 2000);
}

export function startDiagnostics() {
  diagnostics.record("page", { page: location.pathname });
  document.addEventListener("visibilitychange", () =>
    diagnostics.record("visibility", { state: document.visibilityState }),
  );
  for (const event of ["online", "offline"])
    window.addEventListener(event, () =>
      diagnostics.record("network", { online: navigator.onLine }),
    );
  // Error messages/console arguments can contain receipt text or credentials.
  // Keep categories and source positions, never arbitrary error payloads.
  window.addEventListener("error", (event) =>
    diagnostics.record("runtime.error", {
      kind: "uncaught",
      line: event.lineno,
      column: event.colno,
    }),
  );
  window.addEventListener("unhandledrejection", () =>
    diagnostics.record("runtime.error", { kind: "unhandled-rejection" }),
  );
}

export function diagnosticSnapshot() {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    device: location.pathname === "/camera" ? "phone" : "desktop",
    build: new URL(import.meta.url).pathname,
    browser: navigator.userAgent.slice(0, 300),
    visibility: document.visibilityState,
    online: navigator.onLine,
    history: diagnostics.snapshot(),
    audioHistory: audioDiagnostics.snapshot(),
    removalHistory: removalDiagnostics.snapshot(),
    removalTransitions: removalTransitions.snapshot(),
    saveHistory: saveTimings.snapshot(),
  };
}
