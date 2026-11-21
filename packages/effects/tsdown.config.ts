import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/time-stretch.ts", "src/equalizer-bands.ts"],
  format: "esm",
  dts: true,
  // Optional peer, loaded lazily by the stretch pitch engine; never bundled.
  external: ["signalsmith-stretch"],
});
