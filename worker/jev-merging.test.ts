import { afterEach, beforeEach, expect, it } from "vitest";
import { origin, ownerHeaders, runtime } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";
import { mergeDocuments, prepareJevMerge } from "./jev";
import { saveCapture } from "../scripts/jev-test-fixtures.mjs";

let mf: Awaited<ReturnType<typeof runtime>>;

beforeEach(async () => {
  mf = await runtime();
}, 30_000);

afterEach(async () => mf?.dispose());

it("keeps existing page groups intact and carries annotations and review reasons when merging payment evidence", () => {
  const page = (captureId: string) => ({
    captureId,
    sha256: captureId.repeat(64).slice(0, 64),
    crop: null,
    rotation: 0 as const,
  });
  const receipt = newDocument({ id: crypto.randomUUID() } as any);
  receipt.pages = [page("a"), page("b")];
  receipt.handwriting = "absent";
  const payment = newDocument({ id: crypto.randomUUID() } as any);
  payment.pages = [page("c"), page("d")];
  payment.handwriting = "present";
  payment.annotations = [
    {
      captureId: "c",
      text: "Synthetic note",
      box: [1, 2, 3, 4],
      uncertain: false,
    },
  ];
  payment.uncertainties = ["Synthetic unresolved payment detail."];
  const merged = prepareJevMerge(
    payment,
    receipt,
    "payment_match",
    new Map([
      ["a", "receipt"],
      ["b", "receipt"],
      ["c", "payment_evidence"],
      ["d", "payment_evidence"],
    ]),
    new Map([
      ["a", "2026-09-13T17:52:37.462Z\u0000a"],
      ["b", "2026-09-13T17:52:57.696Z\u0000b"],
      ["c", "2026-09-13T17:53:35.601Z\u0000c"],
      ["d", "2026-09-13T17:54:00.000Z\u0000d"],
    ]),
  );
  expect(merged.target.pages.map((item) => item.captureId)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
  expect(merged.target.annotations).toEqual(payment.annotations);
  expect(merged.target.handwriting).toBe("present");
  expect(merged.target.uncertainties).toContain(
    "Synthetic unresolved payment detail.",
  );
  expect(merged.donor.pages).toEqual([]);
  expect(merged.donor.annotations).toEqual([]);
  expect(merged.donor.mergedInto).toBe(receipt.id);
});

it("places an earlier receipt section before a later receipt and payment slip", () => {
  const page = (captureId: string) => ({
    captureId,
    sha256: captureId.repeat(64).slice(0, 64),
    rotation: 0 as const,
  });
  const later = newDocument({ id: crypto.randomUUID() } as any);
  later.pages = [page("bottom"), page("slip")];
  const earlier = newDocument({ id: crypto.randomUUID() } as any);
  earlier.pages = [page("top")];

  const merged = prepareJevMerge(
    later,
    earlier,
    "payment_match",
    new Map([
      ["top", "receipt"],
      ["bottom", "receipt"],
      ["slip", "payment_evidence"],
    ]),
    new Map([
      ["top", "2026-09-13T17:52:37.462Z\u0000top"],
      ["bottom", "2026-09-13T17:52:57.696Z\u0000bottom"],
      ["slip", "2026-09-13T17:53:35.601Z\u0000slip"],
    ]),
  );

  expect(merged.target.id).toBe(later.id);
  expect(merged.target.pages.map((item) => item.captureId)).toEqual([
    "top",
    "bottom",
    "slip",
  ]);
});

it("preserves a reviewed page order when attaching an earlier scanned payment slip", () => {
  const page = (captureId: string) => ({
    captureId,
    sha256: captureId.repeat(64).slice(0, 64),
    rotation: 0 as const,
  });
  const receipt = newDocument({ id: crypto.randomUUID() } as any);
  receipt.pages = [page("bottom"), page("top")];
  const payment = newDocument({ id: crypto.randomUUID() } as any);
  payment.pages = [page("slip")];

  const merged = prepareJevMerge(
    receipt,
    payment,
    "payment_match",
    new Map([
      ["top", "receipt"],
      ["bottom", "receipt"],
      ["slip", "payment_evidence"],
    ]),
    new Map([
      ["slip", "2026-09-13T17:52:30.000Z\u0000slip"],
      ["top", "2026-09-13T17:52:37.462Z\u0000top"],
      ["bottom", "2026-09-13T17:52:57.696Z\u0000bottom"],
    ]),
  );

  expect(merged.target.pages.map((item) => item.captureId)).toEqual([
    "bottom",
    "top",
    "slip",
  ]);
});

it("retargets persisted merged and duplicate aliases when Jev absorbs their target", async () => {
  const captures = [
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
    await saveCapture(mf),
  ];
  const target = newDocument(captures[0]);
  const donor = newDocument(captures[1]);
  donor.pages.push(newDocument(captures[2]).pages[0]);
  const mergedAlias = newDocument(captures[2]);
  mergedAlias.pages = [];
  mergedAlias.mergedInto = donor.id;
  mergedAlias.evidence = "Synthetic prior merge evidence.";
  const duplicateAlias = newDocument(captures[3]);
  duplicateAlias.duplicateOf = donor.id;
  duplicateAlias.evidence = "Synthetic duplicate evidence.";
  const saved = await mf.dispatchFetch(`${origin}/api/documents`, {
    method: "POST",
    headers: {
      ...ownerHeaders,
      Origin: origin,
      "X-Scanner-Request": "1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      documents: [target, donor, mergedAlias, duplicateAlias],
    }),
  });
  expect(saved.status, await saved.text()).toBe(200);
  const db = await mf.getD1Database("DB");
  const priorAlias = {
    ...mergedAlias,
    revision: 2,
    uncertainties: ["Synthetic unresolved OCR review."],
    broken: ["Synthetic unresolved source error."],
  };
  await db.batch([
    db
      .prepare(
        "INSERT INTO document_versions(document_id,revision,payload,created_at) VALUES(?,?,?,?)",
      )
      .bind(
        mergedAlias.id,
        2,
        JSON.stringify(priorAlias),
        new Date().toISOString(),
      ),
    db
      .prepare("UPDATE document_heads SET revision=? WHERE id=?")
      .bind(2, mergedAlias.id),
  ]);
  const catalogResponse = await mf.dispatchFetch(`${origin}/api/documents`, {
    headers: ownerHeaders,
  });
  const catalog = await catalogResponse.json<any>();
  const documents = catalog.documents;
  const currentTarget = documents.find((item: any) => item.id === target.id);
  const currentDonor = documents.find((item: any) => item.id === donor.id);
  const bucket = await mf.getR2Bucket("BUCKET");
  const merged = await mergeDocuments(
    new Request(origin),
    { DB: db, BUCKET: bucket } as any,
    async () => catalog.captures,
    catalog.captures,
    currentDonor,
    currentTarget,
    "payment_match",
    new Map([
      [captures[0].id, "receipt"],
      [captures[1].id, "payment_evidence"],
      [captures[2].id, "payment_evidence"],
    ]),
    documents,
  );
  expect(merged?.id).toBe(target.id);
  const destinationResponse = await mf.dispatchFetch(
    `${origin}/api/documents/${target.id}`,
    { headers: ownerHeaders },
  );
  const destination = (await destinationResponse.json<any>()).document;
  expect(destination.uncertainties).toContain(
    "Synthetic unresolved OCR review.",
  );
  expect(destination.broken).toContain("Synthetic unresolved source error.");
  for (const [id, relationship] of [
    [mergedAlias.id, "mergedInto"],
    [duplicateAlias.id, "duplicateOf"],
  ] as const) {
    const response = await mf.dispatchFetch(`${origin}/api/documents/${id}`, {
      headers: ownerHeaders,
    });
    const document = (await response.json<any>()).document;
    expect(document[relationship]).toBe(target.id);
  }
});
