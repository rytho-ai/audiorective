import { Clock } from "@audiorective/clock";
import { expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";

test("a launch waiting for clock.start() with no time begins exactly on beat 0", async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const clock = new Clock({ context });
  const started: number[] = [];
  const launcher = new ClipLauncher({ a: [{ buffer: context.createBuffer(1, 96000, 48000), loop: true }] }, { context, quantize: "1m" });
  launcher.addEventListener("started", (event) => void started.push((event as unknown as { when: number }).when));
  clock.attach(launcher);
  launcher.launchScene(0);
  clock.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(started).toHaveLength(1);
  expect(Math.abs(started[0] - clock.timeline.beatToTime(0))).toBeLessThan(0.0005);
  clock.dispose();
  launcher.dispose();
  await context.close();
});
