import { execFileSync } from "node:child_process";

// Worker tests run the built bundle through Miniflare (scripts/test-runtime.mjs).
// Build the current source first so a stale dist/ can never pass or fail in its place.
export default function setup() {
  for (const script of ["scripts/assets.mjs", "scripts/build.mjs"]) {
    execFileSync(process.execPath, [script], { stdio: "inherit" });
  }
}
