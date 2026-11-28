import { afterEach, describe, expect, it, vi } from "vitest";
import { Ducker } from "../src";

const SR = 44100;
const db = (x: number) => 20 * Math.log10(x);
const owned: Ducker[] = [];
const own = (ducker: Ducker) => {
  owned.push(ducker);
  return ducker;
};
afterEach(() => {
  for (const ducker of owned.splice(0)) ducker.dispose();
  vi.restoreAllMocks();
});

/** Music (440 Hz, 0.5) through a Ducker; the sidechain is a 200 Hz burst between 0.3 s and 0.8 s. */
async function run(opts: ConstructorParameters<typeof Ducker>[1] = {}, sidechain = true) {
  const ctx = new OfflineAudioContext(2, SR * 1.6, SR);
  const ducker = own(new Ducker(ctx, opts));
  await ducker.ready;
  const music = new OscillatorNode(ctx, { frequency: 440 });
  const musicGain = new GainNode(ctx, { gain: 0.5 });
  music.connect(musicGain).connect(ducker.input);
  const mic = new OscillatorNode(ctx, { frequency: 200 });
  const gate = new GainNode(ctx, { gain: 0 });
  gate.gain
    .setValueAtTime(0, 0)
    .setValueAtTime(sidechain ? 0.5 : 0, 0.3)
    .setValueAtTime(0, 0.8);
  mic.connect(gate).connect(ducker.sidechain);
  ducker.output.connect(ctx.destination);
  music.start();
  mic.start();
  const reductions: number[] = [];
  ducker.cells.reduction.subscribe((v) => reductions.push(v));
  const out = (await ctx.startRendering()).getChannelData(0);
  return { out, reductions, ducker };
}
/** Peak of the output over a window starting at `seconds`. */
const peak = (d: Float32Array, seconds: number, length = 0.01) => {
  let m = 0;
  for (let i = Math.round(seconds * SR); i < Math.round((seconds + length) * SR); i++) m = Math.max(m, Math.abs(d[i]!));
  return m;
};

