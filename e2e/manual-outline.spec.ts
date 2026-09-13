import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startTestServer } from "../scripts/test-server.mjs";

test("saved original viewer uses persisted manual outline while keeping failed capture status", async ({
  page,
  request,
}) => {
  const isolated = await startTestServer();
  try {
    const id = crypto.randomUUID();
    const saved = await request.post(`${isolated.origin}/api/captures/${id}`, {
      headers: {
        Origin: isolated.origin,
        "X-Scanner-Request": "1",
        "X-Capture-Status": "manual-review",
        "X-Capture-Metadata": JSON.stringify({
          manualCapture: true,
          sourcePixels: [800, 1200],
          quality: { ok: false, quad: null, reason: "Synthetic unusual shape" },
        }),
      },
      data: await readFile("e2e/fixtures/generated/flat.png"),
    });
    expect(saved.ok()).toBe(true);
    const source = await saved.json();
    const correction = {
      id: crypto.randomUUID(),
      source_sha256: source.sha256,
      previous_id: null,
      quad: [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
      note: "Synthetic outline review.",
    };
    expect(
      (
        await request.post(`${isolated.origin}/api/captures/${id}/outlines`, {
          headers: { Origin: isolated.origin, "X-Scanner-Request": "1" },
          data: correction,
        })
      ).status(),
    ).toBe(201);
    await page.goto(isolated.origin);
    await expect(page.locator("#saved-photo")).toContainText(
      "Manually corrected outline",
    );
    await expect(page.locator("#saved-photo svg polygon")).toHaveAttribute(
      "points",
      "100,100 900,100 900,900 100,900",
    );
    await expect(page.locator("#saved-photo")).toContainText("Needs attention");
    await page
      .getByRole("button", { name: "Inspect full size", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Corrected outline");
    const detail = await (
      await request.get(`${isolated.origin}/api/captures/${id}`)
    ).json();
    expect(detail.metadata.quality.quad).toBeNull();
    expect(detail.status).toBe("manual-review");
  } finally {
    await isolated.close();
  }
});
