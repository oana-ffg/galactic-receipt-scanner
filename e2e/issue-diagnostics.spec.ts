import { test, expect } from "@playwright/test";

test("private reports freeze diagnostic history and retry an uncertain save unchanged", async ({
  page,
  request,
}) => {
  const before = (await (await request.get("/api/captures")).json()).captures
    .length;
  await page.route("**/api/station", (route) =>
    route.fulfill({
      status: 503,
      json: { detail: "synthetic secret must not enter logs" },
    }),
  );
  await page.goto("/camera");
  await expect(page.locator("#count")).toHaveAttribute(
    "aria-label",
    "Saved count unavailable",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "synthetic secret must not enter logs",
        lineno: 123,
      }),
    ),
  );
  await page.getByRole("button", { name: "Report issue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Report a private issue" });
  await expect(dialog).toContainText("before refreshing");
  await page.evaluate(() =>
    window.dispatchEvent(new ErrorEvent("error", { lineno: 456 })),
  );
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Synthetic frozen diagnostics");
  let attempts = 0;
  const contexts: unknown[] = [];
  await page.route(/\/api\/issues\/[^/]+$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = new Response(route.request().postDataBuffer(), {
      headers: { "Content-Type": route.request().headers()["content-type"] },
    });
    const form = await body.formData();
    contexts.push(JSON.parse(String(form.get("metadata"))).context);
    const saved = await route.fetch();
    if (++attempts === 1) return route.abort("failed");
    return route.fulfill({ response: saved });
  });
  await dialog.getByRole("button", { name: "Save private issue" }).click();
  await expect(dialog.locator(".issue-feedback")).toContainText("Retry saving");
  await dialog.getByRole("button", { name: "Save private issue" }).click();
  await expect(dialog).not.toBeVisible();
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).toEqual(contexts[1]);
  const reports = (
    await (await request.get("/api/issues")).json()
  ).issues.filter(
    (issue: { title: string }) =>
      issue.title === "Synthetic frozen diagnostics",
  );
  expect(reports).toHaveLength(1);
  const history = reports[0].context.diagnostics.history;
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "request",
        data: expect.objectContaining({
          route: "station",
          status: 503,
          ok: false,
        }),
      }),
      expect.objectContaining({
        event: "runtime.error",
        data: expect.objectContaining({ line: 123 }),
      }),
    ]),
  );
  expect(JSON.stringify(history)).not.toContain("secret");
  expect(
    history.some(
      (event: { data: { line?: number } }) => event.data.line === 456,
    ),
  ).toBe(false);
  expect(
    (await (await request.get("/api/captures")).json()).captures.length,
  ).toBe(before);
});
