/** Pure projection of an edited MIDI take into ordered, take-relative playback messages. */
import type { MidiData, RecordedMidiEvent } from "./midi-data";

export type MidiPlaybackSource = Readonly<{ startTime: number; events: readonly RecordedMidiEvent[] }>;
export type MidiPlaybackEvent = Readonly<{
  /** Seconds relative to the take start. The caller places this on its own transport. */
  time: number;
  /** MIDI bytes. A caller sending to an external device may use these directly. */
  data: Uint8Array;
  /** Stable voice identity for matched notes; absent for retained control messages. */
  noteId?: string;
}>;

type RankedEvent = MidiPlaybackEvent & { order: number };
/** A nanosecond is below Web MIDI timestamp precision and removes subtraction round-off at ties. */
const playbackTime = (seconds: number) => Math.round(seconds * 1e9) / 1e9;

function isNoteMessage(data: Uint8Array): boolean {
  if (data.length < 3 || data[0] < 0x80 || data[0] >= 0xf0) return false;
  const kind = data[0] & 0xf0;
  return kind === 0x80 || kind === 0x90;
}

/**
 * Use the current note snapshot for note bytes/times and the recorded take for other messages.
 * Original same-time order follows the source event array; newly inserted note endpoints follow it.
 * This does not schedule audio, apply pedal semantics, or place a clip on a transport.
 */
export function compileMidiPlaybackEvents(source: MidiPlaybackSource, sequence: MidiData): readonly MidiPlaybackEvent[] {
  if (!Number.isFinite(source.startTime) || source.startTime < 0 || !Number.isFinite(sequence.duration) || sequence.duration < 0)
    throw new RangeError("MIDI playback needs finite, non-negative times and valid MIDI notes.");

  const ranks = new Map<string, { on?: number; off?: number }>();
  const result: RankedEvent[] = [];
  source.events.forEach((event, order) => {
    if (!Number.isFinite(event.audioTime) || event.audioTime < source.startTime)
      throw new RangeError("MIDI playback needs finite, non-negative times and valid MIDI notes.");
    if (isNoteMessage(event.data)) {
      if ((event.data[0] & 0xf0) === 0x90 && event.data[2] > 0 && !event.noteId)
        throw new Error("MIDI playback needs note IDs on recorded note-ons.");
      if (event.noteId) {
        const rank = ranks.get(event.noteId) ?? {};
        if ((event.data[0] & 0xf0) === 0x90 && event.data[2] > 0) rank.on = order;
        else rank.off = order;
        ranks.set(event.noteId, rank);
      }
      return; // The current sequence is the sole source of notes, including deletes and edits.
    }
    result.push({ time: playbackTime(event.audioTime - source.startTime), data: new Uint8Array(event.data), order });
  });

  const ids = new Set<string>();
  sequence.notes.forEach((note, index) => {
    if (
      typeof note.id !== "string" ||
      !note.id ||
      ids.has(note.id) ||
      !Number.isFinite(note.start) ||
      !Number.isFinite(note.end) ||
      note.start < 0 ||
      note.end < note.start ||
      note.end > sequence.duration ||
      !Number.isInteger(note.pitch) ||
      note.pitch < 0 ||
      note.pitch > 127 ||
      !Number.isInteger(note.velocity) ||
      note.velocity < 0 ||
      note.velocity > 127 ||
      !Number.isInteger(note.channel) ||
      note.channel < 0 ||
      note.channel > 15 ||
      !Number.isInteger(note.track) ||
      note.track < 0
    )
      throw new RangeError("MIDI playback needs finite, non-negative times and valid MIDI notes.");
    ids.add(note.id);
    if (note.start === note.end || note.velocity === 0) return;
    const rank = ranks.get(note.id);
    result.push({
      time: playbackTime(note.start),
      data: new Uint8Array([0x90 | note.channel, note.pitch, note.velocity]),
      noteId: note.id,
      order: rank?.on ?? source.events.length + index * 2,
    });
    result.push({
      time: playbackTime(note.end),
      data: new Uint8Array([0x80 | note.channel, note.pitch, 0]),
      noteId: note.id,
      order: rank?.off ?? source.events.length + index * 2 + 1,
    });
  });

  result.sort((a, b) => a.time - b.time || a.order - b.order);
  return Object.freeze(result.map(({ order: _order, ...event }) => Object.freeze(event)));
}
