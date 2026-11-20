import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/PadBank.ts" },
  format: "esm",
  dts: true,
});
