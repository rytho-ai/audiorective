import { afterEach, expect, test, vi } from "vitest";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import { WavePlayer } from "../src/WavePlayer";

const disposers: Array<() => void | Promise<unknown>> = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture(fftSize = 2048) {
  const context = new AudioContext();
  const player = new WavePlayer(context);
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  analyser.connect(context.destination);
  disposers.push(
    () => context.close(),
    () => player.dispose(),
    () => analyser.disconnect(),
  );
  await context.resume();
  return { context, player, analyser };
}
/** 220 Hz for two seconds, then 440 Hz, then 880 Hz. */
function bands(context: AudioContext, seconds = 6) {
  const buffer = context.createBuffer(1, context.sampleRate * seconds, context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) {
    const t = i / context.sampleRate;
    channel[i] = 0.25 * Math.sin(2 * Math.PI * (t < 2 ? 220 : t < 4 ? 440 : 880) * t);
  }
  return buffer;
}
function peak(analyser: AnalyserNode) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  return data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
}
function frequency(analyser: AnalyserNode, context: AudioContext) {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);
  let max = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i] > bins[max]) max = i;
  return (max * context.sampleRate) / analyser.fftSize;
}
const until = (context: AudioContext, time: number) => expect.poll(() => context.currentTime, { timeout: 5000, interval: 5 }).toBeGreaterThan(time);

test("a source onset and a gain automation started from one shared `when` line up in rendered sound", async () => {
  const { context, player, analyser } = await fixture(32768);
  const rate = context.sampleRate;
  const SOURCE = 0.8,
    BEFORE = 0.5,
    STEP = 0.02;
  // DC at the context rate: no resampling, so every rendered sample is exactly source level times gain.
  const buffer = context.createBuffer(1, rate * 2, rate);
  buffer.getChannelData(0).fill(SOURCE);
  await player.load(buffer);
  // Gain rests at BEFORE; the automation holds 1 from `when`, then steps to 0.25 after STEP seconds.
  // A source that sounds before the automation renders SOURCE * BEFORE; an automation that leads or lags
  // the source changes the length of the first run.
  const envelope = new GainNode(context, { gain: BEFORE });
  player.output.connect(envelope);
  envelope.connect(analyser);
  const curve = new AutomationCurve([
    { time: 0, value: 1, shape: "hold" },
    { time: STEP, value: 0.25, shape: "hold" },
  ]);
  const binding = new AutomationBinding(context, curve, audioParamTarget(envelope.gain));
  const detach = player.attachSourceAutomation(binding);
  disposers.push(
    () => detach(),
    () => binding.dispose(),
    () => envelope.disconnect(),
  );

  // Deliberately between two frames: callers pass arbitrary times, not frame boundaries.
  const when = context.currentTime + 0.25 + 0.37 / rate;
  const started = await player.play({ when });
  expect(started).toBe(when);

  await until(context, when - 0.12);
  expect(context.currentTime).toBeLessThan(when);
  expect(peak(analyser)).toBe(0);

  await until(context, when + 0.2);
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  const captured = context.currentTime;

  const onset = data.findIndex((v) => v !== 0);
  expect(onset).toBeGreaterThan(0);
  // Silence before the onset, and no sample at the pre-automation level anywhere.
  const levels = new Set(Array.from(data, (v) => Math.round(v * 1000) / 1000));
  expect([...levels].sort()).toEqual([0, 0.2, 0.8]);
  const step = data.findIndex((v, i) => i > onset && Math.abs(v - SOURCE * 0.25) < 1e-4);
  // Relative alignment: the first automation value starts on the onset sample and lasts STEP seconds, within one frame.
  expect(Math.abs(data[onset] - SOURCE)).toBeLessThan(1e-4);
  expect(Math.abs(step - onset - STEP * rate)).toBeLessThanOrEqual(1);
  // Absolute onset: the snapshot ends near `captured`; the analyser lags the clock by a few render quanta.
  const onsetTime = captured - (data.length - onset) / rate;
  expect(Math.abs(onsetTime - when)).toBeLessThan(0.02);
});

