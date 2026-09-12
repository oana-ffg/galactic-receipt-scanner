import { api } from "./api";
import { readOriginal } from "./original";
import { Vision } from "./vision";
import type { Capture } from "./types";
interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}
export function registerSiteTools(refresh: () => Promise<void>) {
  const context = (
    document as unknown as {
      modelContext?: { registerTool: (tool: Tool) => void };
    }
  ).modelContext;
  if (!context?.registerTool) return;
  const id = (value: unknown) => {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
      throw new Error("Invalid capture ID.");
    return value;
  };
  context.registerTool({
    name: "list_receipts",
    description:
      "List up to 100 current accepted receipt takes, one per receipt_id. Set history=true to include rejected and previous takes for reconciliation. Follow next for older captures. OCR is unverified.",
    inputSchema: {
      type: "object",
      properties: { before: { type: "string" }, history: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      return api(
        (input.history === true
          ? "/api/captures?history=1"
          : "/api/captures?current=1") +
          (typeof input.before === "string"
            ? `&before=${encodeURIComponent(input.before)}`
            : ""),
      );
    },
  });
  context.registerTool({
    name: "read_receipt",
    description:
      "Read private capture metadata and authenticated original/crop/PDF download URLs. Open or download within the owner session to inspect the actual source image.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      const captureId = id(input.id);
      return {
        capture: await api(`/api/captures/${captureId}`),
        files: Object.fromEntries(
          ["raw", "image", "pdf", "ocr"].map((kind) => [
            kind,
            new URL(`/api/files/${captureId}/${kind}`, location.origin).href,
          ]),
        ),
      };
    },
  });
  context.registerTool({
    name: "prepare_receipt_outputs",
    description:
      "After scanning, create a crop and image PDF from one saved original. Verifies the original checksum, preserves it unchanged, and stores separate derivatives. Never part of the capture loop.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      const captureId = id(input.id);
      const { capture, blob } = await readOriginal(captureId);
      if (!capture.is_current)
        throw new Error(
          "Choose the current accepted take before making a crop or PDF.",
        );
      const vision = new Vision();
      try {
        const result = await vision.request(
          await createImageBitmap(blob),
          true,
          true,
        );
        if (!result.quality.ok || !result.image || !result.pdf)
          throw new Error(`Review this original: ${result.quality.reason}`);
        const uploads = await Promise.allSettled(
          (
            [
              ["image", result.image],
              ["pdf", result.pdf],
            ] as const
          ).map(([kind, blob]) =>
            api(`/api/captures/${captureId}/artifacts/${kind}`, {
              method: "POST",
              headers: { "Content-Type": blob.type },
              body: blob,
            }),
          ),
        );
        const failed = uploads.find((r) => r.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        await refresh();
        return api(`/api/captures/${captureId}`);
      } finally {
        vision.close();
      }
    },
  });
  context.registerTool({
    name: "transcribe_saved_receipts",
    description:
      "After scanning, run private Danish/English OCR on up to 20 accepted saved originals. Stores versioned unverified text, word coordinates, confidence and source hashes. Review uncertain words, numbers and logos against the source images before accounting. Never called by the capture loop.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      if (
        !Array.isArray(input.ids) ||
        input.ids.length < 1 ||
        input.ids.length > 20
      )
        throw new Error("Provide 1 to 20 capture IDs.");
      const ids = [...new Set(input.ids.map(id))];
      const { ReceiptOcr } = await import("./ocr");
      const ocr = new ReceiptOcr();
      const results = [];
      try {
        for (const captureId of ids) {
          try {
            results.push({ ok: true, ...(await ocr.transcribe(captureId)) });
          } catch (error) {
            results.push({
              ok: false,
              id: captureId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        await refresh();
        return { results };
      } finally {
        await ocr.close();
      }
    },
  });
  context.registerTool({
    name: "save_receipt_transcription",
    description:
      "Store a new unverified OCR/extraction JSON artifact for one receipt. Preserve exact text, uncertain fields, provenance, and source coordinates. Does not overwrite the original or certify accounting values.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        provenance: { type: "string" },
        uncertainties: { type: "array", items: { type: "string" } },
        regions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { enum: ["text", "logo", "unreadable"] },
              text: { type: ["string", "null"] },
              box: {
                type: "array",
                items: { type: "number" },
                minItems: 4,
                maxItems: 4,
              },
              uncertain: { type: "boolean" },
            },
            required: ["kind", "text", "box", "uncertain"],
            additionalProperties: false,
          },
        },
      },
      required: ["id", "text", "provenance", "uncertainties", "regions"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      if (
        typeof input.text !== "string" ||
        typeof input.provenance !== "string" ||
        !Array.isArray(input.uncertainties) ||
        input.uncertainties.some((v) => typeof v !== "string")
      )
        throw new Error("Provide text, provenance and uncertainty strings.");
      const captureId = id(input.id);
      const capture = await api<Capture>(`/api/captures/${captureId}`);
      const dimensions = capture.metadata.sourcePixels;
      if (
        !dimensions ||
        !Array.isArray(input.regions) ||
        input.regions.some((region) => {
          if (!region || typeof region !== "object") return true;
          const { kind, text, box, uncertain } = region as Record<
            string,
            unknown
          >;
          return (
            !["text", "logo", "unreadable"].includes(String(kind)) ||
            (text !== null && typeof text !== "string") ||
            typeof uncertain !== "boolean" ||
            !Array.isArray(box) ||
            box.length !== 4 ||
            box.some(
              (value) => typeof value !== "number" || !Number.isFinite(value),
            ) ||
            box[0] < 0 ||
            box[1] < 0 ||
            box[2] <= box[0] ||
            box[3] <= box[1] ||
            box[2] > dimensions[0] ||
            box[3] > dimensions[1]
          );
        })
      )
        throw new Error(
          "Regions need valid original-pixel boxes [left, top, right, bottom], text or null, and an uncertainty flag.",
        );
      const result = await api(`/api/captures/${captureId}/artifacts/ocr`, {
        method: "POST",
        body: JSON.stringify({
          text: input.text,
          provenance: input.provenance,
          uncertainties: input.uncertainties,
          regions: input.regions,
          source: {
            captureId,
            sha256: capture.sha256,
            pixels: dimensions,
            coordinates: "original image pixels; top-left origin",
          },
          schemaVersion: 1,
          verified: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      await refresh();
      return result;
    },
  });
}
