import { describe, expect, test } from "vitest";
import { SamplerSink } from "../src/midi-sink";

/** A sampler whose voices record the last stop time they were given. */
function rig() {
  const voices: Array<{ when: number; stopAt: number }> = [];
  const sampler = {
    noteOn(_note: number, options: { when?: number }) {
      const voice = {
        when: options.when ?? 0,
        stopAt: Infinity,
        stop(time: number) {
          voice.stopAt = time;
        },
        playing: { value: true, subscribe: () => () => {} },
      };
      voices.push(voice);
      return voice;
    },
    stopAll() {},
  };
  const sink = new SamplerSink(sampler as never, { currentTime: 0 } as BaseAudioContext);
  return { sink, voices };
}
const on = (pitch: number) => [0x90, pitch, 100];
const off = (pitch: number) => [0x80, pitch, 0];

describe("SamplerSink at equal times", () => {
  test("a note-off sent before a note-on at the same time leaves the new voice sounding", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(36), 1);
    sink.scheduleMidi(off(36), 1.25);
    sink.scheduleMidi(off(36), 1.25);
    sink.scheduleMidi(on(36), 1.25);
    sink.scheduleMidi(off(36), 1.5);
    expect(voices.map((v) => v.stopAt)).toEqual([1.25, 1.5]);
  });

  test("a note-off sent after a note-on at the same time still releases it", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(36), 1);
    sink.scheduleMidi(off(36), 1);
    expect(voices[0].stopAt).toBe(1);
  });
});

describe("SamplerSink with times that differ by float round-off", () => {
  test("a note-off one ulp after a same-pitch note-on, sent before it, leaves the new voice sounding", () => {
    const { sink, voices } = rig();
    const justAfter = 1 + Number.EPSILON;
    sink.scheduleMidi(on(36), 0.5);
    sink.scheduleMidi(off(36), justAfter);
    sink.scheduleMidi(on(36), 1);
    sink.scheduleMidi(off(36), 1.5);
    expect(voices.map((v) => v.stopAt)).toEqual([justAfter, 1.5]);
  });
});

describe("SamplerSink velocity", () => {
  /** A sampler that records the velocity each note-on gets. */
  function velocities() {
    const seen: Array<number | undefined> = [];
    const sampler = {
      noteOn(_note: number, options: { velocity?: number }) {
        seen.push(options.velocity);
        return { stop() {}, playing: { value: true, subscribe: () => () => {} } };
      },
      stopAll() {},
    };
    return { sink: new SamplerSink(sampler as never, { currentTime: 0 } as BaseAudioContext), seen };
  }

  test("a velocity given directly plays at the level its MIDI byte gives, as scheduleMidi does", () => {
    const { sink, seen } = velocities();
    sink.noteOn(60, { velocity: 0.8 });
    sink.scheduleMidi([0x90, 60, Math.round(0.8 * 127)], 0);
    expect(seen[0]).toBe(Math.round(0.8 * 127) / 127);
    expect(seen[0]).not.toBe(0.8);
    expect(seen[0]).toBe(seen[1]);
  });

  test("a velocity above 0 never rounds to silence or past 127, and an omitted velocity stays the sampler's default", () => {
    const { sink, seen } = velocities();
    sink.noteOn(60, { velocity: 0.001 });
    sink.noteOn(60, { velocity: 3 });
    sink.noteOn(60);
    expect(seen).toEqual([1 / 127, 1, undefined]);
  });
});
