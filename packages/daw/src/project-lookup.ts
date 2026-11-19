import { untracked } from "@audiorective/core";
import type { AudioClip, Project } from "./model";

/** Find an audio clip by id on any track, without subscribing the caller to the Project. */
export function findAudioClip(project: Project, clipId: string): AudioClip | undefined {
  return untracked(() => {
    for (const track of project.tracks) {
      const clip = track.clips.find((candidate) => candidate.id === clipId);
      if (clip?.kind === "audio") return clip;
    }
    return undefined;
  });
}
