import { defineConfig } from "tsdown";
export default defineConfig({
  entry: { index: "src/WavePlayer.ts" },
  format: "esm",
  dts: true,
});
