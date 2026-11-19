import type { AutomationBinding, AutomationCurve, AutomationPoint } from "@audiorective/core/automation";
import type { WebClapHost } from "@audiorective/host/webclap";
import type { Channel, Send } from "@audiorective/effects";
import type { EffectRack, RackEffect, RackMacroSettings } from "@audiorective/effects/rack";
import type { AudioTrackSession } from "./audio-track-session";
import type { AudioClipGainAutomation, ProjectTrack } from "./model";

/** Seconds of media decoded and scheduled as one chunk. */
export const audioChunkSeconds = 2;

export type AudioHandle = {
  clipId: string;
  setGainAutomation(automation: AudioClipGainAutomation | undefined): void;
  cancel(): void;
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
  rack: EffectRack;
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
  midiHost?: WebClapHost;
};
