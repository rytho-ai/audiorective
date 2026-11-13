import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/peaks.ts"],
  format: "esm",
  dts: true,
});
