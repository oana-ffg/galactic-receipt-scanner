import { defineConfig } from "vite";

export default defineConfig({
  // Keep the existing classic worker; instantiate PDF WASM only for derivatives.
  worker: { rollupOptions: { output: { inlineDynamicImports: true } } },
});
