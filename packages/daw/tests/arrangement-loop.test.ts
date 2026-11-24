import { describe, expect, it } from "vitest";
import { LoopFold, loopWrapMessages } from "../src/arrangement-loop";
import { Project } from "../src/project";

describe("LoopFold", () => {
  const region = { startBeat: 4, endBeat: 8 };

  it("is a plain offset without a region, and from past the region", () => {
    expect(new LoopFold(2, 2, null).toBeat(10)).toBe(10);
    const past = new LoopFold(20, 9, region);
    expect(past.wrapTransport).toBeNull();
    expect(past.toBeat(25)).toBe(14);
  });

  it("runs into the region and repeats it, with the end exclusive", () => {
    const fold = new LoopFold(0, 0, region);
    expect(fold.toBeat(7.5)).toBe(7.5);
    expect(fold.toBeat(8)).toBe(4);
    expect(fold.toBeat(11.5)).toBe(7.5);
    expect(fold.toBeat(12)).toBe(4);
    expect(fold.toBeat(1000)).toBe(4);
  });

  it("splits a window at every wrap", () => {
    const fold = new LoopFold(0, 6, region);
    expect(fold.segments(1, 8)).toEqual([
      { transportStart: 1, transportEnd: 2, beatStart: 7, beatEnd: 8, cycle: -1 },
      { transportStart: 2, transportEnd: 6, beatStart: 4, beatEnd: 8, cycle: 0 },
      { transportStart: 6, transportEnd: 8, beatStart: 4, beatEnd: 6, cycle: 1 },
    ]);
    expect(fold.wraps(1, 8)).toEqual([2, 6]);
    expect(fold.wraps(2, 6)).toEqual([2]);
    expect(fold.wraps(2.5, 6)).toEqual([]);
  });

  it("always advances at very large transport beats", () => {
    const fold = new LoopFold(0, 0, { startBeat: 0, endBeat: 0.3 });
    for (const cycle of [100_000, 1_234_567, 56_713_447, 99_999_999]) {
      const at = fold.wrapTransport! + cycle * 0.3;
      const parts = fold.segments(at - 0.05, at + 0.7);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.at(-1)!.transportEnd).toBe(at + 0.7);
    }
  });

  it("keeps segment boundaries stable after many cycles", () => {
    const fold = new LoopFold(0, 0, { startBeat: 0.1, endBeat: 0.4 });
    const parts = fold.segments(1000, 1001);
    for (const part of parts) {
      expect(part.beatStart).toBeGreaterThanOrEqual(0.1 - 1e-9);
      expect(part.beatEnd).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    expect(parts.at(-1)!.transportEnd).toBe(1001);
  });
});

describe("loopWrapMessages", () => {
  it("releases held notes, restores changed controllers, and resets ones with no earlier value", () => {
    const project = new Project();
    const track = project.addTrack("K", "midi");
    project.addMidiClip(
      track.id,
      {
        duration: 16,
        notes: [
          { pitch: 60, velocity: 1, start: 7, duration: 3 },
          { pitch: 62, velocity: 1, start: 5, duration: 1 },
          { pitch: 64, velocity: 1, start: 7, duration: 1, channel: 2 },
        ],
        events: [
          { time: 0, data: Uint8Array.of(0xb0, 7, 100) },
          { time: 5, data: Uint8Array.of(0xb0, 7, 20) },
          { time: 5, data: Uint8Array.of(0xb0, 64, 127) },
          { time: 6, data: Uint8Array.of(0xe0, 0, 0x60) },
        ],
      },
      0,
    );
    const messages = loopWrapMessages(project.tracks[0].clips, { startBeat: 4, endBeat: 8 }).map((data) => [...data]);
    expect(messages).toContainEqual([0x80, 60, 0]);
    expect(messages).toContainEqual([0x82, 64, 0]);
    expect(messages).not.toContainEqual([0x80, 62, 0]);
    expect(messages).toContainEqual([0xb0, 7, 100]);
    expect(messages).toContainEqual([0xb0, 64, 0]);
    expect(messages).toContainEqual([0xe0, 0, 0x40]);
  });
});
