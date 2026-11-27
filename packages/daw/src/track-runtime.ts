import type { AutomationBinding, AutomationCurve, AutomationPoint } from "@audiorective/core/automation";
import type { WebClapHost } from "@audiorective/host/webclap";
import type { Sampler } from "@audiorective/core";
import type { MidiSink } from "./midi-sink";
import type { Channel, Send } from "@audiorective/effects";
import type { RackEffect, RackMacroSettings } from "./rack-preset";
import type { TrackRack } from "./track-rack";
import type { AudioTrackSession } from "./audio-track-session";
import type { AudioClipGainAutomation, ProjectTrack } from "./model";
import type { ControllerLane } from "./controller-lane";
import type { WidthPath } from "./width-path";
import type { DeviceParameterLink } from "./device-parameter-link";

/** Seconds of media decoded and scheduled as one chunk. */
export const audioChunkSeconds = 2;

export type AudioHandle = {
  /** Opaque ID of the audio clip played by this handle. */
  clipId: string;
  /** Replaces live gain automation in recording seconds; undefined removes the curve. */
  setGainAutomation(automation: AudioClipGainAutomation | undefined): void;
  /** Withdraws scheduled audio and releases its sources and envelope nodes. */
  cancel(): void;
  /** Moves the stop to absolute AudioContext seconds, capped at the natural end; null restores the natural end. */
  setStop(time: number | null): void;
  /** Registers a callback for natural completion or cancellation; called immediately if already ended. */
  onEnded(listener: () => void): void;
};

export type AudioClipWindow = {
  /** Inclusive scheduling-window start in project seconds. */
  start: number;
  /** Exclusive scheduling-window end in project seconds. */
  end: number;
  /** Project-second boundary where playback must stop, or Infinity when this window imposes no stop. */
  stop: number;
  /** Converts project seconds in this window to absolute AudioContext seconds. */
  audioTime(seconds: number): number;
  /** Loop-cycle prefix for scheduled-source keys; empty before the first arrangement wrap. */
  keyPrefix: string;
};

/** The live Web Audio and device state of one Project track. The Workspace owns the map of these. */
export type TrackRuntime = {
  /** Track role used to decide audio, MIDI or bus playback. */
  kind: ProjectTrack["kind"];
  /** Current arrangement clips; audio uses project seconds and MIDI uses project beats. */
  clips: ProjectTrack["clips"];
  /** The track's MIDI controller lanes: Arrangement plays them beside its clips. */
  controllerLanes: readonly ControllerLane[];
  /** Device topology keys used to detect when the live plug-in chain needs rebuilding. */
  deviceKeys: readonly string[];
  /** Last applied opaque plug-in state bytes, keyed by device ID. */
  deviceStates: Map<string, Uint8Array>;
  /** Live mixer strip providing level, pan, mute and metering. */
  channel: Channel;
  /** Native gain stage carrying track volume automation as a linear factor. */
  automationGain: GainNode;
  /** Owned built-in insert chain and its live macro controls. */
  rack: TrackRack;
  /** Last applied ordered built-in insert settings. */
  effectSettings: readonly RackEffect[];
  /** Last applied normalized macro values and target mappings. */
  macroSettings: readonly RackMacroSettings[];
  /** Last bound track gain points in project seconds; omitted before binding. */
  automationPoints?: readonly AutomationPoint[];
  /** Track gain curve in project seconds; omitted when no automation is bound. */
  automationCurve?: AutomationCurve;
  /** Schedules the track gain curve on the audio clock; omitted when no automation is bound. */
  automationBinding?: AutomationBinding;
  /** Currently connected output bus input or master input; omitted before routing is connected. */
  outputDestination?: AudioNode;
  /** Name of this track's receive point on the workspace SendBus. */
  sendName: string;
  /** Live post-fader sends keyed by opaque destination bus ID. */
  sends: Map<
    string,
    {
      /** Destination bus runtime receiving this post-fader send. */
      target: TrackRuntime;
      /** Live send level control and connection into the destination bus. */
      send: Send;
    }
  >;
  /** Input node feeding this track device chain or mixer path. */
  input: AudioNode;
  /** Audio Session clip playback helper for non-bus tracks; omitted for bus tracks. */
  session?: AudioTrackSession;
  /** Loaded WebCLAP host instances keyed by opaque device ID. */
  hosts: Map<string, WebClapHost>;
  /** Keeps each running device's parameter table and its plug-in equal, by device ID. */
  links: Map<string, DeviceParameterLink>;
  /** The wired device chain: its edges and the gate that feeds the rack, so a changed chain can fade in over the one it replaces. */
  chain?: {
    /** Gain stage used to fade a replacement device chain into the rack. */
    gate: GainNode;
    /** Ordered source/destination connections owned by this device chain. */
    edges: ReadonlyArray<readonly [AudioNode, AudioNode]>;
  };
  /** How many channels the track's own sources carry, as last measured in the graph (instrument sounds and buses; audio tracks read it from their clips). */
  sourceWidth?: 1 | 2;
  /** The stereo way into the strip, built the first time a device change switches the track between mono and stereo. */
  widthPath?: WidthPath;
  /** Where the track's MIDI plays: its first WebCLAP device, or its `instruments` sampler. */
  midi?: MidiSink;
  /** The sampler built from `WorkspaceOptions.instruments`, when the track plays one. */
  sampler?: Sampler;
};
