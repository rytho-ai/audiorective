import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
export default defineConfig({
  test: {
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"], executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
      }),
      instances: [{ browser: "chromium" }],
    },
  },
});
