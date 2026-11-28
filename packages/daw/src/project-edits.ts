import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { BusRole, Project, ProjectClip, ProjectMarker, ProjectTrack, TrackKind } from "./model";
import { unityClipEnvelope } from "./clip-envelope";
import { controllerExpressions, controllerMax, controllerPointsAfterInsert, type ControllerExpression } from "./controller-lane";
import type { RackEffect, RackPreset } from "./rack-preset";
import { rackDeviceId, rackSlotParameters, splitRackDeviceId } from "./device-parameters";
import { sessionFor } from "./session";
import { TempoMap, type TempoChange } from "./tempo-map";
import type { TimeSignatureChange } from "./meter-map";
import { timeRangeKind, crossfadeSeconds } from "./ripple-delete";
import { keptContent } from "./project-persistence";
import { findSlotClip, readSession, slotKey } from "./session-state";

/** One state of a Project. Opaque: compare it for equality and pass it back as `expectedVersion`. */
export type ProjectVersion = string & {
  /** Compile-time brand that prevents ordinary strings from being used as project versions. */
  readonly projectVersion: unique symbol;
};
/** A half-open beat range on the owner's axis: project beats for timeline ranges, content beats for MIDI loops. */
export type BeatRange = Readonly<{
  /** Inclusive start in project beats for timeline ranges or content beats for MIDI loops. */
  startBeat: number;
  /** Exclusive end on the same beat axis as startBeat; must be greater than startBeat. */
  endBeat: number;
}>;
/** A half-open seconds range on the owner's axis: project seconds for timeline ranges, recording seconds for audio loops. */
export type SecondsRange = Readonly<{
  /** Inclusive start in project seconds for timeline ranges or recording seconds for audio loops. */
  startSeconds: number;
  /** Exclusive end on the same seconds axis as startSeconds; must be greater than startSeconds. */
  endSeconds: number;
}>;
/** A half-open range in project beats or project seconds. */
export type TimeRange = BeatRange | SecondsRange;

export type ProjectClipSummary = Readonly<{
  id: string;
  /** Optional clip display name; omitted when the clip is unnamed. */
  name?: string;
  kind: "audio" | "midi";
  /** Opaque ID of the track containing this clip. */
  trackId: string;
  /** Display name of the containing track; names need not be unique. */
  trackName: string;
  /** Inclusive clip start in project seconds, converted through the tempo map for MIDI. */
  startSeconds: number;
  /** Clip-window duration in seconds, including tempo changes across a MIDI clip. */
  durationSeconds: number;
  /** Inclusive clip start in project beats, converted through the tempo map for audio. */
  startBeat: number;
  /** Clip-window duration in beats, including tempo changes across an audio clip. */
  durationBeats: number;
  /** MIDI only: the content beat where the clip's start sits; the clip plays content `[sourceOffset, sourceOffset + durationBeats)` (or its loop). */
  sourceOffset?: number;
  /** MIDI only: the part of the content that repeats, in content beats; omitted without a loop. */
  loop?: BeatRange;
  /** The IDs of the other clips (timeline or Session slot) that share this clip's MIDI notes; omitted when the clip is not linked. */
  linkedTo?: readonly string[];
}>;

export type ProjectOverview = Readonly<{
  /** Opaque current project version to pass back as expectedVersion. */
  version: ProjectVersion;
  /** Song title stored in the project. */
  title: string;
  /** Initial tempo in quarter-note beats per minute, before later changes. */
  bpm: number;
  /** Initial [numerator, denominator] signature; MeterMap bars count from 1. */
  signature: readonly [number, number];
  /** Time signatures from a beat on, after the starting `signature`; empty when the meter never changes. */
  signatureChanges: readonly TimeSignatureChange[];
  /** Tempo steps at positive project beats, ordered by beat; empty for a constant tempo. */
  tempoChanges: readonly TempoChange[];
  /** Named positions in project seconds, ordered by time. */
  markers: readonly ProjectMarker[];
  /** The timeline clips of each track. Session slot clips are in `session`, not here. */
  tracks: readonly Readonly<{
    id: string;
    name: string;
    /** Track role: audio, MIDI, or a routing bus. */
    kind: TrackKind;
    /** Arrangement clips on this track; empty for a bus or an empty track. */
    clips: readonly ProjectClipSummary[];
  }>[];
  /** The Session grid: scenes in order, each with the clips of its filled slots. */
  session: readonly Readonly<{
    id: string;
    name: string;
    /** Filled slots in this scene; empty slots have no entry. */
    clips: readonly ProjectSlotClipSummary[];
  }>[];
}>;

/** A clip in a Session slot. `duration` is in the clip's own unit: seconds for audio, beats for MIDI. */
export type ProjectSlotClipSummary = Readonly<{
  id: string;
  /** Optional clip display name; omitted when the clip is unnamed. */
  name?: string;
  kind: "audio" | "midi";
  /** Opaque ID of the track containing this clip. */
  trackId: string;
  /** Display name of the containing track; names need not be unique. */
  trackName: string;
  /** Clip length in seconds for audio or beats for MIDI, as identified by unit; MIDI permits zero. */
  duration: number;
  /** Unit of duration: seconds for audio, quarter-note beats for MIDI. */
  unit: "seconds" | "beats";
  /** MIDI only: the content beat where the clip's start sits (see `ProjectClipSummary`). */
  sourceOffset?: number;
  /** MIDI only: the repeating part of the content, in content beats; omitted without a loop. */
  loop?: BeatRange;
  /** The IDs of the other clips (timeline or Session slot) that share this clip's MIDI notes; omitted when the clip is not linked. */
  linkedTo?: readonly string[];
}>;

export type ProjectClipQuery = Readonly<{
  /** Exact clip name. Names are not unique, so check how many clips match. */
  name?: string;
  /** Opaque track ID filter; omitted to search all tracks. */
  trackId?: string;
  /** Exact track name. */
  trackName?: string;
  /** Half-open project-beat filter converted through the tempo map; omitted for all timeline positions. */
  range?: BeatRange;
  /** How a clip must relate to `range`. Default `"overlaps"`. */
  relation?: "overlaps" | "contained";
}>;

/** An existing clip, or the clips an earlier operation of this request named with `as` (`fromCopy`, optionally narrowed by track or name). */
export type EditClipSelector =
  | Readonly<{
      /** Opaque existing clip ID; mutually exclusive with fromCopy. */
      clipId: string;
      /** Excluded in this union branch; omit this field. */
      fromCopy?: never;
      /** Excluded in this union branch; omit this field. */
      trackId?: never;
      /** Excluded in this union branch; omit this field. */
      trackName?: never;
      /** Excluded in this union branch; omit this field. */
      name?: never;
    }>
  | Readonly<{
      /** Earlier operation alias from as; selects its created clips, optionally narrowed by track or name. */
      fromCopy: string;
      /** Excluded in this union branch; omit this field. */
      clipId?: never;
      /** Opaque track ID narrowing a fromCopy result; omitted to allow any track. */
      trackId?: string;
      /** Exact track display name narrowing a fromCopy result; omitted for no name filter. */
      trackName?: string;
      /** Exact clip display name narrowing a fromCopy result; omitted for no name filter. */
      name?: string;
    }>;
/** A track ID, or `{ fromCopy }` naming a track an earlier `addTrack` of this request made with `as`. */
export type EditTrackRef =
  | string
  | Readonly<{
      /** Alias assigned with as by an earlier addTrack operation in this request. */
      fromCopy: string;
    }>;
/** A scene ID, or `{ fromCopy }` naming a scene an earlier `addScene` or `duplicateScene` of this request made with `as`. */
export type EditSceneRef =
  | string
  | Readonly<{
      /** Alias assigned with as by an earlier addScene or duplicateScene operation in this request. */
      fromCopy: string;
    }>;
/** One cell of the Session grid. */
export type EditSlotRef = Readonly<{
  /** Opaque scene ID or an earlier scene-creation alias naming the slot row. */
  sceneId: EditSceneRef;
  /** Opaque track ID or an earlier track-creation alias naming the slot column. */
  trackId: EditTrackRef;
}>;
/** A project position: `atBeat` (project beats) or `atSeconds` (project seconds), 0 or more, converted with the tempo map current when the step runs. A row giving both is accepted when they agree at that tempo map (within 1e-6 s) and rejected otherwise. */
export type EditPosition =
  | Readonly<{
      /** Non-negative project beat; when both units are supplied they must agree within 1e-6 seconds. */
      atBeat: number;
      /** Non-negative project seconds; when both units are supplied they must agree within 1e-6 seconds. */
      atSeconds?: number;
    }>
  | Readonly<{
      /** Non-negative project seconds; when both units are supplied they must agree within 1e-6 seconds. */
      atSeconds: number;
      /** Non-negative project beat; when both units are supplied they must agree within 1e-6 seconds. */
      atBeat?: number;
    }>;

/** A note to add, in content beats (the clip plays the window starting at its `sourceOffset`): `start` counts from the content's first beat, not the clip's start. */
export type NewNoteEdit = Readonly<{
  /** MIDI note number, an integer 0 to 127 (60 is middle C). */
  pitch: number;
  /** Content beats, 0 or more. */
  start: number;
  /** Beats, more than 0. */
  duration: number;
  /** 0 to 1. Default 0.8. */
  velocity?: number;
}>;

/** Copy a beat range and insert the copy at `atBeat`, opening room on every track; later clips, tempo, markers and volume automation move later. Names the copies with `as`. */
export type CopyRangeEdit = Readonly<{
  type: "copyRange";
  /** Half-open project-beat range to copy from every track. */
  range: BeatRange;
  /** Non-negative project beat at which to insert the copied range and open room on every track. */
  atBeat: number;
  /** `"insert"` opens room at `atBeat`: later clips, tempo, markers and automation move later on every track. */
  placement: "insert";
  /** Names the copies so later operations in this request can select them with `fromCopy`. */
  as: string;
}>;
/** Move a timeline clip, optionally to another track of the same kind. `atBeat` is an absolute project beat (0 or more); `byBeats` shifts from the clip's start. */
export type MoveClipEdit = Readonly<{
  type: "moveClip";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** The target track; default the clip's own. It must be a track of the same kind. */
  trackId?: EditTrackRef;
  /** Beats follow the tempo map at the time this step runs. A clip that ends the request on top of another clip rejects it. */
  position:
    | Readonly<{
        /** Non-negative absolute project beat at which the clip starts; excludes byBeats. */
        atBeat: number;
        /** Excluded in this union branch; omit this field. */
        byBeats?: never;
      }>
    | Readonly<{
        /** Signed shift from the current clip start in beats; excludes atBeat and cannot move before project zero. */
        byBeats: number;
        /** Excluded in this union branch; omit this field. */
        atBeat?: never;
      }>;
}>;
/** Move one or both edges of a clip without deleting content; edges are absolute project beats (0 or more) for audio and MIDI clips alike. */
export type ResizeClipEdit = Readonly<{
  type: "resizeClip";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Absolute project beats. An omitted edge stays. Nothing is deleted: a MIDI clip's start edge moves its `sourceOffset` with it, an audio clip's reveals its recording. */
  start?: number;
  /** Exclusive new clip end in project beats; omitted to retain the current end and must follow the start. */
  end?: number;
}>;
/** Choose which part of a clip's content plays, keeping its position: content beats for MIDI, recording seconds for audio (stretched seconds when time-stretched). */
export type SetClipSourceRangeEdit = Readonly<{
  type: "setClipSourceRange";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** The part of the content to play, keeping the clip's position: content beats for a MIDI clip, recording seconds for an audio clip (seconds of the stretched audio when it is time-stretched). On a looped clip it becomes the loop and the start, and the clip keeps its length. */
  start: number;
  /** Exclusive content-beat end for MIDI or recording-second end for audio, using stretched recording seconds when stretched. */
  end: number;
}>;
/** Set a clip's display name (timeline or Session slot): a non-empty string. */
export type SetClipNameEdit = Readonly<{
  type: "setClipName";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  name: string;
}>;
/** Split a timeline clip at a project position strictly inside it (`atBeat` in project beats or `atSeconds` in project seconds). The left piece keeps the ID; the right piece is the new clip and is named by `as`. */
export type SplitClipEdit = Readonly<{
  type: "splitClip";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}> &
  EditPosition;
/** Copy a timeline clip to a project position (`atBeat` beats or `atSeconds` seconds, 0 or more) on its own track or on `trackId` (same kind). `linked: true` shares a MIDI clip's notes (default false). */
export type DuplicateClipEdit = Readonly<{
  type: "duplicateClip";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Destination track ID or alias of the same kind; omitted to keep the source track. */
  trackId?: EditTrackRef;
  /** Shares MIDI note content with the source when true; default false, and audio copies remain independent. */
  linked?: boolean;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}> &
  EditPosition;
