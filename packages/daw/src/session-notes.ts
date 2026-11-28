import { MidiClip as MidiNotes, type ClipMessage, type MidiNote } from "@audiorective/midi";
import type { ClipScheduler } from "@audiorective/launcher";
import { untracked } from "@audiorective/core";
import { MidiClip, type Project } from "./model";
import { sessionFor } from "./session";

/**
 * The content a Session MIDI clip plays on every pass, in content beats: its window `[sourceOffset, sourceOffset + duration)`, or for a looped clip the
 * loop (`[start, start + min(loop length, duration))`), so a pass never replays the lead-in before the loop. The Session loops this one stretch.
 */
export function sessionWindow(clip: Pick<MidiClip, "loop" | "sourceOffset" | "duration">): Readonly<{ from: number; length: number }> {
  const { loop } = clip;
  return loop
    ? { from: loop.startBeat, length: Math.min(loop.endBeat - loop.startBeat, clip.duration) }
    : { from: clip.sourceOffset, length: clip.duration };
}

/**
 * The clip's messages other than notes (controllers, pitch bend, program changes, pressure) for one Session pass, in beats from the launch: what the Arrangement sends
 * for the same stretch of content (`MidiClip.playbackEvents` of a clip that plays `sessionWindow` once, so the controller values before the window are carried to its
 * start and a pedal still down at the pass end is released there).
 */
export function sessionMessages(clip: MidiClip): readonly ClipMessage[] {
  if (!clip.events.length) return [];
  const { from, length } = sessionWindow(clip);
  const pass = new MidiClip(clip.id, 0, { duration: length, sourceOffset: from, notes: [], events: clip.events });
  try {
    return pass.playbackEvents().filter(({ data }) => (data[0] & 0xf0) !== 0x80 && (data[0] & 0xf0) !== 0x90);
  } finally {
    pass.dispose();
  }
}

/**
 * The scheduler a Session MIDI clip plays through. A clip's own note model plays into one instrument, so when another slot clip on a different track shares
 * the notes (a linked clip), or the clip plays only a window of them (`sessionWindow`), or has controller content to send (`sessionMessages`), this clip gets a private note model that follows the shared
 * notes, shifted and cut to the window, and plays into its own track's instrument.
 */
export function sessionNotes(project: Project, clip: MidiClip, trackId: string, host: NonNullable<MidiNotes["instrument"]>): ClipScheduler {
  const grid = sessionFor(project);
  const crossTrack = untracked(() =>
    project
      .linkedClips(clip.id)
      .some((other) =>
        grid.scenes.some((scene) =>
          project.tracks.some((track) => track.id !== trackId && grid.clipAt({ trackId: track.id, sceneId: scene.id }) === other),
        ),
      ),
  );
  const { from, length } = sessionWindow(clip);
  const messages = sessionMessages(clip);
  // The note model's messages are one list for every placement that shares it, so a clip with controller content plays through its own copy.
  if (!crossTrack && from === 0 && messages.length === 0) {
    clip.midi.instrument = host;
    return clip.midi;
  }
  // A note already sounding at the window's start plays from it, except for a loop pass, which only has the notes that start inside.
  const crossing = !clip.loop;
  const view = (notes: readonly MidiNote[]): MidiNote[] =>
    notes.flatMap((note) => {
      if (note.start >= from + length || (!crossing && note.start < from)) return [];
      const start = Math.max(note.start, from);
      const end = Math.min(note.start + note.duration, from + length);
      return end > start ? [{ ...note, start: start - from, duration: end - start }] : [];
    });
  const mirror = new MidiNotes(view(untracked(() => clip.midi.notes.value)), { instrument: host, messages });
  // The follower lives as long as the launcher clip that holds it: attaching starts it, and the launcher's cleanup (a dispose or a rebuild) ends it.
  return {
    schedule: (window, timing) => mirror.schedule(window, timing),
    reset: (reason) => mirror.reset(reason),
    attached: (handle) => {
      const detach = mirror.attached(handle);
      const off = clip.midi.notes.subscribe((notes) => mirror.setNotes(view(notes)));
      return () => {
        off();
        detach();
        mirror.dispose();
      };
    },
  };
}
