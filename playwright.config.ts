import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:8766",
    channel: "chrome",
    viewport: { width: 1360, height: 900 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/test-server.mjs",
    url: "http://127.0.0.1:8766/api/me",
    reuseExistingServer: false,
    timeout: 90000,
  },
});