/** Remove a timeline clip (a Session slot clip goes with `clearSlot`). */
export type RemoveClipEdit = Readonly<{
  type: "removeClip";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
}>;
/** Repeat part of a clip's content for the clip's whole length, or stop repeating with `null`. MIDI: content beats `{ startBeat, endBeat }`; audio: recording seconds `{ startSeconds, endSeconds }` ending inside the recording. */
export type SetClipLoopEdit = Readonly<{
  type: "setClipLoop";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Half-open repeating content range, in MIDI content beats or audio recording seconds; null removes the loop. */
  loop:
    | Readonly<{
        /** Inclusive loop start in MIDI content beats. */
        startBeat: number;
        /** Exclusive loop end in MIDI content beats; must follow startBeat. */
        endBeat: number;
      }>
    | Readonly<{
        /** Inclusive loop start in audio recording seconds. */
        startSeconds: number;
        /** Exclusive loop end in audio recording seconds; must follow startSeconds and fit the recording. */
        endSeconds: number;
      }>
    | null;
}>;
/** Add a MIDI clip to a MIDI track at `atBeat` (project beats, 0 or more) and `duration` beats (more than 0). `notes` are in content beats; `sourceOffset` is the content beat where the clip starts (default 0). `linkedTo` shares another MIDI clip's notes instead of `notes`. */
export type AddMidiClipEdit = Readonly<{
  type: "addMidiClip";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Non-negative project beat at which the new arrangement clip starts. */
  atBeat: number;
  /** Positive clip-window duration in beats. */
  duration: number;
  /** Notes in content beats; omitted for an empty clip unless linkedTo supplies shared notes. */
  notes?: readonly NewNoteEdit[];
  /** Content beat at the clip start; default 0, with negative values allowing empty lead-in. */
  sourceOffset?: number;
  /** Optional non-empty display name; omitted to leave the new clip unnamed. */
  name?: string;
  /** Existing MIDI clip whose note content to share instead of notes; omitted for independent content. */
  linkedTo?: EditClipSelector;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}>;
/** Set an audio clip's gain and fades: linear gain 0 or more (default 1), fades in seconds 0 or more that fit the clip. An omitted field keeps its value. */
export type SetAudioClipEnvelopeEdit = Readonly<{
  type: "setAudioClipEnvelope";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Finite linear gain 0..∞; omitted to keep the current gain, or unity 1 without an envelope. */
  gain?: number;
  /** Non-negative fade-in duration in clip-local seconds; omitted to keep it, and both fades must fit the clip. */
  fadeIn?: number;
  /** Non-negative fade-out duration in clip-local seconds; omitted to keep it, and both fades must fit the clip. */
  fadeOut?: number;
}>;
/** A point of audio clip gain automation: `atSourceSeconds` is seconds of the original recording (0 or more), `value` linear gain (0 or more), `shape` "linear" (default) or "hold". */
export type ClipGainPointEdit = Readonly<{
  /** Non-negative position in seconds of the original recording, before stretching. */
  atSourceSeconds: number;
  /** Finite linear gain 0..∞, with 1 for unity. */
  value: number;
  /** Interpolation toward the next point; default linear, with the final point normalized to hold. */
  shape?: "linear" | "hold";
}>;
/** Replace an audio clip's gain automation; an empty list clears it. */
export type SetAudioClipGainAutomationEdit = Readonly<{
  type: "setAudioClipGainAutomation";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Replacement gain curve in original recording seconds; empty to clear the curve. */
  points: readonly ClipGainPointEdit[];
}>;
/** A point of track volume automation: a project position (`atBeat` or `atSeconds`), `value` linear gain (0 or more), `shape` "linear" (default) or "hold". */
export type VolumePointEdit = Readonly<{
  /** Finite track gain 0..∞ linear, with 1 for unity. */
  value: number;
  /** Interpolation toward the next point; default linear, with the final point normalized to hold. */
  shape?: "linear" | "hold";
}> &
  EditPosition;
/** Replace a track's volume automation (positions unique); an empty list clears it. */
export type SetVolumeAutomationEdit = Readonly<{
  type: "setVolumeAutomation";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Replacement track gain curve at project positions; empty to clear it and duplicate positions are rejected. */
  points: readonly VolumePointEdit[];
}>;
/** A point of a MIDI controller lane: a project position (`atBeat` or `atSeconds`), an integer `value` in the controller's range (0 to 127, or 0 to 16383 for pitchBend), `shape` "linear" (default) or "hold". Points at one position are a step. */
export type ControllerPointEdit = Readonly<{
  /** Integer 0..127, or 0..16383 for pitch bend with centre 8192. */
  value: number;
  /** Interpolation toward the next point; default linear, with program changes and final points forced to hold. */
  shape?: "linear" | "hold";
}> &
  EditPosition;
/**
 * Replace one MIDI controller lane of a MIDI track, the lane `{ expression, channel, controller }`; an empty list removes it. `controller` is the controller number
 * (`channelController`) or the key (`polyPressure`) and is left out for the other expressions.
 */
export type SetControllerLaneEdit = Readonly<{
  type: "setControllerLane";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** MIDI message family that determines the controller and value ranges. */
  expression: ControllerExpression;
  /** Zero-based MIDI channel, an integer 0..15. */
  channel: number;
  /** Required CC number 0..119 or poly-pressure key 0..127; must be omitted for other expressions. */
  controller?: number;
  /** Replacement points at project positions; empty removes the lane and equal positions make ordered steps. */
  points: readonly ControllerPointEdit[];
}>;
/** Delete a half-open range from the whole song, closing the gap (beats or seconds). `crossfade`: `true` for 5 ms, a length in seconds, or `false` (default) for none. */
export type RippleDeleteEdit = Readonly<{
  type: "rippleDelete";
  /** Half-open range in project beats or project seconds, removed song-wide with the gap closed. */
  range: TimeRange;
  /** `true` for a short default crossfade (5 ms), `false` or omitted for none, or a length in seconds. */
  crossfade?: boolean | number;
}>;
/** Give a linked MIDI clip its own copy of the notes. */
export type MakeClipUniqueEdit = Readonly<{
  type: "makeClipUnique";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
}>;
/** New notes in a MIDI clip's content (timeline or Session slot). Read their IDs with `read_notes` or from the receipt's `createdNotes`. */
export type AddNotesEdit = Readonly<{
  type: "addNotes";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** New MIDI notes in content beats, in the order their IDs appear in createdNotes. */
  notes: readonly NewNoteEdit[];
}>;
/** Delete notes by ID. */
export type RemoveNotesEdit = Readonly<{
  type: "removeNotes";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Opaque IDs of existing notes in the selected MIDI clip; an unknown ID rejects the request. */
  noteIds: readonly string[];
}>;
/** Change notes by ID in content beats; an omitted field stays; velocity is 0 to 1. */
export type EditNotesEdit = Readonly<{
  type: "editNotes";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Existing notes to change by opaque ID; each row must supply at least one changed field. */
  notes: readonly Readonly<{
    id: string;
    /** Integer MIDI note number 0..127, with 60 for middle C; omitted to retain the pitch. */
    pitch?: number;
    /** Non-negative position in content beats; omitted to retain the current start. */
    start?: number;
    /** Positive duration in beats; omitted to retain the current duration. */
    duration?: number;
    /** Normalized strength 0..1; omitted to retain the current velocity. */
    velocity?: number;
  }>[];
}>;

/** Add a track at the end. `volume` is linear gain 0 or more (default 1), `pan` -1 to 1 (default 0), `muted` and `solo` default false, `busRole` (bus only) "submix" (default) or "effect". `as` names it. */
export type AddTrackEdit = Readonly<{
  type: "addTrack";
  name: string;
  /** Role of the new track: audio, MIDI, or a routing bus. */
  kind: TrackKind;
  /** Finite linear gain 0..∞, with 1 for unity; default 1. */
  volume?: number;
  /** Starts the track silent even when soloed if true; default false. */
  muted?: boolean;
  /** Includes the track in the active solo paths when true; default false. */
  solo?: boolean;
  /** Stereo position -1..1, left to right; default 0 at the centre. */
  pan?: number;
  /** Bus purpose, submix or effect; default submix for a bus and invalid on other track kinds. */
  busRole?: BusRole;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}>;
/** Remove a track with its clips, slot clips and devices; routes to a removed bus are cleared. */
export type RemoveTrackEdit = Readonly<{
  type: "removeTrack";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
}>;
/** Rename a track: a non-empty string. */
export type SetTrackNameEdit = Readonly<{
  type: "setTrackName";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  name: string;
}>;
/** Set a track's level as linear gain: 0 or more, 1 is unity (no upper limit). */
export type SetTrackVolumeEdit = Readonly<{
  type: "setTrackVolume";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Finite linear gain 0..∞, with 0 for silence and 1 for unity. */
  volume: number;
}>;
/** Mute or unmute a track (mute wins over solo). */
export type SetTrackMutedEdit = Readonly<{
  type: "setTrackMuted";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** True silences the track even if it is soloed; false removes its mute. */
  muted: boolean;
}>;
/** Solo or unsolo a track. */
export type SetTrackSoloEdit = Readonly<{
  type: "setTrackSolo";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** True includes this track and its routing paths while solo is active; false removes its solo. */
  solo: boolean;
}>;
/** Set a track's stereo position, -1 (left) to 1 (right); 0 is centre. */
export type SetTrackPanEdit = Readonly<{
  type: "setTrackPan";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Stereo position -1..1, from fully left to fully right; 0 is centre. */
  pan: number;
}>;
/** Replace a track's output and post-fader sends. `outputBusId` is a bus track or null for the master (default null); each send has a bus `busId` and a linear `gain` 0 or more. Routes may not form a cycle. */
export type SetTrackRoutingEdit = Readonly<{
  type: "setTrackRouting";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Replacement main output and post-fader sends; cycles are rejected. */
  routing: Readonly<{
    /** Destination bus ID or alias; null or omission routes to the master. */
    outputBusId?: EditTrackRef | null;
    /** Replacement sends; omission clears all sends. */
    sends?: readonly Readonly<{
      /** Destination bus ID or alias; must name an existing bus. */
      busId: EditTrackRef;
      /** Finite post-fader send gain 0..∞ linear, with 1 for unity. */
      gain: number;
    }>[];
  }>;
}>;
/** Replace a track's ordered built-in inserts (filter, delay or eq, as `read_project` lists them). */
export type SetTrackEffectsEdit = Readonly<{
  type: "setTrackEffects";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Replacement ordered built-in inserts; empty removes all inserts. */
  effects: readonly RackEffect[];
}>;
/** Replace a track's inserts and macros together: `{ effects, macros? }`. */
export type SetTrackRackPresetEdit = Readonly<{
  type: "setTrackRackPreset";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Replacement insert settings and macro mappings; omitted macros clear the current macros. */
  preset: RackPreset;
}>;
/** Set one rack macro of a track, 0 to 1. */
export type SetTrackMacroValueEdit = Readonly<{
  type: "setTrackMacroValue";
  /** Opaque track ID or an earlier addTrack alias; the referenced track must exist. */
  trackId: EditTrackRef;
  /** Opaque ID of an existing macro on this track. */
  macroId: string;
  /** Normalized macro position 0..1, mapped to each target parameter range. */
  value: number;
}>;
/** Set the master level as linear gain: 0 or more, 1 is unity. */
export type SetMasterVolumeEdit = Readonly<{
  type: "setMasterVolume";
  /** Finite linear gain 0..∞, with 0 for silence and 1 for unity. */
  volume: number;
}>;
/** Set the song title: a non-empty string. */
export type SetTitleEdit = Readonly<{
  type: "setTitle";
  /** Non-empty song title stored in the project. */
  title: string;
}>;
/** Replace all tempo changes: `{ beat, bpm }` with beat 0 or more (unique) and bpm at least 1. A change at beat 0 sets the starting tempo; without one it stays. */
export type SetTempoChangesEdit = Readonly<{
  type: "setTempoChanges";
  /** Replacement tempo steps at unique project beats >= 0 with BPM >= 1; beat 0 sets the initial tempo. */
  changes: readonly TempoChange[];
}>;
/** Replace all time signature changes: `{ beat, numerator, denominator }` with an integer numerator and a power-of-two denominator. A change at beat 0 sets the starting signature. */
export type SetTimeSignatureChangesEdit = Readonly<{
  type: "setTimeSignatureChanges";
  /** Replacement meter changes at unique project beats >= 0; beat 0 sets the initial signature. */
  changes: readonly TimeSignatureChange[];
}>;
/** A marker: a non-empty `name` at a project position (`atBeat` or `atSeconds`; markers are stored in seconds). */
export type MarkerEdit = Readonly<{ name: string }> & EditPosition;
/** Replace all markers (unique positions). */
export type SetMarkersEdit = Readonly<{
  type: "setMarkers";
  /** Replacement named project positions; duplicate positions are rejected and an empty list clears markers. */
  markers: readonly MarkerEdit[];
}>;
/** Remove a device from its track's chain. */
export type RemoveDeviceEdit = Readonly<{
  type: "removeDevice";
  /** Opaque ID of an existing WebCLAP device in a track device chain. */
  deviceId: string;
}>;
/** Put a device at position `index` (an integer from 0, the first) of its track's chain. */
export type MoveDeviceEdit = Readonly<{
  type: "moveDevice";
  /** Opaque ID of an existing WebCLAP device in a track device chain. */
  deviceId: string;
  /** Zero-based destination position within the track device chain; must be within the existing chain. */
  index: number;
}>;

