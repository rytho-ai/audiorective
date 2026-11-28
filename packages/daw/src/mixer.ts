import { smoothGain } from "./internal/playback-gain";
import { batch } from "@audiorective/core";
import { Channel, SendBus } from "@audiorective/effects";
import { soloRouting } from "./mixer-routing";
import { solveLatency, type LatencyEdge } from "./mixer-latency";
import type { Project, ProjectTrack } from "./model";
import type { TrackRuntime } from "./track-runtime";

/** The mixer strip a track plays through: its Channel and its receive point on the shared SendBus. */
export type MixerStrip = Pick<TrackRuntime, "channel" | "sendName">;

/** Longest compensation one edge can carry, in seconds: the `maxDelayTime` of its DelayNode. */
const MAX_COMPENSATION_SECONDS = 1;

/** What the mixer reports to its Workspace: a warning message, and the master output's total lag in samples. */
export type MixerReport = Readonly<{ warn(message: string): void; latency(samples: number): void }>;

/** A track's own processing latency in samples: its WebCLAP hosts plus its rack. Tracked. */
export function ownLatency(runtime: Pick<TrackRuntime, "hosts" | "rack">): number {
  let total = runtime.rack.latency;
  for (const host of runtime.hosts.values()) total += host.latency.value;
  return total;
}

/**
 * Owns the Channel and SendBus strips and the routing between them. Project is the only owner of
 * mixer state: this writes its values into Channel params and nothing reads them back. It reads the
 * workspace's track map and the current Project through the handles it is given.
 */
export class Mixer {
  private readonly sendBus: SendBus;
  private sendSerial = 0;
  private masterVolume?: number;
  /** Compensation delays, created the first time an edge needs more than 0 samples: a project with no latency has none. */
  private readonly outputDelays = new Map<TrackRuntime, DelayNode>();
  /** Tracks whose compensation is currently clamped to the limit, so each is warned about once. */
  private readonly clamped = new Set<TrackRuntime>();

  constructor(
    private readonly context: AudioContext,
    private readonly output: GainNode,
    private readonly tracks: ReadonlyMap<string, TrackRuntime>,
    private readonly project: () => Project,
    private readonly report: MixerReport,
  ) {
    this.sendBus = new SendBus(context);
  }

  /** Build a strip whose Channel input is fed by `automationGain`. Releases what it built if it throws. */
  createStrip(trackId: string, automationGain: GainNode, track: Pick<ProjectTrack, "volume" | "pan">): MixerStrip {
    // "max" keeps a mono source mono into the panner, so it gets the mono equal-power law.
    // Project owns gain, pan, mute and solo; applyMixer writes them into the Channel params and nothing reads them back.
    // The strip starts at the track's own gain and pan, so a new strip never ramps in from the defaults.
    const channel = new Channel(this.context, { channelCountMode: "max", gain: track.volume, pan: track.pan });
    try {
      automationGain.connect(channel.input);
      const sendName = `${trackId}#${this.sendSerial++}`;
      this.sendBus.define(sendName);
      return { channel, sendName };
    } catch (error) {
      channel.dispose();
      throw error;
    }
  }

  /** Feed a strip's receive point into the track's input. */
  connectReceive(strip: MixerStrip, input: AudioNode): void {
    this.sendBus.receive(strip.sendName).connect(input);
  }

  /** Release a strip that never became part of a track runtime. */
  releaseStrip(strip: MixerStrip): void {
    strip.channel.dispose();
    this.sendBus.undefine(strip.sendName);
  }

  /** Release a track's routing, Channel and receive point. */
  disposeStrip(runtime: TrackRuntime): void {
    runtime.channel.output.disconnect();
    this.outputDelays.get(runtime)?.disconnect();
    this.outputDelays.delete(runtime);
    this.clamped.delete(runtime);
    runtime.outputDestination = undefined;
    for (const { send } of runtime.sends.values()) send.dispose();
    runtime.sends.clear();
    this.releaseStrip(runtime);
  }

  /** Borrow a post-fader track output for the mixer's meter. */
  tap(trackId: string): AudioNode | undefined {
    return this.tracks.get(trackId)?.channel.tap;
  }

