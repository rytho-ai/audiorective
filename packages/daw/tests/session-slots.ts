import { sessionFor, type Project, type ProjectAudio, type ProjectMidiData } from "../src";

/** Fill the Session of `project`: `clips[i]` goes in scene i of the track (`null` leaves it empty); scenes are added as needed. */
export function fillSession(project: Project, trackId: string, clips: ReadonlyArray<ProjectMidiData | ProjectAudio | null>): void {
  const session = sessionFor(project);
  const kind = project.tracks.find((track) => track.id === trackId)!.kind;
  clips.forEach((data, index) => {
    while (session.scenes.length <= index) session.addScene();
    if (!data) return;
    const slot = { trackId, sceneId: session.scenes[index].id };
    if (kind === "midi") session.setMidiClip(slot, data as ProjectMidiData);
    else session.setAudioClip(slot, data as ProjectAudio);
  });
}