describe("Ducker", () => {
  it("ducks by depth dB while the sidechain is loud, never mixing the sidechain into the output", async () => {
    const { out } = await run({ depth: 8 });
    expect(peak(out, 0.2)).toBeCloseTo(0.5, 2);
    expect(Math.abs(db(peak(out, 0.6) / 0.5) - -8)).toBeLessThan(0.3);
    // 200 Hz sidechain would show as a second component: the output stays a clean 440 Hz at the ducked level.
    expect(peak(out, 0.6, 0.05)).toBeLessThan(0.5 * 10 ** (-7.5 / 20));
  });

  it("reacts within the attack time", async () => {
    const { out } = await run({ depth: 8, attack: 0.01 });
    const halfway = db(peak(out, 0.3 + 0.004, 0.004) / 0.5);
    expect(halfway).toBeLessThan(-2);
    expect(halfway).toBeGreaterThan(-6.5);
    expect(db(peak(out, 0.3 + 0.012) / 0.5)).toBeLessThan(-7.5);
  });

  it("recovers over the release time after the sidechain stops", async () => {
    const { out } = await run({ depth: 8, release: 0.3 });
    expect(db(peak(out, 0.85) / 0.5)).toBeLessThan(-7); // the follower still holds
    const mid = db(peak(out, 1.1) / 0.5);
    expect(mid).toBeLessThan(-0.5);
    expect(mid).toBeGreaterThan(-7.5);
    expect(peak(out, 1.5)).toBeCloseTo(0.5, 2);
  });

  it("is smooth: no sample-to-sample step beyond the signal's own slope", async () => {
    const { out } = await run({ depth: 8 });
    let step = 0;
    for (let i = 1; i < out.length; i++) step = Math.max(step, Math.abs(out[i]! - out[i - 1]!));
    expect(step).toBeLessThan(0.5 * 2 * Math.PI * (440 / SR) * 1.05);
  });

  it("no sidechain signal means no ducking", async () => {
    const { out, reductions } = await run({}, false);
    expect(peak(out, 0.6)).toBeCloseTo(0.5, 2);
    expect(Math.min(...reductions, 0)).toBeCloseTo(0, 5);
  });

  it("cells.reduction reports the live reduction in dB", async () => {
    const { reductions } = await run({ depth: 8 });
    expect(Math.min(...reductions)).toBeCloseTo(-8, 1);
    expect(Math.max(...reductions)).toBeLessThanOrEqual(0);
  });

  it("reports the actual wet/dry attenuation instead of the detector envelope", async () => {
    const { out, reductions } = await run({ depth: 8, wet: 0.5 });
    const expected = db((1 + 10 ** (-8 / 20)) / 2);
    expect(db(peak(out, 0.6) / 0.5)).toBeCloseTo(expected, 2);
    expect(Math.min(...reductions)).toBeCloseTo(expected, 2);
  });

  it("reports the audible bypass fade, then zero, without altering the sidechain detector", async () => {
    const ctx = new OfflineAudioContext(1, 22050, SR);
    const ducker = own(new Ducker(ctx, { depth: 8, attack: 0 }));
    await ducker.ready;
    const source = new ConstantSourceNode(ctx, { offset: 1 });
    source.connect(ducker.input);
    source.connect(ducker.sidechain);
    ducker.connect(ctx.destination);
    source.start();
    const reductions: number[] = [];
    ducker.cells.reduction.subscribe((value) => reductions.push(value));
    const change = 11264 / SR;
    ctx.suspend(16384 / SR).then(() => {
      ducker.params.bypass.value = false;
      ctx.resume();
    });
    ctx.suspend(change).then(() => {
      ducker.params.bypass.value = true;
      ctx.resume();
    });
    const out = (await ctx.startRendering()).getChannelData(0);
    const activeGain = 10 ** (-8 / 20);
    expect(out[10000]).toBeCloseTo(activeGain, 5);
    // The existing bypass has a 10 ms lead and 3 ms time constant.
    const frame = Math.round((change + 0.013) * SR);
    const enabled = Math.exp(-(frame / SR - change - 0.01) / 0.003);
    expect(out[frame]).toBeCloseTo(1 - enabled + enabled * activeGain, 4);
    expect(reductions.some((value) => value > -7.9 && value < -0.01)).toBe(true);
    expect(reductions.some((value) => Math.abs(value) < 1e-5)).toBe(true);
    expect(out[15000]).toBeCloseTo(1, 5);
    // Clearing bypass restores ducking after its fade; the detector kept running.
    expect(reductions.at(-1)).toBeCloseTo(-8, 5);
    expect(out[20000]).toBeCloseTo(activeGain, 5);
  });

  it("meter follows scheduled wet automation even while the detector reduction is unchanged", async () => {
    const ctx = new OfflineAudioContext(1, 22050, SR);
    const ducker = own(new Ducker(ctx, { depth: 8, attack: 0, wet: 0 }));
    await ducker.ready;
    const source = new ConstantSourceNode(ctx, { offset: 1 });
    source.connect(ducker.input);
    source.connect(ducker.sidechain);
    ducker.connect(ctx.destination);
    source.start();
    ducker.params.wet.setValueAtTime(0, 0).linearRampToValueAtTime(1, 0.25);
    const reductions: number[] = [];
    ducker.cells.reduction.subscribe((value) => reductions.push(value));
    const out = (await ctx.startRendering()).getChannelData(0);
    const half = db((1 + 10 ** (-8 / 20)) / 2);
    expect(db(out[Math.round(0.125 * SR)]!)).toBeCloseTo(half, 2);
    expect(reductions.some((value) => value > half - 0.3 && value < half + 0.3)).toBe(true);
    expect(reductions.at(-1)).toBeCloseTo(-8, 3);
  });

  it("disposal stops queued worklet meter updates and releases the audible path", async () => {
    const ctx = new OfflineAudioContext(1, 22050, SR);
    const ducker = own(new Ducker(ctx, { depth: 8, attack: 0.1 }));
    await ducker.ready;
    const source = new ConstantSourceNode(ctx, { offset: 1 });
    source.connect(ducker.input);
    source.connect(ducker.sidechain);
    ducker.connect(ctx.destination);
    source.start();
    let disposed = false;
    let laterUpdates = 0;
    ducker.cells.reduction.subscribe(() => {
      if (disposed) laterUpdates++;
    });
    ctx.suspend(11264 / SR).then(() => {
      ducker.dispose();
      disposed = true;
      ctx.resume();
    });
    const out = (await ctx.startRendering()).getChannelData(0);
    expect(laterUpdates).toBe(0);
    expect(out[10000]).toBeGreaterThan(0);
    expect(out[20000]).toBe(0);
  });

  it.each([
    { wet: 1, bypass: false, expected: -Infinity },
    { wet: 0.5, bypass: false, expected: db(0.5) },
    { wet: 1, bypass: true, expected: 0 },
  ])("loading/error meter reflects the actual dry path ($wet wet, bypass $bypass) and releases its frame loop", async ({ wet, bypass, expected }) => {
    let next = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++next;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const tick = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(performance.now());
    };
    const ctx = new OfflineAudioContext(1, 128, SR);
    Object.defineProperty(ctx, "audioWorklet", { value: undefined });
    const ducker = own(new Ducker(ctx, { wet, bypass }));
    expect(ducker.cells.status.value).toBe("loading");
    expect(ducker.cells.reduction.value).toBe(expected);
    await expect(ducker.ready).rejects.toThrow(/no audioWorklet/);
    expect(ducker.cells.status.value).toBe("error");
    expect(ducker.cells.reduction.value).toBe(expected);
    ducker.params.bypass.value = true;
    tick();
    expect(ducker.cells.reduction.value).toBe(0);
    ducker.params.bypass.value = false;
    tick();
    expect(ducker.cells.reduction.value).toBe(wet === 1 ? -Infinity : db(1 - wet));
    ducker.dispose();
    expect(frames.size).toBe(0);
  });

  it("bypass passes the music untouched, status is ready", async () => {
    const { out, reductions, ducker } = await run({ depth: 8, bypass: true });
    expect(peak(out, 0.6)).toBeCloseTo(0.5, 2);
    expect(Math.min(...reductions, 0)).toBeCloseTo(0, 5);
    expect(ducker.cells.status.value).toBe("ready");
  });
});
