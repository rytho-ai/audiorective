import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/ClipLauncher.ts" },
  format: "esm",
  dts: true,
});
