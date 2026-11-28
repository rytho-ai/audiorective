import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    project: "src/project.ts",
    selection: "src/selection.ts",
    dawproject: "src/dawproject.ts",
    runtime: "src/runtime-entry.ts",
    mcp: "src/mcp.ts",
  },
  format: "esm",
  dts: true,
});
