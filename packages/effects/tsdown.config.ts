import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/time-stretch.ts", "src/rack.ts", "src/rack-preset.ts"],
  format: "esm",
  dts: true,
});
