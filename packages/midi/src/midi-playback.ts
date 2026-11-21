/** Pure projection of an edited MIDI take into ordered, take-relative playback messages. */
import { noteProblem, type MidiData } from "./midi-data";

/** A message captured with a take: a beat from the take's start, MIDI bytes and, for a note message, the note it belongs to. */
export type MidiPlaybackSourceEvent = Readonly<{ beat: number; data: Uint8Array; noteId?: string }>;
export type MidiPlaybackSource = Readonly<{ events: readonly MidiPlaybackSourceEvent[] }>;
export type MidiPlaybackEvent = Readonly<{
  /** Beats from the source start. */
  beat: number;
  /** MIDI bytes. A caller sending to an external device may use these directly. */
  data: Uint8Array;
  /** Stable voice identity for matched notes; absent for retained control messages. */
  noteId?: string;
}>;

type RankedEvent = MidiPlaybackEvent & { order: number };
/** Rounding below source precision removes round-off at ties. */
const playbackBeat = (beat: number) => Math.round(beat * 1e9) / 1e9;
const velocityByte = (velocity: number) => Math.max(1, Math.min(127, Math.round(velocity * 127)));

function isNoteMessage(data: Uint8Array): boolean {
  if (data.length < 3 || data[0] < 0x80 || data[0] >= 0xf0) return false;
  const kind = data[0] & 0xf0;
  return kind === 0x80 || kind === 0x90;
}

/**
 * Use the current note snapshot for note bytes/beats and the recorded take for other messages (velocity 0..1 becomes a 1-127 data byte).
 * Original same-time order follows the source event array; newly inserted note endpoints follow it.
 * This does not schedule audio, apply pedal semantics, or place a clip on a transport.
 */
export function compileMidiPlaybackEvents(source: MidiPlaybackSource, sequence: MidiData): readonly MidiPlaybackEvent[] {
  if (!Number.isFinite(sequence.duration) || sequence.duration < 0)
    throw new RangeError("MIDI playback needs finite, non-negative times and valid MIDI notes.");

  const ranks = new Map<string, { on?: number; off?: number }>();
  const result: RankedEvent[] = [];
  source.events.forEach((event, order) => {
    if (!Number.isFinite(event.beat) || event.beat < 0) throw new RangeError("MIDI playback needs finite, non-negative times and valid MIDI notes.");
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
    result.push({ beat: playbackBeat(event.beat), data: new Uint8Array(event.data), order });
  });

  const ids = new Set<string>();
  sequence.notes.forEach((note, index) => {
    if (noteProblem(note) || note.start + note.duration > sequence.duration + 1e-9 || ids.has(note.id))
      throw new RangeError("MIDI playback needs finite, non-negative times and valid MIDI notes.");
    ids.add(note.id);
    if (note.duration === 0 || note.velocity === 0) return;
    const rank = ranks.get(note.id);
    result.push({
      beat: playbackBeat(note.start),
      data: new Uint8Array([0x90 | note.channel, note.pitch, velocityByte(note.velocity)]),
      noteId: note.id,
      order: rank?.on ?? source.events.length + index * 2,
    });
    result.push({
      beat: playbackBeat(note.start + note.duration),
      data: new Uint8Array([0x80 | note.channel, note.pitch, 0]),
      noteId: note.id,
      order: rank?.off ?? source.events.length + index * 2 + 1,
    });
  });

  result.sort((a, b) => a.beat - b.beat || a.order - b.order);
  return Object.freeze(result.map(({ order: _order, ...event }) => Object.freeze(event)));
}
