import { describe, expect, it } from "vitest";
import { Ducker } from "../src";

const SR = 44100;
const db = (x: number) => 20 * Math.log10(x);

/** Music (440 Hz, 0.5) through a Ducker; the sidechain is a 200 Hz burst between 0.3 s and 0.8 s. */
async function run(opts: ConstructorParameters<typeof Ducker>[1] = {}, sidechain = true) {
  const ctx = new OfflineAudioContext(2, SR * 1.6, SR);
  const ducker = new Ducker(ctx, opts);
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

  it("bypass passes the music untouched, status is ready", async () => {
    const { out, ducker } = await run({ depth: 8, bypass: true });
    expect(peak(out, 0.6)).toBeCloseTo(0.5, 2);
    expect(ducker.cells.status.value).toBe("ready");
  });
});