/**
 * Set one parameter of a device to `value`: `deviceId` is a WebCLAP device's ID or a built-in effect's `trackId:slotId`, `parameterId` is the `id` of a row of
 * `read_device_params` (the CLAP id as a string, or `wet`, `frequency`, ...), `value` is in that row's units; a `step: 1` row snaps it to the nearest whole step from `min` (a tie goes up) and the receipt's `deviceParameters` lists the value applied, while a value outside `min`..`max` is rejected. `expectedValue` is the value you read: if the parameter holds another
 * value now (the person or the plug-in moved it) the request returns `conflict` with the current value in its reason and changes nothing. The comparison allows a relative
 * tolerance of 1e-6 (an absolute 1e-9 near 0), so a float32 value printed and copied back (`0.30000001` for `0.3`) is not a conflict.
 */
export type SetDeviceParameterEdit = Readonly<{
  type: "setDeviceParameter";
  /** WebCLAP device ID or rackDeviceId(trackId, slotId) for a built-in insert. */
  deviceId: string;
  /** Parameter-table key: decimal CLAP parameter ID or a built-in rack parameter key. */
  parameterId: string;
  /** Finite value in the parameter own units and inclusive min..max range; stepped rows require integers. */
  value: number;
  /** Value previously read, in the parameter own units; omission skips this guard and a mismatch returns conflict. Equal within a relative 1e-6 (absolute 1e-9 near 0) counts as the same. */
  expectedValue?: number;
}>;

/** Add an empty scene at the end or after `afterSceneId`; `name` defaults to "Scene N". `as` names it. */
export type AddSceneEdit = Readonly<{
  type: "addScene";
  /** Optional non-empty scene display name; default Scene N based on the existing scene count. */
  name?: string;
  /** Scene ID or alias after which to insert; omitted to append to the scene order. */
  afterSceneId?: EditSceneRef;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}>;
/** Rename a scene: a non-empty string. */
export type RenameSceneEdit = Readonly<{
  type: "renameScene";
  /** Opaque scene ID or an earlier scene-creation alias; the referenced scene must exist. */
  sceneId: EditSceneRef;
  name: string;
}>;
/** Put a scene at position `index` (an integer from 0, the first) in the scene order. */
export type MoveSceneEdit = Readonly<{
  type: "moveScene";
  /** Opaque scene ID or an earlier scene-creation alias; the referenced scene must exist. */
  sceneId: EditSceneRef;
  /** Zero-based destination in the scene order; must be within the existing scene list. */
  index: number;
}>;
/** Remove a scene and the clips in its slots. */
export type RemoveSceneEdit = Readonly<{
  type: "removeScene";
  /** Opaque scene ID or an earlier scene-creation alias; the referenced scene must exist. */
  sceneId: EditSceneRef;
}>;
/** Copy a scene with its slot clips after it or after `afterSceneId`; the copy is named "<name> copy". `as` names the new scene. */
export type DuplicateSceneEdit = Readonly<{
  type: "duplicateScene";
  /** Opaque scene ID or an earlier scene-creation alias; the referenced scene must exist. */
  sceneId: EditSceneRef;
  /** Scene ID or alias after which to insert the copy; omitted to place it after the source. */
  afterSceneId?: EditSceneRef;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}>;
/** Put a new MIDI clip in a slot of a MIDI track, replacing its clip. `duration` is beats (more than 0), `notes` and `sourceOffset` are content beats as for `addMidiClip`. `as` names the clip. */
export type SetMidiClipEdit = Readonly<{
  type: "setMidiClip";
  /** Scene and track references naming one Session grid slot. */
  slot: EditSlotRef;
  /** Positive clip-window duration in beats. */
  duration: number;
  /** Notes in content beats; omitted for an empty clip in the selected slot. */
  notes?: readonly NewNoteEdit[];
  /** Content beat at the clip start; default 0, with negative values allowing empty lead-in. */
  sourceOffset?: number;
  /** Optional non-empty display name; omitted to leave the new clip unnamed. */
  name?: string;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}>;
/** Move a slot's clip to another slot of a track of the same kind, replacing its clip; the clip keeps its ID. */
export type MoveSlotClipEdit = Readonly<{
  type: "moveSlotClip";
  /** Source Session slot, which must contain a clip. */
  from: EditSlotRef;
  /** Destination slot on a track of the same kind; replaces any clip already there. */
  to: EditSlotRef;
}>;
/** Empty a slot. */
export type ClearSlotEdit = Readonly<{
  type: "clearSlot";
  /** Scene and track references naming one Session grid slot. */
  slot: EditSlotRef;
}>;
/** Put a copy of a timeline or slot clip in a slot of a track of the same kind, replacing its clip. `linked: true` shares a MIDI clip's notes (default false). `as` names the copy. */
export type CopyToSlotEdit = Readonly<{
  type: "copyToSlot";
  /** Clip selector resolved against the project or copies made earlier in this request. */
  clip: EditClipSelector;
  /** Scene and track references naming one Session grid slot. */
  slot: EditSlotRef;
  /** Shares MIDI note content with the source when true; default false, and audio copies remain independent. */
  linked?: boolean;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}>;
/** Place a copy of a slot's clip on the timeline at `atBeat` or `atSeconds` (project time, 0 or more), on the slot's track or on `trackId` (same kind). `linked: true` shares a MIDI clip's notes. `as` names the copy. */
export type CopyToArrangementEdit = Readonly<{
  type: "copyToArrangement";
  /** Scene and track references naming one Session grid slot. */
  slot: EditSlotRef;
  /** Destination track ID or alias of the same kind; omitted to keep the source track. */
  trackId?: EditTrackRef;
  /** Shares MIDI note content with the source when true; default false, and audio copies remain independent. */
  linked?: boolean;
  /** Optional request-local alias for created objects so later operations can refer to them with fromCopy. */
  as?: string;
}> &
  EditPosition;

/** One JSON-serializable step of `project.applyEdits`. */
export type ProjectEditOperation =
  | CopyRangeEdit
  | MoveClipEdit
  | ResizeClipEdit
  | SetClipSourceRangeEdit
  | SetClipNameEdit
  | SplitClipEdit
  | DuplicateClipEdit
  | RemoveClipEdit
  | SetClipLoopEdit
  | AddMidiClipEdit
  | SetAudioClipEnvelopeEdit
  | SetAudioClipGainAutomationEdit
  | SetVolumeAutomationEdit
  | SetControllerLaneEdit
  | AddNotesEdit
  | RemoveNotesEdit
  | EditNotesEdit
  | RippleDeleteEdit
  | MakeClipUniqueEdit
  | AddTrackEdit
  | RemoveTrackEdit
  | SetTrackNameEdit
  | SetTrackVolumeEdit
  | SetTrackMutedEdit
  | SetTrackSoloEdit
  | SetTrackPanEdit
  | SetTrackRoutingEdit
  | SetTrackEffectsEdit
  | SetTrackRackPresetEdit
  | SetTrackMacroValueEdit
  | SetMasterVolumeEdit
  | SetTitleEdit
  | SetTempoChangesEdit
  | SetTimeSignatureChangesEdit
  | SetMarkersEdit
  | RemoveDeviceEdit
  | MoveDeviceEdit
  | SetDeviceParameterEdit
  | AddSceneEdit
  | RenameSceneEdit
  | MoveSceneEdit
  | RemoveSceneEdit
  | DuplicateSceneEdit
  | SetMidiClipEdit
  | MoveSlotClipEdit
  | ClearSlotEdit
  | CopyToSlotEdit
  | CopyToArrangementEdit;

export type ProjectEditRequest = Readonly<{
  /** The version the caller read. A different current version returns `conflict` and changes nothing. */
  expectedVersion: ProjectVersion;
  /** Shown in undo history. */
  label: string;
  /** Operations applied in order as one atomic Undo step; any rejected step rolls back the request. */
  ops: readonly ProjectEditOperation[];
}>;

export type ProjectEditRejection =
  | "invalid-request"
  | "invalid-operation"
  | "clip-not-found"
  | "ambiguous-clip"
  | "note-not-found"
  | "track-not-found"
  | "scene-not-found"
  | "device-not-found"
  | "overlap"
  | "nothing-to-undo"
  | "nothing-to-redo"
  | "edit-failed";

/** A song-level setting a receipt can report as changed. */
export type ProjectEditSongPart = "tempo" | "timeSignature" | "markers" | "title" | "masterVolume";

export type ProjectEditReceipt = Readonly<
  | {
      /** Outcome tag: applied commits the request, while conflict or rejected changes nothing. */
      status: "applied";
      /** Opaque project version after a successful request, or the unchanged current version on failure. */
      version: ProjectVersion;
      /** IDs of the clips this edit created (timeline and Session slots), including the copies and pieces other operations made. */
      created: readonly string[];
      /** Per `addNotes` operation, in request order: the clip and the IDs of the notes it created, in the order of the operation's `notes`. */
      createdNotes: readonly Readonly<{
        /** Opaque ID of the MIDI clip receiving the new notes. */
        clipId: string;
        /** Opaque IDs of the added notes, in operation input order. */
        ids: readonly string[];
      }>[];
      /** Per `setDeviceParameter` operation, in request order: the value actually applied, which differs from the requested `value` when a stepped parameter snapped it (`53.9` applies as `54`). */
      deviceParameters: readonly Readonly<{
        /** The device operated on: a WebCLAP device ID or `trackId:slotId` of a built-in effect. */
        deviceId: string;
        /** The parameter row `id` that was set. */
        parameterId: string;
        /** The value now held, in the parameter's own units. */
        value: number;
      }>[];
      /** Per `addTrack` operation, in request order: the new track's ID and its `as` name, if any. */
      createdTracks: readonly Readonly<{
        id: string;
        /** Alias supplied by the track-creation operation; omitted when none was supplied. */
        as?: string;
      }>[];
      /** Per `addScene` and `duplicateScene` operation, in request order: the new scene's ID and its `as` name, if any. */
      createdScenes: readonly Readonly<{
        id: string;
        /** Alias supplied by the scene-creation operation; omitted when none was supplied. */
        as?: string;
      }>[];
      /** Opaque IDs of surviving timeline or slot clips changed by the edit. */
      changed: readonly string[];
      /** Opaque IDs of timeline or slot clips removed by the edit. */
      removed: readonly string[];
      /** IDs of the tracks that stay and whose name, level, mute, solo, pan, inserts, macros, routing, devices or level automation this edit changed. */
      changedTracks: readonly string[];
      /** IDs of the tracks this edit removed (an Undo of `addTrack` removes it). */
      removedTracks: readonly string[];
      /** IDs of the scenes that stay and that this edit renamed, or whose place in the order changed (a moved scene and the scenes beside its old and new place). Filling or clearing a slot changes clips, listed in `created`, `changed` and `removed`, not here. */
      changedScenes: readonly string[];
      /** IDs of the scenes this edit removed. */
      removedScenes: readonly string[];
      /** The song-level settings this edit changed, from "tempo", "timeSignature", "markers", "title" and "masterVolume". */
      song: readonly ProjectEditSongPart[];
      /** Per `as` name given to a clip-making operation: the clips it made (`from` is the clip a copy or piece came from, when there is one). */
      copies: Readonly<
        Record<
          string,
          readonly Readonly<{
            /** Opaque source clip ID for a copy or split piece; omitted for newly created content. */
            from?: string;
            id: string;
            /** Opaque ID of the track containing the created clip. */
            trackId: string;
          }>[]
        >
      >;
    }
  | {
      /** Outcome tag: applied commits the request, while conflict or rejected changes nothing. */
      status: "conflict";
      /** Opaque project version after a successful request, or the unchanged current version on failure. */
      version: ProjectVersion;
      /** Human-readable explanation of the conflict or rejection; the request changed nothing. */
      reason: string;
    }
  | {
      /** Outcome tag: applied commits the request, while conflict or rejected changes nothing. */
      status: "rejected";
      /** Opaque project version after a successful request, or the unchanged current version on failure. */
      version: ProjectVersion;
      /** Machine-readable category of the rejected request or operation. */
      code: ProjectEditRejection;
      /** Human-readable explanation of the conflict or rejection; the request changed nothing. */
      reason: string;
      /** Zero-based index of the failing operation; omitted for request-level or history failures. */
      opIndex?: number;
    }
>;

export type ProjectEditCopies = Record<
  string,
  {
    /** Opaque source clip ID for a copy or split piece; omitted for newly created content. */
    from?: string;
    id: string;
    /** Opaque ID of the track containing the created clip. */
    trackId: string;
  }[]
>;
export type ProjectEditCreatedNotes = {
  /** Opaque ID of the MIDI clip receiving new notes. */
  clipId: string;
  /** Opaque IDs of newly added notes in input order. */
  ids: string[];
}[];
export type ProjectEditDeviceParameters = { deviceId: string; parameterId: string; value: number }[];
export type ProjectEditCreated = {
  id: string;
  /** Alias supplied by the creating operation; omitted when no alias was requested. */
  as?: string;
}[];
/** What running the operations produced beyond the clip changes the history entry already lists. */
export type ProjectEditRun = {
  /** Created clips grouped by request-local as alias, including their source when applicable. */
  copies: ProjectEditCopies;
  /** New note IDs grouped by addNotes operation, in request order. */
  createdNotes: ProjectEditCreatedNotes;
  /** The value each setDeviceParameter operation applied, in request order. */
  deviceParameters: ProjectEditDeviceParameters;
  /** New tracks and their optional request-local aliases, in request order. */
  createdTracks: ProjectEditCreated;
  /** New scenes and their optional request-local aliases, in request order. */
  createdScenes: ProjectEditCreated;
};

