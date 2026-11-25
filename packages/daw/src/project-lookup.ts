import { untracked } from "@audiorective/core";
import type { AudioClip, Project } from "./model";
import { findSlotClip } from "./session-state";

/** Find an audio clip by id on any track, or in a Session slot unless `timelineOnly`, without subscribing the caller to the Project. */
export function findAudioClip(project: Project, clipId: string, timelineOnly = false): AudioClip | undefined {
  return untracked(() => {
    for (const track of project.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip?.kind === "audio") return clip;
    }
    const slot = timelineOnly ? undefined : findSlotClip(project, clipId);
    return slot?.kind === "audio" ? slot : undefined;
  });
}
