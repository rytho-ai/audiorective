import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/AudioRecorder.ts" },
  format: "esm",
  dts: true,
});
