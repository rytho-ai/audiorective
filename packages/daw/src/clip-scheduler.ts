import { stopSource } from "./internal/playback-gain";
import type { TickWindow, Timeline } from "@audiorective/clock";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import { clipGainAt } from "./clip-envelope";
import { scheduleClipEnvelope } from "./schedule-clip-envelope";
import { audioClipTimeMap } from "./model";
import type { AudioClip, AudioClipGainAutomation, PcmAudioClip } from "./model";
import type { AudioMedia } from "./media";
import type { WebClapHost } from "@audiorective/host/webclap";
import type { TempoMap } from "./tempo-map";
import { audioChunkSeconds, type AudioClipWindow, type AudioHandle, type TrackRuntime } from "./track-runtime";

/**
 * Turns clips into scheduled Web Audio sources: arrangement windows, media chunk loading and
 * decoded-buffer caches. It owns every scheduled handle of the arrangement transport and holds no
 * Project state; callers pass the clips, tracks and timing they want scheduled.
 */
export class ClipScheduler {
  private readonly scheduled = new Map<string, AudioHandle>();
  private readonly audioBuffers = new WeakMap<PcmAudioClip["channels"], AudioBuffer>();
  private readonly sessionAudioBuffers = new WeakMap<PcmAudioClip, AudioBuffer>();
  private readonly mediaBuffers = new WeakMap<AudioMedia, Map<string, Promise<AudioBuffer>>>();
  /**
   * Clips whose media read failed. An entry skips its clip (`skipping`) for the rest of one playback run, so a bad file is reported once instead of
   * re-read every tick; `retryFailures()` lifts the skip at the next explicit play or seek, and a read that then succeeds removes the entry. The
   * entry belongs to the clip object that failed, so a replaced clip with the same ID starts clean.
   */
  private readonly failures = new Map<string, { clip: AudioClip; error: Error; skipping: boolean }>();
  /** Media sources still waiting for their chunk, so an offline render can hold until what a window needs is scheduled. */
  private readonly loading = new Set<Promise<void>>();
  /** Devices that were sent MIDI since the last `settled()`. */
  private readonly messaged = new Set<WebClapHost>();

  constructor(
    private readonly context: AudioContext,
    /** Called with the first outstanding failure, or null once none remains. */
    private readonly reportError: (error: Error | null) => void,
  ) {}

  /** Schedule one tick window of every track's MIDI events and audio clips. */
  scheduleArrangement(tracks: Iterable<TrackRuntime>, window: TickWindow<Record<never, never>>, map: TempoMap, timeline: Timeline): void {
    tracks = [...tracks];
    this.prune(tracks);
    const span: AudioClipWindow = {
      start: map.beatToSeconds(window.beat.start),
      end: map.beatToSeconds(window.beat.end),
      stop: Infinity,
      audioTime: (seconds) => timeline.beatToTime(map.secondsToBeat(seconds)),
      keyPrefix: "",
    };
    // Request file-backed chunks before the ordinary MIDI and PCM look-ahead.
    const mediaSpan = { ...span, end: map.beatToSeconds(timeline.timeToBeat(window.time.lookAheadEnd + 0.35)) };
    for (const runtime of tracks) {
      for (const clip of runtime.clips) {
        if (clip.kind === "midi") {
          if (!runtime.midiHost) continue;
          for (const event of clip.playbackEvents()) {
            const beat = clip.time + event.beat;
            if (beat < window.beat.start - 1e-8 || beat >= window.beat.end - 1e-8) continue;
            const when = timeline.beatToTime(beat);
            window.own(runtime.midiHost.scheduleMidi(event.data, when), when);
            this.messaged.add(runtime.midiHost);
          }
        } else {
          this.scheduleAudioClipWindow(
            clip,
            runtime.session?.arrangementInput ?? runtime.input,
            clip.media ? mediaSpan : span,
            window,
            this.scheduled,
          );
        }
      }
    }
  }

  /**
   * Resolves when every media source scheduled so far has its chunk and every device that was sent MIDI has handled it. An offline render awaits this
   * while suspended, so a slow media read or a queued device message cannot land after the render has passed its start time.
   */
  async settled(): Promise<void> {
    while (this.loading.size) await Promise.all([...this.loading]);
    for (const { error, skipping } of this.failures.values()) if (skipping) throw error;
    const hosts = [...this.messaged];
    this.messaged.clear();
    // Port messages are handled in order, so this reply proves the scheduled events arrived.
    await Promise.all(hosts.map((host) => host.messagesHandled()));
  }

