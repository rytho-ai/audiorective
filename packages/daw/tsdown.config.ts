import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    project: "src/project.ts",
    selection: "src/selection.ts",
    dawproject: "src/dawproject.ts",
    runtime: "src/runtime-entry.ts",
  },
  format: "esm",
  dts: true,
});
