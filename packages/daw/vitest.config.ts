import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const entry = (name: string) => fileURLToPath(new URL(`./src/${name}.ts`, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "@audiorective/daw/project": entry("project"),
            "@audiorective/daw/dawproject": entry("dawproject"),
            "@audiorective/daw/runtime": entry("runtime-entry"),
          },
        },
        test: { name: "node", environment: "node", include: ["tests/**/*.test.ts"], exclude: ["tests/**/*.browser.test.ts"] },
      },
      {
        test: {
          name: "browser",
          include: ["tests/**/*.browser.test.ts"],
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
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
