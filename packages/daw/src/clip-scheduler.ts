import type { TickWindow, Timeline } from "@audiorective/clock";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";
import { clipGainAt } from "./clip-envelope";
import { scheduleClipEnvelope } from "./schedule-clip-envelope";
import { audioClipTimeMap } from "./model";
import type { AudioClip, AudioClipGainAutomation, PcmAudioClip } from "./model";
import type { AudioMedia } from "./media";
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

  constructor(
    private readonly context: AudioContext,
    private readonly warn: (message: string) => void,
  ) {}

  /** Schedule one tick window of every track's MIDI events and audio clips. */
  scheduleArrangement(tracks: Iterable<TrackRuntime>, window: TickWindow<Record<never, never>>, map: TempoMap, timeline: Timeline): void {
    const span: AudioClipWindow = {
      start: map.beatToSeconds(window.beat.start),
      end: map.beatToSeconds(window.beat.end),
      stop: Infinity,
      audioTime: (seconds) => timeline.beatToTime(map.secondsToBeat(seconds)),
      keyPrefix: "",
    };
    for (const runtime of tracks) {
      for (const clip of runtime.clips) {
        if (clip.kind === "midi") {
          if (!runtime.midiHost) continue;
          for (const event of clip.playbackEvents()) {
            const beat = clip.time + event.beat;
            if (beat < window.beat.start - 1e-8 || beat >= window.beat.end - 1e-8) continue;
            const when = timeline.beatToTime(beat);
            window.own(runtime.midiHost.scheduleMidi(event.data, when), when);
          }
        } else {
          this.scheduleAudioClipWindow(clip, runtime.session?.arrangementInput ?? runtime.input, span, window, this.scheduled);
        }
      }
    }
  }

  /** Load the media chunks that cover `position` so playback starts without a gap. */
  async prefetchMediaAt(tracks: Iterable<TrackRuntime>, position: number): Promise<void> {
    await Promise.all(
      [...tracks].flatMap((track) =>
        track.clips.flatMap((clip) => {
          if (clip.kind !== "audio" || !clip.media || position < clip.time || position >= clip.time + clip.duration) return [];
          const framesPerChunk = clip.sampleRate * audioChunkSeconds;
          const index = Math.floor(((position - clip.time) * clip.sampleRate) / framesPerChunk);
          return [this.loadMediaBuffer(clip, index)];
        }),
      ),
    );
  }

  /** Apply a gain automation edit to already scheduled arrangement sources. */
  setGainAutomation(edits: ReadonlyMap<string, AudioClipGainAutomation | undefined>): void {
    for (const handle of this.scheduled.values()) if (edits.has(handle.clipId)) handle.setGainAutomation(edits.get(handle.clipId));
  }

  cancelAudio(): void {
    for (const handle of this.scheduled.values()) handle.cancel();
    this.scheduled.clear();
  }

  /** Forget scheduled handles without cancelling them (their tracks are being disposed). */
  forget(): void {
    this.scheduled.clear();
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
  ): { setAutomation(automation: AudioClipGainAutomation | undefined): void; dispose(): void } {
    let output: AudioNode = source;
    let envelopeGain: GainNode | undefined;
    if (clip.envelope) {
      envelopeGain = this.context.createGain();
      scheduleClipEnvelope(envelopeGain.gain, clip.envelope, clip.duration, { when, offset, length });
      output = source.connect(envelopeGain);
    }
    output.connect(destination);
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
        output.disconnect(destination);
        output.connect(gain).connect(destination);
      }
      binding = new AutomationBinding(this.context, new AutomationCurve(points), audioParamTarget(gain.gain));
      const elapsed = Math.max(0, this.context.currentTime - when);
      const to = offset + length;
      binding.start({ when, from: Math.min(to, offset + elapsed), to });
    };
    return {
      setAutomation,
      dispose() {
        binding?.dispose();
        envelopeGain?.disconnect();
        gain?.disconnect();
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
    const end = () => {
      if (ended) return;
      ended = true;
      source?.disconnect();
      stage?.dispose();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    void this.loadMediaBuffer(clip, index)
      .then((buffer) => {
        if (cancelled) return end();
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
        this.warn(`Audio clip ${clip.id} could not read its media: ${String(error)}`);
        end();
      });
    return {
      clipId: clip.id,
      setGainAutomation: (next) => {
        automation = next;
        stage?.setAutomation(next);
      },
      cancel: () => {
        cancelled = true;
        if (source && !ended)
          try {
            source.stop();
          } catch {
            /* already stopped */
          }
        end();
      },
      onEnded: (listener) => {
        if (ended) listener();
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
    const end = () => {
      if (ended) return;
      ended = true;
      source.onended = null;
      source.disconnect();
      stage.dispose();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    source.onended = end;
    source.start(start, adjustedOffset, length);
    return {
      clipId: clip.id,
      setGainAutomation: (automation) => stage.setAutomation(automation),
      cancel: () => {
        if (!ended) {
          try {
            source.stop();
          } catch {
            /* already stopped */
          } finally {
            end();
          }
        }
      },
      onEnded: (listener) => {
        if (ended) listener();
        else listeners.add(listener);
      },
    };
  }
}
