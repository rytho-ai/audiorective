import { renderSnapshot, type Project } from "./model";
import type { PCMData } from "@audiorective/core";
import { integratedLoudness, measureSeam, peakDbFS } from "./internal/mix-measure";
import type { BeatRange, ProjectVersion, TimeRange } from "./project-edits";
import { timeRangeKind } from "./ripple-delete";
import { RenderControl, renderSnapshotFrames } from "./offline-render";
import type { Workspace } from "./runtime";

export type MixRangeOptions = Readonly<{
  /** The version to hear. Another current version returns `conflict` without rendering. */
  expectedVersion: ProjectVersion;
  /** Half-open beats or seconds of the full mix to return. Seconds convert to beats through the live project's tempo map when rendering. */
  range: TimeRange;
  /**
   * Seconds rendered before the range and discarded, so reverbs and delays are already ringing. Default: 2, or back to the first MIDI clip
   * when one starts earlier, because held notes and controllers need their history. A shorter value sets `historyTruncated`.
   */
  prerollSeconds?: number;
  /** Project-beat positions to check for clicks, including either range boundary; omitted for no seam checks. */
  seamBeats?: readonly number[];
  /**
   * Hear only these tracks, by id. Each still sounds through its own devices, instruments, inserts, volume, pan and automation, the bus it outputs to and the master,
   * so the audio equals a live solo of the same tracks. Send returns (effect buses fed by a selected track) are included, as in a solo; selecting a bus track also
   * brings in the tracks that feed it. A muted track stays silent, because mute wins over solo, and the project's own solo flags are ignored for this render.
   * Peak, loudness and seams measure the sum of what sounds. The live project, playback and its version are untouched. Default: every track, with the project's own mute and solo.
   * Throws a `RangeError` for an empty list or an id that is not a track.
   */
  trackIds?: readonly string[];
  /** Cancels the offline render with AbortError; omitted to render until completion. */
  signal?: AbortSignal;
}>;

export type MixSeam = Readonly<{
  /** Requested seam position in project beats, including either boundary of the rendered range. */
  beat: number;
  /** Zero-based sample frame per channel in audio; the range-end seam equals its frame count. */
  frame: number;
  /** Largest absolute sample-to-sample amplitude step within 0.002 seconds of the seam. */
  jump: number;
  /** Largest absolute amplitude step within 0.05 seconds, outside the central 0.002 seconds. */
  localJump: number;
  /** The seam stands out from its surroundings: a click, or a hard attack placed exactly there. */
  hasClick: boolean;
}>;

export type MixRangeResult = Readonly<
  | {
      /** Outcome tag; rendered carries audio and conflict carries the current version without rendering. */
      status: "rendered";
      /** Project version captured for rendering, or the current version when a conflict prevents rendering. */
      version: ProjectVersion;
      /** Inclusive project-second start of the returned audio, rounded to the nearest sample frame. */
      startSeconds: number;
      /** Returned audio duration in seconds, after rounding both range edges to sample frames. */
      durationSeconds: number;
      /** Stereo PCM of exactly the range. */
      audio: PCMData;
      /** Sample peak in dBFS; null for digital silence. */
      peakDbFS: number | null;
      /** BS.1770 gated integrated loudness in LUFS; null below 0.4 seconds or for silence. */
      loudnessLUFS: number | null;
      /** Measurements in requested seamBeats order; empty when no seams were requested. */
      seams: readonly MixSeam[];
      /** MIDI started before the rendered audio, so held notes and controllers in this range may be missing. */
      historyTruncated: boolean;
    }
  | {
      /** Outcome tag; rendered carries audio and conflict carries the current version without rendering. */
      status: "conflict";
      /** Project version captured for rendering, or the current version when a conflict prevents rendering. */
      version: ProjectVersion;
      /** Human-readable explanation of the version conflict; no audio was rendered. */
      reason: string;
    }
>;

const SEAM_MARGIN_SECONDS = 0.06;

