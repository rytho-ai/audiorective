/** Demo synth policy: interpret ordered MIDI messages, including channel sustain, into voice intervals in beats. */
import type { MidiPlaybackEvent } from "@audiorective/midi";

/** Start and end in beats; velocity 0..1. */
export type PlannedVoice = Readonly<{ noteId: string; start: number; end: number; pitch: number; velocity: number; channel: number }>;
type ActiveVoice = Omit<PlannedVoice, "end">;

export function planMidiVoices(events: readonly MidiPlaybackEvent[], duration: number): readonly PlannedVoice[] {
  const active = new Map<string, ActiveVoice>();
  const deferred = new Map<number, Set<string>>();
  const pedal = new Set<number>();
  const voices: PlannedVoice[] = [];
  const close = (id: string, beat: number) => {
    const voice = active.get(id);
    if (!voice) return;
    active.delete(id);
    if (beat > voice.start) voices.push({ ...voice, end: beat });
  };
  for (const event of events) {
    if (event.beat > duration) break;
    const status = event.data[0],
      kind = status & 0xf0,
      channel = status & 0x0f;
    if (kind === 0xb0 && event.data[1] === 64) {
      if (event.data[2] >= 64) pedal.add(channel);
      else {
        pedal.delete(channel);
        for (const id of deferred.get(channel) ?? []) close(id, event.beat);
        deferred.delete(channel);
      }
    } else if (event.noteId && kind === 0x90 && event.data[2] > 0) {
      active.set(event.noteId, { noteId: event.noteId, start: event.beat, pitch: event.data[1], velocity: event.data[2] / 127, channel });
    } else if (event.noteId && (kind === 0x80 || (kind === 0x90 && event.data[2] === 0))) {
      if (pedal.has(channel)) {
        const pending = deferred.get(channel) ?? new Set<string>();
        pending.add(event.noteId);
        deferred.set(channel, pending);
      } else close(event.noteId, event.beat);
    }
  }
  for (const id of active.keys()) close(id, duration);
  return voices.sort((a, b) => a.start - b.start);
}
