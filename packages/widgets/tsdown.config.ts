import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/piano-roll.ts", "src/waveform.ts", "src/player.ts", "src/arrangement.ts"],
  format: "esm",
  dts: true,
});