/** Thrown by an operation whose `expected…` guard no longer holds; `applyEdits` returns it as `conflict` (not `rejected`) and the Project is left as it was. */
export class ProjectEditConflict extends Error {}

export class ProjectEditFailure extends Error {
  constructor(
    readonly code: ProjectEditRejection,
    message: string,
    readonly opIndex?: number,
  ) {
    super(message);
  }
}

const EPSILON = 1e-9;
/** Keeps a value step between adjoining automation blocks from becoming a long ramp. */
const AUTOMATION_EDGE_SECONDS = 0.001;

const fail = (code: ProjectEditRejection, message: string): never => {
  throw new ProjectEditFailure(code, message);
};
const validBeat = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function clipBeats(tempo: TempoMap, clip: ProjectClip): readonly [number, number] {
  if (clip.kind === "midi") return [clip.time, clip.time + clip.duration];
  return [tempo.secondsToBeat(clip.time), tempo.secondsToBeat(clip.time + clip.duration)];
}

function summary(project: Project, tempo: TempoMap, track: ProjectTrack, clip: ProjectClip): ProjectClipSummary {
  const linked = project.linkedClips(clip.id).map(({ id }) => id);
  const name = project.clipName(clip.id);
  const [startBeat, endBeat] = clipBeats(tempo, clip);
  const startSeconds = clip.kind === "midi" ? tempo.beatToSeconds(clip.time) : clip.time;
  const endSeconds = clip.kind === "midi" ? tempo.beatToSeconds(clip.time + clip.duration) : clip.time + clip.duration;
  return {
    id: clip.id,
    ...(name === undefined ? {} : { name }),
    kind: clip.kind,
    trackId: track.id,
    trackName: track.name,
    startSeconds,
    durationSeconds: endSeconds - startSeconds,
    startBeat,
    durationBeats: endBeat - startBeat,
    ...(clip.kind === "midi" ? { sourceOffset: clip.sourceOffset, ...(clip.loop ? { loop: { ...clip.loop } } : {}) } : {}),
    ...(linked.length ? { linkedTo: linked } : {}),
  };
}

export function projectOverview(project: Project, version: ProjectVersion): ProjectOverview {
  const tempo = project.tempoMap;
  return {
    version,
    title: project.title,
    bpm: project.bpm,
    signature: project.signature,
    signatureChanges: project.meterMap.changes,
    tempoChanges: tempo.changes,
    markers: project.markers,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      clips: track.clips.map((clip) => summary(project, tempo, track, clip)),
    })),
    session: readSession(project).scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      clips: project.tracks.flatMap((track) => {
        const clip = readSession(project).slots.get(slotKey(scene.id, track.id));
        if (!clip) return [];
        const name = project.clipName(clip.id);
        const linked = project.linkedClips(clip.id).map(({ id }) => id);
        return [
          {
            id: clip.id,
            ...(name === undefined ? {} : { name }),
            kind: clip.kind,
            trackId: track.id,
            trackName: track.name,
            duration: clip.duration,
            unit: clip.kind === "midi" ? ("beats" as const) : ("seconds" as const),
            ...(clip.kind === "midi" ? { sourceOffset: clip.sourceOffset, ...(clip.loop ? { loop: { ...clip.loop } } : {}) } : {}),
            ...(linked.length ? { linkedTo: linked } : {}),
          },
        ];
      }),
    })),
  };
}

export function findProjectClips(project: Project, query: ProjectClipQuery): readonly ProjectClipSummary[] {
  const tempo = project.tempoMap;
  const { range, relation = "overlaps" } = query;
  if (range && (!validBeat(range.startBeat) || !validBeat(range.endBeat) || range.startBeat >= range.endBeat))
    throw new RangeError("Project clip query needs a range with 0 <= startBeat < endBeat.");
  if (relation !== "overlaps" && relation !== "contained") throw new RangeError('Project clip query relation must be "overlaps" or "contained".');
  return project.tracks.flatMap((track) => {
    if ((query.trackId !== undefined && track.id !== query.trackId) || (query.trackName !== undefined && track.name !== query.trackName)) return [];
    return track.clips.flatMap((clip) => {
      if (query.name !== undefined && project.clipName(clip.id) !== query.name) return [];
      const item = summary(project, tempo, track, clip);
      if (range) {
        const end = item.startBeat + item.durationBeats;
        const matches =
          relation === "contained"
            ? item.startBeat >= range.startBeat - EPSILON && end <= range.endBeat + EPSILON
            : item.startBeat < range.endBeat - EPSILON && end > range.startBeat + EPSILON;
        if (!matches) return [];
      }
      return [item];
    });
  });
}

/** Tempo after inserting a copy of `[start, end)` at `at`: every old beat at or after `at` moves later by the section length. */
function insertedTempo(tempo: TempoMap, start: number, end: number, at: number): TempoChange[] {
  const length = end - start;
  if (at === 0 && tempo.bpmAtBeat(start) !== tempo.initialBpm)
    fail("invalid-operation", "copyRange cannot insert at beat 0 when the section starts at a different tempo.");
  const steps = new Map<number, number>();
  for (const change of tempo.changes) if (change.beat < at) steps.set(change.beat, change.bpm);
  steps.set(at, tempo.bpmAtBeat(start));
  for (const change of tempo.changes) if (change.beat > start && change.beat < end) steps.set(at + change.beat - start, change.bpm);
  steps.set(at + length, tempo.bpmAtBeat(at));
  for (const change of tempo.changes) if (change.beat > at) steps.set(change.beat + length, change.bpm);
  let previous = tempo.initialBpm;
  const changes: TempoChange[] = [];
  for (const [beat, bpm] of [...steps].sort((a, b) => a[0] - b[0])) {
    if (beat === 0 || bpm === previous) continue;
    changes.push({ beat, bpm });
    previous = bpm;
  }
  return changes;
}

function insertedAutomation(
  points: readonly AutomationPoint[],
  edges: Readonly<{ start: number; end: number; at: number; atAfter: number }>,
  copied: (seconds: number) => number,
  later: (seconds: number) => number,
): AutomationPoint[] {
  const curve = new AutomationCurve(points);
  const shapeAt = (time: number) => points.findLast((point) => point.time <= time)?.shape ?? "hold";
  const out: AutomationPoint[] = [];
  const push = (time: number, value: number, shape: AutomationPoint["shape"]) => {
    if (time < 0 || (out.length && time <= out[out.length - 1].time)) return;
    out.push({ time, value, shape });
  };
  for (const point of points) if (point.time < edges.at) push(point.time, point.value, point.shape);
  // A curve holds its first value before its first point, so a new earlier point must not redefine that stretch.
  if (!out.length && edges.at > 0) push(Math.max(0, edges.at - AUTOMATION_EDGE_SECONDS), curve.valueAt(edges.at), "hold");
  if (shapeAt(edges.at - EPSILON) === "linear") push(edges.at - AUTOMATION_EDGE_SECONDS, curve.valueAt(edges.at), "linear");
  push(edges.at, curve.valueAt(edges.start), shapeAt(edges.start));
  for (const point of points) if (point.time > edges.start && point.time < edges.end) push(copied(point.time), point.value, point.shape);
  if (shapeAt(edges.end - EPSILON) === "linear") push(edges.atAfter - AUTOMATION_EDGE_SECONDS, curve.valueAt(edges.end), "linear");
  push(edges.atAfter, curve.valueAt(edges.at), shapeAt(edges.at));
  for (const point of points) if (point.time > edges.at) push(later(point.time), point.value, point.shape);
  return out;
}

function copyRange(ctx: Ctx, op: CopyRangeEdit): void {
  const { project, copies } = ctx;
  const { range, atBeat: at, placement } = op;
  if (placement !== "insert") fail("invalid-operation", 'copyRange placement must be "insert".');
  if (!range || !validBeat(range.startBeat) || !validBeat(range.endBeat) || range.startBeat >= range.endBeat || !validBeat(at))
    fail("invalid-operation", "copyRange needs a range with 0 <= startBeat < endBeat and a non-negative atBeat.");
  const as = claimName(ctx, op, true)!;
  const { startBeat: start, endBeat: end } = range;
  if (at > start && at < end) fail("invalid-operation", "copyRange cannot insert inside the copied range.");

  const before = project.tempoMap;
  const length = end - start;
  const startSeconds = before.beatToSeconds(start);
  const endSeconds = before.beatToSeconds(end);
  const atSeconds = before.beatToSeconds(at);
  // A throwaway map answers where each old position lands; the Project takes it last.
  const tempoChanges = insertedTempo(before, start, end, at);
  const after = new TempoMap(before.initialBpm, tempoChanges);
  // Content the opened file keeps as it is moves with the rest, or the edit is refused here, before anything has changed.
  keptContent.shift(
    project,
    {
      kind: "insert",
      seconds: { start: startSeconds, end: endSeconds, at: atSeconds },
      beats: { start, end, at },
      before,
      after,
    },
    "copyRange",
  );
  const copiedSeconds = (seconds: number) => after.beatToSeconds(at + before.secondsToBeat(seconds) - start);
  const laterSeconds = (seconds: number) => after.beatToSeconds(before.secondsToBeat(seconds) + length);
  const originals = project.tracks.flatMap((track) => track.clips.map((clip) => ({ trackId: track.id, clip })));

  const made: ProjectEditCopies[string] = [];
  for (const { trackId, clip } of originals) {
    const isMidi = clip.kind === "midi";
    const from = Math.max((isMidi ? start : startSeconds) - clip.time, 0);
    const to = Math.min((isMidi ? end : endSeconds) - clip.time, clip.duration);
    if (to - from <= (isMidi ? EPSILON : 0.5 / clip.sampleRate)) continue;
    const copy = project.duplicateClip(clip.id, clip.time);
    const whole = from <= EPSILON && to >= clip.duration - EPSILON;
    const placed = whole ? copy : project.resizeClip(copy.id, { start: copy.time + from, end: copy.time + to });
    const position = isMidi ? at + clip.time + from - start : copiedSeconds(clip.time + from);
    project.moveClip(placed.id, trackId, position);
    made.push({ from: clip.id, id: placed.id, trackId });
  }

  for (const { trackId, clip } of originals) {
    const boundary = clip.kind === "midi" ? at : atSeconds;
    const offset = boundary - clip.time;
    const minimum = clip.kind === "midi" ? EPSILON : 1 / clip.sampleRate;
    // A start within one frame of the boundary is on it: audio positions round to frames.
    if (offset >= minimum && clip.duration - offset < minimum) continue;
    if (offset >= clip.duration) continue;
    const moving = offset >= minimum ? project.splitClip(clip.id, offset)[1] : clip;
    if (moving !== clip)
      for (const list of Object.values(copies)) {
        const owner = list.find(({ id }) => id === clip.id);
        if (owner) list.push({ from: owner.from, id: moving.id, trackId });
      }
    project.moveClip(moving.id, trackId, moving.kind === "midi" ? moving.time + length : laterSeconds(moving.time));
  }

  const atAfter = after.beatToSeconds(at + length);
  for (const track of project.tracks)
    if (track.volumeAutomation.length)
      project.setVolumeAutomation(
        track.id,
        insertedAutomation(track.volumeAutomation, { start: startSeconds, end: endSeconds, at: atSeconds, atAfter }, copiedSeconds, laterSeconds),
      );

  for (const track of project.tracks)
    for (const lane of track.controllerLanes)
      project.setControllerLane(track.id, { ...lane, points: controllerPointsAfterInsert(lane.expression, lane.points, start, end, at) });

  const markers = project.markers.flatMap((marker) => {
    const beat = before.secondsToBeat(marker.time);
    const moved = beat >= at - EPSILON ? { time: laterSeconds(marker.time), name: marker.name } : marker;
    return beat >= start - EPSILON && beat < end - EPSILON ? [moved, { time: copiedSeconds(marker.time), name: marker.name }] : [moved];
  });
  project.setMarkers(markers);
  project.setTempoChanges(tempoChanges);
  copies[as] = made;
}

function resolveClip(project: Project, selector: EditClipSelector, copies: ProjectEditCopies): { track: ProjectTrack; clip: ProjectClip } {
  const id = selectedClipId(project, selector, copies);
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return { track, clip };
  }
  return fail("clip-not-found", `Clip "${id}" does not exist.`);
}

/** Like `resolveClip`, for edits that work on any clip by ID: a Session slot clip counts. */
function resolveAnyClip(project: Project, selector: EditClipSelector, copies: ProjectEditCopies): ProjectClip {
  const id = selectedClipId(project, selector, copies);
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return clip;
  }
  return findSlotClip(project, id!) ?? fail("clip-not-found", `Clip "${id}" does not exist.`);
}