  applyRouting(tracks: readonly ProjectTrack[]): void {
    const inputFor = (id: string | null) => (id === null ? this.output : this.tracks.get(id)!.input);
    // Remove obsolete edges first so reversing a bus chain never introduces a temporary cycle.
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (runtime.outputDestination !== inputFor(track.routing.outputBusId)) {
        runtime.channel.output.disconnect();
        this.outputDelays.get(runtime)?.disconnect();
        runtime.outputDestination = undefined;
      }
      for (const [id, entry] of runtime.sends) {
        if (track.routing.sends.some(({ busId }) => busId === id) && entry.target === this.tracks.get(id)) continue;
        entry.send.dispose();
        runtime.sends.delete(id);
      }
    }
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      if (!runtime.outputDestination) {
        runtime.outputDestination = inputFor(track.routing.outputBusId);
        const delay = this.outputDelays.get(runtime);
        if (delay) {
          runtime.channel.output.connect(delay);
          delay.connect(runtime.outputDestination);
        } else runtime.channel.output.connect(runtime.outputDestination);
      }
      for (const { busId, gain } of track.routing.sends) {
        if (runtime.sends.has(busId)) continue;
        const target = this.tracks.get(busId)!;
        runtime.sends.set(busId, { target, send: runtime.channel.send(this.sendBus, target.sendName, gain) });
      }
    }
  }

  /**
   * Align the tracks: solve the routing for each edge's compensation and set it on that edge's delay. A track's output edge delays between its channel output and its
   * destination; a send edge delays inside the Send. An edge gets a delay node the first time it needs more than 0 samples. An edge that needs more than one second
   * is clamped and its track is warned about once. Meters and taps read before these delays. Reports the master's total lag.
   */
  applyLatency(): void {
    const tracks = this.project().tracks.filter((track) => this.tracks.has(track.id));
    const own = new Map(tracks.map((track) => [track.id, ownLatency(this.tracks.get(track.id)!)]));
    const live = (id: string | null) => id === null || this.tracks.has(id);
    const edges: LatencyEdge[] = [];
    for (const track of tracks) {
      if (live(track.routing.outputBusId)) edges.push({ id: `${track.id}>`, from: track.id, to: track.routing.outputBusId });
      for (const { busId } of track.routing.sends) if (live(busId)) edges.push({ id: `${track.id}>${busId}`, from: track.id, to: busId });
    }
    const { delays, total } = solveLatency({ own, edges });
    const limit = MAX_COMPENSATION_SECONDS * this.context.sampleRate;
    const capped = (samples: number) => (samples > limit ? limit : samples);
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id)!;
      const needed = [delays.get(`${track.id}>`) ?? 0, ...track.routing.sends.map(({ busId }) => delays.get(`${track.id}>${busId}`) ?? 0)];
      if (needed.some((samples) => samples > limit)) {
        if (!this.clamped.has(runtime)) {
          this.clamped.add(runtime);
          this.report.warn(
            `Track "${track.name}" needs ${Math.ceil(Math.max(...needed))} samples of latency compensation, more than the 1 second limit: its compensation is clamped to 1 second.`,
          );
        }
      } else this.clamped.delete(runtime);
      this.setOutputDelay(runtime, capped(delays.get(`${track.id}>`) ?? 0));
      for (const [busId, { send }] of runtime.sends) send.setCompensation(capped(delays.get(`${track.id}>${busId}`) ?? 0));
    }
    this.report.latency(total);
  }

  private setOutputDelay(runtime: TrackRuntime, samples: number): void {
    let delay = this.outputDelays.get(runtime);
    if (!delay) {
      if (samples <= 0 || !runtime.outputDestination) return;
      delay = new DelayNode(this.context, { maxDelayTime: MAX_COMPENSATION_SECONDS });
      this.outputDelays.set(runtime, delay);
      runtime.channel.output.disconnect(runtime.outputDestination);
      runtime.channel.output.connect(delay);
      delay.connect(runtime.outputDestination);
    }
    delay.delayTime.value = samples / this.context.sampleRate;
  }

  applyMaster(): void {
    const volume = this.project().masterVolume;
    if (volume === this.masterVolume) return;
    if (this.masterVolume === undefined) this.output.gain.setValueAtTime(volume, this.context.currentTime);
    else smoothGain(this.context, this.output.gain, volume);
    this.masterVolume = volume;
  }

  /** Write Project's master volume, gain, pan, mute, solo and send values into the strips. */
  applyMixer(): void {
    this.applyMaster();
    const tracks = this.project().tracks;
    const solo = soloRouting(tracks);
    for (const track of tracks) {
      const runtime = this.tracks.get(track.id);
      if (!runtime) continue;
      const { params } = runtime.channel;
      batch(() => {
        params.gain.value = track.volume;
        params.pan.value = track.pan;
        params.muted.value = track.muted || !solo.strip(track);
        params.outputEnabled.value = solo.edge(track, track.routing.outputBusId);
        for (const { busId, gain } of track.routing.sends) {
          const send = runtime.sends.get(busId)?.send;
          if (!send) continue;
          send.params.gain.value = gain;
          send.params.enabled.value = solo.edge(track, busId);
        }
      });
    }
  }
}
