import { afterEach, expect, test, vi } from "vitest";
import { Clock } from "@audiorective/clock";
import { WavePlayer } from "../src/WavePlayer";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function rig(bpm: number) {
  const context = new AudioContext();
  const clock = new Clock({ audioContext: context, bpm });
  const player = new WavePlayer(context);
  disposers.push(
    () => player.dispose(),
    () => clock.dispose(),
    () => context.close(),
  );
  await context.resume();
  await player.load(context.createBuffer(1, context.sampleRate * 4, context.sampleRate));
  return { context, clock, player };
}
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test("play({ quantize: '1m' }) starts on the next bar line of the attached clock and publishes startsAt until then", async () => {
  const { context, clock, player } = await rig(240); // a 4/4 bar is exactly one second
  clock.attach(player);
  clock.start();
  await wait(120);
  const started = player.play({ quantize: "1m" });
  await vi.waitFor(() => expect(player.cells.startsAt.value).not.toBeNull());
  const startsAt = player.cells.startsAt.value!;
  expect(startsAt).toBeGreaterThan(context.currentTime);
  expect(player.cells.isPlaying.value).toBe(true);
  const time = await started;

  expect(time).toBe(startsAt);
  const beat = clock.timeline.timeToBeat(time!);
  expect(Math.abs(Math.round(beat / 4) * 4 - beat)).toBeLessThan(1e-6);
  expect(beat).toBeGreaterThan(0);
  await vi.waitFor(() => expect(player.cells.startsAt.value).toBeNull());
  expect(context.currentTime).toBeGreaterThanOrEqual(time!);
});

test("a call exactly on a boundary starts there, not on the next one", async () => {
  const { context, player } = await rig(240);
  // A frozen time source puts "now" exactly on beat 8 (two bars in).
  const frozen = new Clock({ context: { currentTime: 2 }, bpm: 240 });
  disposers.push(() => frozen.dispose());
  frozen.attach(player);
  frozen.start(2, 8);
  const spy = vi.spyOn(context, "currentTime", "get").mockReturnValue(2);
  const time = await player.play({ quantize: "1m" });
  spy.mockRestore();
  expect(time).toBeCloseTo(2, 6);
});

test("quantize needs an attached, playing clock; `when` and quantize are exclusive; unattached play still plays now", async () => {
  const { clock, player } = await rig(240);
  await expect(player.play({ quantize: "1m" })).rejects.toMatchObject({
    name: "InvalidStateError",
    message: "WavePlayer quantize needs clock.attach(player).",
  });
  const detach = clock.attach(player);
  await expect(player.play({ quantize: "1m" })).rejects.toMatchObject({
    name: "InvalidStateError",
    message: "WavePlayer quantize needs a playing clock.",
  });
  clock.start();
  await expect(player.play({ quantize: "1m", when: 1 })).rejects.toThrow("WavePlayer play() takes `when` or `quantize`, not both.");
  await expect(player.play({ quantize: "xm" as "1m" })).rejects.toThrow('WavePlayer requires a note value such as "4n" or "1m"');
  expect(player.cells.isPlaying.value).toBe(false);
  detach();
  expect(await player.play()).not.toBeNull();
  expect(player.cells.isPlaying.value).toBe(true);
  expect(player.cells.startsAt.value).toBeNull();
});

test("stop() and leaving the transport cancel a queued quantized start", async () => {
  const { clock, player } = await rig(30); // a bar is eight seconds, so the boundary is far away
  clock.attach(player);
  clock.start();
  await wait(100);
  const first = player.play({ quantize: "1m" });
  await vi.waitFor(() => expect(player.cells.startsAt.value).not.toBeNull());
  player.stop();
  await first;
  expect(player.cells.startsAt.value).toBeNull();
  expect(player.cells.isPlaying.value).toBe(false);

  const second = player.play({ quantize: "1m" });
  await vi.waitFor(() => expect(player.cells.startsAt.value).not.toBeNull());
  clock.pause();
  await second;
  expect(player.cells.startsAt.value).toBeNull();
  expect(player.cells.isPlaying.value).toBe(false);
});
