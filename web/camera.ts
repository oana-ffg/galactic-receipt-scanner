import { api } from "./api";
import { messageOf, RequestError } from "./errors";
import {
  acknowledge,
  pendingCaptures,
  savePending,
  type PendingCapture,
} from "./pending";
import { CaptureState } from "./state";
import { Vision } from "./vision";
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
  private camera = crypto.randomUUID();
  private sequence = 0;
  private generation = 0;
  private connectionIssue = "";
  private canvas = document.createElement("canvas");
  private wakeLock: WakeLockSentinel | null = null;
  constructor(
    private video: HTMLVideoElement,
    private status: (message: string) => void,
    private state: (state: ScanState) => void,
    private onStopped: () => void,
  ) {
    document.addEventListener("visibilitychange", () => {
      if (this.running && document.visibilityState === "visible")
        void this.keepAwake();
    });
  }
  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "Camera access requires HTTPS. Open the private Site in Safari.",
      );
    this.machine = new CaptureState();
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
      const claim = await api<{ sequence: number }>("/api/station/claim", {
        method: "POST",
        body: JSON.stringify({ camera: this.camera }),
      });
      this.sequence = claim.sequence;
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
    void this.preview(generation);
    await this.recover();
    if (!this.running) throw new Error(this.machine.value.message);
  }
  private async keepAwake() {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.status("Keep the phone awake and this page visible.");
    }
  }
  stop(message = "Camera stopped. Tap Enable camera to reconnect.") {
    this.generation++;
    this.running = false;
    this.connected = false;
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
    this.state(
      this.running && !this.connected
        ? {
            ...this.machine.value,
            phase: "red",
            cameraConnected: false,
            message: `${this.connectionIssue} Reconnecting automatically; new captures are waiting.`,
          }
        : this.machine.value,
    );
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
      try {
        const result = await api<{ sequence: number; command: string }>(
          "/api/station/heartbeat",
          {
            method: "POST",
            body: JSON.stringify({
              camera: this.camera,
              state: this.machine.value,
            }),
            signal: AbortSignal.timeout(4000),
          },
        );
        if (!this.running || this.generation !== generation) return;
        this.connected = true;
        if (result.sequence !== this.sequence && !this.busy) {
          this.sequence = result.sequence;
          if (result.command === "retry-upload") void this.recover();
          else this.machine.control(result.command);
        }
      } catch (error) {
        if (!this.running || this.generation !== generation) return;
        if (this.sessionEnded(error)) return;
        this.connected = false;
        this.connectionIssue = messageOf(error);
        this.machine.interrupt();
      }
      this.emitState();
      await delay(700);
    }
  }
  private async preview(generation: number) {
    while (this.running && this.generation === generation) {
      try {
        if (
          this.connected &&
          !this.busy &&
          this.video.readyState >= 2 &&
          document.visibilityState === "visible"
        ) {
          const ratio = Math.min(
            1,
            800 / Math.max(this.video.videoWidth, this.video.videoHeight),
          );
          this.canvas.width = Math.round(this.video.videoWidth * ratio);
          this.canvas.height = Math.round(this.video.videoHeight * ratio);
          this.canvas
            .getContext("2d")!
            .drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
          const analysis = await this.vision!.request(
            await createImageBitmap(this.canvas),
          );
          if (!this.running || this.generation !== generation) return;
          if (!this.connected) continue;
          const id = this.machine.observe(analysis.quality, performance.now());
          this.emitState();
          if (id) await this.capture(id);
          else {
            const body = await encode(this.canvas, 0.75);
            try {
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
              if (this.sessionEnded(error)) return;
              this.machine.value.streamFresh = false;
              this.machine.value.previewWarning = `Desktop preview is delayed. ${messageOf(error)} Retrying automatically.`;
            }
            this.emitState();
          }
        }
      } catch (error) {
        if (!this.running || this.generation !== generation) return;
        this.stop(
          `Image checks stopped. ${messageOf(error)} Tap Enable camera to restart the checks.`,
        );
      }
      await delay(220);
    }
  }
  private async still(): Promise<{ blob: Blob; method: string }> {
    const track = this.stream!.getVideoTracks()[0];
    const Constructor = (
      window as unknown as { ImageCapture?: PhotoConstructor }
    ).ImageCapture;
    if (Constructor) {
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
        this.status(
          "Using the full-resolution video frame; quality checks still apply.",
        );
      }
    }
    const frame = document.createElement("canvas");
    frame.width = this.video.videoWidth;
    frame.height = this.video.videoHeight;
    frame.getContext("2d")!.drawImage(this.video, 0, 0);
    return {
      blob: await encode(frame, 0.98),
      method: "full-resolution-video-frame",
    };
  }
  private async capture(id: string) {
    if (this.busy) return;
    this.busy = true;
    try {
      if ((await pendingCaptures()).length)
        throw new Error("An image is pending. Use Retry upload first.");
      const { blob, method } = await this.still();
      const capture: PendingCapture = {
        id,
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
      const bitmap = await createImageBitmap(blob);
      capture.sourcePixels = [bitmap.width, bitmap.height];
      if (bitmap.width * bitmap.height > 55000000) {
        bitmap.close();
        throw new Error("Image exceeds the supported 55 megapixels.");
      }
      const result = await this.vision!.request(bitmap, true);
      capture.quality = result.quality;
      capture.image = result.image;
      capture.pdf = result.pdf;
      await savePending(capture);
      await this.upload(capture);
    } catch (error) {
      this.machine.failed(`Capture needs attention: ${messageOf(error)}`);
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
      );
    } finally {
      this.busy = false;
      this.emitState();
    }
  }
  private async upload(capture: PendingCapture) {
    this.machine.value.needsAttention = false;
    this.machine.value.phase = "amber";
    this.machine.value.message =
      "Saving original and outputs—do not move the receipt.";
    this.machine.value.activeId = capture.id;
    this.emitState();
    const result = await api<Capture>(`/api/captures/${capture.id}`, {
      method: "POST",
      body: capture.blob,
      headers: {
        "Content-Type": capture.blob.type,
        "X-Capture-Metadata": JSON.stringify({
          captureMethod: capture.method,
          sourcePixels: capture.sourcePixels,
          quality: capture.quality,
          checks: "browser-opencv-mediapipe-v1",
        }),
      },
    });
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await capture.blob.arrayBuffer()),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (result.sha256 !== hash)
      throw new Error("Stored checksum did not match. Keep this receipt.");
    if (result.status === "checking") {
      if (capture.quality.ok) {
        if (!capture.image || !capture.pdf)
          throw new Error("Crop/PDF missing. Retake required.");
        for (const [kind, blob] of [
          ["image", capture.image],
          ["pdf", capture.pdf],
        ] as const)
          await api(`/api/captures/${capture.id}/artifacts/${kind}`, {
            method: "POST",
            body: blob,
            headers: { "Content-Type": blob.type },
          });
      }
      await api(`/api/captures/${capture.id}/finalize`, {
        method: "POST",
        body: JSON.stringify({
          status: capture.quality.ok ? "accepted" : "rejected",
        }),
      });
    }
    const final = await api<Capture>(`/api/captures/${capture.id}`);
    if (!["accepted", "rejected"].includes(final.status))
      throw new Error("Storage acknowledgement incomplete.");
    await acknowledge(capture.id);
    if (final.status === "accepted") this.machine.saved(capture.id);
    else
      this.machine.failed(
        `Original saved; retake needed: ${capture.quality.reason}`,
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
