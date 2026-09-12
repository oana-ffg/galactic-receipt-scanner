import { Miniflare } from "miniflare";
import { readdir, readFile } from "node:fs/promises";
export const origin = "http://127.0.0.1:8766";
export const ownerHeaders = {
  "oai-authenticated-user-id": "synthetic-owner",
  "oai-authenticated-user-email": "owner@example.test",
};
export async function runtime({
  retiredCaptureIds,
  migrationLimit,
  appOrigin = origin,
} = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/server/index.js",
    compatibilityDate: "2026-08-01",
    bindings: {
      OWNER_EMAIL: "owner@example.test",
      APP_ORIGIN: appOrigin,
      ...(retiredCaptureIds ? { RETIRED_CAPTURE_IDS: retiredCaptureIds } : {}),
    },
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
    assets: {
      directory: "dist/client",
      binding: "ASSETS",
      routerConfig: {
        invoke_user_worker_ahead_of_assets: true,
        has_user_worker: true,
      },
    },
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
