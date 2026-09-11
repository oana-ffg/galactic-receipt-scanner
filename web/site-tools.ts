import { api } from "./api";
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
      "List up to 100 private captures with source hashes, quality checks and same-origin download paths. Follow next for older captures. OCR is unverified.",
    inputSchema: {
      type: "object",
      properties: { before: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      return api(
        "/api/captures" +
          (typeof input.before === "string"
            ? `?before=${encodeURIComponent(input.before)}`
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
      },
      required: ["id", "text", "provenance", "uncertainties"],
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
      const result = await api(`/api/captures/${id(input.id)}/artifacts/ocr`, {
        method: "POST",
        body: JSON.stringify({
          text: input.text,
          provenance: input.provenance,
          uncertainties: input.uncertainties,
          verified: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      await refresh();
      return result;
    },
  });
}
