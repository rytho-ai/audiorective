import { MidiClip as MidiNotes } from "@audiorective/midi";
import type { ClipScheduler } from "@audiorective/launcher";
import { untracked } from "@audiorective/core";
import type { MidiClip, Project } from "./model";
import { sessionFor } from "./session";

/**
 * The scheduler a Session MIDI clip plays through. A clip's own note model plays into one instrument, so when another slot clip on a different track shares
 * the notes (a linked clip), this clip gets a private note model that follows the shared notes and plays into its own track's instrument.
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
  if (!crossTrack) {
    clip.midi.instrument = host;
    return clip.midi;
  }
  const mirror = new MidiNotes(
    untracked(() => clip.midi.notes.value),
    { instrument: host },
  );
  // The follower lives as long as the launcher clip that holds it: attaching starts it, and the launcher's cleanup (a dispose or a rebuild) ends it.
  return {
    schedule: (window, timing) => mirror.schedule(window, timing),
    reset: (reason) => mirror.reset(reason),
    attached: (handle) => {
      const detach = mirror.attached(handle);
      const off = clip.midi.notes.subscribe((notes) => mirror.setNotes(notes));
      return () => {
        off();
        detach();
        mirror.dispose();
      };
    },
  };
}
