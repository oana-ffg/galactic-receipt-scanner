import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateDocumentPdf } from "./document-processing";
import { newDocument } from "./documents";
import { sha256 } from "./checksum";
import type { Capture } from "./types";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  original: vi.fn(),
  addPage: vi.fn(),
}));
vi.mock("./api", () => ({ api: mocks.api }));
vi.mock("./original", () => ({ readOriginal: mocks.original }));
vi.mock("./receipt-pdf", () => ({ addReceiptPage: mocks.addPage }));
const id = "00000000-0000-4000-8000-000000000001";
const sourceHash = "a".repeat(64);
const doc = newDocument({ id, sha256: sourceHash } as Capture);
const savedOcr = () => ({
  source: {
    captureId: id,
    sha256: sourceHash,
    pixels: [100, 200],
    rotation: 0,
    region: { left: 0, top: 0, width: 100, height: 200 },
  },
  provenance: { engine: "PP-OCRv6" },
  text_only_pdf_layers: [
    {
      base64: "synthetic layer consumed by mocked PDF composer",
      sha256: "b".repeat(64),
    },
  ],
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 100, height: 200, close() {} }),
  );
  mocks.original.mockResolvedValue({
    capture: { sha256: sourceHash },
    blob: new Blob(["synthetic pixels"], { type: "image/png" }),
  });
});
afterEach(() => vi.unstubAllGlobals());
async function stored(
  value: ReturnType<typeof savedOcr> | null,
  tampered = false,
) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await sha256(bytes);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(tampered ? "{}" : bytes)),
  );
  mocks.api.mockImplementation(async (_path, options) => {
    if (!options)
      return { artifacts: value ? [{ kind: "ocr", sha256: hash }] : [] };
    return {
      sha256: await sha256(await options.body.arrayBuffer()),
      revision: doc.revision,
      filename: "synthetic.pdf",
    };
  });
}
it("composes a PDF using saved PP OCR without running transcription", async () => {
  const ocr = savedOcr();
  await stored(ocr);
  await expect(generateDocumentPdf(doc)).resolves.toMatchObject({
    filename: "synthetic.pdf",
  });
  expect(mocks.addPage).toHaveBeenCalledOnce();
  expect(mocks.addPage.mock.calls[0][5]).toEqual(ocr);
  expect(
    mocks.api.mock.calls.filter(([, options]) => options).map(([path]) => path),
  ).toEqual([`/api/documents/${id}/pdf?revision=${doc.revision}`]);
});
it.each(["missing", "source", "crop", "rotation", "layer"])(
  "requires processing when saved OCR has a %s mismatch",
  async (reason) => {
    const ocr = savedOcr();
    if (reason === "source") ocr.source.sha256 = "c".repeat(64);
    if (reason === "crop") ocr.source.region.width = 90;
    if (reason === "rotation") ocr.source.rotation = 90;
    if (reason === "layer") ocr.text_only_pdf_layers = [];
    await stored(reason === "missing" ? null : ocr);
    await expect(generateDocumentPdf(doc)).rejects.toThrow(
      "Run the Luna processing flow with PP-OCR",
    );
    expect(mocks.addPage).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.every(([, options]) => !options)).toBe(true);
  },
);
it("rejects tampered saved OCR before composing or uploading a PDF", async () => {
  await stored(savedOcr(), true);
  await expect(generateDocumentPdf(doc)).rejects.toThrow(
    "Saved OCR checksum mismatch",
  );
  expect(mocks.addPage).not.toHaveBeenCalled();
  expect(mocks.api.mock.calls.every(([, options]) => !options)).toBe(true);
});
it.each(["unreadable", "malformed", "checksum"])(
  "reuses an older valid OCR artifact after a newer %s artifact",
  async (failure) => {
    const ocr = savedOcr();
    await stored(ocr);
    const goodBytes = new TextEncoder().encode(JSON.stringify(ocr));
    const badBytes = new TextEncoder().encode(
      failure === "malformed" ? "{broken JSON" : "{}",
    );
    const goodHash = await sha256(goodBytes);
    const badHash =
      failure === "checksum" ? "c".repeat(64) : await sha256(badBytes);
    mocks.api.mockResolvedValueOnce({
      artifacts: [
        { kind: "ocr", sha256: badHash },
        { kind: "ocr", sha256: goodHash },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(badBytes, {
            status: failure === "unreadable" ? 503 : 200,
          }),
        )
        .mockResolvedValueOnce(new Response(goodBytes)),
    );
    await expect(generateDocumentPdf(doc)).resolves.toMatchObject({
      filename: "synthetic.pdf",
    });
    expect(mocks.addPage.mock.calls[0][5]).toEqual(ocr);
  },
);
