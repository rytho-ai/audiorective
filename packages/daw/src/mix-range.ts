import { renderSnapshot } from "./model";
import { ManualTickSource } from "@audiorective/clock";
import type { PCMData } from "@audiorective/core";
import { integratedLoudness, measureSeam, peakDbFS } from "./internal/mix-measure";
import type { BeatRange, ProjectVersion } from "./project-edits";
import { Workspace } from "./runtime";

export type MixRangeOptions = Readonly<{
  /** The version to hear. Another current version returns `conflict` without rendering. */
  expectedVersion: ProjectVersion;
  /** Half-open beats of the full mix to return. */
  range: BeatRange;
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

const RENDER_QUANTUM = 128;
const TICK_INTERVAL = 0.025;
const SEAM_MARGIN_SECONDS = 0.06;

/** Render one beat range of the full mix offline, through every device and effect, and measure it. Playback is not interrupted. */
export async function renderMixRange(workspace: Workspace, options: MixRangeOptions): Promise<MixRangeResult> {
  const { expectedVersion, range, prerollSeconds, seamBeats = [], signal } = options;
  if (!range || !Number.isFinite(range.startBeat) || !Number.isFinite(range.endBeat) || range.startBeat < 0 || range.startBeat >= range.endBeat)
    throw new RangeError("renderMixRange needs a range with 0 <= startBeat < endBeat.");
  if (prerollSeconds !== undefined && (!Number.isFinite(prerollSeconds) || prerollSeconds < 0))
    throw new RangeError("renderMixRange prerollSeconds must be finite and non-negative.");
  if (seamBeats.some((beat) => !Number.isFinite(beat) || beat < range.startBeat || beat > range.endBeat))
    throw new RangeError("renderMixRange seamBeats must lie inside the range.");
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("renderMixRange was cancelled.", "AbortError");
  };
  checkAbort();
  const live = await workspace.checkpoint();
  checkAbort();
  const version = live.cells.version.value;
  if (version !== expectedVersion) return { status: "conflict", version, reason: "The project changed since this version was read." };

  const sampleRate = workspace.context.sampleRate;
  const tempo = live.tempoMap;
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
  const snapshot = renderSnapshot(live);
  let interrupt!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => (interrupt = reject));
  interrupted.catch(() => undefined);
  const cancel = () => interrupt(new DOMException("renderMixRange was cancelled.", "AbortError"));
  signal?.addEventListener("abort", cancel, { once: true });
  const hold = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interrupted]);

  const renderFrames = async (from: number, frameCount: number): Promise<Float32Array[]> => {
    const context = new OfflineAudioContext(2, frameCount, sampleRate);
    const ticks = new ManualTickSource();
    let render: Workspace | undefined;
    let rendering: Promise<AudioBuffer> | undefined;
    try {
      const creating = Workspace.create(context as unknown as AudioContext, snapshot, {
        ...workspace.deviceOptions,
        destination: context.destination,
        tickSource: ticks,
      });
      creating.then((created) => (signal?.aborted ? created.dispose() : undefined)).catch(() => undefined);
      render = await hold(creating);
      if (render.warnings.length) throw new Error(`renderMixRange has unresolved devices: ${render.warnings.join(" ")}`);
      render.seek(from / sampleRate);
      await hold(render.play());
      ticks.tick();
      await hold(render.renderSettled());
      let tickIndex = 1;
      let previous = 0;
      const nextStop = (): number | undefined => {
        previous = Math.max(Math.ceil((tickIndex++ * TICK_INTERVAL * sampleRate) / RENDER_QUANTUM) * RENDER_QUANTUM, previous + RENDER_QUANTUM);
        return previous < frameCount ? previous : undefined;
      };
      const suspendAt = (frame: number) => context.suspend((frame - RENDER_QUANTUM / 2) / sampleRate);
      let stop = nextStop();
      let suspended = stop === undefined ? undefined : suspendAt(stop);
      suspended?.catch(() => undefined);
      rendering = context.startRendering();
      void rendering.catch(() => undefined);
      while (stop !== undefined && suspended) {
        await hold(Promise.race([suspended, rendering]));
        checkAbort();
        ticks.tick();
        await hold(render.renderSettled());
        stop = nextStop();
        suspended = stop === undefined ? undefined : suspendAt(stop);
        suspended?.catch(() => undefined);
        await context.resume();
      }
      const buffer = await hold(rendering);
      checkAbort();
      return [buffer.getChannelData(0), buffer.getChannelData(1)];
    } finally {
      render?.dispose();
      if (rendering && context.state === "suspended") await context.resume().catch(() => undefined);
    }
  };

  try {
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
    signal?.removeEventListener("abort", cancel);
    snapshot.dispose();
  }
}
