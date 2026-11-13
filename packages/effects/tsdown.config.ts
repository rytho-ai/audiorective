import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/time-stretch.ts"],
  format: "esm",
  dts: true,
});
