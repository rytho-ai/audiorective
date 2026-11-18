import { defineConfig } from "tsdown";
export default defineConfig({ entry: ["src/index.ts", "src/effect-rack.ts"], format: "esm", dts: true });
