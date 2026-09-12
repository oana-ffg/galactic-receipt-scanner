import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { runtime, origin, ownerHeaders } from "../scripts/test-runtime.mjs";
let isolated: Awaited<ReturnType<typeof runtime>>;
test.beforeEach(async ({ page }) => {
  isolated = await runtime();
  await page.route(`${origin}/**`, async (route) => {
    const req = route.request();
    const response = await isolated.dispatchFetch(req.url(), {
      method: req.method(),
      headers: { ...req.headers(), ...ownerHeaders },
      body: req.postDataBuffer() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
});
test.afterEach(async () => {
  await isolated?.dispose();
});
const isolatedRequest = {
  async post(
    path: string,
    options: { data: Buffer; headers: Record<string, string> },
  ) {
    const r = await isolated.dispatchFetch(origin + path, {
      method: "POST",
      body: options.data,
      headers: { ...options.headers, ...ownerHeaders },
    });
    return { ok: () => r.ok };
  },
  async get(path: string) {
    const r = await isolated.dispatchFetch(origin + path, {
      headers: ownerHeaders,
    });
    return {
      ok: () => r.ok,
      body: async () => Buffer.from(await r.arrayBuffer()),
      json: () => r.json(),
    };
  },
};

test("review saves non-adjacent pages, produces a named multi-page PDF and keeps uncertainty visible", async ({
  page,
}) => {
  const request = isolatedRequest;
  test.setTimeout(120000);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const image = await readFile("e2e/fixtures/generated/danish.png");
  for (const id of ids) {
    const r = await request.post(`/api/captures/${id}`, {
      data: image,
      headers: {
        Origin: "http://127.0.0.1:8766",
        "X-Scanner-Request": "1",
        "X-Capture-Status": "accepted",
        "X-Capture-Metadata": JSON.stringify({
          sourcePixels: [941, 1672],
          quality: { ok: true, receiptPixels: [941, 1672] },
        }),
      },
    });
    expect(r.ok()).toBe(true);
  }
  await page.addInitScript(() => {
    const tools: Record<string, { execute: (input: object) => Promise<any> }> =
      {};
    Object.assign(window, { documentTools: tools });
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool: (tool: {
          name: string;
          execute: (input: object) => Promise<any>;
        }) => {
          tools[tool.name] = tool;
        },
      },
    });
  });
  await page.goto("/review");
  await expect(
    page.getByRole("heading", { name: "Receipt review", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async (ids) => {
    const tools = (window as any).documentTools;
    const { document: first } = await tools.read_document.execute({
      id: ids[0],
    });
    const { document: last } = await tools.read_document.execute({
      id: ids[2],
    });
    first.pages.push(...last.pages);
    first.vendor = "Synthetic paper shop";
    first.receiptDate = "2026-08-14";
    first.kind = "invoice";
    first.handwriting = "uncertain";
    first.evidence =
      "Synthetic pages 1 and 2 explicitly matched despite intervening capture.";
    first.uncertainties = ["Unclear handwritten payer name."];
    first.invoice = {
      currency: "DKK",
      lines: [10000, 5000],
      adjustments: [{ label: "VAT", amount: 3750 }],
      total: 18751,
      basis: "net-plus-tax",
      evidence: "Synthetic totals mismatch by one minor unit.",
    };
    await tools.save_documents.execute({ documents: [first] });
    return tools.generate_document_pdf.execute({ id: first.id });
  }, ids);
  expect(result.filename).toBe("2026-08-14-synthetic_paper_shop.pdf");
  const response = await request.get(
    `/api/documents/${ids[0]}/pdf?revision=${result.revision}&version=${result.sha256}`,
  );
  expect(response.ok()).toBe(true);
  const pdfBytes = await response.body();
  const pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getPageCount()).toBe(2);
  await mkdir("test-results/documents", { recursive: true });
  await writeFile("test-results/documents/synthetic-grouped.pdf", pdfBytes);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: /2026-08-14-synthetic_paper_shop/ })
    .click();
  await expect(
    page.getByText("Unclear handwritten payer name.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("#review-detail")
      .getByText(/differ from the printed total by -1/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Page 2", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/documents/review-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  const preview = page.getByRole("dialog", { name: /Saved PDF:/ });
  await expect(
    preview.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await expect(preview.getByRole("status")).toHaveText(
    /saved PDF checksum verified/,
  );
  await preview.getByRole("button", { name: "Next page" }).click();
  await expect(
    preview.getByRole("img", { name: "PDF page 2 of 2" }),
  ).toBeVisible();
  await expect(preview.locator("canvas")).toHaveCount(1);
  await preview.getByRole("button", { name: "Zoom in" }).click();
  await expect(preview.getByRole("button", { name: "Fit page" })).toBeVisible();
  await preview.getByRole("button", { name: "Previous page" }).click();
  await expect(
    preview.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Close PDF" }).click();
  await expect(preview).toHaveCount(0);
  const pdfUrl = `${origin}/api/documents/${ids[0]}/pdf?version=${result.sha256}&revision=${result.revision}`;
  await page.route(pdfUrl, (route) =>
    route.fulfill({
      contentType: "application/pdf",
      body: Buffer.from("%PDF-tampered synthetic response"),
    }),
  );
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  await expect(preview.getByRole("status")).toHaveText(/PDF checksum mismatch/);
  await expect(preview.locator("canvas")).toBeHidden();
  await preview.getByRole("button", { name: "Close PDF" }).click();
  await expect(preview).toHaveCount(0);
  await page.unroute(pdfUrl);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route(pdfUrl, async (route) => {
    requested();
    await held;
    await route
      .fulfill({ contentType: "application/pdf", body: pdfBytes })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  await started;
  await preview.getByRole("button", { name: "Close PDF" }).click();
  await expect(preview).toHaveCount(0);
  release();
  await page.unroute(pdfUrl);
  await page.getByRole("button", { name: "Preview saved PDF" }).click();
  await expect(
    preview.getByRole("img", { name: "PDF page 1 of 2" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Close PDF" }).click();
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const history = await request.get(`/api/documents/${ids[0]}/history`);
  expect((await history.json()).length).toBe(1);
  for (const id of ids)
    expect((await request.get(`/api/files/${id}/raw`)).ok()).toBe(true);
  const approvedRevision = await page.evaluate(async (id) => {
    const tools = (window as any).documentTools;
    const { document: d } = await tools.read_document.execute({ id });
    d.invoice.total = 18750;
    d.uncertainties = [];
    d.handwriting = "absent";
    d.checks = { visual: true, transcription: true, grouping: true, pdf: true };
    d.reviewedPdfSha256 = d.pdf.sha256;
    const saved = await tools.save_documents.execute({ documents: [d] });
    return saved.saved[0].revision;
  }, ids[0]);
  await request.post(
    `/api/documents/${ids[0]}/pdf?revision=${approvedRevision}`,
    {
      data: Buffer.from("%PDF-new synthetic artifact for review-hash test"),
      headers: { Origin: "http://127.0.0.1:8766", "X-Scanner-Request": "1" },
    },
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const check = page.getByRole("checkbox", {
    name: "Generated PDF inspected for clipping and legibility",
  });
  await expect(check).not.toBeChecked();
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(/Review saved/);
  const checked = await request.get(`/api/documents/${ids[0]}`);
  expect((await checked.json()).document.checks.pdf).toBe(false);
});
