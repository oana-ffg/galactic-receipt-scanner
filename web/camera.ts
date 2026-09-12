import { sha256 } from "./checksum";
import { api } from "./api";
import { messageOf, RequestError } from "./errors";
import {
  acknowledge,
  pendingCaptures,
  savePending,
  type PendingCapture,
} from "./pending";
import { retakeTarget } from "./control-command";
import { CaptureState } from "./state";
import { Vision } from "./vision";
import { DirectPreview, type PreviewSession } from "./direct-preview";
import type { Capture, ScanState } from "./types";
interface PhotoCapture {
  takePhoto(settings?: {
    imageWidth?: number;
    imageHeight?: number;
  }): Promise<Blob>;
  getPhotoCapabilities(): Promise<{
    imageWidth?: { max: number };
    imageHeight?: { max: number };
  }>;
}
type PhotoConstructor = new (track: MediaStreamTrack) => PhotoCapture;
export class PhoneCamera {
  private stream: MediaStream | null = null;
  private machine = new CaptureState();
  private vision: Vision | null = null;
  private running = false;
  private busy = false;
  private connected = false;
  private previewRequestedUntil = 0;
  private camera = crypto.randomUUID();
  private sequence = 0;
  private generation = 0;
  private stateRevision = 0;
  private connectionIssue = "";
  private canvas = document.createElement("canvas");
  private previewCanvas = document.createElement("canvas");
  private direct = new DirectPreview(
    () => {},
    (command) => {
      if (!this.running || !this.connected || this.busy) return;
      if (command === "retry-upload") void this.recover();
      else if (command === "force") void this.force();
      else this.machine.control(command);
      this.emitState();
    },
    () => {},
  );
  private wakeLock: WakeLockSentinel | null = null;
  private nativePhotoAvailable = true;
  get savedCount(): number | null {
    return this.machine.value.countKnown ? this.machine.value.count : null;
  }
  constructor(
    private video: HTMLVideoElement,
    private status: (message: string) => void,
    private state: (state: ScanState) => void,
    private onStopped: () => void,
  ) {
    window.addEventListener("pagehide", () => this.stop());
    document.addEventListener("visibilitychange", () => {
      this.machine.interrupt();
      if (this.running && document.visibilityState === "visible") {
        void this.keepAwake();
        void this.video
          .play()
          .catch(() =>
            this.stop(
              "Camera playback stopped. Tap Enable camera to restart it.",
            ),
          );
      }
    });
  }
  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "Camera access requires HTTPS. Open the private Site in Safari.",
      );
    this.machine = new CaptureState();
    this.camera = crypto.randomUUID();
    this.stateRevision = 0;
    const generation = ++this.generation;
    this.status("Loading receipt and hand checks…");
    this.vision = new Vision();
    await this.vision.request();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 15, max: 30 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    try {
      await this.claim();
    } catch (error) {
      this.stop();
      throw error;
    }
    this.running = true;
    this.connected = true;
    this.machine.value.detectorReady = true;
    this.stream
      .getVideoTracks()[0]
      .addEventListener("ended", () => this.stop());
    await this.keepAwake();
    this.status(
      `Camera ready: ${this.video.videoWidth} × ${this.video.videoHeight}. Use the desktop controls.`,
    );
    this.emitState();
    void this.heartbeat(generation);
    void this.detect(generation);
    void this.preview(generation);
    await this.recover();
    if (!this.running) throw new Error(this.machine.value.message);
  }
  private async claim() {
    const claim = await api<{ sequence: number; count: number }>(
      "/api/station/claim",
      {
        method: "POST",
        body: JSON.stringify({ camera: this.camera }),
        signal: AbortSignal.timeout(4000),
      },
    );
    this.sequence = claim.sequence;
    this.machine.value.count = claim.count;
    this.machine.value.countKnown = true;
    this.previewRequestedUntil = 0;
  }
  retake() {
    if (
      !this.running ||
      !this.connected ||
      this.busy ||
      this.machine.value.recovery === "upload"
    )
      return;
    this.machine.control("retry");
    this.emitState();
  }
  private async keepAwake() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.status("Keep the phone awake and this page visible.");
    }
  }
  stop(message = "Camera stopped. Tap Enable camera to reconnect.") {
    if (this.running)
      void api("/api/station/release", {
        method: "POST",
        body: JSON.stringify({ camera: this.camera }),
        keepalive: true,
      }).catch(() => {
        /* Expiry releases the lease if the network is unavailable. */
      });
    this.generation++;
    this.running = false;
    this.connected = false;
    this.direct.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.vision?.close();
    this.vision = null;
    void this.wakeLock?.release();
    this.machine.value.cameraConnected = false;
    this.machine.value.detectorReady = false;
    this.machine.failed(message);
    this.emitState();
    this.onStopped();
  }
  private emitState() {
    this.machine.value.cameraId = this.camera;
    this.machine.value.stateRevision = ++this.stateRevision;
    const state: ScanState =
      this.running && !this.connected
        ? {
            ...this.machine.value,
            phase: "red",
            cameraConnected: false,
            message: `${this.connectionIssue} Reconnecting automatically; new captures are waiting.`,
          }
        : this.machine.value;
    this.state(state);
    this.direct.sendState(state);
  }
  private sessionEnded(error: unknown): boolean {
    if (
      !(error instanceof RequestError) ||
      ![401, 403, 409].includes(error.status)
    )
      return false;
    this.stop(
      error.status === 409
        ? "The camera connection expired or another camera took over. Tap Enable camera to reconnect."
        : error.message,
    );
    return true;
  }
  private async heartbeat(generation: number) {
    while (this.running && this.generation === generation) {
      if (document.visibilityState !== "visible") {
        this.machine.interrupt();
        await delay(700);
        continue;
      }
      try {
        const result = await api<{
          sequence: number;
          command: string;
          previewSession: PreviewSession | null;
          previewRequestedForMs?: number;
        }>("/api/station/heartbeat", {
          method: "POST",
          body: JSON.stringify({
            camera: this.camera,
            state: this.machine.value,
          }),
          signal: AbortSignal.timeout(4000),
        });
        if (!this.running || this.generation !== generation) return;
        this.connected = true;
        this.previewRequestedUntil =
          performance.now() +
          Math.min(5000, Math.max(0, result.previewRequestedForMs ?? 0));
        void this.direct.sync(this.camera, result.previewSession, this.stream!);
        if (
          result.sequence !== this.sequence &&
          !this.busy &&
          !(
            retakeTarget(result.command) &&
            this.machine.value.recovery === "upload"
          )
        ) {
          this.sequence = result.sequence;
          if (result.command === "retry-upload") void this.recover();
          else if (result.command === "force") void this.force();
          else this.machine.control(result.command);
        }
      } catch (error) {
        if (!this.running || this.generation !== generation) return;
        this.connected = false;
        this.connectionIssue = messageOf(error);
        this.machine.interrupt();
        if (error instanceof RequestError && error.status === 409) {
          try {
            await this.claim();
            if (!this.running || this.generation !== generation) return;
            this.direct.close();
            this.connected = true;
          } catch (claimError) {
            if (this.sessionEnded(claimError)) return;
            this.connectionIssue = messageOf(claimError);
          }
        } else if (this.sessionEnded(error)) return;
      }
      this.emitState();
      await delay(700);
    }
  }
  private async detect(generation: number) {
    while (this.running && this.generation === generation) {
      const started = performance.now();
      try {
        if (
          this.connected &&
          !this.busy &&
          this.video.readyState >= 2 &&
          document.visibilityState === "visible"
        ) {
          drawFrame(this.video, this.canvas, 800);
          const analysis = await this.vision!.request(
            await createImageBitmap(this.canvas),
            { preview: this.machine.previewChecks },
          );
          if (!this.running || this.generation !== generation) return;
          if (!this.connected) continue;
          const id = this.machine.observe(analysis.quality, performance.now());
          this.emitState();
          if (id) await this.capture(id);
        }
      } catch (error) {
        if (!this.running || this.generation !== generation) return;
        this.stop(
          `Image checks stopped. ${messageOf(error)} Tap Enable camera to restart the checks.`,
        );
      }
      await delay(Math.max(20, 150 - (performance.now() - started)));
    }
  }
  private async preview(generation: number) {
    while (this.running && this.generation === generation) {
      const started = performance.now();
      // Direct video continues during capture. HTTP preview yields upload bandwidth
      // to the original and never holds up detection or creates a frame backlog.
      if (
        (!this.direct.connected ||
          performance.now() < this.previewRequestedUntil) &&
        this.connected &&
        !this.busy &&
        this.video.readyState >= 2 &&
        document.visibilityState === "visible"
      ) {
        try {
          drawFrame(this.video, this.previewCanvas, 640);
          let body = await encode(this.previewCanvas, 0.55);
          if (body.size > 150000) {
            drawFrame(this.video, this.previewCanvas, 480);
            body = await encode(this.previewCanvas, 0.4);
          }
          if (body.size > 150000)
            throw new Error(
              "Preview image is too large; direct video is still being attempted.",
            );
          await api("/api/station/preview", {
            method: "POST",
            headers: {
              "Content-Type": "image/jpeg",
              "X-Camera-Id": this.camera,
            },
            body,
            signal: AbortSignal.timeout(4000),
          });
          if (!this.running || this.generation !== generation) return;
          this.machine.value.previewWarning = undefined;
          this.machine.value.streamFresh = true;
        } catch (error) {
          if (!this.running || this.generation !== generation) return;
          if (
            !(error instanceof RequestError && error.status === 409) &&
            this.sessionEnded(error)
          )
            return;
          this.machine.value.streamFresh = false;
          this.machine.value.previewWarning = `Desktop preview is delayed. ${messageOf(error)} Retrying automatically.`;
        }
      }
      if (this.direct.connected) {
        this.machine.value.previewWarning = undefined;
        this.machine.value.streamFresh = true;
      }
      await delay(Math.max(50, 300 - (performance.now() - started)));
    }
  }
  private async still(): Promise<{ blob: Blob; method: string }> {
    const track = this.stream!.getVideoTracks()[0];
    const Constructor = (
      window as unknown as { ImageCapture?: PhotoConstructor }
    ).ImageCapture;
    if (Constructor && this.nativePhotoAvailable) {
      try {
        const camera = new Constructor(track);
        const caps = await camera.getPhotoCapabilities();
        const blob = await camera.takePhoto({
          ...(caps.imageWidth?.max ? { imageWidth: caps.imageWidth.max } : {}),
          ...(caps.imageHeight?.max
            ? { imageHeight: caps.imageHeight.max }
            : {}),
        });
        if (!blob.size) throw new Error("Empty photo.");
        return { blob, method: "ImageCapture.takePhoto" };
      } catch {
        this.nativePhotoAvailable = false;
      }
    }
    // Freeze the full-resolution frame and encode it in the existing worker.
    // Avoid repeated multi-megapixel HTML canvas/toBlob allocations on iOS.
    const bitmap = await createImageBitmap(this.video);
    return {
      blob: await this.vision!.encodeFrame(bitmap),
      method: "full-resolution-video-frame",
    };
  }
  async force() {
    if (!this.running || !this.connected || this.busy) return;
    const id = this.machine.force();
    if (id) await this.capture(id, true);
  }
  private async capture(id: string, manual = false) {
    if (this.busy) return;
    this.busy = true;
    const started = performance.now();
    let retained = false;
    try {
      if ((await pendingCaptures()).length) {
        retained = true;
        throw new Error("An image is pending. Use Retry upload first.");
      }
      this.machine.value.stage = "photo";
      this.machine.value.message = "Taking the photo…";
      this.emitState();
      const { blob, method } = await this.still();
      const photoMs = performance.now() - started;
      const capture: PendingCapture = {
        id,
        retakeOf: this.machine.value.retakeOf,
        manual,
        blob,
        method,
        sourcePixels: [this.video.videoWidth, this.video.videoHeight],
        quality: {
          ok: false,
          quad: null,
          hands: [],
          reason:
            "Full-resolution image checks were interrupted. Retake needed.",
        },
      };
      await savePending(capture);
      retained = true;
      const bitmap = await createImageBitmap(blob);
      capture.sourcePixels = [bitmap.width, bitmap.height];
      if (bitmap.width * bitmap.height > 55000000) {
        bitmap.close();
        throw new Error("Image exceeds the supported 55 megapixels.");
      }
      this.machine.value.stage = "checking";
      this.machine.value.message = "Checking the captured image…";
      this.emitState();
      const checksStarted = performance.now();
      const result = await this.vision!.request(bitmap, { full: true });
      this.machine.value.timings = {
        photoMs,
        checksMs: performance.now() - checksStarted,
      };
      capture.quality = result.quality;
      await savePending(capture);
      await this.upload(capture);
    } catch (error) {
      this.machine.failed(
        `Capture needs attention: ${messageOf(error)}`,
        retained ? "upload" : "retake",
      );
      this.status(messageOf(error));
    } finally {
      this.busy = false;
      this.emitState();
    }
  }
  async recover() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const capture of await pendingCaptures()) await this.upload(capture);
    } catch (error) {
      this.machine.failed(
        `Image retained on phone: ${messageOf(error)} Use Retry upload.`,
        "upload",
      );
    } finally {
      this.busy = false;
      this.emitState();
    }
  }
  private async upload(capture: PendingCapture) {
    const started = performance.now();
    this.machine.value.stage = "uploading";
    this.machine.value.needsAttention = false;
    this.machine.value.phase = "amber";
    this.machine.value.message = `Saving original (${(capture.blob.size / 1048576).toFixed(1)} MB). Wait for the saved acknowledgement.`;
    this.machine.value.activeId = capture.id;
    this.emitState();
    const result = await api<Capture>(`/api/captures/${capture.id}`, {
      method: "POST",
      body: capture.blob,
      headers: {
        "Content-Type": capture.blob.type,
        "X-Capture-Status": capture.manual
          ? "manual-review"
          : capture.quality.ok
            ? "accepted"
            : "rejected",
        ...(capture.retakeOf ? { "X-Retake-Of": capture.retakeOf } : {}),
        "X-Capture-Metadata": JSON.stringify({
          captureMethod: capture.method,
          manualCapture: capture.manual === true,
          sourcePixels: capture.sourcePixels,
          quality: capture.quality,
          checks: "browser-opencv-mediapipe-v6-paper-boundary",
        }),
      },
    });
    const hash = await sha256(await capture.blob.arrayBuffer());
    if (result.sha256 !== hash)
      throw new Error("Stored checksum did not match. Keep this receipt.");
    const final =
      result.status === "checking"
        ? await api<Capture>(`/api/captures/${capture.id}/finalize`, {
            method: "POST",
            body: JSON.stringify({
              status: capture.manual
                ? "manual-review"
                : capture.quality.ok
                  ? "accepted"
                  : "rejected",
            }),
          })
        : result;
    if (!["accepted", "rejected", "manual-review"].includes(final.status))
      throw new Error("Storage acknowledgement incomplete.");
    await acknowledge(capture.id);
    if (final.status === "accepted" || final.status === "manual-review") {
      this.machine.value.timings = {
        ...this.machine.value.timings,
        saveMs: performance.now() - started,
      };
      this.machine.saved(
        capture.id,
        final.acceptedCount,
        final.status === "manual-review",
      );
    } else
      this.machine.failed(
        `Previous photo needs retaking: ${capture.quality.reason} The image is kept; tap Retake photo to try again.`,
        "retake",
        capture.id,
      );
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function encode(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Image encoding failed.")),
      "image/jpeg",
      quality,
    ),
  );
}

function drawFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  edge: number,
) {
  const ratio = Math.min(
    1,
    edge / Math.max(video.videoWidth, video.videoHeight),
  );
  const width = Math.round(video.videoWidth * ratio);
  const height = Math.round(video.videoHeight * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
}
