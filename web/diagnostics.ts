import type { ScanState } from "./types";

type Event =
  | "page"
  | "visibility"
  | "network"
  | "runtime.error"
  | "request"
  | "scan.state"
  | "scan.transition"
  | "scan.removal"
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

export const diagnostics = new DiagnosticHistory();
// A separate budget prevents network chatter from evicting removal evidence.
export const removalDiagnostics = new DiagnosticHistory(
  () => Date.now(),
  16000,
);

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
  if (state.removalDiagnostics && !state.activeId) {
    removalDiagnostics.record(
      "scan.removal",
      {
        ...q.removalDiagnostics,
        ...state.removalDiagnostics,
        armed: state.armed,
        empty: q.empty,
        strong: q.emptyStrong,
        handsChecked: q.handsChecked,
        hands: q.hands.length,
      },
      state.removalDiagnostics.gate === "removed" ? 0 : 1000,
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
    removalHistory: removalDiagnostics.snapshot(),
  };
}
