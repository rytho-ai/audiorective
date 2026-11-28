import { expect, test } from "vitest";
import { compileMidiPlaybackEvents, type MidiData, type MidiPlaybackSource } from "@audiorective/midi";
import { planMidiVoices } from "../../src/demos/midi/voice-plan";

/** Times are beats; the demo plays at 120 BPM. */
const note: MidiData["notes"][number] = { id: "a", start: 0, duration: 0.6, pitch: 62, velocity: 90 / 127, channel: 0 };
const message = (beat: number, data: number[], noteId?: string) => ({ beat, data: new Uint8Array(data), noteId });

test("recorded same-time order changes whether pedal holds the edited note", () => {
  for (const releaseFirst of [true, false]) {
    const source: MidiPlaybackSource = {
      events: [
        message(0, [0x90, 60, 90], "a"),
        ...(releaseFirst
          ? [message(0.6, [0x80, 60, 0], "a"), message(0.6, [0xb0, 64, 127])]
          : [message(0.6, [0xb0, 64, 127]), message(0.6, [0x80, 60, 0], "a")]),
        message(1.2, [0xb0, 64, 0]),
      ],
    };
    const voices = planMidiVoices(compileMidiPlaybackEvents(source, { notes: [note], duration: 1.6 }), 1.6);
    expect(voices).toEqual([{ noteId: "a", start: 0, end: releaseFirst ? 0.6 : 1.2, pitch: 62, velocity: 90 / 127, channel: 0 }]);
  }
});

test("overlapping edited notes retain separate voices and pedal is channel-specific", () => {
  const source: MidiPlaybackSource = {
    events: [
      message(0, [0x90, 60, 90], "a"),
      message(0.2, [0x91, 60, 70], "b"),
      message(0.4, [0xb0, 64, 127]),
      message(0.6, [0x80, 60, 0], "a"),
      message(0.8, [0x81, 60, 0], "b"),
      message(1.2, [0xb0, 64, 0]),
    ],
  };
  const voices = planMidiVoices(
    compileMidiPlaybackEvents(source, {
      duration: 1.6,
      notes: [note, { id: "b", start: 0.2, duration: 0.6, pitch: 65, velocity: 70 / 127, channel: 1 }],
    }),
    1.6,
  );
  expect(voices).toEqual([
    { noteId: "a", start: 0, end: 1.2, pitch: 62, velocity: 90 / 127, channel: 0 },
    { noteId: "b", start: 0.2, end: 0.8, pitch: 65, velocity: 70 / 127, channel: 1 },
  ]);
});

test("a MIDI file without recorded controls still produces the original note interval", () => {
  const voices = planMidiVoices(compileMidiPlaybackEvents({ events: [] }, { notes: [note], duration: 1.6 }), 1.6);
  expect(voices).toEqual([{ noteId: "a", start: 0, end: 0.6, pitch: 62, velocity: 90 / 127, channel: 0 }]);
});