function selectedClipId(project: Project, selector: EditClipSelector, copies: ProjectEditCopies): string | undefined {
  if (!selector || typeof selector !== "object") fail("invalid-operation", "Edit needs a clip selector.");
  const hasId = selector.clipId !== undefined;
  const hasCopy = selector.fromCopy !== undefined;
  if (hasId === hasCopy) fail("invalid-operation", "A clip selector needs exactly one of clipId and fromCopy.");
  if (hasId && (selector.trackId !== undefined || selector.trackName !== undefined || selector.name !== undefined))
    fail("invalid-operation", "A clipId selector cannot also filter by track or name.");
  let id = selector.clipId;
  if (hasCopy) {
    if (!Object.hasOwn(copies, selector.fromCopy!))
      fail("clip-not-found", `No earlier operation named "${selector.fromCopy}" made clips (give it an \`as\`).`);
    const matches = copies[selector.fromCopy!].filter(({ id: copyId, trackId }) => {
      const track = project.tracks.find((item) => item.id === trackId);
      return (
        (selector.trackId === undefined || trackId === selector.trackId) &&
        (selector.trackName === undefined || track?.name === selector.trackName) &&
        (selector.name === undefined || project.clipName(copyId) === selector.name)
      );
    });
    if (!matches.length) fail("clip-not-found", `Copy "${selector.fromCopy}" has no clip on that track.`);
    if (matches.length > 1)
      fail("ambiguous-clip", `Copy "${selector.fromCopy}" matches ${matches.length} clips: ${matches.map((m) => m.id).join(", ")}.`);
    id = matches[0].id;
  }
  return id;
}

function moveClip(ctx: Ctx, op: MoveClipEdit): void {
  const { project } = ctx;
  const { track, clip } = resolveClip(project, op.clip, ctx.copies);
  const hasAt = op.position?.atBeat !== undefined;
  const hasBy = op.position?.byBeats !== undefined;
  if (hasAt === hasBy) fail("invalid-operation", "moveClip position needs exactly one of atBeat and byBeats.");
  const tempo = project.tempoMap;
  const [startBeat] = clipBeats(tempo, clip);
  const beat = hasAt ? op.position.atBeat! : startBeat + op.position.byBeats!;
  if (!validBeat(beat)) fail("invalid-operation", "moveClip needs a finite target at or after beat 0.");
  const time = clip.kind === "midi" ? beat : tempo.beatToSeconds(beat);
  project.moveClip(clip.id, op.trackId === undefined ? track.id : trackRef(ctx, op.trackId, "moveClip trackId"), time);
  ctx.moved.set(clip.id, ctx.index);
}

function resizeClipOp(project: Project, op: ResizeClipEdit, copies: ProjectEditCopies, moved: Map<string, number>, index: number): void {
  const clip = resolveAnyClip(project, op.clip, copies);
  const { start, end } = op;
  if (
    (start === undefined && end === undefined) ||
    [start, end].some((edge) => edge !== undefined && (typeof edge !== "number" || !Number.isFinite(edge)))
  )
    fail("invalid-operation", "resizeClip needs a finite start, a finite end or both, in project beats.");
  const tempo = project.tempoMap;
  const unit = (beat: number | undefined) => (beat === undefined || clip.kind === "midi" ? beat : tempo.beatToSeconds(Math.max(0, beat)));
  project.resizeClip(clip.id, { start: unit(start), end: unit(end) });
  moved.set(clip.id, index);
}

function setClipSourceRangeOp(
  project: Project,
  op: SetClipSourceRangeEdit,
  copies: ProjectEditCopies,
  moved: Map<string, number>,
  index: number,
): void {
  const clip = resolveAnyClip(project, op.clip, copies);
  if (typeof op.start !== "number" || typeof op.end !== "number" || !Number.isFinite(op.start) || !Number.isFinite(op.end) || !(op.start < op.end))
    fail("invalid-operation", "setClipSourceRange needs finite start < end (content beats for MIDI, recording seconds for audio).");
  project.setClipSourceRange(clip.id, { start: op.start, end: op.end });
  moved.set(clip.id, index);
}

const NOTE_FIELDS = ["pitch", "start", "duration", "velocity"] as const;

/** Rejects a field of `value` that `allowed` does not list, naming the ones it does. */
function onlyFields(value: unknown, allowed: readonly string[], where: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) fail("invalid-operation", `${where} has unknown field "${unknown}"; allowed: ${allowed.join(", ")}.`);
}

