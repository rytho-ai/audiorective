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
  /** Beats inside `range` to check for clicks, such as the joins of an edit. */
  seamBeats?: readonly number[];
  signal?: AbortSignal;
}>;

export type MixSeam = Readonly<{
  beat: number;
  /** Frame in `audio`. */
  frame: number;
  /** Largest sample-to-sample step within 2 ms of the seam. */
  jump: number;
  /** Largest step in the 50 ms around it, outside those 2 ms. */
  localJump: number;
  /** The seam stands out from its surroundings: a click, or a hard attack placed exactly there. */
  hasClick: boolean;
}>;

export type MixRangeResult = Readonly<
  | {
      status: "rendered";
      version: ProjectVersion;
      startSeconds: number;
      durationSeconds: number;
      /** Stereo PCM of exactly the range. */
      audio: PCMData;
      /** `null` for digital silence. */
      peakDbFS: number | null;
      /** BS.1770 gated loudness; `null` under 400 ms or silent. */
      loudnessLUFS: number | null;
      seams: readonly MixSeam[];
      /** MIDI started before the rendered audio, so held notes and controllers in this range may be missing. */
      historyTruncated: boolean;
    }
  | { status: "conflict"; version: ProjectVersion; reason: string }
>;

const SEAM_MARGIN_SECONDS = 0.06;

/** Render one beat range of the full mix offline, through every device and effect, and measure it. Playback is not interrupted. */
export async function renderMixRange(workspace: Workspace, options: MixRangeOptions): Promise<MixRangeResult> {
  const { expectedVersion, prerollSeconds, seamBeats = [], signal } = options;
  if (!timeRangeKind(options.range))
    throw new RangeError("renderMixRange needs a range with 0 <= startBeat < endBeat or 0 <= startSeconds < endSeconds.");
  if (prerollSeconds !== undefined && (!Number.isFinite(prerollSeconds) || prerollSeconds < 0))
    throw new RangeError("renderMixRange prerollSeconds must be finite and non-negative.");
  const control = new RenderControl("renderMixRange", signal);
  const { checkAbort } = control;
  let snapshot: Project | undefined;
  try {
    checkAbort();
    const live = await workspace.checkpoint();
    checkAbort();
    const version = live.cells.version.value;
    if (version !== expectedVersion) return { status: "conflict", version, reason: "The project changed since this version was read." };

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
