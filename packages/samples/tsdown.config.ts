import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/SampleLibrary.ts" },
  format: "esm",
  dts: true,
});
