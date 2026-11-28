import { Clock } from "@audiorective/clock";
import { expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";

const QUANTUM = 128 / 48000;

/**
 * Starts a clock with no time while a scene launch waits, and reports what the launcher scheduled.
 * `blockMs` freezes the main thread between `clock.start()` and the first window fill (a microtask),
 * so the audio clock passes beat 0 first, like a slow CI runner.
 */
async function startNow(blockMs: number) {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.resume();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const clock = new Clock({ context });
  const started: number[] = [];
  const scheduled: { when: number; audioNow: number }[] = [];
  const launcher = new ClipLauncher(
    { a: [{ buffer: context.createBuffer(1, 96000, 48000), loop: true }] },
    {
      context,
      quantize: "1m",
      // called synchronously where the launcher commits the launch, so currentTime here is the time it decided against
      onSchedule: ({ when }) => void scheduled.push({ when, audioNow: context.currentTime }),
    },
  );
  launcher.addEventListener("started", (event) => void started.push((event as unknown as { when: number }).when));
  clock.attach(launcher);
  launcher.launchScene(0);
  clock.start();
  const beat0 = clock.timeline.beatToTime(0);
  if (blockMs > 0) for (const end = performance.now() + blockMs; performance.now() < end; );
  await new Promise((resolve) => setTimeout(resolve, 200));
  clock.dispose();
  launcher.dispose();
  await context.close();
  return { started, scheduled, beat0 };
}

// Launcher rule (commitPending): when = max(beat time, context.currentTime at commit); a beat already past starts now, never in the past.
function expectContract({ started, scheduled, beat0 }: Awaited<ReturnType<typeof startNow>>) {
  expect(started).toHaveLength(1);
  expect(scheduled).toHaveLength(1);
  const { audioNow } = scheduled[0];
  if (beat0 > audioNow) {
    // beat 0 was still ahead when the launch was scheduled: it begins exactly on it
    expect(Math.abs(started[0] - beat0)).toBeLessThan(0.0005);
    return "on-time";
  }
  // beat 0 had already passed (slow machine): starts at the audio time of scheduling, within one render quantum
  expect(started[0]).toBeGreaterThanOrEqual(beat0);
  expect(Math.abs(started[0] - audioNow)).toBeLessThanOrEqual(QUANTUM);
  return "late";
}

test("a launch waiting for clock.start() with no time begins exactly on beat 0", async () => {
  expectContract(await startNow(0));
});

test("a launch waiting for clock.start() starts now when beat 0 has already passed", async () => {
  const result = await startNow(40);
  expect(expectContract(result)).toBe("late");
  expect(result.started[0] - result.beat0).toBeGreaterThan(0.02);
});
