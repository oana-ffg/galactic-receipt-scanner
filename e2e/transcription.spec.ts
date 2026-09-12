import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

// Test downstream transcription independently of camera quality calibration.
test("Danish transcription preserves amounts, coordinates and the immutable source", async ({
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
  await page.goto("/");
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { scannerTools: Record<string, unknown> })
        .scannerTools.transcribe_saved_receipts,
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
  const output = (await page.evaluate(
    async (id) =>
      (
        window as unknown as {
          scannerTools: Record<
            string,
            { execute: (input: object) => Promise<unknown> }
          >;
        }
      ).scannerTools.transcribe_saved_receipts.execute({ ids: [id] }),
    id,
  )) as { results: { ok: boolean; error?: string; text: string }[] };
  console.log("Danish OCR result", JSON.stringify(output));
  expect(output.results[0].ok, output.results[0].error).toBe(true);
  const text = output.results[0].text;
  for (const value of [
    "ØKOHJØRNET",
    "Æbler",
    "Økologisk mælk",
    "Havregryn",
    "Rugbrød",
    "Rabat",
    "24,95",
    "16,50",
    "18,75",
    "22,00",
    "-5,00",
    "77,20",
    "15,44",
    "besøget",
  ])
    expect(text).toContain(value);
  const stored = await (await request.get(`/api/files/${id}/ocr`)).json();
  expect(stored.verified).toBe(false);
  expect(stored.source.sha256).toBe(sourceHash);
  expect(stored.source.pixels).toEqual([941, 1672]);
  expect(stored.lines.length).toBeGreaterThan(10);
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
  await expect(page.locator("#captures")).toContainText("OCR unverified");
});