function noteFieldProblem(note: Record<string, unknown>, field: (typeof NOTE_FIELDS)[number]): string | null {
  const value = note[field];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a finite number`;
  if (field === "pitch" && (!Number.isInteger(value) || value < 0 || value > 127)) return "pitch must be an integer 0 to 127";
  if (field === "velocity" && (value < 0 || value > 1)) return "velocity must be 0 to 1";
  if (field === "start" && value < 0) return "start must be 0 or more content beats";
  if (field === "duration" && value <= 0) return "duration must be more than 0 beats";
  return null;
}

function midiClipOf(project: Project, op: { type: string; clip: EditClipSelector }, copies: ProjectEditCopies) {
  const clip = resolveAnyClip(project, op.clip, copies);
  if (clip.kind !== "midi") fail("invalid-operation", `${op.type} needs a MIDI clip.`);
  return clip as Extract<ProjectClip, { kind: "midi" }>;
}

function noteList(op: { type: string }, key: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) fail("invalid-operation", `${op.type} needs a non-empty ${key} array.`);
  return value as Record<string, unknown>[];
}

/** Rejects a note list that `addNotes`, `addMidiClip` or `setMidiClip` cannot take. */
function validateNewNotes(type: string, notes: Record<string, unknown>[]): void {
  for (const [index, note] of notes.entries()) {
    if (typeof note !== "object" || note === null)
      fail("invalid-operation", `${type} notes[${index}] must be { pitch, start, duration, velocity? }.`);
    onlyFields(note, NOTE_FIELDS, `${type} notes[${index}]`);
    for (const field of ["pitch", "start", "duration"] as const)
      if (note[field] === undefined) fail("invalid-operation", `${type} notes[${index}] needs ${field}.`);
    for (const field of NOTE_FIELDS) {
      const problem = noteFieldProblem(note, field);
      if (problem) fail("invalid-operation", `${type} notes[${index}]: ${problem}.`);
    }
  }
}

function addNotesOp(project: Project, op: AddNotesEdit, copies: ProjectEditCopies, createdNotes: ProjectEditCreatedNotes): void {
  const clip = midiClipOf(project, op, copies);
  const notes = noteList(op, "notes", op.notes);
  validateNewNotes("addNotes", notes);
  const before = new Set(clip.midi.notes.value.map(({ id }) => id));
  const velocities = notes.map((note) => (note.velocity as number | undefined) ?? 0.8);
  clip.midi.edit((draft) => {
    for (const [index, note] of notes.entries())
      draft.push({ pitch: note.pitch as number, start: note.start as number, duration: note.duration as number, velocity: velocities[index] });
  });
  // The clip sorts its notes, so match each requested note to its new one; equal notes are interchangeable and keep push order.
  const fresh = clip.midi.notes.value.filter(({ id }) => !before.has(id));
  const ids = notes.map((note, index) => {
    const at = fresh.findIndex(
      (made) => made.pitch === note.pitch && made.start === note.start && made.duration === note.duration && made.velocity === velocities[index],
    );
    return fresh.splice(at, 1)[0].id;
  });
  createdNotes.push({ clipId: clip.id, ids });
}

function removeNotesOp(project: Project, op: RemoveNotesEdit, copies: ProjectEditCopies): void {
  const clip = midiClipOf(project, op, copies);
  const ids = noteList(op, "noteIds", op.noteIds) as unknown as unknown[];
  if (!ids.every((id) => typeof id === "string" && id)) fail("invalid-operation", "removeNotes noteIds must be note ID strings.");
  const present = new Set(clip.midi.notes.value.map(({ id }) => id));
  for (const id of ids) if (!present.has(id as string)) fail("note-not-found", `Clip "${clip.id}" has no note "${id}".`);
  clip.midi.edit((draft) => {
    for (let index = draft.length - 1; index >= 0; index--) if (ids.includes(draft[index].id)) draft.splice(index, 1);
  });
}

function editNotesOp(project: Project, op: EditNotesEdit, copies: ProjectEditCopies): void {
  const clip = midiClipOf(project, op, copies);
  const edits = noteList(op, "notes", op.notes);
  const present = new Set(clip.midi.notes.value.map(({ id }) => id));
  for (const [index, edit] of edits.entries()) {
    if (typeof edit !== "object" || edit === null || typeof edit.id !== "string") fail("invalid-operation", `editNotes notes[${index}] needs an id.`);
    onlyFields(edit, ["id", ...NOTE_FIELDS], `editNotes notes[${index}]`);
    if (!present.has(edit.id as string)) fail("note-not-found", `Clip "${clip.id}" has no note "${edit.id}".`);
    if (NOTE_FIELDS.every((field) => edit[field] === undefined))
      fail("invalid-operation", `editNotes notes[${index}] changes nothing: give pitch, start, duration or velocity.`);
    for (const field of NOTE_FIELDS) {
      const problem = noteFieldProblem(edit, field);
      if (problem) fail("invalid-operation", `editNotes notes[${index}]: ${problem}.`);
    }
  }
  clip.midi.edit((draft) => {
    for (const edit of edits) {
      const note = draft.find(({ id }) => id === edit.id)!;
      for (const field of NOTE_FIELDS) if (edit[field] !== undefined) note[field] = edit[field] as number;
    }
  });
}

/** The fields each edit type takes; anything else is rejected instead of silently ignored. */
export const PROJECT_EDIT_FIELDS: Readonly<Record<ProjectEditOperation["type"], readonly string[]>> = {
  copyRange: ["range", "atBeat", "placement", "as"],
  moveClip: ["clip", "trackId", "position"],
  resizeClip: ["clip", "start", "end"],
  setClipSourceRange: ["clip", "start", "end"],
  setClipName: ["clip", "name"],
  splitClip: ["clip", "atBeat", "atSeconds", "as"],
  duplicateClip: ["clip", "atBeat", "atSeconds", "trackId", "linked", "as"],
  removeClip: ["clip"],
  setClipLoop: ["clip", "loop"],
  addMidiClip: ["trackId", "atBeat", "duration", "notes", "sourceOffset", "name", "linkedTo", "as"],
  setAudioClipEnvelope: ["clip", "gain", "fadeIn", "fadeOut"],
  setAudioClipGainAutomation: ["clip", "points"],
  setVolumeAutomation: ["trackId", "points"],
  setControllerLane: ["trackId", "expression", "channel", "controller", "points"],
  addNotes: ["clip", "notes"],
  removeNotes: ["clip", "noteIds"],
  editNotes: ["clip", "notes"],
  rippleDelete: ["range", "crossfade"],
  makeClipUnique: ["clip"],
  addTrack: ["name", "kind", "volume", "muted", "solo", "pan", "busRole", "as"],
  removeTrack: ["trackId"],
  setTrackName: ["trackId", "name"],
  setTrackVolume: ["trackId", "volume"],
  setTrackMuted: ["trackId", "muted"],
  setTrackSolo: ["trackId", "solo"],
  setTrackPan: ["trackId", "pan"],
  setTrackRouting: ["trackId", "routing"],
  setTrackEffects: ["trackId", "effects"],
  setTrackRackPreset: ["trackId", "preset"],
  setTrackMacroValue: ["trackId", "macroId", "value"],
  setMasterVolume: ["volume"],
  setTitle: ["title"],
  setTempoChanges: ["changes"],
  setTimeSignatureChanges: ["changes"],
  setMarkers: ["markers"],
  removeDevice: ["deviceId"],
  moveDevice: ["deviceId", "index"],
  setDeviceParameter: ["deviceId", "parameterId", "value", "expectedValue"],
  addScene: ["name", "afterSceneId", "as"],
  renameScene: ["sceneId", "name"],
  moveScene: ["sceneId", "index"],
  removeScene: ["sceneId"],
  duplicateScene: ["sceneId", "afterSceneId", "as"],
  setMidiClip: ["slot", "duration", "notes", "sourceOffset", "name", "as"],
  moveSlotClip: ["from", "to"],
  clearSlot: ["slot"],
  copyToSlot: ["clip", "slot", "linked", "as"],
  copyToArrangement: ["slot", "trackId", "atBeat", "atSeconds", "linked", "as"],
};

/** Every operation type, in the order the tool schema lists them. */
export const PROJECT_EDIT_TYPES = Object.keys(PROJECT_EDIT_FIELDS) as readonly ProjectEditOperation["type"][];

/** The operation that does what each public `Project` and `ProjectSession` method does. A key is `Class.method`. */
export const EDIT_OPERATION_FOR_METHOD: Readonly<Record<string, ProjectEditOperation["type"]>> = {
  "Project.rippleDelete": "rippleDelete",
  "Project.moveClip": "moveClip",
  "Project.resizeClip": "resizeClip",
  "Project.setClipSourceRange": "setClipSourceRange",
  "Project.setClipName": "setClipName",
  "Project.splitClip": "splitClip",
  "Project.duplicateClip": "duplicateClip",
  "Project.removeClip": "removeClip",
  "Project.setClipLoop": "setClipLoop",
  "Project.makeClipUnique": "makeClipUnique",
  "Project.addMidiClip": "addMidiClip",
  "Project.setAudioClipEnvelope": "setAudioClipEnvelope",
  "Project.setAudioClipGainAutomation": "setAudioClipGainAutomation",
  "Project.setVolumeAutomation": "setVolumeAutomation",
  "Project.setControllerLane": "setControllerLane",
  "Project.addTrack": "addTrack",
  "Project.removeTrack": "removeTrack",
  "Project.setTrackName": "setTrackName",
  "Project.setTrackVolume": "setTrackVolume",
  "Project.setTrackMuted": "setTrackMuted",
  "Project.setTrackSolo": "setTrackSolo",
  "Project.setTrackPan": "setTrackPan",
  "Project.setTrackRouting": "setTrackRouting",
  "Project.setTrackEffects": "setTrackEffects",
  "Project.setTrackRackPreset": "setTrackRackPreset",
  "Project.setTrackMacroValue": "setTrackMacroValue",
  "Project.setMasterVolume": "setMasterVolume",
  "Project.setTitle": "setTitle",
  "Project.setTempoChanges": "setTempoChanges",
  "Project.setTimeSignatureChanges": "setTimeSignatureChanges",
  "Project.setMarkers": "setMarkers",
  "Project.removeDevice": "removeDevice",
  "Project.moveDevice": "moveDevice",
  "Project.setDeviceParameter": "setDeviceParameter",
  "ProjectSession.addScene": "addScene",
  "ProjectSession.renameScene": "renameScene",
  "ProjectSession.moveScene": "moveScene",
  "ProjectSession.removeScene": "removeScene",
  "ProjectSession.duplicateScene": "duplicateScene",
  "ProjectSession.setMidiClip": "setMidiClip",
  "ProjectSession.moveClip": "moveSlotClip",
  "ProjectSession.clearSlot": "clearSlot",
  "ProjectSession.copyToSlot": "copyToSlot",
  "ProjectSession.copyToArrangement": "copyToArrangement",
};

/** Operations that are not one method of `Project` or `ProjectSession`, with what they do instead. */
export const EDIT_OPERATION_WITHOUT_METHOD: Readonly<Record<string, string>> = {
  copyRange:
    "composes `duplicateClip`, `resizeClip`, `splitClip`, `moveClip`, `setMarkers`, `setTempoChanges` and `setVolumeAutomation` into one insert",
  addNotes: "edits the notes a clip holds (`clip.midi.edit`), not a `Project` method",
  removeNotes: "edits the notes a clip holds (`clip.midi.edit`), not a `Project` method",
  editNotes: "edits the notes a clip holds (`clip.midi.edit`), not a `Project` method",
};

/** Public methods that have no operation, with the reason. A key is `Class.method`. */
export const EDIT_METHODS_NOT_OFFERED: Readonly<Record<string, string>> = {
  "Project.addAudioClip": "needs PCM audio, which JSON cannot carry",
  "Project.addAudioMediaClip": "needs file-backed audio media, which JSON cannot carry",
  "Project.addMidiTake": "takes a recorded `MidiTake` object from the recorder; `addMidiClip` covers JSON notes",
  "Project.applyAudioClipStretch": "needs rendered PCM; the app's stretch pipeline calls it",
  "Project.addDevice": "needs a plug-in bundle and its state bytes",
  "Project.setDeviceState": "needs the plug-in's binary state",
  "ProjectSession.setAudioClip": "needs PCM audio, which JSON cannot carry",
  "Project.applyEdits": "is the tool itself",
  "Project.edit": "groups code callbacks; `apply_edits` groups JSON operations",
  "Project.undo": "history control, not an edit; the person's Undo undoes an agent's step",
  "Project.redo": "history control, not an edit",
  "Project.clearHistory": "history control, not an edit",
  "Project.extension": "app data owned by registered extensions; the app offers `defineOperation` operations for it",
  "Project.snapshot": "makes a copy, not an edit",
  "Project.dispose": "releases the Project, not an edit",
  "Project.overview": "read: `read_project`",
  "Project.findClips": "read: `find`",
  "Project.findMarker": "read: `find`",
  "Project.extensionSummaries": "read: `read_project`",
  "Project.linkedClips": "read: `read_project` shows `linkedTo`",
  "Project.clipRecording": "read: audio data, not JSON",
  "Project.clipName": "read: `read_project`",
  "Project.clipTimeSeconds": "read: unit conversion",
  "ProjectSession.clipAt": "read: `read_project` lists slot clips",
  "ProjectSession.midiClipAt": "read: `read_project` lists slot clips",
  "ProjectSession.audioClipAt": "read: `read_project` lists slot clips",
};

function checkFields(op: ProjectEditOperation): void {
  const type = op?.type;
  if (typeof type !== "string" || !Object.hasOwn(PROJECT_EDIT_FIELDS, type)) return;
  onlyFields(op, ["type", ...PROJECT_EDIT_FIELDS[type]], type);
  const nested = op as unknown as Record<string, unknown>;
  const range = nested.range as Record<string, unknown> | undefined;
  if (range && typeof range === "object")
    onlyFields(
      range,
      type === "rippleDelete" && "startSeconds" in range ? ["startSeconds", "endSeconds"] : ["startBeat", "endBeat"],
      `${type} range`,
    );
  onlyFields(nested.position, ["atBeat", "byBeats"], `${type} position`);
  for (const key of ["clip", "linkedTo"]) onlyFields(nested[key], ["clipId", "fromCopy", "trackId", "trackName", "name"], `${type} ${key}`);
  for (const key of ["slot", "from", "to"]) onlyFields(nested[key], ["sceneId", "trackId"], `${type} ${key}`);
}

function rippleDeleteOp(project: Project, op: RippleDeleteEdit): void {
  if (!timeRangeKind(op.range)) fail("invalid-operation", "Project ripple delete needs 0 <= start < end.");
  if (crossfadeSeconds(op.crossfade) === undefined)
    fail("invalid-operation", "Project ripple delete crossfade must be true, false or a non-negative number of seconds.");
  project.rippleDelete(op.range, op.crossfade === undefined ? undefined : { crossfade: op.crossfade });
}

// ---------------------------------------------------------------- field checks

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

type NumberRange = Readonly<{ min?: number; max?: number; above?: number; integer?: boolean }>;

function numberFor(type: string, key: string, value: unknown, range: NumberRange): number {
  const bounds = [
    range.integer ? "an integer" : "a finite number",
    range.min !== undefined && range.max !== undefined
      ? `from ${range.min} to ${range.max}`
      : range.min !== undefined
        ? `of ${range.min} or more`
        : range.max !== undefined
          ? `of ${range.max} or less`
          : range.above !== undefined
            ? `more than ${range.above}`
            : "",
  ];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (range.integer && !Number.isInteger(value)) ||
    (range.min !== undefined && value < range.min) ||
    (range.max !== undefined && value > range.max) ||
    (range.above !== undefined && value <= range.above)
  )
    fail("invalid-operation", `${type} needs ${key} as ${bounds.filter(Boolean).join(" ")}.`);
  return value as number;
}

const requiredNumber = (op: Rec, key: string, range: NumberRange = {}): number => numberFor(String(op.type), key, op[key], range);
const optionalNumber = (op: Rec, key: string, range: NumberRange = {}): number | undefined =>
  op[key] === undefined ? undefined : numberFor(String(op.type), key, op[key], range);

function requiredString(op: Rec, key: string): string {
  const value = op[key];
  if (typeof value !== "string" || !value.trim()) fail("invalid-operation", `${op.type} needs ${key} as a non-empty string.`);
  return value as string;
}
function optionalString(op: Rec, key: string): string | undefined {
  return op[key] === undefined ? undefined : requiredString(op, key);
}
function booleanFor(op: Rec, key: string, required: boolean): boolean | undefined {
  const value = op[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "boolean") fail("invalid-operation", `${op.type} needs ${key} as true or false.`);
  return value as boolean;
}
function listFor(op: Rec, key: string, nonEmpty = false): Rec[] {
  const value = op[key];
  if (!Array.isArray(value) || (nonEmpty && !value.length))
    fail("invalid-operation", `${op.type} needs ${key} as ${nonEmpty ? "a non-empty" : "an"} array.`);
  for (const [index, item] of (value as unknown[]).entries())
    if (!isRec(item)) fail("invalid-operation", `${op.type} ${key}[${index}] must be an object.`);
  return value as Rec[];
}

// ---------------------------------------------------------------- the run

type Ctx = {
  project: Project;
  copies: ProjectEditCopies;
  createdNotes: ProjectEditCreatedNotes;
  deviceParameters: ProjectEditDeviceParameters;
  createdTracks: ProjectEditCreated;
  createdScenes: ProjectEditCreated;
  /** Timeline clips a request moved, resized or created, with the index of the operation that did; the final arrangement is checked for overlap on each. */
  moved: Map<string, number>;
  /** The timeline clip IDs seen before the current operation, to find the ones it created. */
  known: Set<string>;
  /** The timeline clips this request created: audio positions round to frames, so they may share less than one frame with a neighbour. */
  created: Set<string>;
  /** Every `as` name used so far; each is unique across clips, tracks and scenes. */
  names: Set<string>;
  tracks: Map<string, string>;
  scenes: Map<string, string>;
  index: number;
};

/** Reserves the operation's `as` name, if it has one. */
function claimName(ctx: Ctx, op: { type: string; as?: unknown }, required = false): string | undefined {
  if (op.as === undefined && !required) return undefined;
  if (typeof op.as !== "string" || !op.as || ctx.names.has(op.as))
    fail("invalid-operation", `${op.type} needs an \`as\` name unused in this request.`);
  ctx.names.add(op.as as string);
  return op.as as string;
}

/** Names the clips an operation made so that later operations can select them with `fromCopy`. */
function nameClips(ctx: Ctx, as: string | undefined, made: ProjectEditCopies[string]): void {
  if (as !== undefined) ctx.copies[as] = made;
}

function resolveRef(
  ctx: Ctx,
  value: unknown,
  where: string,
  names: Map<string, string>,
  exists: (id: string) => boolean,
  code: "track-not-found" | "scene-not-found",
  noun: string,
): string {
  let id: string | undefined;
  if (typeof value === "string" && value) id = value;
  else if (isRec(value) && typeof value.fromCopy === "string") {
    onlyFields(value, ["fromCopy"], where);
    id = names.get(value.fromCopy);
    if (id === undefined) fail(code, `No earlier operation made a ${noun} named "${value.fromCopy}".`);
  } else fail("invalid-operation", `${where} needs a ${noun} ID or { fromCopy: "<as name>" }.`);
  if (!exists(id!)) fail(code, `${noun[0].toUpperCase()}${noun.slice(1)} "${id}" does not exist.`);
  return id!;
}

function trackRef(ctx: Ctx, value: unknown, where: string): string {
  return resolveRef(ctx, value, where, ctx.tracks, (id) => ctx.project.tracks.some((track) => track.id === id), "track-not-found", "track");
}
function sceneRef(ctx: Ctx, value: unknown, where: string): string {
  return resolveRef(
    ctx,
    value,
    where,
    ctx.scenes,
    (id) => sessionFor(ctx.project).scenes.some((scene) => scene.id === id),
    "scene-not-found",
    "scene",
  );
}
function slotRef(ctx: Ctx, value: unknown, where: string): { sceneId: string; trackId: string } {
  if (!isRec(value)) fail("invalid-operation", `${where} needs { sceneId, trackId }.`);
  const slot = value as Rec;
  onlyFields(slot, ["sceneId", "trackId"], where);
  return { sceneId: sceneRef(ctx, slot.sceneId, `${where}.sceneId`), trackId: trackRef(ctx, slot.trackId, `${where}.trackId`) };
}

/** Two positions that name the same moment, in seconds. */
const POSITION_TOLERANCE_SECONDS = 1e-6;

/**
 * A project position as both beats and seconds, 0 or more: `atBeat`, `atSeconds`, or both when they name the same moment at the current tempo map
 * (so a row read from `read_project` goes back unchanged). When both are given the seconds are kept as given.
 */
function positionOf(project: Project, item: Rec, where: string): { beat: number; seconds: number } {
  const hasBeat = item.atBeat !== undefined;
  const hasSeconds = item.atSeconds !== undefined;
  if (!hasBeat && !hasSeconds) fail("invalid-operation", `${where} needs atBeat or atSeconds.`);
  const tempo = project.tempoMap;
  const beat = hasBeat ? numberFor(where, "atBeat", item.atBeat, { min: 0 }) : undefined;
  const seconds = hasSeconds ? numberFor(where, "atSeconds", item.atSeconds, { min: 0 }) : undefined;
  if (beat !== undefined && seconds !== undefined) {
    const expected = tempo.beatToSeconds(beat);
    if (Math.abs(expected - seconds) > POSITION_TOLERANCE_SECONDS)
      fail(
        "invalid-operation",
        `${where} gives atBeat ${beat} and atSeconds ${seconds}, which disagree: atBeat ${beat} is ${expected}s at the tempo map as it is at this step. Give one of them, or make them agree.`,
      );
    return { beat, seconds };
  }
  return beat !== undefined ? { beat, seconds: tempo.beatToSeconds(beat) } : { beat: tempo.secondsToBeat(seconds!), seconds: seconds! };
}
/** The position in a clip kind's own unit: seconds for audio, beats for MIDI. */
const nativeOf = (kind: ProjectClip["kind"], position: { beat: number; seconds: number }): number =>
  kind === "midi" ? position.beat : position.seconds;

