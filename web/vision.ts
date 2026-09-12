import type { Quality } from "./types";
export interface Analysis {
  quality: Quality;
  image?: Blob;
  pdf?: Blob;
  original?: Blob;
}
export class Vision {
  private worker = new Worker(new URL("./vision.worker.ts", import.meta.url));
  private counter = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: Analysis) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else
        p.resolve({
          quality: e.data.quality,
          image: e.data.image,
          pdf: e.data.pdf,
          original: e.data.original,
        });
    };
    this.worker.onerror = () =>
      this.fail("Image-check worker stopped. Reload the camera page.");
  }
  private fail(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  async encodeFrame(bitmap: ImageBitmap): Promise<Blob> {
    const result = await this.request(bitmap, false, false, true);
    if (!result.original?.size)
      throw new Error(
        "The camera frame could not be encoded. Retake the photo.",
      );
    return result.original;
  }
  request(
    bitmap?: ImageBitmap,
    full = false,
    outputs = false,
    encode = false,
  ): Promise<Analysis> {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Image checks timed out. Reload the camera page."));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage(
        { id, bitmap, full, outputs, encode },
        bitmap ? [bitmap] : [],
      );
    });
  }
  close() {
    this.fail("Camera stopped.");
    this.worker.terminate();
  }
}
