import { describe, expect, test } from "vitest";
import { renderScenario } from "./contract";
import { freq, lastSound, onset, peakIn, starts, stops } from "./helpers";

// 120 BPM, 4/4, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const T0 = 0.1;
const BEAT = 0.5;
const bassHz = (clip: number, beat: number) => 200 * (clip + 1) * (1 + beat / 16);
const near = (a: number, b: number, tol = 0.005) => expect(Math.abs(a - b) / b).toBeLessThan(tol);

describe("renderScenario", () => {
  test("every rendered buffer has exactly seconds * sampleRate frames", async () => {
    for (const [seconds, sampleRate] of [
      [1, 44100],
      [2.5, 48000],
      [0.9999, 44100],
      [3.3333, 22050],
    ] as const) {
      const r = await renderScenario({ seconds, sampleRate, actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }] });
      for (const t of ["drums", "bass", "chords"] as const) {
        expect(r.perTrack[t].length).toBe(Math.round(seconds * sampleRate));
        expect(r.perTrack[t].sampleRate).toBe(sampleRate);
      }
    }
  });

  test("a launch on a bar boundary starts at once; a mid-bar launch waits for the next bar", async () => {
    const r = await renderScenario({
      seconds: 5,
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 0.3, kind: "launch", track: "chords", clip: 1 },
      ],
    });
    expect(starts(r.events, 0)[0]).toMatchObject({ track: "bass", when: T0, offsetBeats: 0 });
    expect(Math.abs(starts(r.events, 1)[0]!.when - (T0 + 4 * BEAT))).toBeLessThan(1e-9);
    near(freq(r.perTrack.bass, 0.2, 0.55), bassHz(0, 0));
    expect(onset(r.perTrack.chords)).toBeCloseTo(T0 + 4 * BEAT, 3);
    near(freq(r.perTrack.chords, 2.2, 2.5), 400 * 2);
  });

  test("1. per-clip quantize overrides the global one", async () => {
    const r = await renderScenario({
      seconds: 4,
      globalQuantize: "bar",
      clips: { drums: [{}, { quantize: "beat" }] },
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 0.7, kind: "launch", track: "drums", clip: 1 },
        { at: 0.7, kind: "launch", track: "drums", clip: 0 },
      ],
    });
    // clip 0 on drums is queued for the next bar (2.1); clip 1 replaced that wait? the later launch (clip 0, global bar) wins:
    expect(starts(r.events, 0).filter((e) => e.track === "drums")[0]!.when).toBeCloseTo(2.1, 6);
    const r2 = await renderScenario({
      seconds: 4,
      globalQuantize: "bar",
      clips: { drums: [{}, { quantize: "beat" }] },
      actions: [{ at: 0.7, kind: "launch", track: "drums", clip: 1 }],
    });
    // next beat after 0.7 s: beat boundaries are 0.1 + 0.5k -> 1.1
    expect(starts(r2.events)[0]!.when).toBeCloseTo(1.1, 6);
    expect(onset(r2.perTrack.drums)).toBeCloseTo(1.1, 3);
  });

  test("2. start offset and loop region", async () => {
    // bars 2-3 of a 4-bar buffer: beats 4..12. Starts at beat 2 of the buffer.
    const r = await renderScenario({
      seconds: 14,
      clips: { bass: [{ startBeat: 2, loop: { startBeat: 4, lengthBeats: 8 } }] },
      actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }],
    });
    expect(starts(r.events)[0]).toMatchObject({ offsetBeats: 2 });
    // t=0.1.. beat 2 of material, then 3, then loop region 4..11, wrap to 4.
    near(freq(r.perTrack.bass, 0.2, 0.55), bassHz(0, 2));
    near(freq(r.perTrack.bass, 0.7, 1.05), bassHz(0, 3));
    near(freq(r.perTrack.bass, 1.2, 1.55), bassHz(0, 4)); // material beat 4 at t = 0.1+2*0.5
    near(freq(r.perTrack.bass, 4.7, 5.05), bassHz(0, 11)); // t=0.1+ (2+... ) beat 11
    // 12 beats after start: material wraps from 12 back to 4
    const tWrap = T0 + (12 - 2) * BEAT;
    near(freq(r.perTrack.bass, tWrap + 0.1, tWrap + 0.4), bassHz(0, 4));
  });

  test("3. per-clip gain and pitch", async () => {
    const r = await renderScenario({
      seconds: 3,
      clips: { bass: [{ gainDb: -6, pitch: 12 }] },
      actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }],
    });
    near(freq(r.perTrack.bass, 0.13, 0.3), bassHz(0, 0) * 2, 0.01); // +12 st: the first beat lasts 0.25 s
    expect(peakIn(r.perTrack.bass, 0.2, 1)).toBeCloseTo(0.25, 2);
  });

  test("4. gate: plays while held, release stops at the next boundary", async () => {
    const r = await renderScenario({
      seconds: 6,
      clips: { bass: [{ quantize: "beat" }], chords: [{ quantize: "none" }] },
      actions: [],
    });
    expect(r.events).toEqual([]);
    const g = await renderScenario({
      seconds: 6,
      clips: { bass: [{ quantize: "beat", mode: "gate" }] },
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 1.3, kind: "release", track: "bass", clip: 0 },
      ],
    });
    expect(stops(g.events)[0]!.when).toBeCloseTo(1.6, 6); // next beat after 1.3
    expect(lastSound(g.perTrack.bass)).toBeCloseTo(1.6, 3);
    // released before it starts cancels the launch
    const c = await renderScenario({
      seconds: 4,
      clips: { bass: [{ mode: "gate" }] },
      actions: [
        { at: 0.3, kind: "launch", track: "bass", clip: 0 },
        { at: 1.0, kind: "release", track: "bass", clip: 0 },
      ],
    });
    expect(c.events).toEqual([]);
    expect(onset(c.perTrack.bass)).toBe(-1);
  });

  test("4. toggle: a second launch stops it, quantized", async () => {
    const r = await renderScenario({
      seconds: 8,
      globalQuantize: "bar",
      clips: { bass: [{ mode: "toggle" }] },
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 2.5, kind: "launch", track: "bass", clip: 0 },
      ],
    });
    expect(starts(r.events)).toHaveLength(1);
    expect(stops(r.events)[0]!.when).toBeCloseTo(4.1, 6);
    expect(lastSound(r.perTrack.bass)).toBeCloseTo(4.1, 3);
  });

  test("5. scene tempo changes the transport tempo at the scene boundary", async () => {
    // 60 bpm from bar 1 (t=2.1): a beat is now 1 s, so the next bar boundary is 4 s later (6.1).
    const r = await renderScenario({
      seconds: 12,
      sceneBpm: { 1: 60 },
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 0.3, kind: "scene", scene: 1 },
        { at: 2.3, kind: "launch", track: "chords", clip: 0 },
      ],
    });
    const bass1 = starts(r.events).filter((e) => e.track === "bass");
    expect(bass1[1]!.when).toBeCloseTo(2.1, 6);
    expect(bass1[1]!.clip).toBe(1);
    const ch = starts(r.events).filter((e) => e.track === "chords" && e.when > 3);
    expect(ch.find((e) => e.clip === 0)!.when).toBeCloseTo(6.1, 6);
  });
});
