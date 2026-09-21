import { test, expect } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";

test("owner creates and revokes a connection through site tools without revealing keys", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).siteTools = {};
    Object.defineProperty(document, "modelContext", {
      value: {
        registerTool(tool: any) {
          (window as any).siteTools[tool.name] = tool;
        },
      },
    });
  });
  await page.goto("/agent-access");
  await expect(page.getByText("Connections are available.")).toBeVisible();
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const request = {
    request_id: crypto.randomUUID(),
    name: "Synthetic backup",
    scope: "backup",
    days: 7,
    public_key: publicKey.export({ format: "jwk" }),
  };
  const envelope = await page.evaluate(
    async (input) =>
      (window as any).siteTools.create_processing_connection.execute(input),
    request,
  );
  expect(envelope.id).toBe(request.request_id);
  expect(JSON.stringify(envelope)).not.toContain("synthetic-gateway");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(/Synthetic backup.*Read-only backup.*Active/),
  ).toBeVisible();
  let failRefresh = true;
  await page.route("**/api/connections*", async (route) => {
    if (failRefresh && route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  const revoked = await page.evaluate(
    async (connectionId) =>
      (window as any).siteTools.revoke_processing_connection.execute({
        connection_id: connectionId,
      }),
    request.request_id,
  );
  expect(revoked).toEqual({ revoked: true });
  failRefresh = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/Synthetic backup.*Revoked/)).toBeVisible();
});

test("manual request upload exposes purpose and downloads only an encrypted response", async ({
  page,
}) => {
  await page.goto("/agent-access");
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const request = {
    origin: new URL(page.url()).origin,
    request: {
      request_id: crypto.randomUUID(),
      name: "Synthetic processor",
      scope: "processing",
      days: 1,
      public_key: publicKey.export({ format: "jwk" }),
    },
  };
  await page.getByLabel("Connection request file").setInputFiles({
    name: "request.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(request)),
  });
  await expect(
    page.getByText("Synthetic processor · processing · 1 day(s)"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve connection" }).click();
  await expect(
    page.getByRole("link", { name: "Download encrypted response" }),
  ).toBeVisible();
});
