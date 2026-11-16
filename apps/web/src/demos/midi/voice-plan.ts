/** Demo synth policy: interpret ordered MIDI messages, including channel sustain, into voice intervals. */
import type { MidiPlaybackEvent } from "@audiorective/midi";

export type PlannedVoice = Readonly<{ noteId: string; start: number; end: number; pitch: number; velocity: number; channel: number }>;
type ActiveVoice = Omit<PlannedVoice, "end">;

export function planMidiVoices(events: readonly MidiPlaybackEvent[], duration: number): readonly PlannedVoice[] {
  const active = new Map<string, ActiveVoice>();
  const deferred = new Map<number, Set<string>>();
  const pedal = new Set<number>();
  const voices: PlannedVoice[] = [];
  const close = (id: string, time: number) => {
    const voice = active.get(id);
    if (!voice) return;
    active.delete(id);
    if (time > voice.start) voices.push({ ...voice, end: time });
  };
  for (const event of events) {
    if (event.time > duration) break;
    const status = event.data[0],
      kind = status & 0xf0,
      channel = status & 0x0f;
    if (kind === 0xb0 && event.data[1] === 64) {
      if (event.data[2] >= 64) pedal.add(channel);
      else {
        pedal.delete(channel);
        for (const id of deferred.get(channel) ?? []) close(id, event.time);
        deferred.delete(channel);
      }
    } else if (event.noteId && kind === 0x90 && event.data[2] > 0) {
      active.set(event.noteId, { noteId: event.noteId, start: event.time, pitch: event.data[1], velocity: event.data[2], channel });
    } else if (event.noteId && (kind === 0x80 || (kind === 0x90 && event.data[2] === 0))) {
      if (pedal.has(channel)) {
        const pending = deferred.get(channel) ?? new Set<string>();
        pending.add(event.noteId);
        deferred.set(channel, pending);
      } else close(event.noteId, event.time);
    }
  }
  for (const id of active.keys()) close(id, duration);
  return voices.sort((a, b) => a.start - b.start);
}
