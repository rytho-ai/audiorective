import { defineConfig } from "tsdown";

export default defineConfig({ entry: ["src/webclap.ts"], format: "esm", dts: true });
