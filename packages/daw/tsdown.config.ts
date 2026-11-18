import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", project: "src/project.ts", dawproject: "src/dawproject.ts", runtime: "src/runtime.ts" },
  format: "esm",
  dts: true,
});
