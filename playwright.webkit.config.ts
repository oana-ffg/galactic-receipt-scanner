import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

export default defineConfig({
  ...config,
  testMatch: [
    "**/audio.spec.ts",
    "**/quality.spec.ts",
    "**/generated.spec.ts",
    "**/layout.spec.ts",
    "**/transcription.spec.ts",
  ],
  use: {
    ...config.use,
    browserName: "webkit",
    channel: "",
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://127.0.0.1:8766",
          localStorage: [{ name: "scanner-audio", value: "off" }],
        },
      ],
    },
  },
});
