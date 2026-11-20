import { AudioRecorder } from "@audiorective/recorder";
import type { AudioMedia } from "./media";
import type { Project } from "./model";
import { createOpfsAudioMediaWriter } from "./opfs-media";
import { Workspace } from "./runtime";
import { writeStoredZip } from "./internal/stored-zip";
import type { StoredZipEntry } from "./internal/stored-zip";
import { wavMediaStereoPairEntry } from "./internal/wav";

export type AudioFallbackOptions = Readonly<{
  /** Captures effects after the final clip; default one second. */
  tailSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}>;

/** Render mix and post-mixer track stems in real time to a companion ZIP of float32 WAVs. */
export async function exportAudioFallbackTo(
  workspace: Workspace,
  destination: WritableStream<Uint8Array>,
  options: AudioFallbackOptions = {},
): Promise<void> {
  const tail = options.tailSeconds ?? 1;
  if (!Number.isFinite(tail) || tail < 0 || tail > 60) throw new RangeError("Workspace audio fallback tail must be from 0 to 60 seconds.");
  const signal = options.signal;
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Workspace audio fallback was cancelled.", "AbortError");
  };
  let project: Project | undefined;
  let context: AudioContext | undefined;
  let recorder: AudioRecorder | undefined;
  let mediaWriter: Awaited<ReturnType<typeof createOpfsAudioMediaWriter>> | undefined;
  let media: AudioMedia | undefined;
  let render: Workspace | undefined;
  let archiveStarted = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const cancel = () => recorder?.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    checkAbort();
    await workspace.flush();
    const renderProject = (await workspace.checkpoint()).snapshot();
    project = renderProject;
    context = new AudioContext({ sampleRate: workspace.context.sampleRate });
    const renderContext = context;
    await context.resume();
    render = await Workspace.create(context, renderProject, workspace.deviceOptions);
    if (render.warnings.length) throw new Error(`Workspace audio fallback has unresolved devices: ${render.warnings.join(" ")}`);
    const stemTracks = renderProject.tracks.length <= 15 ? renderProject.tracks : [];
    const buses = [
      { path: "mix.wav", node: render.output },
      ...stemTracks.map((track) => ({
        path: `tracks/${track.id}.wav`,
        node: render!.trackMixerOutput(track.id)!,
      })),
    ];
    const channels = buses.length * 2;
    const merger = context.createChannelMerger(channels);
    for (let index = 0; index < buses.length; index++) {
      const splitter = context.createChannelSplitter(2);
      buses[index].node.connect(splitter);
      splitter.connect(merger, 0, index * 2);
      splitter.connect(merger, 1, index * 2 + 1);
    }
    recorder = new AudioRecorder(context, { channels });
    merger.connect(recorder.input);
    mediaWriter = await createOpfsAudioMediaWriter(context.sampleRate, channels);
    await recorder.ready;
    checkAbort();
    await recorder.startStream((chunk) => mediaWriter!.writeChunk(chunk));
    checkAbort();
    // Let recorder worklet startup settle before project time zero.
    await new Promise((resolve) => setTimeout(resolve, 250));
    checkAbort();
    await render.play();
    checkAbort();
    const origin = render.timeline.beatToTime(0);
    const duration = Math.max(workspace.duration, 0.1) + tail;
    const originFrame = Math.ceil(origin * context.sampleRate);
    const endFrame = Math.ceil((origin + duration) * context.sampleRate);
    progressTimer = setInterval(() => options.onProgress?.(Math.min(1, Math.max(0, (renderContext.currentTime - origin) / duration))), 250);
    const span = await recorder.stopStream({ when: origin + duration });
    clearInterval(progressTimer);
    progressTimer = undefined;
    checkAbort();
    if (span.dropouts?.some((gap) => gap.startFrame < endFrame && gap.endFrame > originFrame))
      throw new Error("Workspace audio fallback lost audio frames during the project; retry the export.");
    media = await mediaWriter.finish(span);
    const startFrame = originFrame - span.startFrame;
    const frameCount = endFrame - originFrame;
    if (startFrame < 0 || startFrame + frameCount > media.frameCount) throw new Error("Workspace audio fallback missed the project start or end.");
    const files: StoredZipEntry[] = buses.map((bus, index) => wavMediaStereoPairEntry(bus.path, media!, startFrame, frameCount, index));
    const manifest = new TextEncoder().encode(
      JSON.stringify(
        {
          format: "audiorective-audio-fallback",
          version: 1,
          title: renderProject.title,
          sampleRate: context.sampleRate,
          durationSeconds: (endFrame - originFrame) / context.sampleRate,
          mix: "mix.wav",
          tracks: stemTracks.map((track) => ({ id: track.id, name: track.name, path: `tracks/${track.id}.wav` })),
          stemsOmitted: renderProject.tracks.length > 15,
        },
        null,
        2,
      ),
    );
    files.push({
      path: "manifest.json",
      size: manifest.length,
      async *chunks() {
        yield manifest;
      },
    });
    checkAbort();
    archiveStarted = true;
    await writeStoredZip(files, destination, signal);
    options.onProgress?.(1);
  } catch (error) {
    if (!archiveStarted) await destination.abort(error).catch(() => undefined);
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    signal?.removeEventListener("abort", cancel);
    cancel();
    recorder?.dispose();
    await mediaWriter?.abort();
    await media?.dispose();
    render?.dispose();
    project?.dispose();
    await context?.close();
  }
}