test("source automation maps a stretched output selection and follows a queued selection edit", async () => {
  const context = new AudioContext();
  const stretch = {
    async process(input: { sampleRate: number; channels: Float32Array[] }, { ratio }: { ratio: number }) {
      return { sampleRate: input.sampleRate, channels: input.channels.map((channel) => new Float32Array(Math.round(channel.length * ratio))) };
    },
  };
  const player = new WavePlayer(context, { stretch });
  const program = vi.fn();
  const hold = vi.fn();
  const binding = new AutomationBinding(
    context,
    new AutomationCurve([
      { time: 0, value: 0, shape: "linear" },
      { time: 2, value: 1, shape: "hold" },
    ]),
    { program, hold },
  );
  const detach = player.attachSourceAutomation(binding);
  disposers.push(
    () => context.close(),
    () => player.dispose(),
    () => binding.dispose(),
    () => detach(),
  );
  await context.resume();
  await player.load(bands(context, 2));
  await player.setStretch(2);
  player.setSelection({ start: 0.5, end: 1.5 });
  const when = context.currentTime + 0.3;
  expect(await player.play({ when })).toBe(when);
  expect(program).toHaveBeenCalled();
  expect(program.mock.calls.at(-1)![1]).toBe(when);
  expect(program.mock.calls.at(-1)![0].at(-1).time).toBeCloseTo(1, 5); // (0.75 - 0.25) source seconds at 2x
  player.setSelection({ start: 1, end: 2 });
  expect(player.position).toBe(1);
  expect(program.mock.calls.at(-1)![1]).toBe(when);
  expect(program.mock.calls.at(-1)![0][0].value).toBeCloseTo(0.25, 5); // source second 0.5 on a 0..2 ramp
  expect(hold).toHaveBeenCalled();
  const previousHolds = hold.mock.calls.length;
  const beforeDetach = context.currentTime;
  detach();
  expect(hold).toHaveBeenCalledTimes(previousHolds + 1);
  expect(hold.mock.calls.at(-1)![0]).toBeGreaterThanOrEqual(beforeDetach);
  expect(hold.mock.calls.at(-1)![0]).toBeLessThanOrEqual(context.currentTime);
  expect(player.isPlaying).toBe(true); // detaching automation leaves borrowed playback alive
});

test("a selection edit invalidates a play still awaiting resume when source automation is attached", async () => {
  const { context, player } = await fixture();
  await player.load(bands(context));
  const program = vi.fn();
  const binding = new AutomationBinding(context, new AutomationCurve([{ time: 0, value: 1, shape: "hold" }]), {
    program,
    hold: vi.fn(),
  });
  const detach = player.attachSourceAutomation(binding);
  disposers.push(
    () => binding.dispose(),
    () => detach(),
  );
  let release!: () => void;
  vi.spyOn(context, "resume").mockReturnValue(new Promise<void>((done) => (release = done)));
  const pendingSelection = player.play({ when: context.currentTime + 0.2 });
  player.setSelection({ start: 1, end: 2 });
  release();
  expect(await pendingSelection).toBeNull();
  expect(player.isPlaying).toBe(false);
  expect(program).not.toHaveBeenCalled();
});

test("starting an unfinished stretch invalidates pending and queued source automation", async () => {
  const context = new AudioContext();
  let resolveRender!: (value: { sampleRate: number; channels: Float32Array[] }) => void;
  const player = new WavePlayer(context, {
    stretch: {
      process() {
        return new Promise((resolve) => (resolveRender = resolve));
      },
    },
  });
  const program = vi.fn();
  const hold = vi.fn();
  const binding = new AutomationBinding(context, new AutomationCurve([{ time: 0, value: 1, shape: "hold" }]), { program, hold });
  const detach = player.attachSourceAutomation(binding);
  disposers.push(
    () => context.close(),
    () => player.dispose(),
    () => binding.dispose(),
    () => detach(),
  );
  await context.resume();
  await player.load(bands(context, 1));
  let release!: () => void;
  vi.spyOn(context, "resume").mockReturnValue(new Promise<void>((done) => (release = done)));
  const pendingStretch = player.play({ when: context.currentTime + 0.2 });
  const stretching = player.setStretch(1.5);
  expect(player.getState().processing).toBe(true);
  release();
  expect(await pendingStretch).toBeNull();
  expect(program).not.toHaveBeenCalled();
  resolveRender({ sampleRate: context.sampleRate, channels: [new Float32Array(Math.round(context.sampleRate * 1.5))] });
  await stretching;

  vi.restoreAllMocks();
  const when = context.currentTime + 0.3;
  expect(await player.play({ when })).toBe(when);
  expect(program).toHaveBeenCalledTimes(1);
  const secondStretch = player.setStretch(1.5);
  expect(player.isPlaying).toBe(false); // queued start is withdrawn before the render commits
  expect(hold).toHaveBeenCalled();
  resolveRender({ sampleRate: context.sampleRate, channels: [new Float32Array(Math.round(context.sampleRate * 1.5))] });
  await secondStretch;
});

