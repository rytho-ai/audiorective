import { renderSnapshot } from "./model";
import { ManualTickSource } from "@audiorective/clock";
import { AudioRecorder, type RecordedAudioSpan } from "@audiorective/recorder";
import type { AudioMedia } from "./media";
import type { Project } from "./model";
import { createOpfsAudioMediaWriter } from "./opfs-media";
import { Workspace } from "./runtime";
import { writeStoredZip } from "./internal/stored-zip";
import type { StoredZipEntry } from "./internal/stored-zip";
import { wavMediaStereoPairEntry } from "./internal/wav";

export type AudioFallbackOptions = Readonly<{
  /** Effect tail after the final clip in seconds, 0..60; default 1. */
  tailSeconds?: number;
  /** Cancels rendering and archive writing; omitted to run until completion. */
  signal?: AbortSignal;
  /** Receives render progress from 0 to 1, with 1 after the archive is written; omitted for no notifications. */
  onProgress?: (fraction: number) => void;
}>;

/** Web Audio's render quantum; `OfflineAudioContext.suspend` pauses on these boundaries. */
const RENDER_QUANTUM = 128;
/** Seconds of audio between transport ticks; below the workspace clock's 0.15 s look-ahead, as live. */
const TICK_INTERVAL = 0.025;
/** The recorder posts at most 4096 frames per chunk and fails a take with 64 writes pending. */
const CHUNK_FRAMES = 4096;
/** Frames the render may run ahead of the OPFS writer before it waits. */
const MAX_WRITE_LAG = 16 * CHUNK_FRAMES;

