import { SamplerSink, type MidiSink } from "./midi-sink";
import { fadeSeconds, minLead, playbackLead, stopSource, VoiceGain } from "./internal/playback-gain";
import type { TickWindow, Timeline } from "@audiorective/clock";
import { AutomationBinding, AutomationCurve, audioParamTarget, type AutomationPoint } from "@audiorective/core/automation";
import { chaseMessages, claimController, controllerRestOf, controllerStateKey } from "@audiorective/midi";
import { controllerLaneKey, controllerMessagesIn, controllerStartMessage, messageLaneKey } from "./controller-lane";
import { loopWrapMessages, type LoopFold, type LoopSegment } from "./arrangement-loop";
import { clipGainAt } from "./clip-envelope";
import { scheduleClipEnvelope } from "./schedule-clip-envelope";
import { audioClipTimeMap, audioRecording } from "./model";
import type { AudioClip, AudioClipGainAutomation, PcmAudioClip } from "./model";
import { audioLoopFrames, audioLoopSourceFrame, loopedGainPoints } from "./clip-loop";
import type { SecondsRange } from "./project-edits";
import type { AudioMedia } from "./media";
import type { TempoMap } from "./tempo-map";
import { audioChunkSeconds, type AudioClipWindow, type AudioHandle, type TrackRuntime } from "./track-runtime";

/** The latest message playback sent a device for one state key, when, and what puts it back at rest (undefined for a controller that is never reset). */
type DeviceState = { data: Uint8Array; rest?: Uint8Array; atRest: boolean; when: number };