test("source automation rejects another audio clock and looping, and manual detach stops binding before target writes", async () => {
  const { context, player } = await fixture();
  const other = new AudioContext();
  disposers.push(() => other.close());
  await player.load(bands(context));
  const gain = new GainNode(context);
  const curve = new AutomationCurve([{ time: 0, value: 1, shape: "hold" }]);
  const wrong = new AutomationBinding(other, curve, audioParamTarget(gain.gain));
  const binding = new AutomationBinding(context, curve, audioParamTarget(gain.gain));
  disposers.push(
    () => wrong.dispose(),
    () => binding.dispose(),
    () => gain.disconnect(),
  );
  expect(() => player.attachSourceAutomation(wrong)).toThrow("Source automation must use the player's AudioContext.");
  const detach = player.attachSourceAutomation(binding);
  expect(() => player.setLooping(true)).toThrow("Source automation requires non-looping playback.");
  expect(await player.play({ when: context.currentTime + 0.2 })).not.toBeNull();
  detach();
  gain.gain.value = 0.4;
  expect(gain.gain.value).toBeCloseTo(0.4, 2);
  expect(player.isPlaying).toBe(true);
  player.dispose();
  expect(() => binding.start()).not.toThrow(); // player borrowed the binding; it did not dispose it
});

test("a reentrant automation target can pause without the old play starting sound", async () => {
  const { context, player, analyser } = await fixture();
  player.output.connect(analyser);
  await player.load(bands(context));
  const program = vi.fn(() => player.pause());
  const binding = new AutomationBinding(context, new AutomationCurve([{ time: 0, value: 1, shape: "hold" }]), {
    program,
    hold: vi.fn(),
  });
  const detach = player.attachSourceAutomation(binding);
  disposers.push(
    () => binding.dispose(),
    () => detach(),
  );
  expect(await player.play({ when: context.currentTime + 0.2 })).toBeNull();
  expect(player.isPlaying).toBe(false);
  expect(program).toHaveBeenCalledTimes(1);
  await delay(280);
  expect(peak(analyser)).toBeLessThan(0.001);
});

test("a failing automation hold does not prevent player cleanup", async () => {
  const { context, player } = await fixture();
  await player.load(bands(context));
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const binding = new AutomationBinding(context, new AutomationCurve([{ time: 0, value: 1, shape: "hold" }]), {
    program() {},
    hold() {
      throw new Error("target gone");
    },
  });
  const detach = player.attachSourceAutomation(binding);
  disposers.push(
    () => binding.dispose(),
    () => detach(),
  );
  expect(await player.play({ when: context.currentTime + 0.2 })).not.toBeNull();
  expect(() => player.dispose()).not.toThrow();
  expect(player.isPlaying).toBe(false);
  expect(errorLog).toHaveBeenCalledWith("WavePlayer source automation stop failed:", expect.any(Error));
});

test("a queued start counts as playing, holds position until `when`, then follows the clock", async () => {
  const { context, player, analyser } = await fixture();
  player.output.connect(analyser);
  await player.load(bands(context));
  player.seek(1);
  const when = context.currentTime + 0.4;
  expect(await player.play({ when })).toBe(when);
  expect(player.cells.isPlaying.value).toBe(true);
  expect(player.isPlaying).toBe(true);
  expect(player.getState()).toMatchObject({ isPlaying: true, position: 1 });
  // A second request while queued starts nothing.
  expect(await player.play({ when: when + 1 })).toBeNull();
  await until(context, when - 0.15);
  expect(context.currentTime).toBeLessThan(when);
  expect(player.position).toBe(1);
  expect(peak(analyser)).toBeLessThan(0.001);
  await until(context, when + 0.2);
  expect(peak(analyser)).toBeGreaterThan(0.1);
  expect(player.position).toBeCloseTo(1 + context.currentTime - when, 1);
  // Pausing a queued start holds the start offset.
  player.pause();
  player.seek(2.5);
  await player.play({ when: context.currentTime + 0.3 });
  player.pause();
  expect(player.position).toBe(2.5);
});

for (const command of ["pause", "stop", "load", "setStretch", "dispose"] as const) {
  test(`${command} before \`when\` cancels the queued start: nothing sounds`, async () => {
    const { context, player, analyser } = await fixture();
    player.output.connect(analyser);
    const buffer = bands(context);
    await player.load(buffer);
    const when = context.currentTime + 0.25;
    expect(await player.play({ when })).toBe(when);
    if (command === "load") await player.load(buffer);
    else if (command === "setStretch") await player.setStretch(1);
    else player[command]();
    expect(context.currentTime).toBeLessThan(when);
    if (command !== "dispose") expect(player.getState().isPlaying).toBe(false);
    for (let i = 0; i < 6; i++) {
      await delay(60);
      expect(peak(analyser)).toBeLessThan(0.001);
    }
    expect(context.currentTime).toBeGreaterThan(when + 0.05);
  });
}

