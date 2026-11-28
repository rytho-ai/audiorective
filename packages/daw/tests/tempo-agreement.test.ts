import { describe, expect, test } from "vitest";
import { Timeline } from "@audiorective/clock";
import { TempoMap } from "../src/tempo-map";

// TempoMap (project beats, immutable) and clock's TempoCurve (audio seconds, mutable) are separate
// by design; this guards that their piecewise-constant integration agrees. The clock side is
// reached through its public Timeline: `bpm.setValueAtTime` steps, then beatToTime/timeToBeat.

const TOLERANCE = 1e-9;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TempoMap agrees with clock Timeline tempo maths", () => {
  const initialBpm = 90;
  const changes = [
    { beat: 4, bpm: 120 },
    { beat: 7.5, bpm: 60 },
    { beat: 16, bpm: 175.25 },
    { beat: 33, bpm: 40 },
  ];
  const map = new TempoMap(initialBpm, changes);

  const ctx = { currentTime: 0 };
  const timeline = new Timeline({ audioContext: ctx, bpm: initialBpm });
  timeline._start();
  for (const change of changes) timeline.bpm.setValueAtTime(change.bpm, map.beatToSeconds(change.beat));

  const random = mulberry32(0xc10c4);
  const beats = [
    0,
    0.25,
    3.999,
    ...changes.map((c) => c.beat),
    ...changes.flatMap((c) => [c.beat - 1e-6, c.beat + 1e-6]),
    5,
    10.125,
    24,
    100,
    1000,
    ...Array.from({ length: 50 }, () => random() * 200),
  ];
  const seconds = [
    0,
    0.5,
    ...changes.map((c) => map.beatToSeconds(c.beat)),
    ...changes.flatMap((c) => [map.beatToSeconds(c.beat) - 1e-6, map.beatToSeconds(c.beat) + 1e-6]),
    30,
    500,
    ...Array.from({ length: 50 }, () => random() * 400),
  ].filter((s) => s >= 0);

  test("beatToTime matches beatToSeconds", () => {
    for (const beat of beats) expect(Math.abs(timeline.beatToTime(beat) - map.beatToSeconds(beat)), `beat ${beat}`).toBeLessThan(TOLERANCE);
  });

  test("timeToBeat matches secondsToBeat", () => {
    for (const s of seconds) {
      ctx.currentTime = s;
      expect(Math.abs(timeline.timeToBeat(s) - map.secondsToBeat(s)), `seconds ${s}`).toBeLessThan(TOLERANCE);
    }
  });
});
