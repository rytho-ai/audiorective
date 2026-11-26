import type { Document, Element } from "@xmldom/xmldom";
import type { NestedAudioLink } from "./nested-audio";

/**
 * What an opened DAWproject file keeps of its own XML, so a save writes back every element and attribute the model does not carry.
 * The reader fills this in; `applySourcePatch` (patch-source.ts) edits the source with whatever the project changed since it was opened.
 */
export type LevelLink = { element: Element; unit: "linear" | "decibel" };
export type TrackLink = {
  /** The Track element, or null for a Channel that stands alone in Structure (Cubase's master). */
  track: Element | null;
  channel: Element;
  sourceId: string;
  channelId: string | null;
  volume?: LevelLink;
  pan?: { element: Element; min: number; max: number };
  mute?: Element;
};
export type ClipLink = {
  element: Element;
  /** The unit of `time` and `duration`. */
  unit: "seconds" | "beats";
  /** The Clips or ClipSlot that holds the element. */
  container: Element;
  trackId: string;
  sceneId?: string;
  /** An audio clip the source writes as an outer Clip around a Clips with one inner Clip (Bitwig): edits go into that form. */
  nested?: NestedAudioLink;
};
/** A gain `Points` the source keeps in its audio clip's content lanes: its time unit and, for beats, the seconds one beat lasts in its content. */
export type GainCurveLink = { points: Element; unit: "seconds" | "beats"; secondsPerBeat: number };
export type Snapshot = Readonly<{ attrs: Record<string, string>; xml: string; children: string; childXml: Record<string, string> }>;
export type SourceXml = {
  project: Document;
  metadata: Document;
  /** Whether the file carries anything the model does not: a save patches the source instead of writing XML from the model. */
  overlay: boolean;
  /** One line per kind of content the file keeps unchanged and the model does not play or edit. */
  kept: string[];
  tracks: Map<string, TrackLink>;
  master?: { channel: Element; volume?: LevelLink };
  channelToTrack: Map<string, string>;
  clips: Map<string, ClipLink>;
  /** The gain curve of each audio clip that came with a standard one, by clip ID. */
  gainCurves: Map<string, GainCurveLink>;
  devices: Map<string, Element>;
  /** Per track, the modeled sends by bus ID. */
  sends: Map<string, Map<string, Element>>;
  /** The Points of a track's volume automation. */
  automation: Map<string, Element>;
  markers?: Element;
  /** The source's markers are in beats; the model's are in seconds. */
  markersInBeats?: boolean;
  tempoAutomation?: Element;
  meterAutomation?: Element;
  scenes: Map<string, Element>;
  /** Source archive path of each decoded recording, by the recording key the model holds. */
  recordings: Map<object, string>;
  /** What the file's `Audio` element states about each compressed audio file (the attribute text), written back as stated whatever rate the model plays it at. */
  encodedAudio: Map<string, { sampleRate: string; channels: string; duration: string }>;
  /** The archive entries the source's audio paths name, so a save can keep a recording it did not rewrite. */
  entries: Map<string, Uint8Array | Blob>;
  /** `key -> serialized` of what the model would write right after opening: a later difference is an edit. */
  baseline?: Map<string, Snapshot>;
};

export const sourceXml = new WeakMap<object, SourceXml>();
