import { describe, expect, test } from "vitest";
import { AudioTrackSession } from "../src/audio-track-session";

/** A context whose arrangement gain records its automation; `level(t)` replays it like an AudioParam would. */
function rig() {
  const events: Array<{ time: number; value: number }> = [];
  const clock = { currentTime: 0 };
  const gain = {
    setValueAtTime: (value: number, time: number) => void events.push({ time, value }),
    cancelScheduledValues: (time: number) => void events.splice(0, events.length, ...events.filter((event) => event.time < time)),
  };
  const context = { currentTime: 0, createGain: () => ({ gain, connect() {}, disconnect() {} }) } as unknown as AudioContext;
  Object.defineProperty(context, "currentTime", { get: () => clock.currentTime });
  const session = new AudioTrackSession(context, {} as AudioNode);
  const level = (time: number) => events.filter((event) => event.time <= time).at(-1)?.value;
  return { session, events, clock, level };
}

describe("AudioTrackSession follows launcher changes", () => {
  test("a launched clip takes the track from Arrangement at its boundary and a stop gives it back", () => {
    const { session, level } = rig();
    session.follow(2, true, null);
    expect([level(1.9), level(2), level(3)]).toEqual([1, 0, 0]);
    session.follow(4, false, null);
    expect([level(3.9), level(4), level(9)]).toEqual([0, 1, 1]);
  });

  test("a one-shot returns the track to Arrangement at its end", () => {
    const { session, level } = rig();
    session.follow(2, true, 3.5);
    expect([level(2.5), level(3.4), level(3.5), level(9)]).toEqual([0, 0, 1, 1]);
  });

  test("a cancelled or reset change leaves the previous one in force", () => {
    const { session, level, clock } = rig();
    session.follow(1, true, null);
    clock.currentTime = 1.5;
    const stop = session.follow(3, false, null);
    expect(level(3)).toBe(1);
    stop.cancel?.();
    expect([level(2), level(3), level(9)]).toEqual([0, 0, 0]);
    const clip = session.follow(5, true, 6);
    expect(level(5.5)).toBe(0);
    clip.reset?.();
    expect(level(5.5)).toBe(0);
    expect(level(9)).toBe(0);
  });

  test("a later change supersedes a one-shot that has not ended", () => {
    const { session, level } = rig();
    session.follow(1, true, 5);
    session.follow(2, true, null);
    expect([level(1.5), level(2.5), level(6)]).toEqual([0, 0, 0]);
    session.follow(3, false, null);
    expect(level(6)).toBe(1);
  });
});
