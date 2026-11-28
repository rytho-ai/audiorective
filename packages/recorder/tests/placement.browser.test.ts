import { describe, expect, test } from "vitest";
import { overdub, punch } from "../src/placement";

// 120 bpm: a beat is 0.5 s; the loop is 4 bars = 16 beats = 8 s, written at 4 kHz.
const RATE = 4000;
const BPM = 120;
function loop(fill: (frame: number) => number, seconds = 8): AudioBuffer {
  const buffer = new AudioBuffer({ length: seconds * RATE, sampleRate: RATE, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = fill(i);
  return buffer;
}
function take(value: number, seconds: number, startBeat: number | null) {
  return { sampleRate: RATE, channels: [new Float32Array(seconds * RATE).fill(value)], startBeat };
}

describe("overdub", () => {
  test("sums a take into the loop at its beat position and leaves the target untouched", () => {
    const base = loop(() => 0.25);
    // a two-bar take (4 s) that started on beat 8 of a loop launched on beat 0: it lands in seconds 4..8 of the loop
    const out = overdub(base, take(0.5, 4, 8), { loopStartBeat: 0, bpm: BPM });
    const data = out.getChannelData(0);
    expect(data[15999]).toBeCloseTo(0.25, 6);
    expect(data[16000]).toBeCloseTo(0.75, 6);
    expect(data[31999]).toBeCloseTo(0.75, 6);
    expect(base.getChannelData(0)[4000]).toBe(0.25);
    expect(out.length).toBe(base.length);
  });

  test("a take placed later in the transport lands at the same loop position, and one crossing the loop end wraps", () => {
    const base = loop(() => 0);
    // the loop started on beat 4; the take starts on beat 4 + 16 + 12 (second pass, 6 s in) and lasts 4 s: 2 s to the end, then 2 s at the start
    const out = overdub(base, take(1, 4, 32), { loopStartBeat: 4, bpm: BPM });
    const data = out.getChannelData(0);
    expect(data[23999]).toBe(0);
    expect(data[24000]).toBe(1);
    expect(data[31999]).toBe(1);
    expect(data[0]).toBe(1);
    expect(data[7999]).toBe(1);
    expect(data[8000]).toBe(0);
  });

  test("a timeline stands in for a constant tempo, and a take without a beat needs atBeat", () => {
    const timeline = { beatToTime: (beat: number) => (beat * 60) / BPM };
    const out = overdub(
      loop(() => 0),
      take(1, 1, null),
      { loopStartBeat: 0, timeline, atBeat: 2 },
    );
    expect(out.getChannelData(0)[3999]).toBe(0);
    expect(out.getChannelData(0)[4000]).toBe(1);
    expect(() =>
      overdub(
        loop(() => 0),
        take(1, 1, null),
        { loopStartBeat: 0, bpm: BPM },
      ),
    ).toThrow("AudioRecorder overdub needs `atBeat` or a take with a startBeat.");
  });
});

describe("punch", () => {
  test("replaces bars 3-4 only, with short crossfades at the edges", () => {
    const base = loop(() => 0.25);
    // bars 3 and 4 of a 4-bar loop: beats 8..16, seconds 4..8
    const out = punch(base, take(1, 4, 8), { loopStartBeat: 0, fromBeat: 8, toBeat: 16, bpm: BPM });
    const data = out.getChannelData(0);
    expect(data[0]).toBe(0.25);
    expect(data[12000]).toBe(0.25);
    expect(data[15976]).toBe(0.25); // outside the region and its fade
    expect(data[16000]).toBeGreaterThan(0.25); // fading in
    expect(data[16000]).toBeLessThan(1);
    expect(data[16040]).toBe(1);
    expect(data[24000]).toBe(1);
    expect(data[31990]).toBeLessThan(1); // fading out
    expect(data[31999]).toBeLessThan(0.5);
    expect(base.getChannelData(0)[6000]).toBe(0.25);
  });

  test("frames of the region the take does not cover keep the loop, and a hard cut needs no fade", () => {
    const base = loop(() => 0.25);
    const out = punch(base, take(1, 1, 8), { loopStartBeat: 0, fromBeat: 8, toBeat: 12, bpm: BPM, fadeSeconds: 0 });
    const data = out.getChannelData(0);
    expect(data[16000]).toBe(1);
    expect(data[19999]).toBe(1);
    expect(data[20000]).toBe(0.25);
  });

  test("rejects a region that is empty or as long as the loop, and mismatched sample rates", () => {
    const base = loop(() => 0);
    expect(() => punch(base, take(1, 1, 0), { loopStartBeat: 0, fromBeat: 4, toBeat: 4, bpm: BPM })).toThrow(
      "AudioRecorder punch needs fromBeat before toBeat, within one loop.",
    );
    expect(() => punch(base, { ...take(1, 1, 0), sampleRate: 2000 }, { loopStartBeat: 0, fromBeat: 0, toBeat: 4, bpm: BPM })).toThrow(
      "AudioRecorder placement needs equal sample rates",
    );
  });
});
