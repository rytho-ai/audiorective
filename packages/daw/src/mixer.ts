import { batch } from "@audiorective/core";
import { Channel, SendBus } from "@audiorective/effects";
import { soloRouting } from "./mixer-routing";
import type { Project, ProjectTrack } from "./model";
import type { TrackRuntime } from "./track-runtime";

/** The mixer strip a track plays through: its Channel and its receive point on the shared SendBus. */
export type MixerStrip = Pick<TrackRuntime, "channel" | "sendName">;

/**
 * Owns the Channel and SendBus strips and the routing between them. Project is the only owner of
 * mixer state: this writes its values into Channel params and nothing reads them back. It reads the
 * workspace's track map and the current Project through the handles it is given.
 */
export class Mixer {
  private readonly sendBus: SendBus;
  private sendSerial = 0;

  constructor(
    private readonly context: AudioContext,
    private readonly output: GainNode,
    private readonly tracks: ReadonlyMap<string, TrackRuntime>,
    private readonly project: () => Project,
  ) {
    this.sendBus = new SendBus(context);
  }

  /** Build a strip whose Channel input is fed by `automationGain`. Releases what it built if it throws. */
  createStrip(trackId: string, automationGain: GainNode): MixerStrip {
    // "max" keeps a mono source mono into the panner, so it gets the mono equal-power law.
    // Project owns gain, pan, mute and solo; applyMixer writes them into the Channel params and nothing reads them back.
    const channel = new Channel(this.context, { channelCountMode: "max" });
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
        runtime.channel.output.connect(runtime.outputDestination);
      }
      for (const { busId } of track.routing.sends) {
        if (runtime.sends.has(busId)) continue;
        const target = this.tracks.get(busId)!;
        runtime.sends.set(busId, { target, send: runtime.channel.send(this.sendBus, target.sendName) });
      }
    }
  }

  applyMaster(): void {
    this.output.gain.setValueAtTime(this.project().masterVolume, this.context.currentTime);
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
        params.mute.value = track.muted || !solo.strip(track);
        params.outputEnabled.value = solo.edge(track, track.routing.outputBusId);
        for (const { busId, gain } of track.routing.sends) {
          const send = runtime.sends.get(busId)?.send;
          if (!send) continue;
          send.gain.value = gain;
          send.enabled.value = solo.edge(track, busId);
        }
      });
    }
  }
}
