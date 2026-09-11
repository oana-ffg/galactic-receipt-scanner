import { api, Connection } from "./api";
import {
  acknowledge,
  pendingCaptures,
  savePending,
  type PendingCapture,
} from "./pending";
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
  private connection: Connection;
  private canvas = document.createElement("canvas");
  private waiting = false;
  private busy = false;
  private running = false;
  private connected = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wakeLock: WakeLockSentinel | null = null;

  constructor(
    private video: HTMLVideoElement,
    private status: (message: string) => void,
    private state: (state: ScanState) => void,
    private onStopped: () => void,
  ) {
    this.connection = new Connection(
      "camera",
      (message) => {
        if (message instanceof Blob) return;
        if (message.type === "state") this.state(message);
        if (message.type === "frameAck") this.waiting = false;
        if (message.type === "capture") void this.capture(message.id);
        if (message.type === "retryUpload") void this.recover();
      },
      (connected, reason) => {
        const newlyConnected = connected && !this.connected;
        this.connected = connected;
        if (!connected) {
          this.waiting = false;
          this.status(reason ?? "Disconnected.");
        }
        if (newlyConnected) void this.recover();
      },
    );
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.running)
        void this.keepAwake();
      else if (this.running)
        this.status("Keep this camera page open in the foreground.");
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        "Camera access needs trusted HTTPS. Complete the certificate setup first.",
      );
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
    this.running = true;
    this.stream.getVideoTracks()[0].addEventListener("ended", () => {
      this.stop();
      this.status("Camera stopped. Tap Enable camera again.");
    });
    this.connection.start();
    await this.keepAwake();
    this.status(
      `Camera ready: ${this.video.videoWidth} × ${this.video.videoHeight} preview source. Use the Mac controls.`,
    );
    void this.preview();
  }

  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.status("Keep the phone awake and this page visible while scanning.");
    }
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.connection.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.wakeLock?.release();
    this.onStopped();
  }

  private async preview(): Promise<void> {
    try {
      if (
        this.running &&
        this.connected &&
        !this.busy &&
        !this.waiting &&
        this.video.readyState >= 2
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
        const blob = await encode(this.canvas, 0.8);
        this.waiting = this.connection.send(blob);
      }
    } catch (error) {
      this.status(messageOf(error));
    } finally {
      if (this.running) this.timer = setTimeout(() => void this.preview(), 125);
    }
  }

  private async still(): Promise<{ blob: Blob; method: string }> {
    const track = this.stream!.getVideoTracks()[0];
    const Constructor = (
      window as unknown as { ImageCapture?: PhotoConstructor }
    ).ImageCapture;
    if (Constructor) {
      try {
        const capture = new Constructor(track);
        const caps = await capture.getPhotoCapabilities();
        const blob = await capture.takePhoto({
          ...(caps.imageWidth?.max ? { imageWidth: caps.imageWidth.max } : {}),
          ...(caps.imageHeight?.max
            ? { imageHeight: caps.imageHeight.max }
            : {}),
        });
        if (!blob.size) throw new Error("Camera returned an empty photo.");
        return { blob, method: "ImageCapture.takePhoto" };
      } catch (error) {
        this.status(
          `Still API unavailable (${messageOf(error)}). Checking full-size video capture instead.`,
        );
      }
    }
    const frame = document.createElement("canvas");
    frame.width = this.video.videoWidth;
    frame.height = this.video.videoHeight;
    frame.getContext("2d")!.drawImage(this.video, 0, 0);
    // Backend still enforces the minimum number of pixels across the cropped receipt.
    return {
      blob: await encode(frame, 0.98),
      method: "full-resolution-video-frame",
    };
  }

  private async capture(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if ((await pendingCaptures()).length)
        throw new Error(
          "An image is still pending upload. Use Retry upload on the Mac.",
        );
      const { blob, method } = await this.still();
      const capture = { id, blob, method };
      await savePending(capture);
      await this.upload(capture);
    } catch (error) {
      const message = messageOf(error);
      this.status(message);
      this.connection.send({ type: "captureError", id, message });
    } finally {
      this.busy = false;
      this.waiting = false;
    }
  }

  async recover(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const capture of await pendingCaptures()) await this.upload(capture);
    } catch (error) {
      this.status(
        `Image retained on phone: ${messageOf(error)} Use Retry upload.`,
      );
    } finally {
      this.busy = false;
    }
  }

  private async upload(capture: PendingCapture): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await api<Capture>(`/api/captures/${capture.id}`, {
          method: "POST",
          body: capture.blob,
          headers: {
            "Content-Type": capture.blob.type || "application/octet-stream",
            "X-Capture-Method": capture.method,
          },
        });
        if (!["accepted", "rejected"].includes(result.status))
          throw new Error("Image was not fully acknowledged.");
        await acknowledge(capture.id);
        this.status(
          result.status === "accepted"
            ? "Saved on the Mac. You can remove this receipt."
            : `Original retained on the Mac. Retake needed: ${result.metadata.quality?.reason}`,
        );
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
    throw lastError;
  }
}

async function encode(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Camera image encoding failed.")),
      "image/jpeg",
      quality,
    ),
  );
}

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
