import { afterAll, beforeAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import type { Quality } from "../web/types";
let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
async function request(
  path: string,
  method = "GET",
  body?: BodyInit,
  headers = {},
) {
  return mf.dispatchFetch(origin + path, {
    method,
    body,
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      ...headers,
    },
  });
}
async function capture(quality: Partial<Quality> = {}) {
  const id = crypto.randomUUID();
  const r = await request(
    `/api/captures/${id}`,
    "POST",
    new Uint8Array([255, 216, 255, Math.floor(Math.random() * 255)]),
    {
      "X-Capture-Status": "accepted",
      "X-Capture-Metadata": JSON.stringify({
        sourcePixels: [1400, 2200],
        quality: { ok: true, receiptPixels: [1400, 2200], ...quality },
      }),
    },
  );
  expect(r.status).toBe(200);
  return r.json();
}
const save = (documents: unknown[]) =>
  request("/api/documents", "POST", JSON.stringify({ documents }));
it("exposes only page rotation for OCR and discards legacy crop input", async () => {
  const source = await capture();
  const before = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(before.layouts.some((row: any) => row.capture_id === source.id)).toBe(
    false,
  );
  const document = newDocument(source);
  (document.pages[0] as any).crop = [10, 20, 1000, 1800];
  document.pages[0].rotation = 90;
  expect((await save([document])).status).toBe(200);
  const first = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    first.layouts.find((row: any) => row.capture_id === source.id),
  ).toEqual({
    capture_id: source.id,
    source_sha256: source.sha256,
    rotation: 90,
  });
  const saved = (
    (await (await request(`/api/documents/${source.id}`)).json()) as any
  ).document;
  expect(saved.pages[0]).not.toHaveProperty("crop");
  saved.pages[0].crop = [20, 30, 1000, 1800];
  expect((await save([saved])).status).toBe(200);
  const latest = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    latest.layouts.find((row: any) => row.capture_id === source.id),
  ).toEqual({
    capture_id: source.id,
    source_sha256: source.sha256,
    rotation: 90,
  });
  const latestSaved = (await (
    await request(`/api/documents/${source.id}`)
  ).json()) as any;
  expect(latestSaved.document.pages[0]).not.toHaveProperty("crop");
});
it("reads saved page layout even when the page index table is stale", async () => {
  const source = await capture();
  const document = newDocument(source);
  (document.pages[0] as any).crop = [40, 50, 900, 1700];
  expect((await save([document])).status).toBe(200);
  const db = await mf.getD1Database("DB");
  await db
    .prepare("UPDATE document_pages SET page_index=7 WHERE capture_id=?")
    .bind(source.id)
    .run();
  const layouts = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    layouts.layouts.find((row: any) => row.capture_id === source.id),
  ).toEqual({
    capture_id: source.id,
    source_sha256: source.sha256,
    rotation: 0,
  });
});
it("preserves scan times and sources through non-adjacent grouping, splitting and optimistic revisions", async () => {
  const a = await capture(),
    middle = await capture(),
    b = await capture();
  const one = newDocument(a),
    two = newDocument(b);
  (two.pages[0] as any).crop = [20, 30, 1000, 1800];
  one.vendor = two.vendor = "Synthetic shop";
  one.receiptDate = two.receiptDate = "2026-02-01";
  expect((await save([one, two])).status).toBe(200);
  const first = await (await request("/api/documents")).json();
  const savedA = first.documents.find((d: any) => d.id === a.id),
    savedB = first.documents.find((d: any) => d.id === b.id);
  expect(savedA.filename).toBe("2026-02-01_synthetic_shop.pdf");
  expect(savedB.filename).toBe("2026-02-01_synthetic_shop_2.pdf");
  expect(savedA.scannedAt).toEqual([a.created_at]);
  savedA.pages.push(...savedB.pages);
  savedA.evidence = "Same synthetic invoice number and pages 1/2, 2/2.";
  savedB.pages = [];
  savedB.mergedInto = a.id;
  savedB.evidence = savedA.evidence;
  expect((await save([savedA, savedB])).status).toBe(200);
  expect((await save([savedA, savedB])).status).toBe(409);
  const second = await (await request("/api/documents")).json();
  const grouped = second.documents.find((d: any) => d.id === a.id);
  expect(grouped.pages.map((p: any) => p.captureId)).toEqual([a.id, b.id]);
  const mergedLayouts = (await (
    await request("/api/processing/ocr-layouts")
  ).json()) as any;
  expect(
    mergedLayouts.layouts.filter((row: any) => row.capture_id === b.id),
  ).toEqual([
    {
      capture_id: b.id,
      source_sha256: b.sha256,
      rotation: 0,
    },
  ]);
  expect(second.documents.some((d: any) => d.id === middle.id)).toBe(true);
  expect((await request(`/api/files/${b.id}/raw`)).status).toBe(200);
  const drop = { ...grouped, pages: [grouped.pages[0]] };
  expect((await save([drop])).status).toBe(400);
  const separate = { ...newDocument(b), id: crypto.randomUUID() };
  expect((await save([drop, separate])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${a.id}/history`)).json()).length,
  ).toBe(3);
});
it("rejects spoofed sources, missing fields, cyclic duplicates and invalid money", async () => {
  const c = await capture(),
    d = newDocument(c);
  expect((await save([{}])).status).toBe(400);
  expect(
    (await save([{ ...d, pages: [{ ...d.pages[0], sha256: "f".repeat(64) }] }]))
      .status,
  ).toBe(400);
  const another = newDocument(await capture());
  d.duplicateOf = another.id;
  another.duplicateOf = d.id;
  d.evidence = another.evidence = "Synthetic duplicate evidence";
  expect((await save([d, another])).status).toBe(400);
  d.duplicateOf = null;
  expect(
    (
      await save([
        {
          ...d,
          invoice: {
            currency: "DKK",
            lines: [1.5],
            adjustments: [],
            total: 1.5,
            basis: "gross",
            evidence: "Test",
          },
        },
      ])
    ).status,
  ).toBe(400);
});
it("never hides an unassigned current original on its first processing save", async () => {
  const a = newDocument(await capture()),
    b = newDocument(await capture());
  expect(
    (
      await save([
        {
          ...a,
          pages: [],
          mergedInto: b.id,
          evidence: "Attempted virtual merge",
        },
      ])
    ).status,
  ).toBe(400);
  expect((await save([{ ...a, pages: b.pages }])).status).toBe(400);
  const catalog = await (await request("/api/documents")).json();
  expect(
    catalog.documents.some((d: any) =>
      d.pages.some((p: any) => p.captureId === a.id),
    ),
  ).toBe(true);
  expect(
    (
      await save([
        {
          ...a,
          checks: { ...a.checks, pdf: true },
          evidence: "Premature PDF check",
        },
      ])
    ).status,
  ).toBe(400);
  a.duplicateOf = b.id;
  a.broken = ["OCR failed on synthetic source"];
  a.evidence = "Proposed duplicate";
  expect((await save([a])).status).toBe(200);
  const updated = await (await request("/api/documents")).json();
  const duplicate = updated.documents.find((d: any) => d.id === a.id);
  expect(duplicate.status).toBe("duplicate");
  expect(duplicate.reasons).toContain("OCR failed on synthetic source");
});
it("keeps broken totals broken and invalidates output after page changes", async () => {
  const c = await capture(),
    d = newDocument(c);
  d.vendor = "Invoice test";
  d.receiptDate = "2026-02-02";
  d.kind = "invoice";
  d.evidence = "Synthetic invoice";
  d.checks.visual = d.checks.transcription = d.checks.grouping = true;
  d.invoice = {
    currency: "DKK",
    lines: [100, 200],
    adjustments: [],
    total: 301,
    basis: "gross",
    evidence: "Source lines",
  };
  expect((await save([d])).status).toBe(200);
  let catalog = await (await request("/api/documents")).json();
  let current = catalog.documents.find((x: any) => x.id === c.id);
  expect(current.status).toBe("broken");
  const uploaded = await request(
    `/api/documents/${d.id}/pdf?revision=1`,
    "POST",
    "%PDF-1.7\nsynthetic test envelope",
  );
  expect(uploaded.status).toBe(200);
  const pdf = await uploaded.json();
  const pinned = `/api/documents/${d.id}/pdf?revision=1&version=${pdf.sha256}`;
  expect((await request(pinned)).status).toBe(200);
  current.pages[0].rotation = 90;
  expect((await save([current])).status).toBe(200);
  catalog = await (await request("/api/documents")).json();
  current = catalog.documents.find((x: any) => x.id === c.id);
  expect(current.pdf).toBeNull();
  expect((await request(pinned)).status).toBe(200);
  expect(
    (
      await request(
        `/api/documents/${d.id}/pdf?revision=1`,
        "POST",
        "%PDF-stale",
      )
    ).status,
  ).toBe(409);
});
it("allows only one concurrent revision and keeps access owner-only", async () => {
  const d = newDocument(await capture());
  expect((await save([d])).status).toBe(200);
  d.revision = 1;
  const results = await Promise.all([
    save([{ ...d, vendor: "Choice A" }]),
    save([{ ...d, vendor: "Choice B" }]),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await mf.dispatchFetch(origin + "/api/documents")).status).toBe(401);
  expect(
    (
      await request("/api/documents", "GET", undefined, {
        "oai-authenticated-user-email": "other@example.test",
      })
    ).status,
  ).toBe(403);
  expect((await request("/review")).status).toBe(200);
});
it("paginates compact summaries and returns individual sources without all batch text", async () => {
  const a = newDocument(await capture()),
    b = newDocument(await capture());
  a.vendor = "Synthetic Orchard";
  a.text = "unique distant continuation ZX123";
  b.text = "another document";
  expect((await save([a, b])).status).toBe(200);
  const first = await (
    await request("/api/documents?summary=1&limit=1")
  ).json();
  expect(first.documents).toHaveLength(1);
  expect(first.next).toBeTruthy();
  expect(first.documents[0]).not.toHaveProperty("text");
  const second = await (
    await request(`/api/documents?summary=1&limit=1&after=${first.next}`)
  ).json();
  expect(second.documents[0].id).not.toBe(first.documents[0].id);
  const search = await (
    await request("/api/documents?summary=1&q=ZX123")
  ).json();
  expect(search.documents.map((d: any) => d.id)).toEqual([a.id]);
  const detail = await (await request(`/api/documents/${a.id}`)).json();
  expect(detail.document.text).toBe(a.text);
  expect(detail.captures.map((c: any) => c.id)).toEqual([a.id]);
  const lookup = await (
    await request(`/api/documents?captureId=${a.id}`)
  ).json();
  expect(lookup.document.id).toBe(a.id);
});
it("keeps unresolved reasons on retained documents during agent-driven merges", async () => {
  const a = newDocument(await capture()),
    b = newDocument(await capture());
  a.broken = ["OCR failed on a synthetic source"];
  expect((await save([a, b])).status).toBe(200);
  a.revision = b.revision = 1;
  b.pages.push(...a.pages);
  a.pages = [];
  a.mergedInto = b.id;
  a.evidence = "Synthetic merge";
  expect((await save([a, b])).status).toBe(400);
  b.broken = [...a.broken];
  expect((await save([a, b])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${b.id}`)).json()).document.status,
  ).toBe("broken");
  a.revision = b.revision = 2;
  b.broken = [];
  b.evidence = "Original inspected: the synthetic OCR failure is resolved.";
  expect((await save([b])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${b.id}`)).json()).document.broken,
  ).toEqual([]);
  const history = await (
    await request(`/api/documents/${b.id}/history`)
  ).json();
  expect(history).toHaveLength(3);
  b.revision = 3;
  a.uncertainties = ["New synthetic handwritten amount needs clarification"];
  expect((await save([a])).status).toBe(400);
  b.uncertainties = [...a.uncertainties];
  expect((await save([a, b])).status).toBe(200);
  a.revision = 3;
  b.revision = 4;
  const c = newDocument(await capture());
  a.mergedInto = c.id;
  c.evidence = "Synthetic retargeting";
  expect((await save([a, c])).status).toBe(400);
  c.broken = [...a.broken];
  c.uncertainties = [...a.uncertainties];
  expect((await save([a, c])).status).toBe(200);
});
it("pins visual approval to a stored PDF hash and requires review after regeneration", async () => {
  const d = newDocument(await capture());
  d.vendor = "Synthetic approved";
  d.receiptDate = "2026-01-01";
  d.kind = "receipt";
  d.handwriting = "absent";
  d.evidence = "Synthetic originals inspected";
  d.checks = { visual: true, transcription: true, grouping: true, pdf: false };
  expect((await save([d])).status).toBe(200);
  const first = await (
    await request(
      `/api/documents/${d.id}/pdf?revision=1`,
      "POST",
      "%PDF-first synthetic output",
    )
  ).json();
  d.revision = 1;
  d.checks.pdf = true;
  d.reviewedPdfSha256 = first.sha256;
  expect((await save([d])).status).toBe(200);
  expect(
    (await (await request(`/api/documents/${d.id}`)).json()).document.status,
  ).toBe("ready");
  const incoming = newDocument(await capture());
  expect(
    (
      await save([
        {
          ...d,
          revision: 2,
          pages: [...d.pages, ...incoming.pages],
          checks: { ...d.checks, pdf: false },
        },
      ])
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        `/api/documents/${d.id}/pdf?revision=2`,
        "POST",
        "%PDF-second synthetic output",
      )
    ).status,
  ).toBe(200);
  const changed = await (await request(`/api/documents/${d.id}`)).json();
  expect(changed.document.status).toBe("processing");
  expect(changed.document.reasons.join(" ")).toContain(
    "visually reviewed version",
  );
});

it("preserves a nonblocking blur flag and shows it until visual review", async () => {
  const blur: NonNullable<Quality["blur"]> = {
    version: "crete-1",
    score: 0.35,
    category: "uncertain",
    region: "document-bounds",
    sourceBounds: [0, 0, 1400, 2200],
    pixels: [382, 600],
    filterSize: 11,
    fineBelow: 0.3,
    blurryAbove: 0.38,
  };
  const c = await capture({ blur });
  expect(c.status).toBe("accepted");
  const original = await (await request(`/api/captures/${c.id}`)).json();
  expect(original.metadata.quality.blur).toEqual(blur);
  const listed = await (await request("/api/documents")).json();
  const view = listed.documents.find((d: any) => d.id === c.id);
  expect(view.reasons.join(" ")).toContain(
    "borderline blur flagged at capture (0.350)",
  );
  const d = newDocument(original);
  d.checks.visual = true;
  d.evidence = "Synthetic original visually checked for blur.";
  const saved = await save([d]);
  expect(saved.status, await saved.text()).toBe(200);
  const reviewed = await (await request("/api/documents")).json();
  expect(
    reviewed.documents.find((v: any) => v.id === c.id).reasons.join(" "),
  ).not.toContain("borderline blur");
  expect(
    (await (await request(`/api/captures/${c.id}`)).json()).metadata.quality
      .blur,
  ).toEqual(blur);
});
