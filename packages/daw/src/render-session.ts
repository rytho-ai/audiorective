import type { PCMData } from "@audiorective/core";
import { RenderControl, renderSnapshotFrames } from "./offline-render";
import { integratedLoudness, peakDbFS } from "./internal/mix-measure";
import { renderSnapshot, type Project, type ProjectClip } from "./model";
import type { ProjectVersion } from "./project-edits";
import type { Workspace } from "./runtime";
import { sessionFor } from "./session";

export type RenderSessionOptions = Readonly<{
  /** Project scene IDs in play order; a scene may repeat (`[b, b, b, b]`, `[a, a, b, c]`). At least one. */
  scenes: readonly string[];
  /** The version to hear. Another current version returns `conflict` without rendering. Omit to render whatever is current. */
  expectedVersion?: ProjectVersion;
  /** Seconds rendered after the last scene so reverbs and delays ring out. Default: 2. */
  tailSeconds?: number;
  signal?: AbortSignal;
}>;

export type RenderSessionResult = Readonly<
  | {
      status: "rendered";
      version: ProjectVersion;
      /** Stereo PCM from beat 0 (the first scene's start) to the end of the last scene plus the tail. */
      audio: PCMData;
      durationSeconds: number;
      /** Seconds in `audio` where each entry of `scenes` starts, on a bar line, in play order. */
      starts: readonly number[];
      /** `null` for digital silence. */
      peakDbFS: number | null;
      /** BS.1770 gated loudness; `null` under 400 ms or silent. */
      loudnessLUFS: number | null;
    }
  | { status: "conflict"; version: ProjectVersion; reason: string }
>;

const EPS = 1e-9;

/**
 * Render scenes of the Session grid, back to back, offline through the full mix (volume, pan, mute, solo, sends, effects, devices, instruments, master)
 * and measure the result. The Arrangement is not heard, and neither playback nor the song is touched: the render runs on a copy.
 *
 * Scenes follow the rule of the live `playChain`: each starts where the previous one ends and lasts as long as its longest slot clip (a bar when no slot has a clip),
 * so they sit on bar lines when the clips are whole bars. A clip shorter than the scene repeats until the scene ends, as a launched Session clip loops; an empty slot is silent for that scene.
 * Track volume automation plays against the song's time from 0, as it does under a live chain; the Arrangement's clips are not heard.
 */
export async function renderSession(workspace: Workspace, options: RenderSessionOptions): Promise<RenderSessionResult> {
  const { scenes, expectedVersion, signal } = options;
  const tailSeconds = options.tailSeconds ?? 2;
  if (!Array.isArray(scenes) || scenes.length === 0 || scenes.some((id) => typeof id !== "string"))
    throw new RangeError("renderSession needs scenes: a non-empty list of scene IDs.");
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0) throw new RangeError("renderSession tailSeconds must be finite and non-negative.");
  const control = new RenderControl("renderSession", signal);
  const { checkAbort } = control;
  let snapshot: Project | undefined;
  try {
    checkAbort();
    const live = await workspace.checkpoint();
    checkAbort();
    const version = live.cells.version.value;
    if (expectedVersion !== undefined && version !== expectedVersion)
      return { status: "conflict", version, reason: "The project changed since this version was read." };
    const known = new Set(sessionFor(live).scenes.map((scene) => scene.id));
    const unknown = scenes.find((id) => !known.has(id));
    if (unknown !== undefined) throw new RangeError(`renderSession has no scene with id "${unknown}".`);

    snapshot = renderSnapshot(live);
    for (const track of snapshot.tracks) for (const clip of [...track.clips]) snapshot.removeClip(clip.id);
    const grid = sessionFor(snapshot);
    const tempo = snapshot.tempoMap;
    const [numerator, denominator] = snapshot.signature;
    const barBeats = (numerator * 4) / denominator;
    const sampleRate = workspace.context.sampleRate;

    let cursor = 0;
    const starts: number[] = [];
    for (const sceneId of scenes) {
      const startSeconds = tempo.beatToSeconds(cursor);
      starts.push(startSeconds);
      const slots = snapshot.tracks.flatMap((track) => {
        const clip = grid.clipAt({ trackId: track.id, sceneId });
        return clip && clip.duration > 0 ? [{ slot: { trackId: track.id, sceneId }, clip }] : [];
      });
      // One pass of a slot clip in beats: a MIDI loop ends its pass at the loop end; audio lasts its duration at this point of the tempo map.
      const passBeats = (clip: ProjectClip) =>
        clip.kind === "midi"
          ? clip.loop
            ? Math.min(clip.loop.endBeat, clip.duration)
            : clip.duration
          : tempo.secondsToBeat(startSeconds + clip.duration) - cursor;
      const longest = Math.max(0, ...slots.map(({ clip }) => passBeats(clip)));
      const end = cursor + (longest > EPS ? longest : barBeats);
      const endSeconds = tempo.beatToSeconds(end);
      for (const { slot, clip } of slots) {
        if (clip.kind === "midi") {
          const pass = passBeats(clip);
          for (let at = cursor; at < end - EPS; at += pass) {
            const copy = grid.copyToArrangement(slot, { atBeat: at });
            const stop = Math.min(at + pass, end);
            if (Math.abs(copy.time + copy.duration - stop) > EPS) snapshot.resizeClip(copy.id, { end: stop });
          }
        } else {
          for (let at = startSeconds; at < endSeconds - EPS; at += clip.duration) {
            const copy = grid.copyToArrangement(slot, { atSeconds: at });
            const stop = Math.min(at + clip.duration, endSeconds);
            if (copy.time + copy.duration > stop + EPS) snapshot.resizeClip(copy.id, { end: stop });
          }
        }
      }
      cursor = end;
    }

    const totalSeconds = tempo.beatToSeconds(cursor) + tailSeconds;
    const frames = Math.max(1, Math.round(totalSeconds * sampleRate));
    const channels = await renderSnapshotFrames(workspace, snapshot, control, 0, frames);
    return {
      status: "rendered",
      version,
      audio: { sampleRate, channels },
      durationSeconds: frames / sampleRate,
      starts,
      peakDbFS: peakDbFS(channels),
      loudnessLUFS: integratedLoudness(channels, sampleRate),
    };
  } finally {
    control.dispose();
    snapshot?.dispose();
  }
}
