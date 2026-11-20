import { afterEach, expect, test } from "vitest";
import { PadBank } from "../src/PadBank";

const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture() {
  const context = new AudioContext();
  await context.resume();
  const buffer = (seconds: number, level: number) => {
    const result = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate);
    result.getChannelData(0).fill(level);
    return result;
  };
  const bank = new PadBank(context, [
    { id: "open", sound: buffer(1, 0.3), group: "hat" },
    { id: "closed", sound: buffer(0.1, 0.1), group: "hat" },
  ]);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  bank.output.connect(analyser);
  analyser.connect(context.destination);
  disposers.push(
    () => context.close(),
    () => analyser.disconnect(),
    () => bank.dispose(),
  );
  const level = () => {
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  };
  return { context, bank, buffer, level };
}

test("cancelling a future closed hit retracts its choke and preserves an open hit", async () => {
  const { context, bank, level } = await fixture();
  const open = bank.trigger("open")!;
  let ended = 0;
  open.playing.subscribe((playing) => playing || ended++);
  const future = bank.trigger("closed", { when: context.currentTime + 0.18 })!;
  future.stop();
  await delay(260);
  expect(level()).toBeCloseTo(0.3, 2);
  expect(bank.cells.activeVoices.value).toBe(1);
  expect(ended).toBe(0);
  open.stop();
  await expect.poll(level).toBeLessThan(0.001);
  expect(ended).toBe(1);
});

test("a committed future choke cuts audio at its deadline even when scheduled out of order", async () => {
  const { context, bank, level } = await fixture();
  const deadline = context.currentTime + 0.22;
  bank.trigger("closed", { when: deadline });
  bank.trigger("open");
  await delay(70);
  expect(level()).toBeCloseTo(0.3, 2);
  await delay(260);
  // The analyser window can still contain samples from the short closed hit.
  await expect.poll(level).toBeLessThan(0.001);
  expect(bank.cells.activeVoices.value).toBe(0);
  bank.trigger("open");
  await expect.poll(level).toBeGreaterThan(0.25);
});

test("assign cancels only its pad's events and their future choke; handles end once", async () => {
  const { context, bank, buffer, level } = await fixture();
  const manual = bank.trigger("open")!;
  const second = bank.trigger("open", { when: context.currentTime + 0.5 })!;
  let secondEnds = 0;
  second.playing.subscribe((playing) => playing || secondEnds++);
  second.stop();
  second.stop();
  expect(secondEnds).toBe(1);
  bank.trigger("closed", { when: context.currentTime + 0.14 });
  bank.assign("closed", buffer(0.1, 0.05));
  await delay(220);
  expect(level()).toBeCloseTo(0.3, 2);
  expect(bank.cells.activeVoices.value).toBe(1);
  manual.stop();
  expect(bank.cells.activeVoices.value).toBe(0);
});

test("invalid inputs preserve state and dispose ends future events", async () => {
  const { context, bank } = await fixture();
  expect(
    () =>
      new PadBank(context, [
        { id: "same", sound: context.createBuffer(1, 10, context.sampleRate) },
        { id: "same", sound: context.createBuffer(1, 10, context.sampleRate) },
      ]),
  ).toThrow("Pad Bank pad IDs must be nonempty and unique.");
  expect(() => bank.trigger("open", { when: NaN })).toThrow("Sound hit needs a finite time in seconds.");
  expect(() => bank.trigger("open", { velocity: Infinity })).toThrow("Sound hit needs a velocity from 0 to 1.");
  expect(() => bank.assign("missing", context.createBuffer(1, 10, context.sampleRate))).toThrow("Unknown pad.");
  const future = bank.trigger("closed", { when: context.currentTime + 1 })!;
  let ended = 0;
  future.playing.subscribe((playing) => playing || ended++);
  bank.dispose();
  expect(ended).toBe(1);
  expect(bank.cells.activeVoices.value).toBe(0);
  expect(() => bank.trigger("open")).toThrow("PadBank is disposed.");
});

test("offline output follows native choke timing even without cleanup timer ticks", async () => {
  async function render(cancelFuture: boolean) {
    const rate = 48_000;
    const context = new OfflineAudioContext(1, rate / 2, rate);
    const sample = (seconds: number, level: number) => {
      const value = context.createBuffer(1, rate * seconds, rate);
      value.getChannelData(0).fill(level);
      return value;
    };
    const bank = new PadBank(context, [
      { id: "open", sound: sample(0.4, 0.3), group: "hat" },
      { id: "closed", sound: sample(0.05, 0.1), group: "hat" },
    ]);
    bank.output.connect(context.destination);
    bank.trigger("open", { when: 0 });
    const future = bank.trigger("closed", { when: 0.2 })!;
    if (cancelFuture) future.stop();
    const output = await context.startRendering();
    bank.dispose();
    return output.getChannelData(0);
  }
  const cancelled = await render(true);
  const committed = await render(false);
  const afterDeadline = (data: Float32Array) => data.slice(14_400, 16_800).reduce((sum, value) => sum + Math.abs(value), 0) / 2_400;
  expect(afterDeadline(cancelled)).toBeCloseTo(0.3, 5);
  expect(afterDeadline(committed)).toBeLessThan(0.001);
});

test("pitch reaches a factory as semitones in hit.pitch and defaults to 0", async () => {
  const context = new AudioContext();
  const pitches: number[] = [];
  const bank = new PadBank(context, [{ id: "tone", sound: (ctx, hit) => (pitches.push(hit.pitch), new ConstantSourceNode(ctx)) }]);
  const at = context.currentTime + 0.5;
  bank.trigger("tone", { when: at });
  bank.trigger("tone", { when: at, pitch: 12 });
  bank.trigger("tone", { when: at, pitch: -12 });
  expect(pitches).toEqual([0, 12, -12]);
  expect(() => bank.trigger("tone", { when: at, pitch: NaN })).toThrow("Sound hit needs finite semitones for pitch.");
  bank.dispose();
  await context.close();
});

test("stop(when) schedules the release, and stopping a future hit drops it", async () => {
  const { context, bank, level } = await fixture();
  const open = bank.trigger("open")!;
  open.stop(context.currentTime + 0.1);
  await delay(50);
  expect(level()).toBeCloseTo(0.3, 2);
  expect(open.playing.value).toBe(true);
  await expect.poll(level, { timeout: 1500 }).toBeLessThan(0.001);
  await expect.poll(() => bank.cells.activeVoices.value).toBe(0);
  expect(open.playing.value).toBe(false);
  const future = bank.trigger("closed", { when: context.currentTime + 0.3 })!;
  future.stop(context.currentTime + 0.1);
  expect(future.playing.value).toBe(false);
  expect(bank.cells.activeVoices.value).toBe(0);
});

test("the signal option disposes the bank, and an unknown pad returns null", async () => {
  const context = new AudioContext();
  const controller = new AbortController();
  const bank = new PadBank(context, [{ id: "kick", sound: context.createBuffer(1, 100, context.sampleRate) }], { signal: controller.signal });
  expect(bank.trigger("nope")).toBeNull();
  const hit = bank.trigger("kick", { when: context.currentTime + 1 })!;
  controller.abort();
  expect(hit.playing.value).toBe(false);
  expect(() => bank.trigger("kick")).toThrow("PadBank is disposed.");
  await context.close();
});
