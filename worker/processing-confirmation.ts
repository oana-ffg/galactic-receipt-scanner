import type { Env } from "./index";
import type { Capture } from "../web/types";
import type { ReceiptDocument } from "../web/documents";
import {
  arithmetic,
  extractionErrors,
  type Extraction,
} from "../web/extraction";
import { compareStoredOcr } from "./ocr-comparison";
import { requireThat } from "./http";

const HASH = /^[a-f0-9]{64}$/;
export interface LunaDraft {
  version: 1;
  extraction: Extraction;
  documents: ReceiptDocument[];
  pixel_pdf_sha256: string;
  images: { sha256: string; pixels: number[] }[];
}

export function lunaDraft(
  input: any,
  id: string,
  revision: number,
  previous: ReceiptDocument[],
  captures: Capture[],
): LunaDraft {
  const docs = input.documents as ReceiptDocument[];
  requireThat(
    Array.isArray(docs) &&
      docs.length > 0 &&
      docs.length <= 20 &&
      HASH.test(input.pixel_pdf_sha256),
    400,
    "Freeze the documents and pixel-only PDF hash.",
  );
  const ids = docs.map((d) => d?.id);
  requireThat(
    new Set(ids).size === ids.length && ids.includes(id),
    400,
    "Use unique affected documents including the claim.",
  );
  const old = docs.map((d) => previous.find((p) => p.id === d.id));
  requireThat(
    old.every((d, i) => d && d.revision === docs[i].revision),
    409,
    "A draft document changed.",
  );
  const expected = old
    .flatMap((d) => d!.pages)
    .map((p) => p.captureId)
    .sort();
  const pages = docs.flatMap((d) => d.pages ?? []);
  requireThat(
    pages.length <= 100 &&
      JSON.stringify(pages.map((p) => p.captureId).sort()) ===
        JSON.stringify(expected),
    400,
    "Preserve all affected original pages exactly once.",
  );
  for (const document of docs)
    for (const p of document.pages) {
      const source = captures.find((c) => c.id === p.captureId);
      requireThat(
        source &&
          source.sha256 === p.sha256 &&
          [0, 90, 180, 270].includes(p.rotation),
        400,
        "Invalid frozen source or rotation.",
      );
      if (document.id !== id) {
        const prior = previous
          .find((d) => d.id === document.id)
          ?.pages.find((page) => page.captureId === p.captureId);
        requireThat(
          prior &&
            prior.rotation === p.rotation &&
            JSON.stringify(prior.crop) === JSON.stringify(p.crop),
          400,
          "Preserve residual donor geometry.",
        );
        continue;
      }
      requireThat(
        Array.isArray(p.crop) &&
          p.crop.length === 4 &&
          p.crop.every(Number.isSafeInteger) &&
          p.crop[0] >= 0 &&
          p.crop[1] >= 0 &&
          p.crop[2] > p.crop[0] &&
          p.crop[3] > p.crop[1],
        400,
        "Freeze explicit source-pixel crop bounds.",
      );
    }
  const target = docs.find((d) => d.id === id)!;
  requireThat(
    target.revision === revision &&
      target.pages.length > 0 &&
      !target.mergedInto,
    400,
    "Keep the claimed document as the retained target.",
  );
  requireThat(
    Array.isArray(input.images) &&
      input.images.length === target.pages.length &&
      input.images.every(
        (p: any) =>
          HASH.test(p?.sha256) &&
          Array.isArray(p.pixels) &&
          p.pixels.length === 2 &&
          p.pixels.every(
            (n: any) => Number.isSafeInteger(n) && n > 0 && n <= 50000,
          ),
      ),
    400,
    "Freeze every derived page image hash and dimensions.",
  );
  return {
    version: 1,
    extraction: input.extraction,
    documents: docs,
    pixel_pdf_sha256: input.pixel_pdf_sha256,
    images: input.images,
  };
}

export function checkQwen(input: any, draft: LunaDraft, id: string) {
  requireThat(
    input.model === "qwen3-vl:8b-instruct" &&
      HASH.test(input.model_digest) &&
      HASH.test(input.prompt_sha256) &&
      HASH.test(input.schema_sha256),
    400,
    "Record the configured Qwen model and provenance hashes.",
  );
  requireThat(
    typeof input.runtime_version === "string" &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+.a-zA-Z0-9]*)$/.test(input.runtime_version),
    400,
    "Record the local runtime version.",
  );
  requireThat(
    input.pixel_pdf_sha256 === draft.pixel_pdf_sha256 &&
      JSON.stringify(input.images) === JSON.stringify(draft.images) &&
      Array.isArray(input.images) &&
      input.images.length ===
        draft.documents.find((d) => d.id === id)!.pages.length &&
      input.images.every(
        (p: any) =>
          HASH.test(p?.sha256) &&
          Array.isArray(p.pixels) &&
          p.pixels.length === 2 &&
          p.pixels.every(
            (n: any) => Number.isSafeInteger(n) && n > 0 && n <= 50000,
          ),
      ),
    400,
    "Bind every Qwen input image to the frozen PDF.",
  );
  requireThat(
    input.options?.temperature === 0 &&
      input.options?.num_predict === 6000 &&
      Object.keys(input.options).length === 2,
    400,
    "Use the recorded bounded inference settings.",
  );
  requireThat(
    extractionErrors(input.extraction).length === 0 &&
      input.extraction.category_id === null,
    400,
    "Save a valid independent Qwen extraction without category context.",
  );
  requireThat(
    input.done_reason === "stop" &&
      Number.isFinite(input.elapsed_seconds) &&
      input.elapsed_seconds >= 0,
    400,
    "Incomplete local inference cannot be used as confirmation.",
  );
  const keys = [
    "model",
    "model_digest",
    "prompt_sha256",
    "schema_sha256",
    "runtime_version",
    "pixel_pdf_sha256",
    "images",
    "options",
    "extraction",
    "done_reason",
    "elapsed_seconds",
  ];
  requireThat(
    Object.keys(input).every((k) => k === "token" || keys.includes(k)),
    400,
    "Unknown confirmation field.",
  );
  return Object.fromEntries(keys.map((k) => [k, input[k]]));
}

