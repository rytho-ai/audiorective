import { resamplePCM, type PCMData } from "@audiorective/core";
import { decodeWav } from "./internal/wav";
import { xmlSafeName } from "./midi-file";
import { RenderControl, renderSnapshotFrames } from "./offline-render";
import { renderSnapshot, type Project, type ProjectAudio, type ProjectTrack } from "./model";
import type { ProjectVersion, TimeRange } from "./project-edits";
import { timeRangeKind } from "./ripple-delete";
import type { Workspace } from "./runtime";

/** A file to import: a `File` or `Blob` from an input or a drop, or bytes with the name to give the track. */
export type AudioFileInput = Blob | File | Readonly<{ name: string; bytes: Uint8Array }>;

export type ImportAudioFilesOptions = Readonly<{
  /** The project beat where every clip starts. Default 0. */
  atBeat?: number;
}>;

export type ImportAudioFilesResult = Readonly<{
  /** The new audio tracks in file order, as the project holds them after the import. */
  tracks: readonly ProjectTrack[];
  /** The Workspace's sample rate, which every clip now has. */
  sampleRate: number;
}>;

async function decode(workspace: Workspace, bytes: Uint8Array, label: string): Promise<ProjectAudio> {
  const riff =
    bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  if (riff) {
    try {
      return decodeWav(bytes);
    } catch {
      // A WAV flavour we do not read ends up with the browser's decoder, like any other format.
    }
  }
  try {
    const buffer = await workspace.context.decodeAudioData(bytes.slice().buffer);
    return {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => new Float32Array(buffer.getChannelData(index))),
    };
  } catch {
    throw new Error(`importAudioFiles could not decode "${label}": the browser does not read this audio format.`);
  }
}

/**
 * Adds one audio track and one clip per file to the Workspace's project, named after the file without its extension, all starting at `atBeat`, as one undoable edit.
 * WAV files (8/16/24/32-bit integer, 32/64-bit float) are read directly and resampled to the Workspace's sample rate with core's `resamplePCM` (a Kaiser-windowed sinc), frame 0 to frame 0, so files that start together stay together and their leading silence is kept.
 * Other formats go through the browser's decoder, which already resamples to the Workspace's rate.
 * Adding tracks sets `workspace.cells.needsSync`; the caller runs `await workspace.sync()` before playing.
 */
export async function importAudioFiles(
  workspace: Workspace,
  files: readonly AudioFileInput[],
  options: ImportAudioFilesOptions = {},
): Promise<ImportAudioFilesResult> {
  const atBeat = options.atBeat ?? 0;
  if (!Number.isFinite(atBeat) || atBeat < 0) throw new RangeError("importAudioFiles atBeat must be finite beats >= 0.");
  if (!Array.isArray(files)) throw new TypeError("importAudioFiles needs a list of files.");
  const rate = workspace.context.sampleRate;
  const decoded: { name: string; audio: ProjectAudio }[] = [];
  for (const [index, file] of files.entries()) {
    const given = (file as { name?: unknown }).name;
    const raw = typeof given === "string" ? given : "";
    const bytes =
      file instanceof Blob
        ? new Uint8Array(await file.arrayBuffer())
        : file && (file as { bytes?: unknown }).bytes instanceof Uint8Array
          ? (file as { bytes: Uint8Array }).bytes
          : undefined;
    if (!bytes) throw new TypeError("importAudioFiles takes Blobs, Files or { name, bytes }.");
    const label = raw || `file ${index + 1}`;
    const audio = resamplePCM(await decode(workspace, bytes, label), rate);
    if (!audio.channels[0]?.length) throw new Error(`importAudioFiles found no audio in "${label}".`);
    decoded.push({ name: xmlSafeName(raw.replace(/\.[^./\\]+$/, "")) || `Audio ${index + 1}`, audio });
  }
  const project = workspace.project;
  const created: string[] = [];
  project.edit("Import audio files", () => {
    const seconds = project.tempoMap.beatToSeconds(atBeat);
    for (const { name, audio } of decoded) {
      const track = project.addTrack(name, "audio");
      project.addAudioClip(track.id, audio, seconds, { name });
      created.push(track.id);
    }
  });
  return Object.freeze({ tracks: project.tracks.filter((track) => created.includes(track.id)), sampleRate: rate });
}

export type RenderStemsOptions = Readonly<{
  /** Half-open beats or seconds to render. Default: from 0 to the end of the last clip. */
  range?: TimeRange;
  /** Seconds added after the range so reverbs and delays ring out. Default 2. */
  tailSeconds?: number;
  /** Also return the full mix, rendered the same way. Default true. */
  includeMix?: boolean;
  /** The version to hear. Another current version returns `conflict` without rendering. */
  expectedVersion?: ProjectVersion;
  signal?: AbortSignal;
}>;

