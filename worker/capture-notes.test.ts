import { afterAll, beforeAll, expect, it } from "vitest";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
import { newDocument } from "../web/documents";

let mf: Awaited<ReturnType<typeof runtime>>;
beforeAll(async () => {
  mf = await runtime();
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

function request(
  path: string,
  method = "GET",
  body?: BodyInit,
  headers = ownerHeaders,
) {
  return mf.dispatchFetch(origin + path, {
    method,
    body,
    headers: { ...headers, Origin: origin, "X-Scanner-Request": "1" },
  });
}
async function capture(retakeOf?: string) {
  const id = crypto.randomUUID();
  expect(
    (
      await request(
        `/api/captures/${id}`,
        "POST",
        new Uint8Array([255, 216, 255, 8]),
        {
          ...ownerHeaders,
          "X-Capture-Status": "accepted",
          "X-Capture-Metadata": JSON.stringify({
            quality: { ok: true, receiptPixels: [1200, 1800] },
          }),
          ...(retakeOf ? { "X-Retake-Of": retakeOf } : {}),
        },
      )
    ).status,
  ).toBe(200);
  return id;
}
const read = async (id: string) =>
  (await request(`/api/captures/${id}`)).json() as Promise<any>;

it("keeps append-only owner comments with a physical receipt across retakes and document reads", async () => {
  const first = await capture();
  const before = await read(first);
  const document = newDocument(before);
  expect(
    (
      await request(
        "/api/documents",
        "POST",
        JSON.stringify({ documents: [document] }),
      )
    ).status,
  ).toBe(200);
  const savedDocument = (
    (await (await request(`/api/documents/${first}`)).json()) as any
  ).document;
  const id = crypto.randomUUID();
  const note = {
    id,
    text: "Original paper is visibly cut off. No fuller copy exists.",
  };
  const path = `/api/captures/${first}/notes`;
  const saved = await request(path, "POST", JSON.stringify(note));
  expect(saved.status).toBe(200);
  expect((await saved.json()).text).toBe(note.text);
  expect((await request(path, "POST", JSON.stringify(note))).status).toBe(200);
  const second = await capture(first);
  expect((await read(first)).owner_notes).toMatchObject([note]);
  expect((await read(second)).owner_notes).toMatchObject([note]);
  const catalog = (await (await request("/api/documents")).json()) as any;
  expect(
    catalog.captures.find((row: any) => row.id === first).owner_notes,
  ).toMatchObject([note]);
  const after = (await (
    await request(`/api/documents/${first}`)
  ).json()) as any;
  expect(after.document.revision).toBe(savedDocument.revision);
  expect((await read(first)).metadata).toEqual(before.metadata);
  expect(
    (
      await request(
        path,
        "POST",
        JSON.stringify({ id, text: "Different text" }),
      )
    ).status,
  ).toBe(409);
});

it("rejects empty, oversized and unauthorized comments", async () => {
  const captureId = await capture();
  const path = `/api/captures/${captureId}/notes`;
  for (const text of ["   ", "x".repeat(2001)])
    expect(
      (
        await request(
          path,
          "POST",
          JSON.stringify({ id: crypto.randomUUID(), text }),
        )
      ).status,
    ).toBe(400);
  expect(
    (
      await request(
        path,
        "POST",
        JSON.stringify({ id: crypto.randomUUID(), text: "private" }),
        {},
      )
    ).status,
  ).toBe(401);
  expect((await read(captureId)).owner_notes).toEqual([]);
});
