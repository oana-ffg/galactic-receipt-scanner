import { Miniflare } from "miniflare";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
export const origin = "http://127.0.0.1:8766";
export const ownerHeaders = {
  "oai-authenticated-user-id": "synthetic-owner",
  "oai-authenticated-user-email": "owner@example.test",
};
export async function runtime({
  retiredCaptureIds,
  migrationLimit,
  appOrigin = origin,
  processingTokenSha256,
  sitesGatewayToken,
  typesafeApiKey,
  outboundService,
} = {}) {
  const configuredDist = process.env.RECEIPT_TEST_DIST_ROOT;
  if (configuredDist && !isAbsolute(configuredDist))
    throw Error("RECEIPT_TEST_DIST_ROOT must be an absolute path.");
  const distRoot = configuredDist || "dist";
  const mf = new Miniflare({
    modules: true,
    scriptPath: join(distRoot, "server", "index.js"),
    compatibilityDate: "2026-08-01",
    bindings: {
      OWNER_EMAIL: "owner@example.test",
      APP_ORIGIN: appOrigin,
      ...(sitesGatewayToken ? { SITES_GATEWAY_TOKEN: sitesGatewayToken } : {}),
      ...(typesafeApiKey ? { TYPESAFE_API_KEY: typesafeApiKey } : {}),
      ...(processingTokenSha256
        ? { PROCESSING_TOKEN_SHA256: processingTokenSha256 }
        : {}),
      ...(retiredCaptureIds ? { RETIRED_CAPTURE_IDS: retiredCaptureIds } : {}),
    },
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
    assets: {
      directory: join(distRoot, "client"),
      binding: "ASSETS",
      routerConfig: {
        invoke_user_worker_ahead_of_assets: true,
        has_user_worker: true,
      },
    },
    ...(outboundService ? { outboundService } : {}),
  });
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .slice(0, migrationLimit))
    for (const sql of (await readFile(`drizzle/${file}`, "utf8")).split(
      "--> statement-breakpoint",
    ))
      if (sql.trim()) await db.prepare(sql).run();
  return mf;
}
