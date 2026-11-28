import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/StepSequencer.ts" },
  format: "esm",
  dts: true,
});
