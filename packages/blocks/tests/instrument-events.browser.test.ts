import { afterEach, expect, test } from "vitest";
import { InstrumentEvents } from "../src/InstrumentEvents";

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
  const bank = new InstrumentEvents(context, [
    { id: "open", buffer: buffer(1, 0.3), group: "hat", gate: true },
    { id: "closed", buffer: buffer(0.1, 0.1), group: "hat" },
  ]);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  bank.output.connect(analyser);
  analyser.connect(context.destination);
  disposers.push(
    () => context.close(),
    () => analyser.disconnect(),
    () => bank.destroy(),
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
  open.onEnded(() => ended++);
  const future = bank.trigger("closed", 1, context.currentTime + 0.18)!;
  future.cancel();
  await delay(260);
  expect(level()).toBeCloseTo(0.3, 2);
  expect(bank.cells.activeEvents.value).toBe(1);
  expect(ended).toBe(0);
  open.cancel();
  await expect.poll(level).toBeLessThan(0.001);
  expect(ended).toBe(1);
});

test("a committed future choke cuts audio at its deadline even when scheduled out of order", async () => {
  const { context, bank, level } = await fixture();
  const deadline = context.currentTime + 0.22;
  bank.trigger("closed", 1, deadline);
  bank.trigger("open");
  await delay(70);
  expect(level()).toBeCloseTo(0.3, 2);
  await delay(260);
  // The analyser window can still contain samples from the short closed hit.
  await expect.poll(level).toBeLessThan(0.001);
  expect(bank.cells.activeEvents.value).toBe(0);
  bank.trigger("open");
  await expect.poll(level).toBeGreaterThan(0.25);
});

test("assign cancels only its pad's events and their future choke; handles end once", async () => {
  const { context, bank, buffer, level } = await fixture();
  const manual = bank.trigger("open")!;
  const second = bank.trigger("open")!;
  let secondEnds = 0;
  second.onEnded(() => secondEnds++);
  second.cancel();
  second.cancel();
  expect(secondEnds).toBe(1);
  bank.trigger("closed", 1, context.currentTime + 0.14);
  bank.assign("closed", buffer(0.1, 0.05));
  await delay(220);
  expect(level()).toBeCloseTo(0.3, 2);
  expect(bank.cells.activeEvents.value).toBe(1);
  manual.cancel();
  expect(bank.cells.activeEvents.value).toBe(0);
});

test("invalid inputs preserve state and destroy ends future events", async () => {
  const { context, bank } = await fixture();
  expect(
    () =>
      new InstrumentEvents(context, [
        { id: "same", buffer: context.createBuffer(1, 10, context.sampleRate) },
        { id: "same", buffer: context.createBuffer(1, 10, context.sampleRate) },
      ]),
  ).toThrow("Instrument pad IDs must be nonempty and unique.");
  expect(() => bank.trigger("open", 1, NaN)).toThrow("Instrument event time must be finite, non-negative seconds.");
  expect(() => bank.trigger("open", Infinity)).toThrow("Instrument velocity must be finite.");
  expect(() => bank.assign("missing", context.createBuffer(1, 10, context.sampleRate))).toThrow("Unknown instrument pad.");
  const future = bank.trigger("closed", 1, context.currentTime + 1)!;
  let ended = 0;
  future.onEnded(() => ended++);
  bank.destroy();
  expect(ended).toBe(1);
  expect(bank.cells.activeEvents.value).toBe(0);
  expect(() => bank.trigger("open")).toThrow("InstrumentEvents is destroyed.");
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
    const bank = new InstrumentEvents(context, [
      { id: "open", buffer: sample(0.1, 0.3), group: "hat", gate: true },
      { id: "closed", buffer: sample(0.05, 0.1), group: "hat" },
    ]);
    bank.output.connect(context.destination);
    bank.trigger("open", 1, 0);
    const future = bank.trigger("closed", 1, 0.2)!;
    if (cancelFuture) future.cancel();
    const output = await context.startRendering();
    bank.destroy();
    return output.getChannelData(0);
  }
  const cancelled = await render(true);
  const committed = await render(false);
  const afterDeadline = (data: Float32Array) => data.slice(14_400, 16_800).reduce((sum, value) => sum + Math.abs(value), 0) / 2_400;
  expect(afterDeadline(cancelled)).toBeCloseTo(0.3, 5);
  expect(afterDeadline(committed)).toBeLessThan(0.001);
});
