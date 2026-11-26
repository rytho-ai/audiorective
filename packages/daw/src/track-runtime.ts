import type { AutomationBinding, AutomationCurve, AutomationPoint } from "@audiorective/core/automation";
import type { WebClapHost } from "@audiorective/host/webclap";
import type { Sampler } from "@audiorective/core";
import type { MidiSink } from "./midi-sink";
import type { Channel, Send } from "@audiorective/effects";
import type { RackEffect, RackMacroSettings } from "./rack-preset";
import type { TrackRack } from "./track-rack";
import type { AudioTrackSession } from "./audio-track-session";
import type { AudioClipGainAutomation, ProjectTrack } from "./model";
import type { WidthPath } from "./width-path";

/** Seconds of media decoded and scheduled as one chunk. */
export const audioChunkSeconds = 2;

export type AudioHandle = {
  clipId: string;
  setGainAutomation(automation: AudioClipGainAutomation | undefined): void;
  cancel(): void;
  /** Move the audio-clock time this source stops, or let it play to its natural end with `null`. */
  setStop(time: number | null): void;
  onEnded(listener: () => void): void;
};

export type AudioClipWindow = {
  start: number;
  end: number;
  stop: number;
  audioTime(seconds: number): number;
  keyPrefix: string;
};

/** The live Web Audio and device state of one Project track. The Workspace owns the map of these. */
export type TrackRuntime = {
  kind: ProjectTrack["kind"];
  clips: ProjectTrack["clips"];
  deviceKeys: readonly string[];
  deviceStates: Map<string, Uint8Array>;
  channel: Channel;
  automationGain: GainNode;
  rack: TrackRack;
  effectSettings: readonly RackEffect[];
  macroSettings: readonly RackMacroSettings[];
  automationPoints?: readonly AutomationPoint[];
  automationCurve?: AutomationCurve;
  automationBinding?: AutomationBinding;
  outputDestination?: AudioNode;
  /** Name of this track's receive point on the workspace SendBus. */
  sendName: string;
  sends: Map<string, { target: TrackRuntime; send: Send }>;
  input: AudioNode;
  session?: AudioTrackSession;
  hosts: Map<string, WebClapHost>;
  /** The wired device chain: its edges and the gate that feeds the rack, so a changed chain can fade in over the one it replaces. */
  chain?: { gate: GainNode; edges: ReadonlyArray<readonly [AudioNode, AudioNode]> };
  /** How many channels the track's own sources carry, as last measured in the graph (instrument sounds and buses; audio tracks read it from their clips). */
  sourceWidth?: 1 | 2;
  /** The stereo way into the strip, built the first time a device change switches the track between mono and stereo. */
  widthPath?: WidthPath;
  /** Where the track's MIDI plays: its first WebCLAP device, or its `instruments` sampler. */
  midi?: MidiSink;
  /** The sampler built from `WorkspaceOptions.instruments`, when the track plays one. */
  sampler?: Sampler;
};