export async function confirmationEvidence(
  env: Env,
  draft: LunaDraft,
  id: string,
  qwen: Extraction,
) {
  const doc = draft.documents.find((d) => d.id === id)!;
  const initialOcr = await compareStoredOcr(env, doc, draft.extraction, {
    strictRegion: true,
    engine: "tesseract",
  });
  requireThat(
    initialOcr.artifacts.length === doc.pages.length,
    409,
    "Prepare matching Tesseract OCR for every frozen page first.",
  );
  const qwenOcr = await compareStoredOcr(env, doc, qwen, {
    strictRegion: true,
    engine: "tesseract",
    pins: initialOcr.artifacts,
  });
  const ignored = new Set([
    "category_id",
    "certainty",
    "uncertainties",
    "broken_reasons",
    "evidence",
    "confirmed_arithmetic_mismatch",
  ]);
  const differences = Object.keys(draft.extraction).filter(
    (k) =>
      !ignored.has(k) &&
      JSON.stringify(draft.extraction[k as keyof Extraction]) !==
        JSON.stringify(qwen[k as keyof Extraction]),
  );
  return {
    initial_arithmetic: arithmetic(draft.extraction),
    qwen_arithmetic: arithmetic(qwen),
    initial_ocr: initialOcr,
    qwen_ocr: qwenOcr,
    differing_fields: differences,
  };
}

/** First-pass confirmation pins ordinary PP OCR; no second language model is run. */
export async function ppConfirmation(
  env: Env,
  input: any,
  draft: LunaDraft,
  id: string,
) {
  const doc = draft.documents.find((d) => d.id === id)!;
  const pins = input.artifacts;
  requireThat(
    input.provider === "ppocr" &&
      input.pixel_pdf_sha256 === draft.pixel_pdf_sha256 &&
      Object.keys(input).every((k) =>
        ["token", "provider", "pixel_pdf_sha256", "artifacts"].includes(k),
      ) &&
      Array.isArray(pins) &&
      pins.length === doc.pages.length &&
      new Set(pins.map((p: any) => p?.capture_id)).size === pins.length &&
      pins.every(
        (p: any, i: number) =>
          p?.capture_id === doc.pages[i].captureId &&
          HASH.test(p?.sha256) &&
          Object.keys(p).every((k) => ["capture_id", "sha256"].includes(k)),
      ),
    400,
    "Pin PP OCR for every frozen page in order.",
  );
  const initialOcr = await compareStoredOcr(env, doc, draft.extraction, {
    strictRegion: true,
    pins,
    engine: "ppocr",
  });
  requireThat(
    initialOcr.artifacts.length === doc.pages.length,
    409,
    "Prepare source-matched PP OCR for every frozen page first.",
  );
  const checked = {
    provider: "ppocr",
    pixel_pdf_sha256: draft.pixel_pdf_sha256,
    artifacts: pins,
  };
  return {
    checked,
    payload: {
      ppocr: checked,
      evidence: {
        initial_arithmetic: arithmetic(draft.extraction),
        initial_ocr: initialOcr,
      },
    },
  };
}

export function checkAssessment(
  value: any,
  evidenceHash: string,
): asserts value is {
  confirmation_sha256: string;
  rationale: string;
  changed_fields: string[];
} {
  requireThat(
    value &&
      value.confirmation_sha256 === evidenceHash &&
      typeof value.rationale === "string" &&
      value.rationale.trim().length > 0 &&
      value.rationale.length <= 20000,
    400,
    "Assess the saved confirmation and explain retained/corrected values.",
  );
  requireThat(
    Array.isArray(value.changed_fields) &&
      value.changed_fields.length <= 50 &&
      value.changed_fields.every(
        (v: any) => typeof v === "string" && v.length > 0 && v.length <= 200,
      ),
    400,
    "List reassessed extraction fields.",
  );
  requireThat(
    Object.keys(value).every((k) =>
      ["confirmation_sha256", "rationale", "changed_fields"].includes(k),
    ),
    400,
    "Unknown reassessment field.",
  );
}
