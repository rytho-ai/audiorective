import { defineConfig } from "vitest/config";
import { playwright, defineBrowserCommand } from "@vitest/browser-playwright";

export default defineConfig({
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
          // Optional explicit executable for environments with preinstalled browsers.
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        },
      }),
      commands: {
        waveformPointer: defineBrowserCommand(
          async (
            { page, frame },
            input: {
              action: "down" | "move" | "up";
              x?: number;
              y?: number;
              alt?: boolean;
            },
          ) => {
            if (input.alt) await page.keyboard.down("Alt");
            else await page.keyboard.up("Alt");
            if (input.x !== undefined && input.y !== undefined) {
              const testFrame = await frame();
              const element = await testFrame.frameElement();
              const bounds = await element.boundingBox();
              const frameSize = await testFrame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
              // Vitest may scale its preview iframe to fit the runner viewport.
              const scaleX = bounds ? bounds.width / frameSize.width : 1;
              const scaleY = bounds ? bounds.height / frameSize.height : 1;
              await page.mouse.move((bounds?.x ?? 0) + input.x * scaleX, (bounds?.y ?? 0) + input.y * scaleY);
            }
            if (input.action === "down") await page.mouse.down();
            if (input.action === "up") await page.mouse.up();
          },
        ),
      },
      instances: [{ browser: "chromium" }],
    },
  },
});
