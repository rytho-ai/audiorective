import type { Document, Element } from "@xmldom/xmldom";
import type { NestedAudioLink } from "./nested-audio";
import type { KeptShiftRecord, KeptTimed } from "./kept-timeline";

/**
 * What an opened DAWproject file keeps of its own XML, so a save writes back every element and attribute the model does not carry.
 * The reader fills this in; `applySourcePatch` (patch-source.ts) edits the source with whatever the project changed since it was opened.
 */
export type LevelLink = {
  /** XML level parameter element whose value attribute stores the gain. */
  element: Element;
  /** Stored gain representation: a linear factor or decibels. */
  unit: "linear" | "decibel";
};
export type TrackLink = {
  /** The Track element, or null for a Channel that stands alone in Structure (Cubase's master). */
  track: Element | null;
  /** XML Channel element carrying this track mixer and device settings. */
  channel: Element;
  /** Track or standalone Channel ID used by source XML references. */
  sourceId: string;
  /** Source Channel ID, or null when the file has no channel ID. */
  channelId: string | null;
  /** Source volume parameter and unit; omitted when the channel has no modeled volume. */
  volume?: LevelLink;
  /** Source pan parameter and its declared range; omitted when pan is absent. */
  pan?: {
    /** XML pan parameter element whose value is converted to the model -1..1 range. */
    element: Element;
    /** Lower bound of the source pan parameter scale. */
    min: number;
    /** Upper bound of the source pan parameter scale. */
    max: number;
  };
  /** Source mute parameter element; omitted when the file has none. */
  mute?: Element;
};
export type ClipLink = {
  /** Source Clip element updated in place when this modeled clip changes. */
  element: Element;
  /** The unit of `time` and `duration`. */
  unit: "seconds" | "beats";
  /** The Clips or ClipSlot that holds the element. */
  container: Element;
  /** Opaque model track ID owning this source clip. */
  trackId: string;
  /** Opaque scene ID for a Session slot clip; omitted for an arrangement clip. */
  sceneId?: string;
  /** An audio clip the source writes as an outer Clip around a Clips with one inner Clip (Bitwig): edits go into that form. */
  nested?: NestedAudioLink;
};
/** A gain `Points` the source keeps in its audio clip's content lanes: its time unit and, for beats, the seconds one beat lasts in its content. */
export type GainCurveLink = {
  /** Source XML Points element holding the clip gain curve. */
  points: Element;
  /** Time unit of the source points: recording seconds or content beats. */
  unit: "seconds" | "beats";
  /** Seconds per content beat used to convert beat-based audio gain points to recording seconds. */
  secondsPerBeat: number;
};
/** A controller lane's `Points` in the source: its time unit (`seconds` lanes convert through the tempo map). */
export type ControllerLink = {
  /** Source XML Points element holding this track controller lane. */
  points: Element;
  /** Time unit of the source points; project seconds convert through the project tempo map. */
  unit: "seconds" | "beats";
};
export type Snapshot = Readonly<{
  /** Source attributes as text, keyed by attribute name, for change detection. */
  attrs: Record<string, string>;
  /** Serialized baseline XML for the whole modeled element. */
  xml: string;
  /** Serialized baseline child elements in source order for change detection. */
  children: string;
  /** Serialized baseline child elements grouped by XML tag name. */
  childXml: Record<string, string>;
}>;
export type SourceXml = {
  /** Parsed project.xml document kept for in-place save patches. */
  project: Document;
  /** Parsed metadata.xml document kept for in-place save patches. */
  metadata: Document;
  /** Whether the file carries anything the model does not: a save patches the source instead of writing XML from the model. */
  overlay: boolean;
  /** One line per kind of content the file keeps unchanged and the model does not play or edit. */
  kept: string[];
  /** The timed content the file keeps (clips and automation the model does not carry): a song-wide time edit moves it too. */
  keptTimed: KeptTimed[];
  /** The song-wide edits that moved kept timed content, oldest first; an undone one stays listed with `applied: false`. */
  keptShifts: KeptShiftRecord[];
  /** The `time` text each moved kept element had in the file, so undoing every move writes it back exactly. */
  keptTexts: Map<object, string>;
  /** Source track/channel links keyed by opaque model track ID. */
  tracks: Map<string, TrackLink>;
  /** Source master mixer channel, if the file defines one. */
  master?: {
    /** XML Channel element representing the master output. */
    channel: Element;
    /** Source master level and its unit; omitted when no level parameter exists. */
    volume?: LevelLink;
  };
  /** Source channel IDs mapped to opaque model track IDs. */
  channelToTrack: Map<string, string>;
  /** Source links keyed by opaque modeled clip ID. */
  clips: Map<string, ClipLink>;
  /** The gain curve of each audio clip that came with a standard one, by clip ID. */
  gainCurves: Map<string, GainCurveLink>;
  /** Source device XML elements keyed by opaque model device ID. */
  devices: Map<string, Element>;
  /** Per track, the modeled sends by bus ID. */
  sends: Map<string, Map<string, Element>>;
  /** The Points of a track's volume automation. */
  automation: Map<string, Element>;
  /** The track-level `Points` of each controller lane the model read, by track ID and lane key. */
  controllerLanes: Map<string, Map<string, ControllerLink>>;
  /** Source marker container; omitted when the file contains none. */
  markers?: Element;
  /** The source's markers are in beats; the model's are in seconds. */
  markersInBeats?: boolean;
  /** Source tempo automation container; omitted when the file contains none. */
  tempoAutomation?: Element;
  /** Source time-signature automation container; omitted when the file contains none. */
  meterAutomation?: Element;
  /** Source Scene elements keyed by opaque model scene ID. */
  scenes: Map<string, Element>;
  /** Source archive path of each decoded recording, by the recording key the model holds. */
  recordings: Map<object, string>;
  /** What the file's `Audio` element states about each compressed audio file (the attribute text), written back as stated whatever rate the model plays it at. */
  encodedAudio: Map<
    string,
    {
      /** Original sampleRate attribute text in hertz, preserved across decoding and resampling. */
      sampleRate: string;
      /** Original channels attribute text as an integer channel count. */
      channels: string;
      /** Original duration attribute text in recording seconds, preserved across decoding. */
      duration: string;
    }
  >;
  /** The archive entries the source's audio paths name, so a save can keep a recording it did not rewrite. */
  entries: Map<string, Uint8Array | Blob>;
  /** `key -> serialized` of what the model would write right after opening: a later difference is an edit. */
  baseline?: Map<string, Snapshot>;
};

/** `Points` inside a MIDI clip that the model does not carry (an expression or unit it cannot read): a save that rewrites the clip keeps them. */
export const unmodeledPoints = new WeakSet<object>();

export const sourceXml = new WeakMap<object, SourceXml>();