test("seek before `when` re-issues the queued start at the same time from the new position", async () => {
  const { context, player, analyser } = await fixture();
  player.output.connect(analyser);
  await player.load(bands(context));
  const when = context.currentTime + 0.4;
  await player.play({ when });
  player.seek(4.5);
  expect(player.isPlaying).toBe(true);
  expect(player.position).toBe(4.5);
  await until(context, when - 0.15);
  expect(context.currentTime).toBeLessThan(when);
  expect(player.position).toBe(4.5);
  expect(peak(analyser)).toBeLessThan(0.001);
  await until(context, when + 0.25);
  expect(peak(analyser)).toBeGreaterThan(0.1);
  // Only the re-issued start sounds: 880 Hz from 4.5 s, never 220 Hz from the superseded offset.
  expect(frequency(analyser, context)).toBeGreaterThan(860);
  expect(player.position).toBeCloseTo(4.5 + context.currentTime - when, 1);
});

test("selection and looping changes before `when` keep the start time, bounds and one-shot stop", async () => {
  const { context, player, analyser } = await fixture();
  player.output.connect(analyser);
  await player.load(bands(context));
  // One-shot: a selection set while queued moves the start into the range; the stop is measured from `when`.
  let when = context.currentTime + 0.4;
  await player.play({ when });
  player.setSelection({ start: 3.3, end: 3.6 });
  expect(player.position).toBe(3.3);
  await until(context, when - 0.15);
  expect(context.currentTime).toBeLessThan(when);
  expect(peak(analyser)).toBeLessThan(0.001);
  expect(player.position).toBe(3.3);
  await until(context, when + 0.15);
  expect(player.isPlaying).toBe(true);
  expect(frequency(analyser, context)).toBeGreaterThan(420);
  expect(frequency(analyser, context)).toBeLessThan(460);
  expect(player.position).toBeCloseTo(3.3 + context.currentTime - when, 1);
  await expect.poll(() => player.isPlaying).toBe(false);
  expect(context.currentTime).toBeGreaterThan(when + 0.29);
  expect(player.position).toBeCloseTo(3.6, 2);

  // Looping toggled while queued: still silent until `when`, then loops past the range length.
  player.stop();
  when = context.currentTime + 0.3;
  await player.play({ when });
  player.setLooping(true);
  expect(player.position).toBe(3.3);
  await until(context, when - 0.1);
  expect(context.currentTime).toBeLessThan(when);
  expect(peak(analyser)).toBeLessThan(0.001);
  await until(context, when + 0.45);
  expect(player.isPlaying).toBe(true);
  expect(peak(analyser)).toBeGreaterThan(0.1);
  const elapsed = context.currentTime - when;
  expect(player.position).toBeCloseTo(3.3 + (elapsed % 0.3), 1);

  // Looping selection edited around the held position while queued: position does not run ahead of `when`.
  player.pause();
  player.seek(3.4);
  when = context.currentTime + 0.3;
  await player.play({ when });
  player.setSelection({ start: 3.35, end: 3.55 });
  expect(player.position).toBe(3.4);
  await until(context, when - 0.1);
  expect(context.currentTime).toBeLessThan(when);
  expect(player.position).toBe(3.4);
  expect(peak(analyser)).toBeLessThan(0.001);
  await until(context, when + 0.1);
  const run = context.currentTime - when;
  expect(player.position).toBeCloseTo(3.4 + run, 1);
  expect(peak(analyser)).toBeGreaterThan(0.1);
});

test("a past or missing `when` clamps to now and the effective time is returned; invalid times reject", async () => {
  const { context, player, analyser } = await fixture();
  player.output.connect(analyser);
  expect(await player.play({ when: context.currentTime + 1 })).toBeNull(); // no source
  await player.load(bands(context));
  for (const invalid of [NaN, Infinity, -1])
    await expect(player.play({ when: invalid })).rejects.toThrow("Start time must be finite, non-negative seconds.");
  expect(player.isPlaying).toBe(false);

  // `when` passes while the context resume is pending.
  let release!: () => void;
  vi.spyOn(context, "resume").mockReturnValue(new Promise<void>((done) => (release = done)));
  const when = context.currentTime + 0.05;
  const pending = player.play({ when });
  await until(context, when + 0.1);
  expect(player.isPlaying).toBe(false);
  const before = context.currentTime;
  release();
  const started = await pending;
  expect(started).toBeGreaterThanOrEqual(before);
  expect(started).toBeLessThanOrEqual(context.currentTime);
  expect(started).toBeGreaterThan(when);
  await expect.poll(() => peak(analyser)).toBeGreaterThan(0.1);
  expect(player.position).toBeCloseTo(context.currentTime - started!, 1);

  player.stop();
  const now = context.currentTime;
  const immediate = await player.play();
  expect(immediate).toBeGreaterThanOrEqual(now);
  expect(immediate).toBeLessThanOrEqual(context.currentTime);
  expect(await player.play({ when: 0 })).toBeNull(); // already playing
});
