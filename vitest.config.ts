import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["web/**/*.test.ts", "worker/**/*.test.ts"],
    testTimeout: 30000,
  },
});
