import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["web/**/*.test.ts", "worker/**/*.test.ts"],
    globalSetup: ["scripts/vitest-global-setup.mjs"],
    testTimeout: 30000,
  },
});