const POINT_SHAPES = ["linear", "hold"];
function shapeOf(item: Rec, where: string): "linear" | "hold" {
  if (item.shape === undefined) return "linear";
  if (!POINT_SHAPES.includes(item.shape as string)) fail("invalid-operation", `${where} shape must be "linear" or "hold".`);
  return item.shape as "linear" | "hold";
}

/** Notes for a new clip, validated like `addNotes`; each gets the default velocity when it has none. */
function newNotes(type: string, value: unknown): { pitch: number; start: number; duration: number; velocity: number }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("invalid-operation", `${type} needs notes as an array.`);
  const notes = value as Rec[];
  validateNewNotes(type, notes);
  return notes.map((note) => ({
    pitch: note.pitch as number,
    start: note.start as number,
    duration: note.duration as number,
    velocity: (note.velocity as number | undefined) ?? 0.8,
  }));
}

function addMidiClipOp(ctx: Ctx, op: AddMidiClipEdit): void {
  const { project } = ctx;
  const as = claimName(ctx, op);
  const trackId = trackRef(ctx, op.trackId, "addMidiClip trackId");
  const atBeat = requiredNumber(op, "atBeat", { min: 0 });
  const duration = requiredNumber(op, "duration", { above: 0 });
  const sourceOffset = optionalNumber(op, "sourceOffset");
  const name = optionalString(op, "name");
  let linkedTo: string | undefined;
  if (op.linkedTo !== undefined) {
    if (op.notes !== undefined)
      fail("invalid-operation", "addMidiClip takes notes or linkedTo, not both: a linked clip shares the other clip's notes.");
    linkedTo = resolveAnyClip(project, op.linkedTo, ctx.copies).id;
  }
  const clip = project.addMidiClip(
    trackId,
    { notes: newNotes("addMidiClip", op.notes), duration, ...(sourceOffset === undefined ? {} : { sourceOffset }) },
    atBeat,
    { ...(name === undefined ? {} : { name }), ...(linkedTo === undefined ? {} : { linkedTo }) },
  );
  nameClips(ctx, as, [{ ...(linkedTo === undefined ? {} : { from: linkedTo }), id: clip.id, trackId }]);
}

function splitClipOp(ctx: Ctx, op: SplitClipEdit): void {
  const { project } = ctx;
  const as = claimName(ctx, op);
  const { track, clip } = resolveClip(project, op.clip, ctx.copies);
  const offset = nativeOf(clip.kind, positionOf(project, op as unknown as Rec, "splitClip")) - clip.time;
  const [, right] = project.splitClip(clip.id, offset);
  nameClips(ctx, as, [{ from: clip.id, id: right.id, trackId: track.id }]);
}

function duplicateClipOp(ctx: Ctx, op: DuplicateClipEdit): void {
  const { project } = ctx;
  const as = claimName(ctx, op);
  const { track, clip } = resolveClip(project, op.clip, ctx.copies);
  const time = nativeOf(clip.kind, positionOf(project, op as unknown as Rec, "duplicateClip"));
  const trackId = op.trackId === undefined ? undefined : trackRef(ctx, op.trackId, "duplicateClip trackId");
  const linked = booleanFor(op as unknown as Rec, "linked", false);
  const copy = project.duplicateClip(clip.id, time, { ...(trackId === undefined ? {} : { trackId }), ...(linked === undefined ? {} : { linked }) });
  nameClips(ctx, as, [{ from: clip.id, id: copy.id, trackId: trackId ?? track.id }]);
}

function setClipLoopOp(ctx: Ctx, op: SetClipLoopEdit): void {
  const clip = resolveAnyClip(ctx.project, op.clip, ctx.copies);
  if (op.loop !== null) {
    if (!isRec(op.loop))
      fail("invalid-operation", "setClipLoop needs loop as null or { startBeat, endBeat } (MIDI) or { startSeconds, endSeconds } (audio).");
    onlyFields(op.loop, clip.kind === "midi" ? ["startBeat", "endBeat"] : ["startSeconds", "endSeconds"], `setClipLoop loop for a ${clip.kind} clip`);
  }
  ctx.project.setClipLoop(clip.id, op.loop);
}

function envelopeOp(ctx: Ctx, op: SetAudioClipEnvelopeEdit): void {
  const clip = resolveAnyClip(ctx.project, op.clip, ctx.copies);
  const fields = ["gain", "fadeIn", "fadeOut"] as const;
  if (fields.every((key) => op[key] === undefined)) fail("invalid-operation", "setAudioClipEnvelope needs gain, fadeIn, fadeOut or several of them.");
  const given = Object.fromEntries(
    fields.flatMap((key) => (op[key] === undefined ? [] : [[key, requiredNumber(op as unknown as Rec, key, { min: 0 })]])),
  );
  const current = clip.kind === "audio" ? (clip.envelope ?? unityClipEnvelope) : unityClipEnvelope;
  ctx.project.setAudioClipEnvelope(clip.id, { ...current, ...given });
}

function gainAutomationOp(ctx: Ctx, op: SetAudioClipGainAutomationEdit): void {
  const clip = resolveAnyClip(ctx.project, op.clip, ctx.copies);
  const points = listFor(op as unknown as Rec, "points").map((point, index) => {
    const where = `setAudioClipGainAutomation points[${index}]`;
    onlyFields(point, ["atSourceSeconds", "value", "shape"], where);
    return {
      time: numberFor(where, "atSourceSeconds", point.atSourceSeconds, { min: 0 }),
      value: numberFor(where, "value", point.value, { min: 0 }),
      shape: shapeOf(point, where),
    };
  });
  ctx.project.setAudioClipGainAutomation(clip.id, points);
}

function volumeAutomationOp(ctx: Ctx, op: SetVolumeAutomationEdit): void {
  const trackId = trackRef(ctx, op.trackId, "setVolumeAutomation trackId");
  const points = listFor(op as unknown as Rec, "points").map((point, index) => {
    const where = `setVolumeAutomation points[${index}]`;
    onlyFields(point, ["atBeat", "atSeconds", "value", "shape"], where);
    return {
      time: positionOf(ctx.project, point, where).seconds,
      value: numberFor(where, "value", point.value, { min: 0 }),
      shape: shapeOf(point, where),
    };
  });
  ctx.project.setVolumeAutomation(trackId, points);
}

function controllerLaneOp(ctx: Ctx, op: SetControllerLaneEdit): void {
  const trackId = trackRef(ctx, op.trackId, "setControllerLane trackId");
  const rec = op as unknown as Rec;
  if (!controllerExpressions.includes(op.expression))
    fail("invalid-operation", `setControllerLane needs expression as one of ${controllerExpressions.join(", ")}.`);
  const channel = requiredNumber(rec, "channel", { min: 0, max: 15, integer: true });
  const numbered = op.expression === "channelController" || op.expression === "polyPressure";
  if (!numbered && op.controller !== undefined) fail("invalid-operation", `setControllerLane takes no controller for ${op.expression}.`);
  const controller = numbered
    ? requiredNumber(rec, "controller", { min: 0, max: op.expression === "channelController" ? 119 : 127, integer: true })
    : 0;
  const max = controllerMax(op.expression);
  const points = listFor(rec, "points").map((point, index) => {
    const where = `setControllerLane points[${index}]`;
    onlyFields(point, ["atBeat", "atSeconds", "value", "shape"], where);
    return {
      time: positionOf(ctx.project, point, where).beat,
      value: numberFor(where, "value", point.value, { min: 0, max, integer: true }),
      shape: shapeOf(point, where),
    };
  });
  ctx.project.setControllerLane(trackId, { expression: op.expression, channel, controller, points });
}

function addTrackOp(ctx: Ctx, op: AddTrackEdit): void {
  const as = claimName(ctx, op);
  const rec = op as unknown as Rec;
  const name = requiredString(rec, "name");
  if (op.kind !== "audio" && op.kind !== "midi" && op.kind !== "bus") fail("invalid-operation", 'addTrack needs kind as "audio", "midi" or "bus".');
  const volume = optionalNumber(rec, "volume", { min: 0 });
  const pan = optionalNumber(rec, "pan", { min: -1, max: 1 });
  const muted = booleanFor(rec, "muted", false);
  const solo = booleanFor(rec, "solo", false);
  if (op.busRole !== undefined && op.busRole !== "submix" && op.busRole !== "effect")
    fail("invalid-operation", 'addTrack needs busRole as "submix" or "effect".');
  const track = ctx.project.addTrack(name, op.kind, {
    ...(volume === undefined ? {} : { volume }),
    ...(pan === undefined ? {} : { pan }),
    ...(muted === undefined ? {} : { muted }),
    ...(solo === undefined ? {} : { solo }),
    ...(op.busRole === undefined ? {} : { busRole: op.busRole }),
  });
  ctx.createdTracks.push({ id: track.id, ...(as === undefined ? {} : { as }) });
  if (as !== undefined) ctx.tracks.set(as, track.id);
}

function routingOp(ctx: Ctx, op: SetTrackRoutingEdit): void {
  const trackId = trackRef(ctx, op.trackId, "setTrackRouting trackId");
  if (!isRec(op.routing)) fail("invalid-operation", "setTrackRouting needs routing as { outputBusId?, sends? }.");
  onlyFields(op.routing, ["outputBusId", "sends"], "setTrackRouting routing");
  const output = op.routing.outputBusId;
  const outputBusId = output === undefined || output === null ? null : trackRef(ctx, output, "setTrackRouting routing.outputBusId");
  const sends = (op.routing.sends === undefined ? [] : listFor(op.routing as Rec, "sends")).map((send, index) => {
    const where = `setTrackRouting routing.sends[${index}]`;
    onlyFields(send, ["busId", "gain"], where);
    return { busId: trackRef(ctx, send.busId, `${where}.busId`), gain: numberFor(where, "gain", send.gain, { min: 0 }) };
  });
  ctx.project.setTrackRouting(trackId, { outputBusId, sends });
}

function markersOp(ctx: Ctx, op: SetMarkersEdit): void {
  const markers = listFor(op as unknown as Rec, "markers").map((marker, index) => {
    const where = `setMarkers markers[${index}]`;
    onlyFields(marker, ["name", "atBeat", "atSeconds"], where);
    return { time: positionOf(ctx.project, marker, where).seconds, name: requiredString(marker, "name") };
  });
  ctx.project.setMarkers(markers);
}

function changesOp(op: SetTempoChangesEdit | SetTimeSignatureChangesEdit, fields: readonly string[]): Rec[] {
  const changes = listFor(op as unknown as Rec, "changes");
  for (const [index, change] of changes.entries()) {
    onlyFields(change, fields, `${op.type} changes[${index}]`);
    for (const key of fields)
      numberFor(
        `${op.type} changes[${index}]`,
        key,
        change[key],
        key === "beat" ? { min: 0 } : key === "bpm" ? { min: 1 } : { integer: true, min: 1 },
      );
  }
  return changes;
}

function deviceRef(project: Project, op: Rec): string {
  const id = requiredString(op, "deviceId");
  if (!project.tracks.some((track) => track.devices.some((device) => device.id === id))) fail("device-not-found", `Device "${id}" does not exist.`);
  return id;
}

/** The row a device-parameter operation names, or the reason it cannot: a WebCLAP device's table row, or a rack effect slot's row. */
function deviceParameterOp(project: Project, op: SetDeviceParameterEdit, applied: ProjectEditDeviceParameters): void {
  const deviceId = requiredString(op as unknown as Rec, "deviceId");
  const parameterId = requiredString(op as unknown as Rec, "parameterId");
  const value = requiredNumber(op as unknown as Rec, "value");
  const expected = optionalNumber(op as unknown as Rec, "expectedValue");
  const device = project.tracks.flatMap((track) => track.devices).find((item) => item.id === deviceId);
  const at = splitRackDeviceId(deviceId);
  const track = at && project.tracks.find((item) => item.id === at.trackId);
  const slot = track?.effects.find((item) => item.id === at!.slotId);
  if (!device && !slot) {
    const hint = project.tracks.flatMap((item) => item.effects.filter(({ id }) => id === deviceId).map(({ id }) => `"${rackDeviceId(item.id, id)}"`));
    fail("device-not-found", `Device "${deviceId}" does not exist${hint.length ? `; a built-in effect is addressed as ${hint.join(" or ")}` : ""}.`);
  }
  const rows = device ? device.parameters : rackSlotParameters(slot!);
  const row = rows.find((item) => item.id === parameterId);
  if (!row)
    fail(
      "invalid-operation",
      `Device "${deviceId}" has no parameter "${parameterId}"${rows.length ? `; read_device_params lists its ${rows.length}` : "; it has no parameter table yet"}.`,
    );
  if (expected !== undefined && Math.abs(row!.value - expected) > Math.max(1e-9, 1e-6 * Math.max(Math.abs(row!.value), Math.abs(expected))))
    throw new ProjectEditConflict(
      `Parameter "${parameterId}" of device "${deviceId}" is ${row!.value} now, not the ${expected} you read. Read it again and decide whether to still set ${value}.`,
    );
  try {
    applied.push({ deviceId, parameterId, value: project.setDeviceParameter(deviceId, parameterId, value) });
  } catch (error) {
    if (error instanceof RangeError) fail("invalid-operation", error.message);
    throw error;
  }
}