/** Render one beat range of the mix offline, through every device and effect (all tracks, or only `trackIds`), and measure it. Playback is not interrupted. */
export async function renderMixRange(workspace: Workspace, options: MixRangeOptions): Promise<MixRangeResult> {
  const { expectedVersion, prerollSeconds, seamBeats = [], signal } = options;
  if (!timeRangeKind(options.range))
    throw new RangeError("renderMixRange needs a range with 0 <= startBeat < endBeat or 0 <= startSeconds < endSeconds.");
  if (prerollSeconds !== undefined && (!Number.isFinite(prerollSeconds) || prerollSeconds < 0))
    throw new RangeError("renderMixRange prerollSeconds must be finite and non-negative.");
  const { trackIds } = options;
  if (trackIds !== undefined && (!Array.isArray(trackIds) || trackIds.length === 0 || trackIds.some((id) => typeof id !== "string")))
    throw new RangeError("renderMixRange trackIds must be a non-empty list of track IDs.");
  const control = new RenderControl("renderMixRange", signal);
  const { checkAbort } = control;
  let snapshot: Project | undefined;
  try {
    checkAbort();
    const live = await workspace.checkpoint();
    checkAbort();
    const version = live.cells.version.value;
    if (version !== expectedVersion) return { status: "conflict", version, reason: "The project changed since this version was read." };

    if (trackIds) {
      const known = new Set(live.tracks.map((track) => track.id));
      const unknown = trackIds.find((id) => !known.has(id));
      if (unknown !== undefined) throw new RangeError(`renderMixRange has no track with id "${unknown}".`);
    }

    const sampleRate = workspace.context.sampleRate;
    const tempo = live.tempoMap;
    const range: BeatRange =
      "startSeconds" in options.range
        ? { startBeat: tempo.secondsToBeat(options.range.startSeconds), endBeat: tempo.secondsToBeat(options.range.endSeconds) }
        : options.range;
    if (seamBeats.some((beat) => !Number.isFinite(beat) || beat < range.startBeat || beat > range.endBeat))
      throw new RangeError("renderMixRange seamBeats must lie inside the range.");
    const startFrame = Math.round(tempo.beatToSeconds(range.startBeat) * sampleRate);
    const endFrame = Math.round(tempo.beatToSeconds(range.endBeat) * sampleRate);
    if (endFrame <= startFrame) throw new RangeError("renderMixRange needs a range at least one frame long.");
    const firstMidiSeconds = Math.min(
      Infinity,
      ...live.tracks.flatMap((track) => track.clips.flatMap((clip) => (clip.kind === "midi" ? [tempo.beatToSeconds(clip.time)] : []))),
    );
    const firstMidiFrame = firstMidiSeconds === Infinity ? Infinity : Math.floor(firstMidiSeconds * sampleRate);
    const defaultFirst = Math.min(startFrame - Math.round(2 * sampleRate), firstMidiFrame);
    const firstFrame = Math.max(0, prerollSeconds === undefined ? defaultFirst : startFrame - Math.round(prerollSeconds * sampleRate));
    // Seams are judged against the audio on both sides. Frames after the range cannot change it; earlier ones could, so they get their own render.
    const margin = seamBeats.length ? Math.ceil(SEAM_MARGIN_SECONDS * sampleRate) : 0;
    const seamFirstFrame = Math.min(firstFrame, Math.max(0, startFrame - margin));
    const rendering = (snapshot = renderSnapshot(live));
    if (trackIds) {
      const chosen = new Set(trackIds);
      for (const track of rendering.tracks) rendering.setTrackSolo(track.id, chosen.has(track.id));
    }
    const renderFrames = (from: number, frameCount: number) => renderSnapshotFrames(workspace, rendering, control, from, frameCount);

    const rendered = await renderFrames(firstFrame, endFrame + margin - firstFrame);
    const offset = startFrame - firstFrame;
    const channels = rendered.map((channel) => channel.slice(offset, offset + endFrame - startFrame));
    const seamAudio =
      seamBeats.length && seamFirstFrame < firstFrame ? await renderFrames(seamFirstFrame, endFrame + margin - seamFirstFrame) : rendered;
    const seamOrigin = seamAudio === rendered ? firstFrame : seamFirstFrame;
    const seams = seamBeats.map((beat) => {
      const absolute = Math.round(tempo.beatToSeconds(beat) * sampleRate);
      return { beat, frame: absolute - startFrame, ...measureSeam(seamAudio, absolute - seamOrigin, sampleRate) };
    });
    return {
      status: "rendered",
      version,
      startSeconds: startFrame / sampleRate,
      durationSeconds: channels[0].length / sampleRate,
      audio: { sampleRate, channels },
      peakDbFS: peakDbFS(channels),
      loudnessLUFS: integratedLoudness(channels, sampleRate),
      seams,
      historyTruncated: firstMidiFrame < firstFrame,
    };
  } finally {
    control.dispose();
    snapshot?.dispose();
  }
}