  /** Load media needed at the transport boundary before it starts. */
  prefetchMediaAt(tracks: Iterable<TrackRuntime>, position: number): Promise<void> | undefined {
    tracks = [...tracks];
    this.prune(tracks);
    const reads: Promise<AudioBuffer | void>[] = [];
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== "audio" || !clip.media || this.isSkipped(clip) || clip.time >= position + 0.5 || position >= clip.time + clip.duration)
          continue;
        const first = Math.floor(Math.max(0, position - clip.time) / audioChunkSeconds);
        const last = Math.min(Math.ceil(clip.duration / audioChunkSeconds), Math.ceil((position + 0.5 - clip.time) / audioChunkSeconds));
        for (let index = first; index < last; index++)
          reads.push(
            this.loadMediaBuffer(clip, index).then(
              () => this.recovered(clip),
              (error: unknown) => this.mediaError(clip, error),
            ),
          );
      }
    }
    if (reads.length) return Promise.all(reads).then(() => undefined);
  }

  private isSkipped(clip: AudioClip): boolean {
    const failure = this.failures.get(clip.id);
    return failure?.clip === clip && failure.skipping;
  }

  private mediaError(clip: AudioClip, cause: unknown): void {
    if (this.isSkipped(clip)) return;
    const error = new Error(`Audio clip ${clip.id} could not read its media: ${String(cause)}`, { cause });
    this.failures.set(clip.id, { clip, error, skipping: true });
    this.publishFailures();
  }

  /** A read after `retryFailures()` succeeded: the clip is healthy again. A success from before the retry says nothing. */
  private recovered(clip: AudioClip): void {
    const failure = this.failures.get(clip.id);
    if (failure?.clip !== clip || failure.skipping) return;
    this.failures.delete(clip.id);
    this.publishFailures();
  }

  private publishFailures(): void {
    this.reportError(this.failures.values().next().value?.error ?? null);
  }

  /** Let the next read of every failed clip through. Call at an explicit play or seek; the failure stays reported until a read succeeds. */
  retryFailures(): void {
    for (const failure of this.failures.values()) failure.skipping = false;
  }

  /** Drop failures of clips that are no longer in the arrangement (removed or replaced). */
  prune(tracks: Iterable<TrackRuntime>): void {
    if (!this.failures.size) return;
    const live = new Set<AudioClip>();
    for (const track of tracks) for (const clip of track.clips) if (clip.kind === "audio") live.add(clip);
    let changed = false;
    for (const [id, { clip }] of this.failures)
      if (!live.has(clip)) {
        this.failures.delete(id);
        changed = true;
      }
    if (changed) this.publishFailures();
  }

  /** Apply a gain automation edit to already scheduled arrangement sources. */
  setGainAutomation(edits: ReadonlyMap<string, AudioClipGainAutomation | undefined>): void {
    for (const handle of this.scheduled.values()) if (edits.has(handle.clipId)) handle.setGainAutomation(edits.get(handle.clipId));
  }

  cancelAudio(clipIds?: ReadonlySet<string>): void {
    for (const [key, handle] of this.scheduled) {
      if (clipIds && !clipIds.has(handle.clipId)) continue;
      this.scheduled.delete(key);
      handle.cancel();
    }
  }

  /** Forget scheduled handles without cancelling them (their tracks are being disposed). */
  forget(): void {
    this.scheduled.clear();
    if (this.failures.size) {
      this.failures.clear();
      this.publishFailures();
    }
  }

  scheduleAudioClipWindow(
    clip: AudioClip,
    destination: AudioNode,
    span: AudioClipWindow,
    window: TickWindow<Record<never, never>>,
    scheduled: Map<string, AudioHandle>,
  ): void {
    if (clip.time >= span.end || clip.time + clip.duration <= span.start) return;
    const own = (key: string, handle: AudioHandle, when: number) => {
      scheduled.set(key, handle);
      handle.onEnded(() => {
        if (scheduled.get(key) === handle) scheduled.delete(key);
      });
      window.own(handle, when);
    };
    if (clip.media) {
      if (this.isSkipped(clip)) return;
      const framesPerChunk = clip.sampleRate * audioChunkSeconds;
      const first = Math.floor((Math.max(0, span.start - clip.time) * clip.sampleRate) / framesPerChunk);
      const last = Math.min(Math.ceil(clip.frameCount / framesPerChunk), Math.ceil(((span.end - clip.time) * clip.sampleRate) / framesPerChunk));
      for (let index = first; index < last; index++) {
        const key = `${span.keyPrefix}${clip.id}:${index}`;
        if (scheduled.has(key)) continue;
        const chunkTime = clip.time + index * audioChunkSeconds;
        const from = Math.max(chunkTime, span.start);
        const when = span.audioTime(from);
        own(key, this.scheduleMediaAudio(clip, index, destination, when, from - chunkTime, span.stop - chunkTime), when);
      }
    } else {
      const key = `${span.keyPrefix}${clip.id}`;
      if (scheduled.has(key)) return;
      const from = Math.max(clip.time, span.start);
      const when = span.audioTime(from);
      own(key, this.scheduleAudio(clip, destination, when, from - clip.time, span.stop - clip.time), when);
    }
  }

  loadMediaBuffer(clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number }, index: number): Promise<AudioBuffer> {
    const framesPerChunk = clip.sampleRate * audioChunkSeconds;
    const offset = index * framesPerChunk;
    const count = Math.min(framesPerChunk, clip.frameCount - offset);
    if (count < 1) return Promise.reject(new RangeError("Workspace media chunk is outside the clip."));
    let cache = this.mediaBuffers.get(clip.media);
    if (!cache) this.mediaBuffers.set(clip.media, (cache = new Map()));
    const key = `${clip.startFrame + offset}:${count}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = clip.media
      .readFrames(clip.startFrame + offset, count)
      .then((channels) => {
        const buffer = this.context.createBuffer(channels.length, count, clip.sampleRate);
        channels.forEach((samples, channel) => buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, channel));
        return buffer;
      })
      .catch((error: unknown) => {
        cache!.delete(key);
        throw error;
      });
    cache.set(key, pending);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return pending;
  }

  private connectClipSource(
    source: AudioBufferSourceNode,
    destination: AudioNode,
    clip: AudioClip,
    when: number,
    offset: number,
    length: number,
  ): { setAutomation(automation: AudioClipGainAutomation | undefined): void; stop(): void; dispose(): void } {
    let output: AudioNode = source;
    let envelopeGain: GainNode | undefined;
    if (clip.envelope) {
      envelopeGain = this.context.createGain();
      envelopeGain.gain.value = clipGainAt(clip.envelope, clip.duration, offset);
      scheduleClipEnvelope(envelopeGain.gain, clip.envelope, clip.duration, { when, offset, length });
      output = source.connect(envelopeGain);
    }
    const cancellation = this.context.createGain();
    output.connect(cancellation).connect(destination);
    let timeMap: ReturnType<typeof audioClipTimeMap> | undefined;
    let gain: GainNode | undefined;
    let binding: AutomationBinding | undefined;
    const setAutomation = (automation: AudioClipGainAutomation | undefined) => {
      if (!automation) {
        binding?.dispose();
        binding = undefined;
        gain?.gain.setValueAtTime(1, this.context.currentTime);
        return;
      }
      if (!(length > 0)) return;
      timeMap ??= audioClipTimeMap(clip);
      const points = timeMap.projectGain(automation.points, automation.sourceStart);
      if (binding) {
        binding.curve.value = points;
        return;
      }
      if (!gain) {
        gain = this.context.createGain();
        output.disconnect(cancellation);
        output.connect(gain).connect(cancellation);
      }
      binding = new AutomationBinding(this.context, new AutomationCurve(points), audioParamTarget(gain.gain));
      const elapsed = Math.max(0, this.context.currentTime - when);
      const to = offset + length;
      binding.start({ when, from: Math.min(to, offset + elapsed), to });
    };
    return {
      setAutomation,
      stop: () => stopSource(this.context, source, cancellation.gain, when),
      dispose() {
        binding?.dispose();
        envelopeGain?.disconnect();
        gain?.disconnect();
        cancellation.disconnect();
      },
    };
  }

  scheduleMediaAudio(
    clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number },
    index: number,
    destination: AudioNode,
    when: number,
    offset: number,
    endOffset = Infinity,
  ): AudioHandle {
    let cancelled = false;
    let ended = false;
    let source: AudioBufferSourceNode | undefined;
    let stage: ReturnType<ClipScheduler["connectClipSource"]> | undefined;
    let automation = clip.gainAutomation;
    const listeners = new Set<() => void>();
    const releaseOwnership = () => {
      for (const listener of listeners) listener();
      listeners.clear();
    };
    const end = () => {
      if (ended) return;
      ended = true;
      source?.disconnect();
      stage?.dispose();
      releaseOwnership();
    };
    const loading = this.loadMediaBuffer(clip, index)
      .then((buffer) => {
        if (cancelled) return end();
        this.recovered(clip);
        source = this.context.createBufferSource();
        source.buffer = buffer;
        source.onended = end;
        const start = Math.max(when, this.context.currentTime);
        const adjustedOffset = offset + Math.max(0, start - when);
        const length = Math.min(buffer.duration, endOffset) - adjustedOffset;
        if (length <= 0) return end();
        stage = this.connectClipSource(source, destination, clip, start, index * audioChunkSeconds + adjustedOffset, length);
        stage.setAutomation(automation);
        source.start(start, adjustedOffset, length);
      })
      .catch((error: unknown) => {
        if (!cancelled) this.mediaError(clip, error);
        end();
      });
    this.loading.add(loading);
    void loading.finally(() => this.loading.delete(loading));
    return {
      clipId: clip.id,
      setGainAutomation: (next) => {
        automation = next;
        stage?.setAutomation(next);
      },
      cancel: () => {
        if (cancelled || ended) return;
        cancelled = true;
        releaseOwnership();
        if (stage) stage.stop();
        else end();
      },
      onEnded: (listener) => {
        if (ended || cancelled) listener();
        else listeners.add(listener);
      },
    };
  }

  bufferFor(clip: PcmAudioClip): AudioBuffer {
    let buffer = this.audioBuffers.get(clip.channels);
    if (!buffer) {
      buffer = this.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      clip.channels.forEach((samples, index) => buffer!.getChannelData(index).set(samples));
      this.audioBuffers.set(clip.channels, buffer);
    }
    return buffer;
  }

  sessionBufferFor(clip: PcmAudioClip): AudioBuffer {
    const { envelope, gainAutomation } = clip;
    if (!envelope && !gainAutomation) return this.bufferFor(clip);
    let buffer = this.sessionAudioBuffers.get(clip);
    if (!buffer) {
      buffer = this.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      const output = clip.channels.map((_, index) => buffer!.getChannelData(index));
      const curve = gainAutomation && new AutomationCurve(audioClipTimeMap(clip).projectGain(gainAutomation.points, gainAutomation.sourceStart));
      for (let frame = 0; frame < buffer.length; frame++) {
        const time = frame / clip.sampleRate;
        const gain = (envelope ? clipGainAt(envelope, clip.duration, time) : 1) * (curve?.valueAt(time) ?? 1);
        for (let channel = 0; channel < output.length; channel++) output[channel][frame] = clip.channels[channel][frame] * gain;
      }
      this.sessionAudioBuffers.set(clip, buffer);
    }
    return buffer;
  }

  scheduleAudio(clip: PcmAudioClip, destination: AudioNode, when: number, offset: number, endOffset = Infinity): AudioHandle {
    const source = this.context.createBufferSource();
    source.buffer = this.bufferFor(clip);
    const start = Math.max(when, this.context.currentTime);
    const adjustedOffset = Math.min(clip.duration, offset + Math.max(0, start - when));
    const length = Math.max(0, Math.min(clip.duration, endOffset) - adjustedOffset);
    const stage = this.connectClipSource(source, destination, clip, start, adjustedOffset, length);
    stage.setAutomation(clip.gainAutomation);
    let ended = false;
    const listeners = new Set<() => void>();
    const releaseOwnership = () => {
      for (const listener of listeners) listener();
      listeners.clear();
    };
    const end = () => {
      if (ended) return;
      ended = true;
      source.onended = null;
      source.disconnect();
      stage.dispose();
      releaseOwnership();
    };
    source.onended = end;
    source.start(start, adjustedOffset, length);
    let cancelled = false;
    return {
      clipId: clip.id,
      setGainAutomation: (automation) => stage.setAutomation(automation),
      cancel: () => {
        if (ended || cancelled) return;
        cancelled = true;
        releaseOwnership();
        stage.stop();
      },
      onEnded: (listener) => {
        if (ended || cancelled) listener();
        else listeners.add(listener);
      },
    };
  }
}
