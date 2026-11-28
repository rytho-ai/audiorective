import { defineConfig } from "vitest/config";
import { playwright, defineBrowserCommand } from "@vitest/browser-playwright";
import { readFile } from "node:fs/promises";

export default defineConfig({
  // The Emscripten bundle builds its worklet module from its own script location; pre-bundling breaks that.
  optimizeDeps: { exclude: ["signalsmith-stretch"] },
  test: {
    // Audio tests assert against the AudioContext wall-clock; running test files in
    // parallel browser contexts starves those timers and makes them flaky. Serialize.
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          args: ["--autoplay-policy=no-user-gesture-required"],
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        },
      }),
      commands: {
        timeStretchWasmBytes: defineBrowserCommand(async () => {
          const path = process.env.AUDIORECTIVE_RUBBERBAND_WASM;
          return path ? Array.from(await readFile(path)) : null;
        }),
      },
      instances: [{ browser: "chromium" }],
    },
  },
});