function sceneOp(ctx: Ctx, as: string | undefined, scene: { id: string }): void {
  ctx.createdScenes.push({ id: scene.id, ...(as === undefined ? {} : { as }) });
  if (as !== undefined) ctx.scenes.set(as, scene.id);
}

function setMidiClipOp(ctx: Ctx, op: SetMidiClipEdit): void {
  const as = claimName(ctx, op);
  const slot = slotRef(ctx, op.slot, "setMidiClip slot");
  const duration = requiredNumber(op as unknown as Rec, "duration", { above: 0 });
  const sourceOffset = optionalNumber(op as unknown as Rec, "sourceOffset");
  const name = optionalString(op as unknown as Rec, "name");
  const clip = sessionFor(ctx.project).setMidiClip(
    slot,
    { notes: newNotes("setMidiClip", op.notes), duration, ...(sourceOffset === undefined ? {} : { sourceOffset }) },
    name === undefined ? {} : { name },
  );
  nameClips(ctx, as, [{ id: clip.id, trackId: slot.trackId }]);
}

function copyToSlotOp(ctx: Ctx, op: CopyToSlotEdit): void {
  const as = claimName(ctx, op);
  const clip = resolveAnyClip(ctx.project, op.clip, ctx.copies);
  const slot = slotRef(ctx, op.slot, "copyToSlot slot");
  const linked = booleanFor(op as unknown as Rec, "linked", false);
  const copy = sessionFor(ctx.project).copyToSlot(clip.id, slot, linked === undefined ? {} : { linked });
  nameClips(ctx, as, [{ from: clip.id, id: copy.id, trackId: slot.trackId }]);
}

function copyToArrangementOp(ctx: Ctx, op: CopyToArrangementEdit): void {
  const as = claimName(ctx, op);
  const slot = slotRef(ctx, op.slot, "copyToArrangement slot");
  const trackId = op.trackId === undefined ? slot.trackId : trackRef(ctx, op.trackId, "copyToArrangement trackId");
  const linked = booleanFor(op as unknown as Rec, "linked", false);
  positionOf(ctx.project, op as unknown as Rec, "copyToArrangement");
  const at = op.atBeat === undefined ? { atSeconds: op.atSeconds as number } : { atBeat: op.atBeat };
  const source = sessionFor(ctx.project).clipAt(slot);
  const copy = sessionFor(ctx.project).copyToArrangement(slot, { trackId, ...at, ...(linked === undefined ? {} : { linked }) });
  nameClips(ctx, as, [{ ...(source ? { from: source.id } : {}), id: copy.id, trackId }]);
}

type Runners = {
  [K in ProjectEditOperation["type"]]: (ctx: Ctx, op: Extract<ProjectEditOperation, { type: K }>) => void;
};

const RUNNERS: Runners = {
  copyRange: (ctx, op) => copyRange(ctx, op),
  moveClip: (ctx, op) => moveClip(ctx, op),
  resizeClip: (ctx, op) => resizeClipOp(ctx.project, op, ctx.copies, ctx.moved, ctx.index),
  setClipSourceRange: (ctx, op) => setClipSourceRangeOp(ctx.project, op, ctx.copies, ctx.moved, ctx.index),
  setClipName: (ctx, op) => ctx.project.setClipName(resolveAnyClip(ctx.project, op.clip, ctx.copies).id, op.name),
  splitClip: splitClipOp,
  duplicateClip: duplicateClipOp,
  removeClip: (ctx, op) => ctx.project.removeClip(resolveClip(ctx.project, op.clip, ctx.copies).clip.id),
  setClipLoop: setClipLoopOp,
  addMidiClip: addMidiClipOp,
  setAudioClipEnvelope: envelopeOp,
  setAudioClipGainAutomation: gainAutomationOp,
  setVolumeAutomation: volumeAutomationOp,
  setControllerLane: controllerLaneOp,
  addNotes: (ctx, op) => addNotesOp(ctx.project, op, ctx.copies, ctx.createdNotes),
  removeNotes: (ctx, op) => removeNotesOp(ctx.project, op, ctx.copies),
  editNotes: (ctx, op) => editNotesOp(ctx.project, op, ctx.copies),
  rippleDelete: (ctx, op) => rippleDeleteOp(ctx.project, op),
  makeClipUnique: (ctx, op) => void ctx.project.makeClipUnique(resolveClip(ctx.project, op.clip, ctx.copies).clip.id),
  addTrack: addTrackOp,
  removeTrack: (ctx, op) => ctx.project.removeTrack(trackRef(ctx, op.trackId, "removeTrack trackId")),
  setTrackName: (ctx, op) => ctx.project.setTrackName(trackRef(ctx, op.trackId, "setTrackName trackId"), requiredString(op, "name")),
  setTrackVolume: (ctx, op) =>
    ctx.project.setTrackVolume(trackRef(ctx, op.trackId, "setTrackVolume trackId"), requiredNumber(op, "volume", { min: 0 })),
  setTrackMuted: (ctx, op) => ctx.project.setTrackMuted(trackRef(ctx, op.trackId, "setTrackMuted trackId"), booleanFor(op, "muted", true)!),
  setTrackSolo: (ctx, op) => ctx.project.setTrackSolo(trackRef(ctx, op.trackId, "setTrackSolo trackId"), booleanFor(op, "solo", true)!),
  setTrackPan: (ctx, op) => ctx.project.setTrackPan(trackRef(ctx, op.trackId, "setTrackPan trackId"), requiredNumber(op, "pan", { min: -1, max: 1 })),
  setTrackRouting: routingOp,
  setTrackEffects: (ctx, op) => {
    const trackId = trackRef(ctx, op.trackId, "setTrackEffects trackId");
    if (!Array.isArray(op.effects)) fail("invalid-operation", "setTrackEffects needs effects as an array.");
    ctx.project.setTrackEffects(trackId, op.effects);
  },
  setTrackRackPreset: (ctx, op) => {
    const trackId = trackRef(ctx, op.trackId, "setTrackRackPreset trackId");
    if (!isRec(op.preset)) fail("invalid-operation", "setTrackRackPreset needs preset as { effects, macros? }.");
    ctx.project.setTrackRackPreset(trackId, op.preset);
  },
  setTrackMacroValue: (ctx, op) =>
    ctx.project.setTrackMacroValue(
      trackRef(ctx, op.trackId, "setTrackMacroValue trackId"),
      requiredString(op, "macroId"),
      requiredNumber(op, "value", { min: 0, max: 1 }),
    ),
  setMasterVolume: (ctx, op) => ctx.project.setMasterVolume(requiredNumber(op, "volume", { min: 0 })),
  setTitle: (ctx, op) => ctx.project.setTitle(requiredString(op, "title")),
  setTempoChanges: (ctx, op) => ctx.project.setTempoChanges(changesOp(op, ["beat", "bpm"]) as unknown as TempoChange[]),
  setTimeSignatureChanges: (ctx, op) =>
    ctx.project.setTimeSignatureChanges(changesOp(op, ["beat", "numerator", "denominator"]) as unknown as TimeSignatureChange[]),
  setMarkers: markersOp,
  removeDevice: (ctx, op) => ctx.project.removeDevice(deviceRef(ctx.project, op)),
  moveDevice: (ctx, op) => ctx.project.moveDevice(deviceRef(ctx.project, op), requiredNumber(op, "index", { integer: true, min: 0 })),
  setDeviceParameter: (ctx, op) => deviceParameterOp(ctx.project, op, ctx.deviceParameters),
  addScene: (ctx, op) => {
    const as = claimName(ctx, op);
    const name = optionalString(op, "name");
    const after = op.afterSceneId === undefined ? undefined : sceneRef(ctx, op.afterSceneId, "addScene afterSceneId");
    sceneOp(
      ctx,
      as,
      sessionFor(ctx.project).addScene({ ...(name === undefined ? {} : { name }), ...(after === undefined ? {} : { afterSceneId: after }) }),
    );
  },
  renameScene: (ctx, op) => sessionFor(ctx.project).renameScene(sceneRef(ctx, op.sceneId, "renameScene sceneId"), requiredString(op, "name")),
  moveScene: (ctx, op) =>
    sessionFor(ctx.project).moveScene(sceneRef(ctx, op.sceneId, "moveScene sceneId"), requiredNumber(op, "index", { integer: true, min: 0 })),
  removeScene: (ctx, op) => sessionFor(ctx.project).removeScene(sceneRef(ctx, op.sceneId, "removeScene sceneId")),
  duplicateScene: (ctx, op) => {
    const as = claimName(ctx, op);
    const sceneId = sceneRef(ctx, op.sceneId, "duplicateScene sceneId");
    const after = op.afterSceneId === undefined ? undefined : sceneRef(ctx, op.afterSceneId, "duplicateScene afterSceneId");
    sceneOp(ctx, as, sessionFor(ctx.project).duplicateScene(sceneId, after === undefined ? {} : { afterSceneId: after }));
  },
  setMidiClip: setMidiClipOp,
  moveSlotClip: (ctx, op) => sessionFor(ctx.project).moveClip(slotRef(ctx, op.from, "moveSlotClip from"), slotRef(ctx, op.to, "moveSlotClip to")),
  clearSlot: (ctx, op) => sessionFor(ctx.project).clearSlot(slotRef(ctx, op.slot, "clearSlot slot")),
  copyToSlot: copyToSlotOp,
  copyToArrangement: copyToArrangementOp,
};

/** Runs inside a Project edit, which rolls everything back when a step throws. */
export function runProjectEdits(project: Project, ops: readonly ProjectEditOperation[]): ProjectEditRun {
  if (!Array.isArray(ops)) throw new ProjectEditFailure("invalid-request", "applyEdits needs an ops array.");
  const ctx: Ctx = {
    project,
    copies: {},
    createdNotes: [],
    deviceParameters: [],
    createdTracks: [],
    createdScenes: [],
    moved: new Map<string, number>(),
    known: new Set(project.tracks.flatMap((track) => track.clips.map(({ id }) => id))),
    created: new Set<string>(),
    names: new Set<string>(),
    tracks: new Map<string, string>(),
    scenes: new Map<string, string>(),
    index: 0,
  };
  ops.forEach((op: ProjectEditOperation, index) => {
    ctx.index = index;
    try {
      checkFields(op);
      const type = op?.type;
      if (typeof type !== "string" || !Object.hasOwn(RUNNERS, type))
        fail("invalid-operation", `Unknown edit type "${String((op as { type?: unknown } | null)?.type)}".`);
      (RUNNERS[type] as (ctx: Ctx, op: ProjectEditOperation) => void)(ctx, op);
      // A clip an operation created or placed on the timeline (duplicate, new MIDI clip, copy from a slot, a piece of a copied range) answers to the same overlap rule as a moved one.
      // rippleDelete overlaps the pieces it joins on purpose (the crossfade), so what it makes is not checked.
      for (const track of project.tracks)
        for (const { id } of track.clips)
          if (!ctx.known.has(id)) {
            ctx.known.add(id);
            if (type === "rippleDelete") continue;
            ctx.moved.set(id, index);
            ctx.created.add(id);
          }
    } catch (error) {
      if (error instanceof ProjectEditConflict) throw error;
      if (error instanceof ProjectEditFailure) throw new ProjectEditFailure(error.code, error.message, index);
      throw new ProjectEditFailure("edit-failed", error instanceof Error ? error.message : String(error), index);
    }
  });
  // Checked on the final arrangement, so clips moved together may pass through each other's old positions.
  for (const [clipId, index] of ctx.moved) {
    const track = project.tracks.find((item) => item.clips.some(({ id }) => id === clipId));
    const clip = track?.clips.find(({ id }) => id === clipId);
    if (!track || !clip) continue;
    const end = clip.time + clip.duration;
    const tolerance = ctx.created.has(clipId) && clip.kind === "audio" ? Math.max(EPSILON, 1 / clip.sampleRate) : EPSILON;
    const blocker = track.clips.find(
      (other) => other.id !== clipId && other.time < end - tolerance && other.time + other.duration > clip.time + tolerance,
    );
    if (blocker) throw new ProjectEditFailure("overlap", `Clip "${clipId}" would overlap clip "${blocker.id}".`, index);
    // Clips the opened file keeps as they are occupy their place on the track too.
    const seconds = (value: number) => (clip.kind === "midi" ? project.tempoMap.beatToSeconds(value) : value);
    const kept = keptContent
      .spans(project, track.id)
      .find((span) => span.start < seconds(end) - tolerance && span.end > seconds(clip.time) + tolerance);
    if (kept)
      throw new ProjectEditFailure("overlap", `Clip "${clipId}" would overlap kept clip "${kept.name}", which the file keeps unchanged.`, index);
  }
  const { copies, createdNotes, createdTracks, createdScenes, deviceParameters } = ctx;
  return { copies, createdNotes, createdTracks, createdScenes, deviceParameters };
}
