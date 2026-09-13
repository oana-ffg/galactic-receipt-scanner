import { beforeEach, expect, it, vi } from "vitest";
import { processOcr } from "./document-processing";
import { newDocument, documentReasons } from "./documents";
import { RequestError } from "./errors";
import type { Capture } from "./types";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  transcribe: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./api", () => ({ api: mocks.api }));
vi.mock("./ocr", () => ({
  ReceiptOcr: class {
    transcribe = mocks.transcribe;
    close = mocks.close;
  },
}));
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transcribe.mockResolvedValue({
    id,
    text: "Synthetic receipt",
    uncertainWords: ["faint"],
  });
});
it("retries a document conflict without redoing saved OCR or overwriting newer review notes", async () => {
  const fresh = newDocument({ id, sha256: "a".repeat(64) } as Capture);
  let reads = 0,
    writes = 0;
  mocks.api.mockImplementation(async (_path, options) => {
    if (!options) {
      reads++;
      return {
        document: structuredClone({
          ...fresh,
          revision: reads,
          evidence: reads === 2 ? "New source check" : "",
          uncertainties: reads === 2 ? ["Unclear date after retries"] : [],
        }),
      };
    }
    writes++;
    if (writes === 1) throw new RequestError("Document changed", 409);
    const saved = JSON.parse(options.body).documents[0];
    expect(saved.revision).toBe(2);
    expect(saved.broken).toEqual([]);
    expect(saved.uncertainties).toEqual(["Unclear date after retries"]);
    expect(saved.evidence).toContain("New source check");
    expect(saved.evidence).toContain("OCR processing: 1 low-confidence");
    return { saved: [{ id, revision: 3 }] };
  });
  expect((await processOcr([id])).results[0].ok).toBe(true);
  expect(mocks.transcribe).toHaveBeenCalledTimes(1);
  expect(writes).toBe(2);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it("keeps a successful OCR result pending when document updates fail", async () => {
  const fresh = newDocument({ id, sha256: "a".repeat(64) } as Capture);
  mocks.api.mockImplementation(async (_path, options) => {
    if (!options) return { document: structuredClone(fresh) };
    expect(JSON.parse(options.body).documents[0].broken).toEqual([]);
    throw new RequestError("Connection interrupted", 503);
  });
  const result = (await processOcr([id])).results[0];
  expect(result).toMatchObject({
    ok: false,
    failureRecorded: false,
    text: "Synthetic receipt",
  });
  expect(result.error).toContain("OCR was saved");
  expect(mocks.api).toHaveBeenCalledTimes(2);
  expect(documentReasons(fresh).status).toBe("processing");
});
it("still records an actual OCR artifact failure as broken", async () => {
  const fresh = newDocument({ id, sha256: "a".repeat(64) } as Capture);
  mocks.transcribe.mockRejectedValue(new Error("OCR save checksum mismatch"));
  mocks.api.mockImplementation(async (_path, options) => {
    if (!options) return { document: structuredClone(fresh) };
    expect(JSON.parse(options.body).documents[0].broken).toEqual([
      "OCR failed: OCR save checksum mismatch",
    ]);
    return { saved: [{ id, revision: 1 }] };
  });
  expect((await processOcr([id])).results[0]).toMatchObject({
    ok: false,
    failureRecorded: true,
  });
});
