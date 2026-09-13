import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { sha256 } from "./checksum";
import { api } from "./api";
import { readOriginal } from "./original";
import { recognizeReceipt } from "./ocr-data";
import models from "../model-assets.json";

// One worker per bounded downstream batch; never imported by the camera loop.
export class ReceiptOcr {
  private worker?: Promise<Worker>;
  private engine() {
    return (this.worker ??= createWorker(["dan", "eng"], OEM.LSTM_ONLY, {
      workerPath: "/vendor/ocr/worker.min.js",
      corePath: "/vendor/ocr/core",
      langPath: "/vendor/ocr",
      workerBlobURL: false,
      gzip: true,
      cacheMethod: "none",
    }).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: "1",
      });
      return worker;
    }));
  }
  async transcribe(id: string, crop?: [number, number, number, number] | null) {
    const { capture, blob } = await readOriginal(id);
    if (!capture.is_current || capture.status !== "accepted")
      throw new Error("Choose the current accepted take before transcription.");
    const bitmap = await createImageBitmap(blob);
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    const artifact = await recognizeReceipt(
      await this.engine(),
      blob,
      { captureId: id, sha256: capture.sha256, pixels: dimensions },
      {
        dan: models["ocr/dan.traineddata.gz"].sha256,
        eng: models["ocr/eng.traineddata.gz"].sha256,
      },
      capture.metadata.quality?.quad,
      crop,
    );
    const body = JSON.stringify(artifact);
    const expected = await sha256(new TextEncoder().encode(body));
    const saved = await api<{ sha256: string }>(
      `/api/captures/${id}/artifacts/ocr`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
    );
    if (saved.sha256 !== expected)
      throw new Error(
        "OCR save checksum mismatch. Keep this receipt in the review queue.",
      );
    return {
      id,
      sha256: saved.sha256,
      text: artifact.text,
      confidence: artifact.confidence,
      uncertainWords: artifact.uncertainties,
      review: artifact.review,
      source: artifact.source,
    };
  }
  async close() {
    const pending = this.worker;
    this.worker = undefined;
    if (pending)
      await pending.then(
        (worker) => worker.terminate(),
        () => undefined,
      );
  }
}
