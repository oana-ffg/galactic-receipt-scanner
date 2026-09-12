import { createWorker, OEM, PSM, type Worker, type Page } from "tesseract.js";
import { sha256 } from "./checksum";
import { api } from "./api";
import { readOriginal } from "./original";
import models from "../model-assets.json";

function linesOf(data: Page) {
  return (data.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.map((line) => ({
        text: line.text,
        confidence: line.confidence,
        box: line.bbox,
        words: line.words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          box: word.bbox,
        })),
      })),
    ),
  );
}

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
  async transcribe(id: string) {
    const { capture, blob } = await readOriginal(id);
    if (!capture.is_current || capture.status !== "accepted")
      throw new Error("Choose the current accepted take before transcription.");
    const bitmap = await createImageBitmap(blob);
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    const quad = capture.metadata.quality?.quad;
    let rectangle;
    if (
      quad?.length === 4 &&
      quad.every(
        (point) =>
          point.length === 2 &&
          point.every(
            (value) => Number.isFinite(value) && value >= 0 && value <= 1,
          ),
      )
    ) {
      const margin = Math.min(...dimensions) * 0.01;
      const left = Math.max(
        0,
        Math.floor(Math.min(...quad.map((p) => p[0])) * dimensions[0] - margin),
      );
      const top = Math.max(
        0,
        Math.floor(Math.min(...quad.map((p) => p[1])) * dimensions[1] - margin),
      );
      const right = Math.min(
        dimensions[0],
        Math.ceil(Math.max(...quad.map((p) => p[0])) * dimensions[0] + margin),
      );
      const bottom = Math.min(
        dimensions[1],
        Math.ceil(Math.max(...quad.map((p) => p[1])) * dimensions[1] + margin),
      );
      rectangle = { left, top, width: right - left, height: bottom - top };
    }
    const worker = await this.engine();
    const { data: layout } = await worker.recognize(
      blob,
      rectangle ? { rectangle } : {},
      { text: true, blocks: true },
    );
    // AUTO finds large headings/logos, but can drop receipt amount columns.
    // A block pass preserves the body; retain both observations for review.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    let data: Page;
    try {
      ({ data } = await worker.recognize(blob, rectangle ? { rectangle } : {}, {
        text: true,
        blocks: true,
      }));
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    }
    const bodyLines = linesOf(data),
      headings = linesOf(layout);
    const lines = [
      ...bodyLines,
      ...headings.filter(
        (line) =>
          !bodyLines.some((other) => {
            const a = line.box,
              b = other.box;
            const area =
              Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
              Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
            return area / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0)) > 0.5;
          }),
      ),
    ].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
    const uncertainWords = lines
      .flatMap((line) => line.words)
      .filter((word) => word.confidence < 85);
    const artifact = {
      schemaVersion: 1,
      verified: false,
      text: lines.map((line) => line.text.trimEnd()).join("\n"),
      language: ["da", "en"],
      source: {
        captureId: id,
        sha256: capture.sha256,
        pixels: dimensions,
        coordinates: "original image pixels; top-left origin",
        region: rectangle ?? {
          left: 0,
          top: 0,
          width: dimensions[0],
          height: dimensions[1],
        },
      },
      provenance: {
        engine: "tesseract.js 7.0.0",
        tesseractVersion: data.version,
        models: {
          dan: models["ocr/dan.traineddata.gz"].sha256,
          eng: models["ocr/eng.traineddata.gz"].sha256,
        },
        pageSegmentation: ["AUTO", "SINGLE_BLOCK"],
        createdAt: new Date().toISOString(),
      },
      confidence: data.confidence,
      lines,
      passes: [
        { segmentation: "AUTO", text: layout.text, lines: headings },
        { segmentation: "SINGLE_BLOCK", text: data.text, lines: bodyLines },
      ],
      uncertainties: uncertainWords,
      handwriting: {
        status: "unchecked",
        method: "requires visual inspection",
      },
      review: {
        required: true,
        notes: [
          "Compare text and amounts against the original. Confidence is a heuristic, not verification.",
          "Inspect the entire original for handwriting and OCR omissions, including outside the OCR region. Printed-text OCR cannot rule out handwriting.",
          "Inspect logos and graphics visually. OCR does not identify brands or guarantee detection of stylized lettering.",
          ...(data.text.trim() ? [] : ["No readable text was recognized."]),
        ],
      },
    };
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
      confidence: data.confidence,
      uncertainWords,
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