export type StemsResult = Readonly<
  | {
      status: "rendered";
      version: ProjectVersion;
      sampleRate: number;
      /** One entry per audio and MIDI track, in track order. A muted track, or a MIDI track with no device and no `instruments` entry, has a silent stem. */
      stems: readonly Readonly<{ trackId: string; name: string; audio: PCMData }>[];
      /** The full mix as heard (mute, solo, sends, buses, master); absent when `includeMix` is false. */
      mix?: PCMData;
      /** The length of every stem and of the mix. */
      durationSeconds: number;
      /** One sentence per silent stem with its reason (muted, or a MIDI track with no instrument or plug-in); empty when every stem can sound. */
      warnings: readonly string[];
    }
  | { status: "conflict"; version: ProjectVersion; reason: string }
>;

/**
 * Render each audio and MIDI track of the song to a file of its own, all with the same start and the same length, plus the full mix. The live song keeps playing and is not changed.
 * A stem is the track alone through its own chain (clips, volume and automation, pan, inserts, devices and instruments) and on through the bus it outputs to,
 * so a submix bus's processing and the master volume are in it. Its sends are not: send returns (effect buses) are only in `mix`. Mute applies (a muted track has a silent stem), solo is ignored.
 * Because buses and sends are shared, the stems add up to the mix only when no send, effect bus or non-linear master or bus processing is involved.
 * The result's `audio` is stereo PCM; save it with `encodeWav`.
 */
export async function renderStems(workspace: Workspace, options: RenderStemsOptions = {}): Promise<StemsResult> {
  const { expectedVersion, signal } = options;
  const tailSeconds = options.tailSeconds ?? 2;
  const includeMix = options.includeMix ?? true;
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0) throw new RangeError("renderStems tailSeconds must be finite seconds >= 0.");
  if (options.range !== undefined && !timeRangeKind(options.range))
    throw new RangeError("renderStems needs a range with 0 <= startBeat < endBeat or 0 <= startSeconds < endSeconds.");
  const control = new RenderControl("renderStems", signal);
  const { checkAbort } = control;
  const snapshots: Project[] = [];
  try {
    checkAbort();
    const live = await workspace.checkpoint();
    checkAbort();
    const version = live.cells.version.value;
    if (expectedVersion !== undefined && version !== expectedVersion)
      return { status: "conflict", version, reason: "The project changed since this version was read." };
    const sampleRate = workspace.context.sampleRate;
    const tempo = live.tempoMap;
    let startSeconds = 0;
    let endSeconds = 0;
    if (options.range) {
      const range = options.range;
      if ("startSeconds" in range) [startSeconds, endSeconds] = [range.startSeconds, range.endSeconds];
      else [startSeconds, endSeconds] = [tempo.beatToSeconds(range.startBeat), tempo.beatToSeconds(range.endBeat)];
    } else {
      for (const track of live.tracks)
        for (const clip of track.clips)
          endSeconds = Math.max(endSeconds, clip.kind === "midi" ? tempo.beatToSeconds(clip.time + clip.duration) : clip.time + clip.duration);
    }
    const startFrame = Math.round(startSeconds * sampleRate);
    const frames = Math.round(endSeconds * sampleRate) - startFrame + Math.round(tailSeconds * sampleRate);
    if (frames < 1) throw new RangeError("renderStems needs at least one frame to render: the song is empty and tailSeconds is 0.");
    const render = async (prepare?: (copy: Project) => void) => {
      const copy = renderSnapshot(live);
      snapshots.push(copy);
      prepare?.(copy);
      const channels = await renderSnapshotFrames(workspace, copy, control, startFrame, frames);
      checkAbort();
      snapshots.pop();
      copy.dispose();
      return { sampleRate, channels } satisfies PCMData;
    };
    const stems: { trackId: string; name: string; audio: PCMData }[] = [];
    const warnings: string[] = [];
    const { instruments } = workspace.deviceOptions;
    for (const track of live.tracks) {
      if (track.kind === "bus") continue;
      if (track.muted) warnings.push(`Track "${track.name}" is muted, so its stem is silent.`);
      else if (track.kind === "midi" && !track.devices.length && !(typeof instruments === "function" ? instruments(track) : instruments?.[track.id]))
        warnings.push(`Track "${track.name}" has no instrument or plug-in, so its stem is silent.`);
      const audio = track.muted
        ? { sampleRate, channels: [new Float32Array(frames), new Float32Array(frames)] }
        : await render((copy) => {
            for (const other of copy.tracks) if (other.solo && other.id !== track.id) copy.setTrackSolo(other.id, false);
            copy.setTrackSolo(track.id, true);
            copy.setTrackRouting(track.id, { outputBusId: track.routing.outputBusId, sends: [] });
          });
      stems.push({ trackId: track.id, name: track.name, audio });
    }
    const mix = includeMix ? await render() : undefined;
    return {
      status: "rendered",
      version,
      sampleRate,
      stems,
      ...(mix ? { mix } : {}),
      durationSeconds: frames / sampleRate,
      warnings,
    };
  } finally {
    control.dispose();
    for (const copy of snapshots) copy.dispose();
  }
}
