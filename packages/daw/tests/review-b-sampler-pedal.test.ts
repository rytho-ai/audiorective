import { describe, expect, test } from "vitest";
import { SamplerSink } from "../src/midi-sink";

/** The Sampler sink honours the sustain pedal (CC64) at its own time. */
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
  const context = { currentTime: 0 } as BaseAudioContext;
  return { sink: new SamplerSink(sampler as never, context), voices };
}
const on = (pitch: number) => [0x90, pitch, 100];
const off = (pitch: number) => [0x80, pitch, 0];
const pedal = (value: number, channel = 0) => [0xb0 | channel, 64, value];

describe("SamplerSink sustain pedal", () => {
  test("a note-off while the pedal is down releases at the pedal-up", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(60), 1);
    sink.scheduleMidi(pedal(127), 0.5);
    sink.scheduleMidi(off(60), 2);
    expect(voices[0].stopAt).toBe(Infinity);
    sink.scheduleMidi(pedal(0), 3);
    expect(voices[0].stopAt).toBe(3);
  });

  test("a note-off before the pedal goes down, or after it comes up, releases at its own time", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(60), 1);
    sink.scheduleMidi(off(60), 1.5);
    sink.scheduleMidi(pedal(127), 2);
    sink.scheduleMidi(on(62), 3);
    sink.scheduleMidi(pedal(127), 2.5);
    sink.scheduleMidi(pedal(0), 2.75);
    sink.scheduleMidi(off(62), 4);
    expect(voices.map((voice) => voice.stopAt)).toEqual([1.5, 4]);
  });

  test("a pedal move that is withdrawn gives the note its own release", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(60), 1);
    const down = sink.scheduleMidi(pedal(127), 0.5);
    sink.scheduleMidi(off(60), 2);
    expect(voices[0].stopAt).toBe(Infinity);
    down.cancel();
    expect(voices[0].stopAt).toBe(2);
  });

  test("all-notes-off (CC123) releases at once whatever the pedal does, and allNotesOff() lifts the pedal", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(60), 1);
    sink.scheduleMidi(pedal(127), 0.5);
    sink.scheduleMidi([0xb0, 123, 0], 2);
    expect(voices[0].stopAt).toBe(2);
    sink.allNotesOff();
    sink.scheduleMidi(on(64), 5);
    sink.scheduleMidi(off(64), 6);
    expect(voices[1].stopAt).toBe(6);
  });

  test("bend, mod wheel, pressure and program change are ignored and cancel nothing", () => {
    const { sink, voices } = rig();
    sink.scheduleMidi(on(60), 1);
    for (const data of [
      [0xe0, 0, 100],
      [0xb0, 1, 90],
      [0xd0, 50],
      [0xa0, 60, 50],
      [0xc0, 7],
    ])
      sink.scheduleMidi(data, 1.5).cancel();
    sink.scheduleMidi(off(60), 2);
    expect(voices[0].stopAt).toBe(2);
  });
});
