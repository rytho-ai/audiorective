import { defineConfig } from "tsdown";
export default defineConfig({ entry: ["src/index.ts", "src/midi.ts"], format: "esm", dts: true });
