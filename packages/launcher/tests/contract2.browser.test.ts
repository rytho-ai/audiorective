import { describe, expect, test } from "vitest";
import { renderScenario, type Scenario } from "./contract";
import { freq, lastSound, onset, starts, stops } from "./helpers";

const bassHz = (clip: number, beat: number) => 200 * (clip + 1) * (1 + beat / 16);
const near = (a: number, b: number, tol = 0.005) => expect(Math.abs(a - b) / b).toBeLessThan(tol);
const whens = (ev: ReturnType<typeof starts>) => ev.map((e) => Math.round(e.when * 1000) / 1000);

describe("renderScenario: follow, legato, chance, cancel, replace", () => {
  test("6. follow: after N bars the next clip launches on the quantized boundary", async () => {
    const r = await renderScenario({
      seconds: 9,
      clips: { bass: [{ follow: { afterBars: 1, actions: [{ to: "next", chance: 1 }] } }, {}] },
      actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }],
    });
    expect(starts(r.events).map((e) => [e.clip, Math.round(e.when * 1000) / 1000])).toEqual([
      [0, 0.1],
      [1, 2.1],
    ]);
    expect(stops(r.events)[0]).toMatchObject({ clip: 0, when: 2.1 });
    near(freq(r.perTrack.bass, 2.2, 2.45), bassHz(1, 0));
  });

  test("6. follow chain loops (0 -> 1 -> 0 ...), also with 'previous' and an explicit slot", async () => {
    const r = await renderScenario({
      seconds: 9,
      clips: {
        bass: [{ follow: { afterBars: 1, actions: [{ to: 1, chance: 1 }] } }, { follow: { afterBars: 2, actions: [{ to: "previous", chance: 1 }] } }],
      },
      actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }],
    });
    expect(starts(r.events).map((e) => [e.clip, Math.round(e.when * 1000) / 1000])).toEqual([
      [0, 0.1],
      [1, 2.1],
      [0, 6.1],
      [1, 8.1],
    ]);
  });

  test("6. follow draws are deterministic for a seed, and 'stay' keeps the clip playing", async () => {
    const sc = (seed: number): Scenario => ({
      seconds: 24,
      seed,
      clips: {
        bass: [{ follow: { afterBars: 1, actions: [{ to: 1, chance: 0.5 }] } }, { follow: { afterBars: 1, actions: [{ to: 0, chance: 0.5 }] } }],
      },
      actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }],
    });
    const a = await renderScenario(sc(1));
    const b = await renderScenario(sc(1));
    const c = await renderScenario(sc(2));
    expect(a.events).toEqual(b.events);
    expect(whens(starts(a.events))).not.toEqual(whens(starts(c.events)));
    expect(starts(a.events).length).toBeGreaterThan(2);
    expect(starts(a.events).length).toBeLessThan(12); // some draws were "stay"
  });

  test("7. legato starts at the playing clip's phase", async () => {
    const r = await renderScenario({
      seconds: 8,
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 1.0, kind: "launch", track: "bass", clip: 1, legato: true },
      ],
    });
    const s1 = starts(r.events, 1)[0]!;
    expect(s1.when).toBeCloseTo(2.1, 6);
    expect(s1.offsetBeats).toBeCloseTo(4, 6); // clip 0 has played 2 s = 4 beats at the boundary
    near(freq(r.perTrack.bass, 2.15, 2.45), bassHz(1, 4), 0.01);
    expect(stops(r.events, 0)[0]!.offsetBeats).toBeCloseTo(4, 6);
  });

  test("7. legato wraps the phase inside a loop (clip 0 has wrapped once)", async () => {
    const r = await renderScenario({
      seconds: 22,
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 17, kind: "launch", track: "bass", clip: 1, legato: true },
      ],
    });
    const s1 = starts(r.events, 1)[0]!;
    // boundary 18.1: clip 0 started at 0.1, 18 s = 36 beats, mod 16 = 4
    expect(s1.when).toBeCloseTo(18.1, 6);
    expect(s1.offsetBeats).toBeCloseTo(4, 6);
  });

  test("8. probability launch: 0 never, 1 always, 0.5 deterministic per seed", async () => {
    const acts = (n: number): Scenario["actions"] =>
      Array.from({ length: n }, (_, i) => ({ at: 0.1 + i * 2, kind: "launch" as const, track: "bass" as const, clip: i % 2 }));
    const never = await renderScenario({ seconds: 12, clips: { bass: [{ chance: 0 }, { chance: 0 }] }, actions: acts(5) });
    expect(never.events).toEqual([]);
    const half = (seed: number) => renderScenario({ seconds: 20, seed, clips: { bass: [{ chance: 0.5 }, { chance: 0.5 }] }, actions: acts(8) });
    const a = await half(3);
    const b = await half(3);
    expect(a.events).toEqual(b.events);
    const n = starts(a.events).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(8);
    const other = await half(4);
    expect(whens(starts(other.events))).not.toEqual(whens(starts(a.events)));
  });

  test("a skipped launch leaves what plays untouched", async () => {
    const r = await renderScenario({
      seconds: 6,
      clips: { bass: [{}, { chance: 0 }] },
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 1, kind: "launch", track: "bass", clip: 1 },
      ],
    });
    expect(starts(r.events)).toHaveLength(1);
    expect(stops(r.events)).toHaveLength(0);
    near(freq(r.perTrack.bass, 4.15, 4.45), bassHz(0, 8)); // clip 0 never stopped: 4 s in = beat 8
  });

  test("cancel withdraws a waiting launch; what plays keeps playing", async () => {
    const r = await renderScenario({
      seconds: 6,
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 0.5, kind: "launch", track: "bass", clip: 1 },
        { at: 1.0, kind: "cancel", track: "bass" },
      ],
    });
    expect(starts(r.events).map((e) => e.clip)).toEqual([0]);
    expect(stops(r.events)).toHaveLength(0);
  });

  test("stop: quantized, and 'none' is immediate", async () => {
    const r = await renderScenario({
      seconds: 8,
      actions: [
        { at: 0.1, kind: "launch", track: "bass", clip: 0 },
        { at: 0.1, kind: "launch", track: "chords", clip: 0 },
        { at: 0.7, kind: "stop", track: "bass" },
        { at: 0.7, kind: "stop", track: "chords", quantize: "none" },
      ],
    });
    expect(stops(r.events).find((e) => e.track === "bass")!.when).toBeCloseTo(2.1, 6);
    expect(Math.abs(stops(r.events).find((e) => e.track === "chords")!.when - 0.7)).toBeLessThan(0.003);
    expect(lastSound(r.perTrack.bass)).toBeCloseTo(2.1, 3);
    expect(lastSound(r.perTrack.chords)).toBeLessThan(0.71);
  });

  test("a waiting launch handed to the graph is replaced by a later one (no leak of the first)", async () => {
    // 2.1 boundary is inside the look-ahead at 2.05; a launch at 2.07 replaces it
    const r = await renderScenario({
      seconds: 4,
      actions: [
        { at: 2.05, kind: "launch", track: "bass", clip: 1 },
        { at: 2.07, kind: "launch", track: "bass", clip: 2 },
      ],
    });
    expect(starts(r.events).map((e) => e.clip)).toEqual([2]);
    near(freq(r.perTrack.bass, 2.15, 2.4), bassHz(2, 0));
    expect(onset(r.perTrack.bass)).toBeCloseTo(2.1, 3);
  });

  test("a one-shot ends at its exact end", async () => {
    const r = await renderScenario({
      seconds: 10,
      clips: { bass: [{ loop: false }] },
      actions: [{ at: 0.1, kind: "launch", track: "bass", clip: 0 }],
    });
    expect(stops(r.events)[0]).toMatchObject({ clip: 0 });
    expect(stops(r.events)[0]!.when).toBeCloseTo(8.1, 6);
    expect(stops(r.events)[0]!.offsetBeats).toBeCloseTo(16, 6);
    expect(lastSound(r.perTrack.bass)).toBeCloseTo(8.1, 3);
  });

  test("scene launch: one shared boundary for every track, per-clip quantize ignored", async () => {
    const r = await renderScenario({
      seconds: 5,
      clips: { drums: [{ quantize: "beat" }], bass: [{}], chords: [{}] },
      actions: [{ at: 0.7, kind: "scene", scene: 0 }],
    });
    expect(starts(r.events).map((e) => e.when)).toEqual([2.1, 2.1, 2.1].map((x) => expect.closeTo(x, 6)));
  });
});
