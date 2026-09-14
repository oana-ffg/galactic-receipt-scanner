import { build } from "esbuild";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
// Remove only generated output so obsolete LAN assets cannot enter a Site archive.
await rm("dist", { recursive: true, force: true });
for (const args of [
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.worker.json"],
  ["node_modules/vite/bin/vite.js", "build", "--outDir", "dist/client"],
]) {
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
await mkdir("dist/server", { recursive: true });
await build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "dist/server/index.js",
  external: ["cloudflare:workers"],
});
await mkdir("dist/.openai", { recursive: true });
const manifest = JSON.parse(await readFile(".openai/hosting.json", "utf8"));
await writeFile("dist/.openai/hosting.json", JSON.stringify(manifest, null, 2));
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
