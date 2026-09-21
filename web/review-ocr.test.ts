import { afterEach, expect, it, vi } from "vitest";
import { sha256 } from "./checksum";
import { ocrExcerpts, readReviewOcr, type ReviewOcr } from "./review-ocr";
import type { DocumentView } from "./documents";

afterEach(() => vi.unstubAllGlobals());
it("shows verbatim OCR candidates without repairing faded dates or merging totals", () => {
  const ocr: ReviewOcr = {
    engine: "Synthetic OCR",
    pages: [
      {
        number: 1,
        text: "Open 07.00-20.00\nX8-01-2026 18:58\nTOTAL 12,00\nMOMS TOTAL 2,40",
        createdAt: "2026-01-10",
        sameRegion: true,
        sha256: "synthetic",
        confidence: null,
        lines: [],
      },
    ],
  };
  expect(ocrExcerpts(ocr, "receipt_date")).toEqual([
    "Page 1: X8-01-2026 18:58",
  ]);
  expect(ocrExcerpts(ocr, "total_minor")).toEqual([
    "Page 1: TOTAL 12,00",
    "Page 1: MOMS TOTAL 2,40",
  ]);
  expect(ocrExcerpts(ocr, "vendor")).toEqual([]);
});
it("keeps the newest source-matched transcript from each OCR engine", async () => {
  const page = {
    captureId: "synthetic-capture",
    sha256: "synthetic-original",
    rotation: 0,
  };
  const doc = { pages: [page] } as DocumentView;
  const artifacts = await Promise.all(
    [
      { engine: "OCR A", text: "Wrong original", sourceHash: "different" },
      { engine: "OCR A", text: "Newest A", sourceHash: page.sha256 },
      { engine: "OCR B", text: "Newest B", sourceHash: page.sha256 },
      { engine: "OCR A", text: "Old A", sourceHash: page.sha256 },
      {
        engine: "OCR A",
        text: "Current crop A",
        sourceHash: page.sha256,
        currentCrop: true,
      },
    ].map(async (a) => {
      const text = JSON.stringify({
        source: {
          captureId: page.captureId,
          sha256: a.sourceHash,
          region: a.currentCrop
            ? { left: 10, top: 20, width: 80, height: 160 }
            : { left: 0, top: 0, width: 100, height: 200 },
          pixels: [100, 200],
        },
        provenance: { engine: a.engine },
        text: a.text,
      });
      return {
        kind: "ocr",
        sha256: await sha256(new TextEncoder().encode(text)),
        created_at: "2026-01-10T00:00:00Z",
        text,
      };
    }),
  );
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith("/api/captures/"))
      return Response.json({
        id: page.captureId,
        sha256: page.sha256,
        metadata: { sourcePixels: [100, 200], quality: { quad: null } },
        artifacts: [
          ...artifacts,
          {
            kind: "ocr",
            sha256: "missing-old-artifact",
            created_at: "2025-01-01",
          },
        ],
      });
    if (url.endsWith("missing-old-artifact"))
      return new Response("", { status: 404 });
    const artifact = artifacts.find((a) => url.endsWith(a.sha256))!;
    return new Response(artifact.text);
  });
  vi.stubGlobal("fetch", fetch);
  const results = await readReviewOcr(doc);
  expect(
    results.engines.map((r) => [
      r.engine,
      r.pages[0].text,
      r.pages[0].sameRegion,
    ]),
  ).toEqual([
    ["OCR A", "Newest A", true],
    ["OCR B", "Newest B", true],
  ]);
  expect(results.errors).toHaveLength(1);
  expect(fetch.mock.calls.every(([url]) => !url.includes("/artifacts/"))).toBe(
    true,
  );
});
it("rejects OCR bytes that do not match the saved artifact hash", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.startsWith("/api/captures/")
        ? Response.json({
            artifacts: [
              { kind: "ocr", sha256: "wrong", created_at: "2026-01-10" },
            ],
          })
        : new Response("{}"),
    ),
  );
  const result = await readReviewOcr({
    pages: [{ captureId: "synthetic", sha256: "source" }],
  } as DocumentView);
  expect(result.engines).toEqual([]);
  expect(result.errors.join(" ")).toContain("checksum mismatch");
});

it("stops reads when the selected document is disposed", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    controller.abort();
    return Response.json({
      artifacts: [{ kind: "ocr", sha256: "unused", created_at: "2026-01-10" }],
    });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    readReviewOcr(
      { pages: [{ captureId: "synthetic", sha256: "source" }] } as DocumentView,
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