const sameMessage = (a: Uint8Array, b: Uint8Array) => a[0] === b[0] && a[1] === b[1] && (a[2] ?? 0) === (b[2] ?? 0);

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
  private readonly messaged = new Set<MidiSink>();
  /**
   * Per device, what playback has set (a controller, pitch bend, pressure, a program: whatever `controllerStateKey` names) as the latest message sent for it
   * (the one with the latest time), that time, and the message that puts it back at rest when it has a rest value (`rest`; the curated performance controllers
   * only). A run that begins compares what its position needs with this and sends the difference; a stop or pause puts every `rest` back.
   */
  private readonly state = new Map<MidiSink, Map<string, DeviceState>>();
  /** The next segment of every track begins a run: the arrangement was switched back on, so the devices are brought to what its position needs. */
  private chasePending = false;
  private refolds = 0;
  /**
   * The cut of the last live clip edit that faded a sounding source: that source fades out from `at`, and a source that takes over from it starts no
   * earlier than `at` (advanced to the same place in its clip) and fades in over the same span, so a split, trim or move is a crossfade, not a hard cut.
   * Seeks, stops and offline renders keep no cut: their start times are exact.
   */
  private cut: { at: number; until: number; loose: boolean } | null = null;
  /** The cut time `cancelAudio` is applying to the handles it cancels right now. */
  private cutAt: number | undefined;
  /** Sources a cancel is fading out. A later live edit that lands while they fade lets them fall on from where they are, so the sum of levels stays 1. */
  private readonly fading = new Set<{ lane: VoiceGain; source: AudioBufferSourceNode }>();
  private cutLoose = false;
  /** A seek crossfade is waiting for its media: the next transport start re-arms the cut so the resumed audio fades in. */
  private seekFade = false;
  /** Audio clips another clip of the same track starts right after; refreshed every window. */
  private readonly abutting = new Set<string>();
  /** Audio clips that start right where another clip of the same track ends (the right half of a split); refreshed every window. */
  private readonly continued = new Set<string>();

  constructor(
    private readonly context: AudioContext,
    /** Called with the first outstanding failure, or null once none remains. */
    private readonly reportError: (error: Error | null) => void,
  ) {}

  /** Schedule one tick window of every track's MIDI events and audio clips, through the loop fold. */
  scheduleArrangement(
    tracks: Iterable<TrackRuntime>,
    window: TickWindow<Record<never, never>>,
    map: TempoMap,
    timeline: Timeline,
    fold: LoopFold,
  ): void {
    tracks = [...tracks];
    this.prune(tracks);
    const stop = fold.region ? map.beatToSeconds(fold.region.endBeat) : Infinity;
    const spanOf = (segment: LoopSegment): AudioClipWindow => ({
      start: map.beatToSeconds(segment.beatStart),
      end: map.beatToSeconds(segment.beatEnd),
      stop,
      audioTime: (seconds) => timeline.beatToTime(segment.transportStart + map.secondsToBeat(seconds) - segment.beatStart),
      keyPrefix: segment.cycle < 0 ? "" : `${segment.cycle}:`,
    });
    const segments = fold.segments(window.beat.start, window.beat.end);
    // Request file-backed chunks before the ordinary MIDI and PCM look-ahead.
    const mediaSegments = fold.segments(window.beat.start, timeline.timeToBeat(window.time.lookAheadEnd + 0.35));
    this.abutting.clear();
    this.continued.clear();
    for (const runtime of tracks)
      for (const clip of runtime.clips)
        if (clip.kind === "audio")
          for (const next of runtime.clips)
            if (next !== clip && next.kind === "audio" && Math.abs(next.time - (clip.time + clip.duration)) < 1e-3) {
              this.abutting.add(clip.id);
              this.continued.add(next.id);
            }
    for (const runtime of tracks) {
      for (const clip of runtime.clips) {
        if (clip.kind === "audio") {
          const destination = runtime.session?.arrangementInput ?? runtime.input;
          for (const segment of clip.media ? mediaSegments : segments)
            this.scheduleAudioClipWindow(clip, destination, spanOf(segment), window, this.scheduled);
        }
      }
      const host = runtime.midi;
      if (!host) continue;
      const send = (data: Uint8Array, when: number) => {
        // A Session clip holds this track: its own scheduler plays the device instead.
        if (runtime.session?.playingAt(when)) return;
        window.own(host.scheduleMidi(data, when), when);
        this.messaged.add(host);
        this.note(host, data, when);
      };
      // A track lane replaces the clips' own events for the same controller (the lane wins, as an automation lane does over clip content in a DAW).
      const laneKeys = new Set(runtime.controllerLanes.map(controllerLaneKey));
      const clipOwns = (data: Uint8Array) => {
        const key = messageLaneKey(data);
        return key === undefined || !laneKeys.has(key);
      };
      for (const segment of segments) {
        // A note-off at the wrap goes first, so a note restarting on that exact time is not cut by it.
        if (fold.region && segment.cycle >= 0 && segment.beatStart <= fold.region.startBeat + 1e-9) {
          const when = timeline.beatToTime(segment.transportStart);
          for (const data of loopWrapMessages(runtime.clips, fold.region)) if (clipOwns(data)) send(data, when);
        }
        // At one time: note-offs, then program changes, then controllers and bend, then note-ons, so a note always sounds with the program and controllers of its beat.
        const queue: Array<{ when: number; rank: number; data: Uint8Array }> = [];
        const enqueue = (data: Uint8Array, when: number) => {
          const status = data[0] & 0xf0;
          const bank = status === 0xb0 && (data[1] === 0 || data[1] === 32);
          const rank = status === 0x80 || (status === 0x90 && data[2] === 0) ? 0 : bank ? 0.9 : status === 0xc0 ? 1 : status === 0x90 ? 3 : 2;
          queue.push({ when, rank, data });
        };
        // A segment that begins a run (the start, a seek, a loop wrap, the arrangement switched back on) first brings the device to what the position needs.
        const begins =
          (this.chasePending && segment === segments[0]) ||
          (segment.cycle < 0
            ? Math.abs(segment.transportStart - fold.originTransport) < 1e-9
            : !!fold.region && segment.beatStart <= fold.region.startBeat + 1e-9);
        if (begins) {
          const needed = this.neededAt(runtime, segment.beatStart);
          const at = timeline.beatToTime(segment.transportStart);
          let order = 0;
          // The chase goes before the segment's own messages at its time, in the order the song set them (a bank select before its program change).
          for (const data of this.chase(host, needed, window.time.current)) queue.push({ when: at, rank: 0.5 + order++ * 1e-6, data });
        }
        for (const clip of runtime.clips) {
          if (clip.kind !== "midi") continue;
          for (const event of clip.playbackEvents()) {
            const beat = clip.time + event.beat;
            if (beat < segment.beatStart - 1e-8 || beat >= segment.beatEnd - 1e-8) continue;
            if (clipOwns(event.data)) enqueue(event.data, timeline.beatToTime(segment.transportStart + beat - segment.beatStart));
          }
        }
        for (const lane of runtime.controllerLanes) {
          const messages = controllerMessagesIn(lane, segment.beatStart, segment.beatEnd, begins);
          // The first message of a beginning segment is the lane's start value, which the chase already decided.
          for (const { beat, data } of begins && controllerStartMessage(lane, segment.beatStart) ? messages.slice(1) : messages)
            enqueue(data, timeline.beatToTime(segment.transportStart + beat - segment.beatStart));
        }
        queue.sort((a, b) => a.when - b.when || a.rank - b.rank);
        for (const { data, when } of queue) send(data, when);
      }
    }
    this.chasePending = false;
  }

  /**
   * The state the Arrangement needs on `runtime`'s track at `beat`: the latest message for each controller key the clips set before it (a lane replaces its clips'
   * events for its controller, with its value in force or its rest value before its first point).
   */
  private neededAt(runtime: TrackRuntime, beat: number): Map<string, Uint8Array> {
    const laneKeys = new Set(runtime.controllerLanes.map(controllerLaneKey));
    const events: Array<{ beat: number; data: Uint8Array }> = [];
    for (const clip of runtime.clips)
      if (clip.kind === "midi")
        for (const event of clip.playbackEvents()) {
          const key = messageLaneKey(event.data);
          if (key === undefined || !laneKeys.has(key)) events.push({ beat: clip.time + event.beat, data: event.data });
        }
    const needed = new Map<string, Uint8Array>();
    for (const { data } of chaseMessages(events, beat - 1e-8)) needed.set(controllerStateKey(data)!, data);
    for (const lane of runtime.controllerLanes) {
      const start = controllerStartMessage(lane, beat);
      if (start) needed.set(controllerStateKey(start)!, start);
    }
    return needed;
  }

  /**
   * A Session clip stopped or ended and `runtime`'s track returns to the Arrangement at audio time `when`, which plays `beat`: the device is sent everything the
   * Arrangement needs there, whatever the Session clip left on it (the Session scheduler plays outside this one, so what it set is not known here). Returns the
   * scheduled messages so a withdrawn change can cancel them.
   */
  handBack(runtime: TrackRuntime, when: number, beat: number): Array<{ cancel(): void }> {
    const host = runtime.midi;
    if (!host) return [];
    const handles: Array<{ cancel(): void }> = [];
    for (const data of this.neededAt(runtime, beat).values()) {
      handles.push(host.scheduleMidi(data, when));
      // The Session clip that just stopped puts back its controllers a moment later; what the Arrangement needs stays.
      claimController(host, data, when);
      this.messaged.add(host);
      this.note(host, data, when);
    }
    return handles;
  }

  /** The next window of the arrangement begins a run on every track: it brings each device to what its position needs (the arrangement was switched back on). */
  requestChase(): void {
    this.chasePending = true;
  }

  /**
   * A seek silenced the devices. A sampler's `allNotesOff` also lifts its pedal (the one thing it forgets), so the pedal state it was last sent is no longer where
   * it stands and the run that follows sends the position's pedal again; a plug-in keeps its pedal through all-notes-off, and its state stays.
   */
  forgetPedals(): void {
    for (const [host, states] of this.state)
      if (host instanceof SamplerSink) for (const key of [...states.keys()]) if (key.endsWith(":64") && key.startsWith("cc:")) states.delete(key);
  }

  /** Records that `data` was sent to `host` for `when`, if it sets something a later run has to compare with. */
  private note(host: MidiSink, data: Uint8Array, when: number): void {
    const key = controllerStateKey(data);
    if (key === undefined) return;
    const states = this.state.get(host) ?? new Map<string, DeviceState>();
    this.state.set(host, states);
    if (when < (states.get(key)?.when ?? -Infinity)) return;
    const moved = controllerRestOf(data);
    states.set(key, { data, rest: moved?.rest, atRest: moved?.atRest ?? false, when });
  }

  /**
   * What a run that begins at the device `host` has to send, in order, given the `needed` state at its position (one message per state key). A key the device
   * was last sent exactly this value for, at or before `now`, is skipped; every other needed key is sent. A controller playback moved that nothing at the position
   * drives goes back to its rest value (only the curated performance controllers have one; selectors, data entry, banks and programs stay where they are).
   */
  private chase(host: MidiSink, needed: ReadonlyMap<string, Uint8Array>, now: number): Uint8Array[] {
    const states = this.state.get(host);
    const out: Uint8Array[] = [];
    for (const [key, data] of needed) {
      const held = states?.get(key);
      if (held && held.when <= now + 1e-6 && sameMessage(held.data, data)) continue;
      out.push(data);
    }
    if (states)
      for (const [key, held] of states) {
        if (needed.has(key) || !held.rest) continue;
        if (held.atRest && held.when <= now + 1e-6) continue;
        out.push(held.rest);
      }
    return out;
  }

  /**
   * Puts every performance controller playback moved off rest back, on each device a message was sent to, at `when`: pedal up, pitch bend centre, pressure and
   * the controllers of the curated list (`controllerRestValue`) at their rest value. A controller whose last message was a rest value sent at or before `when` is
   * left alone, and one without a rest value (bank select, data entry, RPN and NRPN selectors, programs) is never touched. A stop or a pause calls it after
   * the devices' own all-notes-off; a seek does not, because the run that follows chases the position (`chase`).
   */
  resetControllers(when: number): void {
    for (const [host, states] of this.state) {
      for (const [key, held] of states) {
        if (!held.rest || (held.atRest && held.when <= when)) continue;
        try {
          host.scheduleMidi(held.rest, when);
          this.messaged.add(host);
        } catch {
          // A device that was disposed has nothing to reset.
        }
        states.set(key, { data: held.rest, rest: held.rest, atRest: true, when });
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
        if (clip.loop) {
          const plan = audioLoopFrames(clip as AudioClip & { loop: SecondsRange });
          const from = Math.min(plan.entry, plan.loopStart);
          reads.push(
            this.loadMediaRange(clip.media, from, plan.loopEnd - from, clip.sampleRate).then(
              () => this.recovered(clip),
              (error: unknown) => this.mediaError(clip, error),
            ),
          );
          continue;
        }
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

  /**
   * `clipIds` names the clips a live edit replaces; their sounding sources crossfade into the new ones. `crossfade` does the same for every source (a seek
   * while playing: the new position fades in over the old one fading out, and a source that starts soon after, once its media is read, fades in too).
   * A stop or pause fades the sources out alone, and an offline render keeps exact start times.
   */
  cancelAudio(clipIds?: ReadonlySet<string>, crossfade = false): void {
    const offline = typeof OfflineAudioContext !== "undefined" && this.context instanceof OfflineAudioContext;
    this.cut = null;
    this.cutAt = (clipIds || crossfade) && !offline ? this.context.currentTime + playbackLead : undefined;
    this.cutLoose = crossfade;
    this.seekFade = crossfade && !offline;
    try {
      if (this.cutAt !== undefined) this.refade(this.cutAt);
      for (const [key, handle] of this.scheduled) {
        if (clipIds && !clipIds.has(handle.clipId)) continue;
        this.scheduled.delete(key);
        handle.cancel();
      }
    } finally {
      this.cutAt = undefined;
      this.cutLoose = false;
    }
  }

  /** A cut at `at` finds sources still fading out from an earlier one: they fall on from their level there, over a fresh fade, as the new sources fade in. */
  private refade(at: number): void {
    for (const voice of this.fading) {
      if (voice.lane.end <= at) this.fading.delete(voice);
      else voice.source.stop(voice.lane.fadeOut(at, fadeSeconds));
    }
  }

  /**
   * The loop changed: sources already sounding keep playing and take the new stop time. Their keys move to the new fold's first pass, so
   * the refill recognises them instead of starting the same audio again.
   */
  refold(stopTime: number | null): void {
    // Within one clip the newest cycle is the one sounding; an older source may have finished with its `ended` event still queued.
    const newest = new Map<string, { key: string; cycle: number }>();
    for (const [key, handle] of this.scheduled) {
      handle.setStop(stopTime);
      if (key.startsWith("old:")) continue;
      const match = /^(\d+):/.exec(key);
      const plain = match ? key.slice(match[0].length) : key;
      const cycle = match ? Number(match[1]) : -1;
      const best = newest.get(plain);
      if (!best || cycle > best.cycle) newest.set(plain, { key, cycle });
    }
    const keep = new Set([...newest.values()].map(({ key }) => key));
    let aside = 0;
    for (const [key, handle] of [...this.scheduled]) {
      if (key.startsWith("old:") || keep.has(key)) continue;
      this.scheduled.delete(key);
      this.scheduled.set(`old:${this.refolds}:${aside++}`, handle);
    }
    this.refolds++;
    for (const [plain, { key }] of newest) {
      if (key === plain) continue;
      const handle = this.scheduled.get(key)!;
      this.scheduled.delete(key);
      this.scheduled.set(plain, handle);
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

  /** The transport (re)starts at `when` after a seek that crossfaded: sources starting within 0.3 s of it fade in. */
  armSeekFade(when: number): void {
    if (!this.seekFade) return;
    this.seekFade = false;
    this.cut = { at: when, until: when + 0.3, loose: true };
  }

  /** When a source started at `start` for `length` seconds ends, counting a stop time. */
  private endOf(clip: AudioClip, start: number, length: number, stop: number | null): number | null {
    // A clip another clip continues from (a split) ends without a fade: the next one starts there.
    if (this.abutting.has(clip.id)) return null;
    return stop === null ? start + length : Math.min(start + length, Math.max(start, stop));
  }

  /** The live cut still in force, if any. */
  private activeCut(): { at: number; loose: boolean } | null {
    return this.cut && this.context.currentTime < this.cut.until ? this.cut : null;
  }

  /**
   * Where a source planned for `when` really starts, and how far into its clip. A source that is late (its time has passed, or the cut of a live edit
   * lies ahead) starts at the cut or now, advanced by the lateness so it stays on the clip's timeline; after a live cut it also fades in.
   */
  private join(
    when: number,
    offset: number,
    clipId?: string,
  ): {
    start: number;
    offset: number;
    fadeIn: boolean;
    /** The level a continuing piece starts at, and when it reaches full. */ ramp?: { from: number; until: number };
  } {
    const now = this.context.currentTime;
    const cut = this.activeCut();
    // Under a live cut, a source that is late starts a little ahead of now, not at it: a start in the past is applied when the message arrives, out of step with the fade it follows.
    const start = Math.max(when, cut ? Math.max(cut.at, now + minLead) : now);
    // A source that joins its clip part-way (offset > 0) has no start of its own to be hard: after a stall, when the refill came later than the cut, it
    // still replaces the audio the cut faded out, so it fades in too instead of stepping to full level.
    const fadeIn = cut !== null && (when <= cut.at + 1e-6 || offset > 0 || (cut.loose && when <= now + 0.1));
    // The second half of a split begins inside the crossfade, where the source it replaces is still fading out: it joins the ramp where it stands
    // (not from silence, not at full), so the levels of the old source and the two halves keep adding up to one across the seam.
    const inside = cut !== null && clipId !== undefined && this.continued.has(clipId) && when > cut.at + 1e-6 && when < cut.at + fadeSeconds - 1e-6;
    const ramp = inside ? { from: (when - cut.at) / fadeSeconds, until: cut.at + fadeSeconds } : undefined;
    return { start, offset: offset + Math.max(0, start - when), fadeIn: fadeIn || inside, ramp };
  }

  scheduleAudioClipWindow(
    clip: AudioClip,
    destination: AudioNode,
    span: AudioClipWindow,
    window: TickWindow<Record<never, never>>,
    scheduled: Map<string, AudioHandle>,
  ): void {
    if (clip.time >= span.end || clip.time + clip.duration <= span.start) return;
    const stopAt = Number.isFinite(span.stop) ? span.audioTime(span.stop) : null;
    const own = (key: string, handle: AudioHandle, when: number) => {
      scheduled.set(key, handle);
      handle.onEnded(() => {
        // A loop change may have re-keyed this handle since it was scheduled.
        for (const [current, value] of scheduled)
          if (value === handle) {
            scheduled.delete(current);
            break;
          }
      });
      window.own(handle, when);
    };
    if (clip.loop) {
      // One source plays the whole looped clip from here on: it loops itself, so the repeats have no seams.
      const key = `${span.keyPrefix}${clip.id}`;
      if (scheduled.has(key) || this.isSkipped(clip)) return;
      const from = Math.max(clip.time, span.start);
      const when = span.audioTime(from);
      own(key, this.scheduleLoopedAudio(clip as AudioClip & { loop: SecondsRange }, destination, when, from - clip.time, stopAt), when);
      return;
    }
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
        own(key, this.scheduleMediaAudio(clip, index, destination, when, from - chunkTime, stopAt), when);
      }
    } else {
      const key = `${span.keyPrefix}${clip.id}`;
      if (scheduled.has(key)) return;
      const from = Math.max(clip.time, span.start);
      const when = span.audioTime(from);
      own(key, this.scheduleAudio(clip, destination, when, from - clip.time, stopAt), when);
    }
  }

  loadMediaBuffer(clip: AudioClip & { media: AudioMedia; startFrame: number; frameCount: number }, index: number): Promise<AudioBuffer> {
    const framesPerChunk = clip.sampleRate * audioChunkSeconds;
    const offset = index * framesPerChunk;
    const count = Math.min(framesPerChunk, clip.frameCount - offset);
    if (count < 1) return Promise.reject(new RangeError("Workspace media chunk is outside the clip."));
    return this.loadMediaRange(clip.media, clip.startFrame + offset, count, clip.sampleRate);
  }

  /** `count` frames of a media file from `startFrame`, as one buffer. Reads are cached per file. */
  private loadMediaRange(media: AudioMedia, startFrame: number, count: number, sampleRate: number): Promise<AudioBuffer> {
    let cache = this.mediaBuffers.get(media);
    if (!cache) this.mediaBuffers.set(media, (cache = new Map()));
    const key = `${startFrame}:${count}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = media
      .readFrames(startFrame, count)
      .then((channels) => {
        const buffer = this.context.createBuffer(channels.length, count, sampleRate);
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
    /** A source that takes over from a faded one: fades in from `when`, and out before `end` so a clip trimmed at the playhead does not stop hard. */
    fadeIn: { end: number | null; ramp?: { from: number; until: number } } | false = false,
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
    const lane = new VoiceGain(cancellation.gain, when);
    if (fadeIn) {
      // Silent until the fade begins: the source may start a sample before the first gain event takes hold, and the default gain of 1 would let that sample through.
      const from = fadeIn.ramp?.from ?? 0;
      lane.setInitialValue(from);
      lane.setValueAtTime(from, when);
      // Too short to fade both ways: the source it replaces is still fading out, which covers it.
      if (fadeIn.ramp) lane.linearRampToValueAtTime(1, fadeIn.ramp.until);
      else if (fadeIn.end === null) lane.linearRampToValueAtTime(1, when + fadeSeconds);
      else if (fadeIn.end - when >= 2 * fadeSeconds) {
        lane.linearRampToValueAtTime(1, when + fadeSeconds);
        lane.setValueAtTime(1, fadeIn.end - fadeSeconds);
        lane.linearRampToValueAtTime(0, fadeIn.end);
      }
    }
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
      // A looped clip reads the curve at its place in the recording, so the curve repeats with the loop.
      let points: readonly AutomationPoint[];
      if (clip.loop) points = loopedGainPoints(clip as AudioClip & { loop: SecondsRange }, automation);
      else points = (timeMap ??= audioClipTimeMap(clip)).projectGain(automation.points, automation.sourceStart);
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
      stop: () => {
        // A batch of cancellations that overruns its lead moves the cut forward for the sources still to come, and the sources they are replaced by follow it.
        const at = this.cutAt === undefined ? undefined : (this.cutAt = Math.max(this.cutAt, this.context.currentTime + minLead));
        if (!stopSource(this.context, source, lane, when, at)) return;
        for (const voice of this.fading) if (voice.lane.end <= this.context.currentTime) this.fading.delete(voice);
        this.fading.add({ lane, source });
        if (at !== undefined) this.cut = { at, until: at + (this.cutLoose ? 0.3 : 0.5), loose: this.cutLoose };
      },
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
    stopAt: number | null = null,
  ): AudioHandle {
    let cancelled = false;
    let stopTime = stopAt;
    let naturalEnd = 0;
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
        const { start, offset: adjustedOffset, fadeIn } = this.join(when, offset, clip.id);
        const length = buffer.duration - adjustedOffset;
        if (length <= 0 || (stopTime !== null && stopTime <= start)) return end();
        stage = this.connectClipSource(source, destination, clip, start, index * audioChunkSeconds + adjustedOffset, length, fadeIn && { end: null });
        stage.setAutomation(automation);
        source.start(start, adjustedOffset, length);
        naturalEnd = start + length;
        if (stopTime !== null && stopTime < naturalEnd) source.stop(stopTime);
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
      setStop: (time) => {
        stopTime = time;
        if (!source || !naturalEnd || cancelled || ended) return;
        source.stop(Math.max(this.context.currentTime, Math.min(time ?? naturalEnd, naturalEnd)));
      },
      onEnded: (listener) => {
        if (ended || cancelled) listener();
        else listeners.add(listener);
      },
    };
  }

  /**
   * A looped clip from `offset` seconds into it to its end, as one source that loops natively. A file-backed clip reads only the frames from
   * its entry point to the loop end, once, and loops that buffer.
   */
  scheduleLoopedAudio(
    clip: AudioClip & { loop: SecondsRange },
    destination: AudioNode,
    when: number,
    offset: number,
    stopAt: number | null = null,
  ): AudioHandle {
    const rate = clip.sampleRate;
    const plan = audioLoopFrames(clip);
    const bufferStart = clip.media ? Math.min(plan.entry, plan.loopStart) : 0;
    let cancelled = false;
    let stopTime = stopAt;
    let naturalEnd = 0;
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
    const loading = (
      clip.media
        ? this.loadMediaRange(clip.media, bufferStart, plan.loopEnd - bufferStart, rate)
        : Promise.resolve(this.bufferFor(audioRecording(clip).source as Pick<PcmAudioClip, "channels" | "sampleRate">))
    )
      .then((buffer) => {
        if (cancelled) return end();
        this.recovered(clip);
        const { start, offset: localOffset, fadeIn } = this.join(when, offset, clip.id);
        const length = clip.duration - localOffset;
        if (length <= 0 || (stopTime !== null && stopTime <= start)) return end();
        source = this.context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = (plan.loopStart - bufferStart) / rate;
        source.loopEnd = (plan.loopEnd - bufferStart) / rate;
        source.onended = end;
        stage = this.connectClipSource(source, destination, clip, start, localOffset, length, fadeIn && { end: null });
        stage.setAutomation(automation);
        source.start(start, (audioLoopSourceFrame(plan, Math.round(localOffset * rate)) - bufferStart) / rate, length);
        naturalEnd = start + length;
        if (stopTime !== null && stopTime < naturalEnd) source.stop(stopTime);
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
      setStop: (time) => {
        stopTime = time;
        if (!source || !naturalEnd || cancelled || ended) return;
        source.stop(Math.max(this.context.currentTime, Math.min(time ?? naturalEnd, naturalEnd)));
      },
      onEnded: (listener) => {
        if (ended || cancelled) listener();
        else listeners.add(listener);
      },
    };
  }

  bufferFor(clip: Pick<PcmAudioClip, "channels" | "sampleRate">): AudioBuffer {
    let buffer = this.audioBuffers.get(clip.channels);
    if (!buffer) {
      buffer = this.context.createBuffer(clip.channels.length, clip.channels[0].length, clip.sampleRate);
      clip.channels.forEach((samples, index) => buffer!.getChannelData(index).set(samples));
      this.audioBuffers.set(clip.channels, buffer);
    }
    return buffer;
  }

  /** A looped clip's Session audio: its whole recording at the clip's gain and gain automation (read at recording seconds). Fades follow the Arrangement only. */
  sessionLoopBufferFor(clip: PcmAudioClip): AudioBuffer {
    const whole = audioRecording(clip).source as Pick<PcmAudioClip, "channels" | "sampleRate">;
    const gain = clip.envelope?.gain ?? 1;
    const automation = clip.gainAutomation;
    if (gain === 1 && !automation) return this.bufferFor(whole);
    const curve = automation && new AutomationCurve(automation.points);
    const shift = automation ? automation.sourceStart - clip.sourceOffset : 0;
    let buffer = this.sessionAudioBuffers.get(clip);
    if (!buffer) {
      buffer = this.context.createBuffer(whole.channels.length, whole.channels[0].length, whole.sampleRate);
      whole.channels.forEach((samples, index) => {
        const out = buffer!.getChannelData(index);
        for (let frame = 0; frame < out.length; frame++) out[frame] = samples[frame] * gain * (curve?.valueAt(frame / whole.sampleRate + shift) ?? 1);
      });
      this.sessionAudioBuffers.set(clip, buffer);
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

  scheduleAudio(clip: PcmAudioClip, destination: AudioNode, when: number, offset: number, stopAt: number | null = null): AudioHandle {
    const source = this.context.createBufferSource();
    source.buffer = this.bufferFor(clip);
    const { start, offset: late, fadeIn, ramp } = this.join(when, offset, clip.id);
    const adjustedOffset = Math.min(clip.duration, late);
    const length = Math.max(0, clip.duration - adjustedOffset);
    const stage = this.connectClipSource(
      source,
      destination,
      clip,
      start,
      adjustedOffset,
      length,
      fadeIn && { end: this.endOf(clip, start, length, stopAt), ramp },
    );
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
    const naturalEnd = start + length;
    if (stopAt !== null && stopAt < naturalEnd) source.stop(Math.max(start, stopAt));
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
      setStop: (time) => {
        if (ended || cancelled) return;
        source.stop(Math.max(this.context.currentTime, Math.min(time ?? naturalEnd, naturalEnd)));
      },
      onEnded: (listener) => {
        if (ended || cancelled) listener();
        else listeners.add(listener);
      },
    };
  }
}