/**
 * Render mix and post-mixer track stems offline to a companion ZIP of float32 WAVs.
 * An `OfflineAudioContext` renders the project in steps that match the transport's tick interval. Between steps the render is suspended while
 * media chunks load, device messages land and the OPFS writer catches up, so contention on the main thread cannot drop frames.
 */
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
  let context: OfflineAudioContext | undefined;
  let recorder: AudioRecorder | undefined;
  let recording: Promise<RecordedAudioSpan> | undefined;
  let mediaWriter: Awaited<ReturnType<typeof createOpfsAudioMediaWriter>> | undefined;
  let media: AudioMedia | undefined;
  let render: Workspace | undefined;
  let rendering: Promise<unknown> | undefined;
  let archiveStarted = false;
  let wake: (() => void) | undefined;
  // Settles the first reason to stop (cancellation or a failed writer), so every wait in the render loop can race it.
  let interrupt!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => (interrupt = reject));
  interrupted.catch(() => undefined);
  const cancel = () => {
    interrupt(new DOMException("Workspace audio fallback was cancelled.", "AbortError"));
    recorder?.cancel();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    checkAbort();
    await workspace.flush();
    const renderProject = renderSnapshot(await workspace.checkpoint());
    project = renderProject;
    const sampleRate = workspace.context.sampleRate;
    const duration = Math.max(workspace.duration, 0.1) + tail;
    const frameCount = Math.ceil(duration * sampleRate);
    // The destination only has to exist: stems stream through the recorder. One more quantum lets the recorder see the frame after its last.
    const refused = (error: unknown) =>
      new Error(`Workspace audio fallback could not start an offline render of ${duration.toFixed(1)} seconds: ${String(error)}`);
    try {
      context = new OfflineAudioContext(1, frameCount + RENDER_QUANTUM, sampleRate);
    } catch (error) {
      throw refused(error);
    }
    const offline = context;
    const ticks = new ManualTickSource();
    render = await Workspace.create(offline as unknown as AudioContext, renderProject, { ...workspace.deviceOptions, tickSource: ticks });
    if (render.cells.warnings.value.length)
      throw new Error(`Workspace audio fallback has unresolved devices: ${render.cells.warnings.value.join(" ")}`);
    const stemTracks = renderProject.tracks.length <= 15 ? renderProject.tracks : [];
    const buses = [
      { path: "mix.wav", node: render.output },
      ...stemTracks.map((track) => ({
        path: `tracks/${track.id}.wav`,
        node: render!.trackMixerOutput(track.id)!,
      })),
    ];
    const channels = buses.length * 2;
    const merger = offline.createChannelMerger(channels);
    for (let index = 0; index < buses.length; index++) {
      const splitter = offline.createChannelSplitter(2);
      buses[index].node.connect(splitter);
      splitter.connect(merger, 0, index * 2);
      splitter.connect(merger, 1, index * 2 + 1);
    }
    recorder = new AudioRecorder(offline, { channels });
    merger.connect(recorder.input);
    mediaWriter = await createOpfsAudioMediaWriter(sampleRate, channels);
    await recorder.ready;
    checkAbort();
    let writtenFrames = 0;
    const writer = mediaWriter;
    // The node is built synchronously from here, before rendering starts, so capture begins on frame 0.
    recording = recorder.record({
      when: 0,
      length: frameCount / sampleRate,
      signal,
      onChunk: async (chunk) => {
        await writer.writeChunk(chunk);
        writtenFrames = chunk.startFrame + chunk.channels[0].length;
        wake?.();
      },
    });
    recording.catch(interrupt);
    const hold = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, interrupted]);
    // Waits until `done()`, woken by each finished write.
    const until = async (done: () => boolean) => {
      while (!done()) await hold(new Promise<void>((resolve) => (wake = resolve)));
    };
    await render.play();
    ticks.tick();
    await hold(render.renderSettled());
    let tickIndex = 1;
    let previous = 0;
    const nextStop = (): number | undefined => {
      previous = Math.max(Math.ceil((tickIndex++ * TICK_INTERVAL * sampleRate) / RENDER_QUANTUM) * RENDER_QUANTUM, previous + RENDER_QUANTUM);
      return previous < frameCount ? previous : undefined;
    };
    // Ask for a time inside the quantum below the target so rounding cannot move the stop one quantum later.
    const suspendAt = (frame: number) => offline.suspend((frame - RENDER_QUANTUM / 2) / sampleRate);
    let stop = nextStop();
    let suspended = stop === undefined ? undefined : suspendAt(stop);
    suspended?.catch(() => undefined);
    // Browsers may accept the context and refuse its buffer only here.
    rendering = offline.startRendering().catch((error: unknown) => {
      throw error instanceof DOMException && error.name === "NotSupportedError" ? refused(error) : error;
    });
    void rendering.catch(() => undefined);
    let reported = 0;
    while (stop !== undefined && suspended) {
      await hold(Promise.race([suspended, rendering]));
      checkAbort();
      ticks.tick();
      await hold(render.renderSettled());
      const reachedFrames = stop;
      await until(() => reachedFrames - writtenFrames <= MAX_WRITE_LAG);
      const progress = Math.min(1, reachedFrames / frameCount);
      if (progress - reported >= 0.01) {
        reported = progress;
        options.onProgress?.(progress);
      }
      stop = nextStop();
      suspended = stop === undefined ? undefined : suspendAt(stop);
      suspended?.catch(() => undefined);
      await offline.resume();
    }
    await hold(rendering);
    const span = await hold(recording);
    checkAbort();
    if (span.dropouts?.some((gap) => gap.startFrame < frameCount && gap.endFrame > 0))
      throw new Error("Workspace audio fallback lost audio frames during the project; retry the export.");
    media = await mediaWriter.finish(span);
    if (span.startFrame !== 0 || span.endFrame < frameCount || media.frameCount < frameCount)
      throw new Error("Workspace audio fallback missed the project start or end.");
    const files: StoredZipEntry[] = buses.map((bus, index) => wavMediaStereoPairEntry(bus.path, media!, 0, frameCount, index));
    const manifest = new TextEncoder().encode(
      JSON.stringify(
        {
          format: "audiorective-audio-fallback",
          version: 1,
          title: renderProject.title,
          sampleRate,
          durationSeconds: frameCount / sampleRate,
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
    signal?.removeEventListener("abort", cancel);
    cancel();
    await recording?.catch(() => undefined);
    recorder?.dispose();
    await mediaWriter?.abort();
    await media?.dispose();
    render?.dispose();
    project?.dispose();
    // An unfinished offline render stays suspended until it is resumed; with the graph gone it runs out quickly.
    if (rendering && context?.state === "suspended") await context.resume().catch(() => undefined);
  }
}
