import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Saved processing output remains reviewable without browser OCR execution.
test("saved transcription preserves versions and originals without browser OCR", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const bytes = await readFile("e2e/fixtures/generated/danish.png");
  const id = randomUUID();
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const response = await request.post(`/api/captures/${id}`, {
    data: bytes,
    headers: {
      Origin: "http://127.0.0.1:8766",
      "X-Scanner-Request": "1",
      "Content-Type": "image/png",
      "x-capture-status": "accepted",
      "x-capture-metadata": JSON.stringify({
        sourcePixels: [941, 1672],
        quality: {
          ok: true,
          receiptPixels: [941, 1672],
          quad: [
            [0.1, 0.05],
            [0.895, 0.05],
            [0.895, 0.94],
            [0.1, 0.94],
          ],
        },
        fixture: "downstream-ocr",
      }),
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.addInitScript(() => {
    const tools: Record<
      string,
      { execute: (input: object) => Promise<unknown> }
    > = {};
    Object.assign(window, { scannerTools: tools });
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: (tool: {
          name: string;
          execute: (input: object) => Promise<unknown>;
        }) => {
          tools[tool.name] = tool;
        },
      },
    });
  });
  await page.goto("/review");
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { scannerTools: Record<string, unknown> })
        .scannerTools.save_receipt_transcription,
    ),
  );
  const external: string[] = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:8766/") &&
      !r.url().startsWith("blob:")
    )
      external.push(r.url());
  });
  const toolNames = await page.evaluate(() =>
    Object.keys(
      (window as unknown as { scannerTools: Record<string, unknown> })
        .scannerTools,
    ),
  );
  expect(toolNames).not.toContain("transcribe_saved_receipts");
  expect(toolNames).not.toContain("process_document_ocr");
  await expect(
    page.getByRole("button", { name: "Transcribe next 20" }),
  ).toHaveCount(0);
  const text = "ØKOHJØRNET\nÆbler 24,95\nTotal 77,20";
  const saved = await request.post(`/api/captures/${id}/artifacts/ocr`, {
    data: {
      verified: false,
      text,
      source: { captureId: id, sha256: sourceHash, pixels: [941, 1672] },
      provenance: { engine: "PP-OCRv6" },
      lines: [{ text, box: { x0: 190, y0: 250, x1: 780, y1: 490 } }],
      review: { required: true },
    },
    headers: { Origin: "http://127.0.0.1:8766", "X-Scanner-Request": "1" },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stored = await (await request.get(`/api/files/${id}/ocr`)).json();
  expect(stored.verified).toBe(false);
  expect(stored.source.sha256).toBe(sourceHash);
  expect(stored.source.pixels).toEqual([941, 1672]);
  expect(stored.lines).toHaveLength(1);
  for (const line of stored.lines) {
    expect(line.box.x0).toBeGreaterThanOrEqual(0);
    expect(line.box.x1).toBeLessThanOrEqual(941);
    expect(line.box.y0).toBeGreaterThanOrEqual(0);
    expect(line.box.y1).toBeLessThanOrEqual(1672);
  }
  expect(stored.review.required).toBe(true);
  const reviewed = (await page.evaluate(
    async ({ id, text }) => {
      const tools = (
        window as unknown as {
          scannerTools: Record<
            string,
            { execute: (input: object) => Promise<unknown> }
          >;
        }
      ).scannerTools;
      const input = {
        id,
        text: text.replace(/^7\n/, ""),
        provenance:
          "Synthetic test: leaf symbol visually distinguished from the OCR 7",
        uncertainties: [],
        regions: [
          {
            kind: "logo",
            text: "ØKOHJØRNET; leaf symbol",
            box: [190, 250, 780, 490],
            uncertain: false,
          },
        ],
      };
      try {
        await tools.save_receipt_transcription.execute({
          ...input,
          regions: [{ ...input.regions[0], box: [0, 0, 99999, 99999] }],
        });
        throw new Error("Invalid region accepted");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Regions need")
        )
          throw error;
      }
      return tools.save_receipt_transcription.execute(input);
    },
    { id, text },
  )) as { sha256: string };
  const versions = (await (await request.get(`/api/captures/${id}`)).json())
    .artifacts;
  expect(
    versions.filter((v: { kind: string }) => v.kind === "ocr"),
  ).toHaveLength(2);
  const initialVersion = versions.find(
    (v: { sha256: string }) => v.sha256 !== reviewed.sha256,
  ).sha256;
  expect(
    await (
      await request.get(`/api/files/${id}/ocr?version=${initialVersion}`)
    ).json(),
  ).toEqual(stored);
  const correction = await (
    await request.get(`/api/files/${id}/ocr?version=${reviewed.sha256}`)
  ).json();
  expect(correction.text.startsWith("ØKOHJØRNET")).toBe(true);
  expect(correction.source.sha256).toBe(sourceHash);
  expect(
    createHash("sha256")
      .update(await (await request.get(`/api/files/${id}/raw`)).body())
      .digest("hex"),
  ).toBe(sourceHash);
  expect(external).toEqual([]);
});
