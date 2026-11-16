import { expect, test } from "vitest";
import { compileMidiPlaybackEvents, type MidiData, type MidiPlaybackSource } from "@audiorective/midi";
import { planMidiVoices } from "../../src/demos/midi/voice-plan";

const note: MidiData["notes"][number] = { id: "a", start: 0, end: 0.3, pitch: 62, velocity: 90, channel: 0, track: 0 };
const message = (time: number, data: number[], noteId?: string) => ({ audioTime: 10 + time, data: new Uint8Array(data), noteId });

test("recorded same-time order changes whether pedal holds the edited note", () => {
  for (const releaseFirst of [true, false]) {
    const source: MidiPlaybackSource = {
      startTime: 10,
      events: [
        message(0, [0x90, 60, 90], "a"),
        ...(releaseFirst
          ? [message(0.3, [0x80, 60, 0], "a"), message(0.3, [0xb0, 64, 127])]
          : [message(0.3, [0xb0, 64, 127]), message(0.3, [0x80, 60, 0], "a")]),
        message(0.6, [0xb0, 64, 0]),
      ],
    };
    const voices = planMidiVoices(compileMidiPlaybackEvents(source, { notes: [note], duration: 0.8 }), 0.8);
    expect(voices).toEqual([{ noteId: "a", start: 0, end: releaseFirst ? 0.3 : 0.6, pitch: 62, velocity: 90, channel: 0 }]);
  }
});

test("overlapping edited notes retain separate voices and pedal is channel-specific", () => {
  const source: MidiPlaybackSource = {
    startTime: 10,
    events: [
      message(0, [0x90, 60, 90], "a"),
      message(0.1, [0x91, 60, 70], "b"),
      message(0.2, [0xb0, 64, 127]),
      message(0.3, [0x80, 60, 0], "a"),
      message(0.4, [0x81, 60, 0], "b"),
      message(0.6, [0xb0, 64, 0]),
    ],
  };
  const voices = planMidiVoices(
    compileMidiPlaybackEvents(source, {
      duration: 0.8,
      notes: [note, { id: "b", start: 0.1, end: 0.4, pitch: 65, velocity: 70, channel: 1, track: 0 }],
    }),
    0.8,
  );
  expect(voices).toEqual([
    { noteId: "a", start: 0, end: 0.6, pitch: 62, velocity: 90, channel: 0 },
    { noteId: "b", start: 0.1, end: 0.4, pitch: 65, velocity: 70, channel: 1 },
  ]);
});

test("a MIDI file without recorded controls still produces the original note interval", () => {
  const voices = planMidiVoices(compileMidiPlaybackEvents({ startTime: 0, events: [] }, { notes: [note], duration: 0.8 }), 0.8);
  expect(voices).toEqual([{ noteId: "a", start: 0, end: 0.3, pitch: 62, velocity: 90, channel: 0 }]);
});
