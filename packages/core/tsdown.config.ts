import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/peaks.ts", "src/automation.ts"],
  format: "esm",
  dts: true,
});
