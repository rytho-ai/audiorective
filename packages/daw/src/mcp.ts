import { encode } from "@toon-format/toon";
import { encodeWavBytes, untracked, type PCMData } from "@audiorective/core";
import { saveWorkspace } from "./compose";
import { PROJECT_EDIT_TYPES, type ProjectEditOperation, type ProjectEditRequest, type ProjectVersion } from "./project-edits";
import { checkArguments } from "./extensions";
import { midiPasses } from "./clip-loop";
import { findSlotClip } from "./session-state";
import { renderMixRange } from "./mix-range";
import { renderStems } from "./exchange";
import { exportMidiFile } from "./midi-file";
import type { ControllerExpression } from "./controller-lane";
import type { Workspace } from "./runtime";
import { selectionFor } from "./selection";
import { sessionFor } from "./session";
import type { Project, ProjectClip } from "./model";
import { rackDeviceId, rackSlotParameters } from "./device-parameters";
import { bridgeProtocols, callableOperations, operationRefusal, resolveAllow, restrictTools, type McpToolCategory } from "./mcp-policy";

export { MCP_TOOL_CATEGORIES, type McpToolCategory } from "./mcp-policy";

/** What a tool hands back: text the agent reads, whether it failed, and the same facts as JSON for code. */
export type McpToolResult = Readonly<{
  /** The text the agent reads: TOON for summaries and queries, JSON for receipts and measurements. */
  content: string;
  /** `true` when the call did nothing useful: bad input, a conflict, a rejection or a failure. `content` says why. */
  isError?: boolean;
  /** The same facts as `content`, as a plain value. */
  data?: unknown;
  /** Sound for the agent to hear, sent next to `content` as an MCP audio block. Only `listen` sets it, and only when the app allows it with `listenAudio` and its `allow` includes `export`. */
  audio?: Readonly<{
    /** Media type of the encoded audio block; always audio/wav. */
    mimeType: "audio/wav";
    /** Base64-encoded WAV file bytes. */
    base64: string;
  }>;
}>;

/** One thing an agent can do to the open project. Transport-neutral: an MCP server, a WebSocket bridge or a test calls it the same way. */
export type McpTool = Readonly<{
  name: string;
  /** What the tool does, for `mcpTools`' `allow` option. Every tool declares one where it is defined, so a new tool cannot skip the policy. */
  category: McpToolCategory;
  /** Plain-language purpose and argument guidance exposed to the agent. */
  description: string;
  /** JSON Schema (type `"object"`) of the arguments. */
  inputSchema: Readonly<Record<string, unknown>>;
  /** Never rejects: bad arguments and failures come back as `{ isError: true }` results the agent can read. */
  call(args: unknown): Promise<McpToolResult>;
}>;

export type McpToolsOptions = Readonly<{
  /** Where `save_as` puts the file; the page decides (a download, a file handle, a server). Without it `save_as` returns an error. */
  save?: (bytes: Uint8Array<ArrayBuffer>, name: string) => void | Promise<void>;
  /** Text added to the `Agent: ` prefix of an undo label. Default none. */
  labelPrefix?: string;
  /**
   * The kinds of tool the agent may use; the rest do not appear in the tool list and are refused if called. `read`: queries and `listen`;
   * `edit`: `apply_edits`; `export`: `save_as`, `export_midi`, `export_stems`; `operations`: `run_operation` for the app's operations (a
   * `readOnly` operation needs `read` instead). Default: all four, so an existing app keeps working; the origin check and pairing token
   * of `@audiorective/mcp` are what keep other web pages out. Restrict it for an agent that should only look, such as `["read"]`.
   */
  allow?: readonly McpToolCategory[];
  /**
   * Let `listen` return sound as well as numbers when the agent asks with `audio: true`: a 16-bit stereo WAV of the start of the rendered range, at most `maxSeconds` long.
   * Default off, because audio is the largest and most private thing a tool can send: it is base64 in a tool result that the agent's model provider receives,
   * and about 192 KB per second at 48 kHz, so the app opts in and picks the length. Returning audio sends the song out of the page like an export does, so it also needs the
   * `export` category in `allow` (the default allows it); an app with `allow: ["read"]` gets the numbers only. When off, `audio: true` returns the numbers and says why audio is not returned.
   * `maxSeconds` must be a finite number greater than 0; `mcpTools` throws otherwise.
   */
  listenAudio?: Readonly<{
    /** Configured audio cap in seconds; only the start of a longer rendered range is returned. */
    maxSeconds: number;
  }>;
}>;

/** The WebSocket close code `@audiorective/mcp` sends to a page that a newer page replaced. */
const REPLACED_CODE = 4000;

type Args = Record<string, unknown>;

const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const isRecord = (value: unknown): value is Args => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string, data?: unknown): McpToolResult => ({ content: message, isError: true, ...(data === undefined ? {} : { data }) });
const json = (value: unknown, isError = false): McpToolResult => ({
  content: JSON.stringify(value, null, 2),
  data: value,
  ...(isError ? { isError } : {}),
});
const toon = (value: unknown): McpToolResult => ({ content: encode(value), data: value });

function stringArg(args: Args, name: string, required: boolean): string | undefined | McpToolResult {
  const value = args[name];
  if (value === undefined) return required ? fail(`"${name}" is required.`) : undefined;
  if (typeof value !== "string" || !value.trim()) return fail(`"${name}" must be a non-empty string.`);
  return value;
}

function beatRange(value: unknown, name: string): { startBeat: number; endBeat: number } | McpToolResult {
  if (
    !isRecord(value) ||
    typeof value.startBeat !== "number" ||
    typeof value.endBeat !== "number" ||
    !Number.isFinite(value.startBeat) ||
    !Number.isFinite(value.endBeat) ||
    value.startBeat < 0 ||
    value.startBeat >= value.endBeat
  )
    return fail(`"${name}" must be { startBeat, endBeat } with 0 <= startBeat < endBeat.`);
  return { startBeat: value.startBeat, endBeat: value.endBeat };
}

function timeRange(value: unknown): { startBeat: number; endBeat: number } | { startSeconds: number; endSeconds: number } | McpToolResult {
  if (isRecord(value) && "startSeconds" in value) {
    const { startSeconds, endSeconds } = value;
    if (
      typeof startSeconds !== "number" ||
      typeof endSeconds !== "number" ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      startSeconds >= endSeconds
    )
      return fail(`"range" must be { startSeconds, endSeconds } with 0 <= startSeconds < endSeconds.`);
    return { startSeconds, endSeconds };
  }
  return beatRange(value, "range");
}

const BEAT_RANGE_SCHEMA = {
  type: "object",
  properties: { startBeat: { type: "number", minimum: 0 }, endBeat: { type: "number", minimum: 0 } },
  required: ["startBeat", "endBeat"],
  description: "Half-open beat range: startBeat is inside, endBeat is not.",
} as const;

const prop = (type: string, description: string, extra: Record<string, unknown> = {}) => ({ type, description, ...extra });
const NUM = (description: string, extra: Record<string, unknown> = {}) => prop("number", description, extra);
const STR = (description: string) => prop("string", description);
const BOOL = (description: string) => prop("boolean", description);
const AT_BEAT = NUM("Project beats (quarter notes from the start), 0 or more. With atSeconds too, both must name the same moment (1e-6 s).", {
  minimum: 0,
});
const AT_SECONDS = NUM("Project seconds, 0 or more. With atBeat too, both must name the same moment (1e-6 s).", { minimum: 0 });
const AS = STR("Names what this step makes, unique in the request; later steps select it as { fromCopy: <name> }.");
const REF_OBJECT = { type: "object", properties: { fromCopy: { type: "string" } }, required: ["fromCopy"], additionalProperties: false };
const CLIP = {
  type: "object",
  description: "{ clipId } or { fromCopy: <as name>, trackId?, trackName?, name? } for clips an earlier step made with `as`.",
  properties: {
    clipId: { type: "string" },
    fromCopy: { type: "string" },
    trackId: { type: "string" },
    trackName: { type: "string" },
    name: { type: "string" },
  },
  additionalProperties: false,
};
const TRACK = {
  description: "A track ID, or { fromCopy: <as name> } for a track an earlier addTrack made.",
  oneOf: [{ type: "string" }, REF_OBJECT],
};
const SCENE = {
  description: "A scene ID, or { fromCopy: <as name> } for a scene an earlier addScene or duplicateScene made.",
  oneOf: [{ type: "string" }, REF_OBJECT],
};
const SLOT = {
  type: "object",
  description: "One Session cell: { sceneId, trackId }.",
  properties: { sceneId: SCENE, trackId: TRACK },
  required: ["sceneId", "trackId"],
  additionalProperties: false,
};
const NOTE_PROPS = {
  pitch: prop("integer", "MIDI note number 0 to 127 (60 is middle C).", { minimum: 0, maximum: 127 }),
  start: NUM("Content beats, 0 or more.", { minimum: 0 }),
  duration: NUM("Beats, more than 0.", { exclusiveMinimum: 0 }),
  velocity: NUM("0 to 1. Default 0.8.", { minimum: 0, maximum: 1 }),
};
const NEW_NOTES = {
  type: "array",
  description: "Notes in content beats: [{ pitch, start, duration, velocity? }].",
  items: { type: "object", properties: NOTE_PROPS, required: ["pitch", "start", "duration"], additionalProperties: false },
};
const SHAPE = { enum: ["linear", "hold"], description: 'Default "linear".' };
const GAIN = (what: string) => NUM(`${what} as linear gain: 0 or more, 1 is unity (no upper limit).`, { minimum: 0 });
const POSITIONED = (extra: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { atBeat: AT_BEAT, atSeconds: AT_SECONDS, ...extra },
  required,
  additionalProperties: false,
});

export type OpSpec = Readonly<{
  /** Plain-language description of this edit operation for the generated tool schema. */
  summary: string;
  /** JSON Schema entries for the operation arguments, excluding the type discriminant. */
  properties: Readonly<Record<string, unknown>>;
  /** Names of required arguments; omitted when every argument is optional. */
  required?: readonly string[];
}>;

/** Every apply_edits operation: what it does and its fields. The schema, the description and the field list the daw package enforces must agree (a test checks it). */
export const EDIT_OP_SPECS: Readonly<Record<ProjectEditOperation["type"], OpSpec>> = {
  copyRange: {
    summary:
      "Copy a beat range and insert the copy at atBeat; opens room on every track (later clips, tempo, markers and volume automation move later).",
    properties: {
      range: BEAT_RANGE_SCHEMA,
      atBeat: NUM("Project beat to insert at, 0 or more.", { minimum: 0 }),
      placement: { const: "insert" },
      as: AS,
    },
    required: ["range", "atBeat", "placement", "as"],
  },
  moveClip: {
    summary: "Move a timeline clip to a project beat, or by a number of beats, optionally to another track of the same kind.",
    properties: {
      clip: CLIP,
      trackId: TRACK,
      position: {
        type: "object",
        description: "Exactly one of atBeat (absolute project beat, 0 or more) and byBeats (shift, may be negative).",
        properties: { atBeat: { type: "number", minimum: 0 }, byBeats: { type: "number" } },
        additionalProperties: false,
      },
    },
    required: ["clip", "position"],
  },
  resizeClip: {
    summary:
      "Move one or both edges of a clip, in absolute project beats, without deleting content (a MIDI start edge moves its sourceOffset, an audio start edge reveals its recording).",
    properties: { clip: CLIP, start: NUM("Project beat of the start edge."), end: NUM("Project beat of the end edge.") },
    required: ["clip"],
  },
  setClipSourceRange: {
    summary:
      "Choose the part of a clip's content that plays, keeping its position: content beats for MIDI, recording seconds for audio (stretched seconds when time-stretched). On a looped clip the range becomes the loop.",
    properties: { clip: CLIP, start: NUM("Content beat (MIDI) or recording second (audio)."), end: NUM("Greater than start.") },
    required: ["clip", "start", "end"],
  },
  setClipName: {
    summary: "Set a clip's display name (timeline or Session slot).",
    properties: { clip: CLIP, name: STR("Non-empty.") },
    required: ["clip", "name"],
  },
  splitClip: {
    summary:
      "Split a timeline clip at a project position strictly inside it; the left piece keeps the clip's ID and `as` names the right piece. A position row with both atBeat and atSeconds must have them agree at the current tempo (1e-6 s).",
    properties: { clip: CLIP, atBeat: AT_BEAT, atSeconds: AT_SECONDS, as: AS },
    required: ["clip"],
  },
  duplicateClip: {
    summary:
      "Copy a timeline clip to a project position (own track or trackId of the same kind); atBeat and atSeconds together must agree (1e-6 s). linked: true shares a MIDI clip's notes (default false).",
    properties: { clip: CLIP, atBeat: AT_BEAT, atSeconds: AT_SECONDS, trackId: TRACK, linked: BOOL("MIDI only. Default false."), as: AS },
    required: ["clip"],
  },
  removeClip: { summary: "Remove a timeline clip (a Session slot clip goes with clearSlot).", properties: { clip: CLIP }, required: ["clip"] },
  setClipLoop: {
    summary:
      "Repeat part of a clip's content for the clip's whole length, or stop with null. MIDI: { startBeat, endBeat } in content beats; audio: { startSeconds, endSeconds } in recording seconds, 0 <= start < end inside the recording.",
    properties: {
      clip: CLIP,
      loop: {
        description: "null removes the loop.",
        oneOf: [
          { type: "null" },
          {
            type: "object",
            properties: { startBeat: { type: "number" }, endBeat: { type: "number" } },
            required: ["startBeat", "endBeat"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { startSeconds: { type: "number" }, endSeconds: { type: "number" } },
            required: ["startSeconds", "endSeconds"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["clip", "loop"],
  },
  addMidiClip: {
    summary:
      "Add a MIDI clip to a MIDI track at a project beat. notes and sourceOffset are content beats; linkedTo shares another MIDI clip's notes instead of notes.",
    properties: {
      trackId: TRACK,
      atBeat: NUM("Project beat, 0 or more.", { minimum: 0 }),
      duration: NUM("Clip length in beats, more than 0.", { exclusiveMinimum: 0 }),
      notes: NEW_NOTES,
      sourceOffset: NUM("Content beat where the clip starts. Default 0."),
      name: STR("Display name."),
      linkedTo: CLIP,
      as: AS,
    },
    required: ["trackId", "atBeat", "duration"],
  },
  setAudioClipEnvelope: {
    summary: "Set an audio clip's gain and fades; an omitted field keeps its value.",
    properties: {
      clip: CLIP,
      gain: GAIN("Clip level"),
      fadeIn: NUM("Seconds, 0 or more; fadeIn + fadeOut must fit the clip.", { minimum: 0 }),
      fadeOut: NUM("Seconds, 0 or more.", { minimum: 0 }),
    },
    required: ["clip"],
  },
  setAudioClipGainAutomation: {
    summary: "Replace an audio clip's gain automation (empty list clears it); point times are seconds of the original recording.",
    properties: {
      clip: CLIP,
      points: {
        type: "array",
        items: {
          type: "object",
          properties: {
            atSourceSeconds: NUM("Seconds of the original recording, 0 or more, unique.", { minimum: 0 }),
            value: GAIN("Gain"),
            shape: SHAPE,
          },
          required: ["atSourceSeconds", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["clip", "points"],
  },
  setVolumeAutomation: {
    summary:
      "Replace a track's volume automation (empty list clears it); each point is at a unique project position, atBeat or atSeconds (both must agree at the current tempo, 1e-6 s). A position in beats is converted with the tempo map as it is at this step of the request, so put tempo changes first in `ops`.",
    properties: {
      trackId: TRACK,
      points: { type: "array", items: POSITIONED({ value: GAIN("Gain"), shape: SHAPE }, ["value"]) },
    },
    required: ["trackId", "points"],
  },
  setControllerLane: {
    summary:
      "Replace one MIDI controller lane of a MIDI track (sustain, mod wheel, any controller, pitch bend, pressure, program): the lane is { expression, channel, controller }; an empty list removes it. Points are project positions, atBeat or atSeconds, value an integer (0 to 127; 0 to 16383 for pitchBend, centre 8192). Two points at one position are a step; shape hold keeps the value to the next point. Plays in Arrangement with the track's clips.",
    properties: {
      trackId: TRACK,
      expression: { enum: ["channelController", "pitchBend", "channelPressure", "polyPressure", "programChange"], description: "The MIDI message." },
      channel: NUM("MIDI channel 0 to 15.", { minimum: 0, maximum: 15 }),
      controller: NUM("The controller number 0 to 119 for channelController, the key 0 to 127 for polyPressure; leave out otherwise.", {
        minimum: 0,
        maximum: 127,
      }),
      points: {
        type: "array",
        items: POSITIONED({ value: NUM("Integer in the controller's range.", { minimum: 0, maximum: 16383 }), shape: SHAPE }, ["value"]),
      },
    },
    required: ["trackId", "expression", "channel", "points"],
  },
  addNotes: {
    summary: "Add notes to a MIDI clip (timeline or slot); the receipt's createdNotes lists their IDs.",
    properties: { clip: CLIP, notes: NEW_NOTES },
    required: ["clip", "notes"],
  },
  removeNotes: {
    summary: "Delete notes by ID (read_notes lists them).",
    properties: { clip: CLIP, noteIds: { type: "array", items: { type: "string" } } },
    required: ["clip", "noteIds"],
  },
  editNotes: {
    summary: "Change notes by ID in content beats; an omitted field stays.",
    properties: {
      clip: CLIP,
      notes: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string" }, ...NOTE_PROPS }, required: ["id"], additionalProperties: false },
      },
    },
    required: ["clip", "notes"],
  },
  rippleDelete: {
    summary: "Delete a half-open range from the whole song and close the gap; crossfade true is 5 ms, a number is seconds, false or omitted is none.",
    properties: {
      range: {
        description: "{ startBeat, endBeat } or { startSeconds, endSeconds }.",
        oneOf: [
          BEAT_RANGE_SCHEMA,
          {
            type: "object",
            properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } },
            required: ["startSeconds", "endSeconds"],
            additionalProperties: false,
          },
        ],
      },
      crossfade: { oneOf: [{ type: "boolean" }, { type: "number", minimum: 0 }] },
    },
    required: ["range"],
  },
  makeClipUnique: { summary: "Give a linked MIDI clip its own copy of the notes.", properties: { clip: CLIP }, required: ["clip"] },
  addTrack: {
    summary: "Add a track at the end; the receipt's createdTracks lists its ID.",
    properties: {
      name: STR("Non-empty."),
      kind: { enum: ["audio", "midi", "bus"] },
      volume: GAIN("Track level"),
      muted: BOOL("Default false."),
      solo: BOOL("Default false."),
      pan: NUM("-1 (left) to 1 (right), 0 is centre. Default 0.", { minimum: -1, maximum: 1 }),
      busRole: { enum: ["submix", "effect"], description: 'Bus tracks only. Default "submix".' },
      as: AS,
    },
    required: ["name", "kind"],
  },
  removeTrack: {
    summary: "Remove a track with its clips, slot clips and devices; routes to a removed bus are cleared.",
    properties: { trackId: TRACK },
    required: ["trackId"],
  },
  setTrackName: { summary: "Rename a track.", properties: { trackId: TRACK, name: STR("Non-empty.") }, required: ["trackId", "name"] },
  setTrackVolume: { summary: "Set a track's level.", properties: { trackId: TRACK, volume: GAIN("Track level") }, required: ["trackId", "volume"] },
  setTrackMuted: {
    summary: "Mute or unmute a track (mute wins over solo).",
    properties: { trackId: TRACK, muted: { type: "boolean" } },
    required: ["trackId", "muted"],
  },
  setTrackSolo: { summary: "Solo or unsolo a track.", properties: { trackId: TRACK, solo: { type: "boolean" } }, required: ["trackId", "solo"] },
  setTrackPan: {
    summary: "Set a track's stereo position.",
    properties: { trackId: TRACK, pan: NUM("-1 (left) to 1 (right), 0 is centre.", { minimum: -1, maximum: 1 }) },
    required: ["trackId", "pan"],
  },
  setTrackRouting: {
    summary: "Replace a track's output and post-fader sends; no cycles.",
    properties: {
      trackId: TRACK,
      routing: {
        type: "object",
        properties: {
          outputBusId: { description: "A bus track, or null for the master. Default null.", oneOf: [{ type: "null" }, ...TRACK.oneOf] },
          sends: {
            type: "array",
            items: {
              type: "object",
              properties: { busId: TRACK, gain: GAIN("Send level") },
              required: ["busId", "gain"],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    required: ["trackId", "routing"],
  },
  setTrackEffects: {
    summary:
      "Replace a track's ordered inserts. Each is { id, type: filter|delay|eq, enabled, wet 0..1, ...settings } as read_project shows them under trackEffects.",
    properties: { trackId: TRACK, effects: { type: "array", items: { type: "object" } } },
    required: ["trackId", "effects"],
  },
  setTrackRackPreset: {
    summary: "Replace a track's inserts and macros together.",
    properties: { trackId: TRACK, preset: { type: "object", description: "{ effects, macros? } as read_project shows them under trackEffects." } },
    required: ["trackId", "preset"],
  },
  setTrackMacroValue: {
    summary: "Set one rack macro of a track.",
    properties: { trackId: TRACK, macroId: { type: "string" }, value: NUM("0 to 1.", { minimum: 0, maximum: 1 }) },
    required: ["trackId", "macroId", "value"],
  },
  setMasterVolume: { summary: "Set the master level.", properties: { volume: GAIN("Master level") }, required: ["volume"] },
  setTitle: { summary: "Set the song title.", properties: { title: STR("Non-empty.") }, required: ["title"] },
  setTempoChanges: {
    summary: "Replace all tempo changes (read tempoChanges first); a change at beat 0 sets the starting tempo, without one it stays.",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: { beat: NUM("0 or more, unique.", { minimum: 0 }), bpm: NUM("At least 1.", { minimum: 1 }) },
          required: ["beat", "bpm"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
  },
  setTimeSignatureChanges: {
    summary: "Replace all time signature changes (read signatureChanges first); a change at beat 0 sets the starting signature.",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            beat: NUM("0 or more, unique.", { minimum: 0 }),
            numerator: prop("integer", "Beats per bar, 1 or more.", { minimum: 1 }),
            denominator: prop("integer", "A power of two: 1, 2, 4, 8, 16.", { minimum: 1 }),
          },
          required: ["beat", "numerator", "denominator"],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
  },
  setMarkers: {
    summary:
      "Replace all markers (read markers first); each is a name at a unique project position, atBeat or atSeconds (both must agree at the current tempo, 1e-6 s). A position in beats is converted with the tempo map as it is at this step of the request, so put tempo changes first in `ops`.",
    properties: { markers: { type: "array", items: POSITIONED({ name: STR("Non-empty.") }, ["name"]) } },
    required: ["markers"],
  },
  removeDevice: {
    summary: "Remove a device from its track's chain (read_project lists devices).",
    properties: { deviceId: { type: "string" } },
    required: ["deviceId"],
  },
  moveDevice: {
    summary: "Put a device at a position in its track's chain.",
    properties: { deviceId: { type: "string" }, index: prop("integer", "0 is first.", { minimum: 0 }) },
    required: ["deviceId", "index"],
  },
  setDeviceParameter: {
    summary:
      "Set one parameter of a device: a WebCLAP plug-in or a built-in effect (read_device_params lists deviceId, each row's id and its range). Send `expectedValue` (the row's value you read) so a value the person changed meanwhile returns conflict instead of being overwritten (equal within a relative 1e-6 counts as unchanged). Joins the same undo step as the other operations.",
    properties: {
      deviceId: STR('A device ID from read_project (devices), or "trackId:slotId" for a built-in effect (read_project effectDevices).'),
      parameterId: STR("The `id` of a read_device_params row."),
      value: prop(
        "number",
        "In the row's units, within its min and max; a stepped row (`step: 1`) snaps it to the nearest whole step, and the receipt's deviceParameters reports the value applied.",
      ),
      expectedValue: prop(
        "number",
        "The row's value as you read it; a different current value (beyond a relative 1e-6, so a float32 value copied back still matches) returns status conflict with the current value and changes nothing.",
      ),
    },
    required: ["deviceId", "parameterId", "value"],
  },
  addScene: {
    summary: "Add an empty Session scene at the end or after afterSceneId; the receipt's createdScenes lists its ID.",
    properties: { name: STR('Default "Scene N".'), afterSceneId: SCENE, as: AS },
  },
  renameScene: { summary: "Rename a scene.", properties: { sceneId: SCENE, name: STR("Non-empty.") }, required: ["sceneId", "name"] },
  moveScene: {
    summary: "Put a scene at a position in the scene order.",
    properties: { sceneId: SCENE, index: prop("integer", "0 is first.", { minimum: 0 }) },
    required: ["sceneId", "index"],
  },
  removeScene: { summary: "Remove a scene and the clips in its slots.", properties: { sceneId: SCENE }, required: ["sceneId"] },
  duplicateScene: {
    summary: 'Copy a scene with its slot clips, after it or after afterSceneId; the copy is named "<name> copy".',
    properties: { sceneId: SCENE, afterSceneId: SCENE, as: AS },
    required: ["sceneId"],
  },
  setMidiClip: {
    summary: "Put a new MIDI clip in a slot of a MIDI track, replacing its clip. duration is beats; notes and sourceOffset are content beats.",
    properties: {
      slot: SLOT,
      duration: NUM("Beats, more than 0.", { exclusiveMinimum: 0 }),
      notes: NEW_NOTES,
      sourceOffset: NUM("Content beat where the clip starts. Default 0."),
      name: STR("Display name."),
      as: AS,
    },
    required: ["slot", "duration"],
  },
  moveSlotClip: {
    summary: "Move a slot's clip to another slot of a track of the same kind, replacing its clip; it keeps its ID.",
    properties: { from: SLOT, to: SLOT },
    required: ["from", "to"],
  },
  clearSlot: { summary: "Empty a slot.", properties: { slot: SLOT }, required: ["slot"] },
  copyToSlot: {
    summary:
      "Put a copy of a timeline or slot clip in a slot of a track of the same kind, replacing its clip. linked: true shares a MIDI clip's notes.",
    properties: { clip: CLIP, slot: SLOT, linked: BOOL("MIDI only. Default false."), as: AS },
    required: ["clip", "slot"],
  },
  copyToArrangement: {
    summary:
      "Place a copy of a slot's clip on the timeline at a project position (atBeat and atSeconds together must agree, 1e-6 s), on the slot's track or trackId (same kind). linked: true shares a MIDI clip's notes.",
    properties: { slot: SLOT, trackId: TRACK, atBeat: AT_BEAT, atSeconds: AT_SECONDS, linked: BOOL("MIDI only. Default false."), as: AS },
    required: ["slot"],
  },
};

/** The full JSON Schema of one operation object. `apply_edits` does not send it (the tool list stays small; `runProjectEdits` validates every field and names the allowed ones), but tests and tools can use it. */
export function opSchema(type: string, spec: OpSpec) {
  return {
    type: "object",
    description: spec.summary,
    properties: { type: { const: type }, ...spec.properties },
    required: ["type", ...(spec.required ?? [])],
    additionalProperties: false,
  };
}

/** One line per operation for the tool description: `name{required, optional?}: summary`. */
function opLine(type: string, spec: OpSpec): string {
  const required = new Set(spec.required ?? []);
  const fields = Object.keys(spec.properties).map((key) => (required.has(key) ? key : `${key}?`));
  return `- ${type}{${fields.join(", ")}}: ${spec.summary}`;
}

/** The part of a clip's content that plays, as flat fields: beats for a MIDI clip, seconds of the recording for an audio clip. */
function windowFields(clip: ProjectClip | null | undefined) {
  if (!clip) return { sourceOffset: "", sourceLength: "", loopStart: "", loopEnd: "", stretchRatio: "" };
  if (clip.kind === "midi")
    return {
      sourceOffset: round(clip.sourceOffset),
      sourceLength: "",
      loopStart: clip.loop ? round(clip.loop.startBeat) : "",
      loopEnd: clip.loop ? round(clip.loop.endBeat) : "",
      stretchRatio: "",
    };
  return {
    sourceOffset: round(clip.sourceOffset),
    sourceLength: round(clip.sourceLength),
    loopStart: clip.loop ? round(clip.loop.startSeconds) : "",
    loopEnd: clip.loop ? round(clip.loop.endSeconds) : "",
    stretchRatio: clip.stretch ? round(clip.stretch.ratio) : "",
  };
}

function timelineClip(project: Project, id: string): ProjectClip | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (clip) return clip;
  }
  return undefined;
}

/** A curve longer than this is summarized in `read_project` as a count and its first and last position; `read_automation` returns the points. */
const AUTOMATION_SUMMARY_LIMIT = 32;

/** Where a curve point sits, for the first and last of a long curve. */
type CurvePoint = { time: number; value: number; shape: "linear" | "hold" };
type CurveShape = { row: (point: CurvePoint) => Record<string, unknown>; position: (point: CurvePoint) => Record<string, unknown> };

/** A track volume point as `setVolumeAutomation` takes it: both positions, unrounded so the row goes back unchanged. */
const volumeCurve = (project: Project): CurveShape => {
  const position = (point: CurvePoint) => ({ atBeat: project.tempoMap.secondsToBeat(point.time), atSeconds: point.time });
  return { position, row: (point) => ({ ...position(point), value: point.value, shape: point.shape }) };
};
/** A clip gain point as `setAudioClipGainAutomation` takes it. */
const gainCurve: CurveShape = {
  position: (point) => ({ atSourceSeconds: point.time }),
  row: (point) => ({ atSourceSeconds: point.time, value: point.value, shape: point.shape }),
};

/** Whether a lane of this expression has a controller number (`channelController`) or key (`polyPressure`); the other expressions have none. */
const numberedLane = (expression: ControllerExpression): boolean => expression === "channelController" || expression === "polyPressure";

/** A controller lane point as `setControllerLane` takes it: its beat, the seconds it falls at now, the value and shape. */
const controllerCurve = (project: Project): CurveShape => {
  const position = (point: CurvePoint) => ({ atBeat: point.time, atSeconds: project.tempoMap.beatToSeconds(point.time) });
  return { position, row: (point) => ({ ...position(point), value: point.value, shape: point.shape }) };
};

/** One owner's curve as `{ <key>, points }`, or `{ <key>, count, first, last }` (positions only) when it is long. */
function curveRows(key: string, id: string, points: readonly CurvePoint[], shape: CurveShape) {
  if (points.length <= AUTOMATION_SUMMARY_LIMIT) return { [key]: id, points: points.map(shape.row) };
  return { [key]: id, count: points.length, first: shape.position(points[0]), last: shape.position(points[points.length - 1]) };
}

/** A compact, readable view of the project for `read_project`. */
function projectView(workspace: Workspace) {
  return untracked(() => {
    const project = workspace.project;
    const overview = project.overview();
    const selection = selectionFor(project).state.value;
    const mixer = new Map(project.tracks.map((track) => [track.id, track]));
    const tracks = overview.tracks.map(({ id, name, kind, clips }) => {
      const track = mixer.get(id)!;
      return {
        id,
        name,
        kind,
        busRole: track.busRole ?? "",
        volume: round(track.volume, 4),
        muted: track.muted,
        solo: track.solo,
        pan: round(track.pan, 4),
        output: track.routing.outputBusId ?? "master",
        clips: clips.length,
      };
    });
    const devices = project.tracks.flatMap((track) =>
      track.devices.map((device, index) => ({
        id: device.id,
        trackId: track.id,
        index,
        name: device.name,
        pluginId: device.pluginId,
        parameters: device.parameters.length,
      })),
    );
    const effectDevices = project.tracks.flatMap((track) =>
      track.effects.map((slot) => ({
        id: rackDeviceId(track.id, slot.id),
        trackId: track.id,
        slotId: slot.id,
        type: slot.type,
        parameters: rackSlotParameters(slot).length,
      })),
    );
    const trackEffects = project.tracks
      .filter((track) => track.effects.length || track.effectMacros.length)
      .map((track) => ({ trackId: track.id, effects: track.effects, macros: track.effectMacros }));
    const routing = project.tracks
      .filter((track) => track.routing.outputBusId !== null || track.routing.sends.length)
      .map((track) => ({
        trackId: track.id,
        routing: { outputBusId: track.routing.outputBusId, sends: track.routing.sends.map(({ busId, gain }) => ({ busId, gain })) },
      }));
    const volumeAutomation = project.tracks
      .filter((track) => track.volumeAutomation.length)
      .map((track) => curveRows("trackId", track.id, track.volumeAutomation, volumeCurve(project)));
    const controllerLanes = project.tracks.flatMap((track) =>
      track.controllerLanes.map((lane) => {
        const { expression, channel, controller } = lane;
        const { trackId: _id, ...rest } = curveRows("trackId", track.id, lane.points, controllerCurve(project));
        // The controller number (or key) only exists for the numbered expressions: setControllerLane takes none for the others.
        return { trackId: track.id, expression, channel, ...(numberedLane(expression) ? { controller } : {}), ...rest };
      }),
    );
    const everyClip = [
      ...project.tracks.flatMap((track) => track.clips),
      ...sessionFor(project).scenes.flatMap((scene) =>
        project.tracks.flatMap((track) => sessionFor(project).clipAt({ sceneId: scene.id, trackId: track.id }) ?? []),
      ),
    ];
    const clipEnvelopes = everyClip.flatMap((clip) =>
      clip.kind === "audio" && clip.envelope
        ? [{ id: clip.id, gain: round(clip.envelope.gain, 4), fadeIn: round(clip.envelope.fadeIn), fadeOut: round(clip.envelope.fadeOut) }]
        : [],
    );
    const clipGainAutomation = everyClip.flatMap((clip) =>
      clip.kind === "audio" && clip.gainAutomation?.points.length ? [curveRows("clipId", clip.id, clip.gainAutomation.points, gainCurve)] : [],
    );
    const clips = overview.tracks.flatMap((track) =>
      track.clips.map((clip) => ({
        id: clip.id,
        name: clip.name ?? "",
        kind: clip.kind,
        track: track.name,
        startBeat: round(clip.startBeat),
        durationBeats: round(clip.durationBeats),
        startSeconds: round(clip.startSeconds),
        durationSeconds: round(clip.durationSeconds),
        ...windowFields(timelineClip(project, clip.id)),
        linkedTo: clip.linkedTo?.join(",") ?? "",
      })),
    );
    const slots = overview.session.flatMap((scene) =>
      scene.clips.map((clip) => ({
        scene: scene.name,
        sceneId: scene.id,
        id: clip.id,
        name: clip.name ?? "",
        kind: clip.kind,
        track: clip.trackName,
        duration: round(clip.duration),
        unit: clip.unit,
        ...windowFields(sessionFor(project).clipAt({ sceneId: scene.id, trackId: clip.trackId })),
      })),
    );
    const history = project.cells.history.value;
    let extensions: { extensions?: unknown; extensionsError?: string } = {};
    try {
      const summaries = project.extensionSummaries();
      if (summaries.length) extensions = { extensions: summaries };
    } catch (error) {
      extensions = { extensionsError: error instanceof Error ? error.message : String(error) };
    }
    return {
      title: overview.title,
      version: overview.version,
      bpm: overview.bpm,
      signature: `${overview.signature[0]}/${overview.signature[1]}`,
      ...(overview.signatureChanges.length
        ? {
            signatureChanges: overview.signatureChanges.map(({ beat, numerator, denominator }) => ({ beat, numerator, denominator })),
          }
        : {}),
      tempoChanges: overview.tempoChanges.map(({ beat, bpm }) => ({ beat, bpm })),
      markers: overview.markers.map(({ name, time }) => ({ name, atBeat: project.tempoMap.secondsToBeat(time), atSeconds: time })),
      masterVolume: round(project.masterVolume, 4),
      tracks,
      ...(devices.length ? { devices } : {}),
      ...(effectDevices.length ? { effectDevices } : {}),
      ...(routing.length ? { routing } : {}),
      ...(trackEffects.length ? { trackEffects } : {}),
      ...(volumeAutomation.length ? { volumeAutomation } : {}),
      ...(controllerLanes.length ? { controllerLanes } : {}),
      clips,
      ...(clipEnvelopes.length ? { clipEnvelopes } : {}),
      ...(clipGainAutomation.length ? { clipGainAutomation } : {}),
      scenes: overview.session.map(({ id, name }) => ({ id, name })),
      slotClips: slots,
      selection: {
        trackId: selection.trackId,
        clipIds: [...selection.clipIds],
        openClipId: selection.openClipId,
        noteIds: [...selection.noteIds],
        range: selection.range ? { startBeat: selection.range.startBeat, endBeat: selection.range.endBeat } : null,
      },
      playback: {
        playing: workspace.player.isPlaying.value,
        positionSeconds: round(workspace.position),
        needsSync: workspace.cells.needsSync.value,
        error: workspace.cells.error.value,
      },
      history: { undo: history.undo ?? null, redo: history.redo ?? null },
      ...extensions,
      operations: project.operations.list().map(({ name, description, input, readOnly }) => ({ name, description, readOnly, input })),
    };
  });
}

async function playbackState(workspace: Workspace, version: ProjectVersion) {
  const status = await workspace.editStatus(version);
  return {
    status,
    inPlayback: status === "applied",
    needsSync: untracked(() => workspace.cells.needsSync.value),
    error: untracked(() => workspace.cells.error.value),
  };
}

function silentSpans(channels: readonly Float32Array[], sampleRate: number, startSeconds: number, thresholdDb: number, minSeconds: number) {
  const frames = channels[0]?.length ?? 0;
  const threshold = 10 ** (thresholdDb / 20);
  const spans: { startSeconds: number; endSeconds: number }[] = [];
  let from = -1;
  const close = (end: number) => {
    if (from >= 0 && (end - from) / sampleRate >= minSeconds)
      spans.push({ startSeconds: round(startSeconds + from / sampleRate), endSeconds: round(startSeconds + end / sampleRate) });
    from = -1;
  };
  for (let frame = 0; frame < frames; frame++) {
    let quiet = true;
    for (const channel of channels)
      if (Math.abs(channel[frame]) > threshold) {
        quiet = false;
        break;
      }
    if (quiet) {
      if (from < 0) from = frame;
    } else close(frame);
  }
  close(frames);
  return spans;
}

/**
 * The tools an agent uses to work on the project a person has open: read it and the person's selection, query it, edit it as one
 * undoable step, run the app's named operations, listen to a range and save. All logic lives here, so any transport can serve them
 * (see `connectMcpBridge` and the `@audiorective/mcp` server).
 */
export function mcpTools(workspace: Workspace, options: McpToolsOptions = {}): readonly McpTool[] {
  const prefix = `Agent: ${options.labelPrefix ?? ""}`;
  const allowed = resolveAllow(options.allow);
  const listenAudio = options.listenAudio;
  if (
    listenAudio !== undefined &&
    !(isRecord(listenAudio) && typeof listenAudio.maxSeconds === "number" && Number.isFinite(listenAudio.maxSeconds) && listenAudio.maxSeconds > 0)
  )
    throw new Error("mcpTools: listenAudio.maxSeconds must be a finite number greater than 0.");
  const guard =
    (run: (args: Args) => Promise<McpToolResult> | McpToolResult) =>
    async (raw: unknown): Promise<McpToolResult> => {
      try {
        if (raw !== undefined && raw !== null && !isRecord(raw)) return fail("Arguments must be a JSON object.");
        return await run(raw ?? {});
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    };

  const tools: McpTool[] = [
    {
      name: "read_project",
      category: "read",
      description:
        "Read the open project as TOON text: title, tempo and meter, markers, tracks, every clip with its beats and seconds, Session scenes, what the person has SELECTED (selection.clipIds, openClipId, range), the current `version`, playback state, undo labels, the app's own data as `extensions` (each `{ id, summary }`: what the app's data means, such as which pattern sits at which bars; only extensions that publish a summary appear) and the app's named operations (each with its `input` JSON Schema: pass exactly those fields to run_operation; `readOnly: true` ones only answer a question and change nothing). Clips carry sourceOffset, sourceLength (audio) and loopStart/loopEnd: the window of the content that plays, in beats for MIDI clips and seconds of the recording for audio clips. An audio clip that is time-stretched also carries stretchRatio (timeline seconds per second of audio; empty when it is not stretched). Call it first and again after any conflict. Positions are in beats (quarter notes from the start) unless named seconds.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: guard(async () => toon(callableOperations(projectView(workspace), allowed))),
    },
    {
      name: "find",
      category: "read",
      description:
        'Locate content. `{ type: "clips", name?, trackId?, trackName?, range?, relation? }` returns the matching clips (names are not unique: check `count`). `{ type: "marker", name, occurrence? }` returns one marker. Ranges are half-open beats.',
      inputSchema: {
        type: "object",
        properties: {
          type: { enum: ["clips", "marker"] },
          name: { type: "string" },
          trackId: { type: "string" },
          trackName: { type: "string" },
          range: BEAT_RANGE_SCHEMA,
          relation: { enum: ["overlaps", "contained"], description: 'How a clip relates to `range`. Default "overlaps".' },
          occurrence: { type: "integer", minimum: 1, description: "Which marker of that name, counting from 1 in time order. Default 1." },
        },
        required: ["type"],
      },
      call: guard((args) => {
        const project = workspace.project;
        if (args.type === "marker") {
          const name = stringArg(args, "name", true);
          if (typeof name !== "string") return name!;
          const occurrence = args.occurrence;
          if (occurrence !== undefined && (!Number.isInteger(occurrence) || (occurrence as number) < 1))
            return fail(`"occurrence" must be a positive integer (1 is the first).`);
          const marker = untracked(() => project.findMarker({ name, occurrence: occurrence as number | undefined }));
          if (!marker) return fail(`No marker named "${name}"${occurrence === undefined ? "" : ` at occurrence ${occurrence}`}.`);
          return toon({
            name: marker.name,
            seconds: round(marker.time),
            beat: round(untracked(() => project.tempoMap.secondsToBeat(marker.time))),
          });
        }
        if (args.type !== "clips") return fail(`"type" must be "clips" or "marker".`);
        const query: {
          name?: string;
          trackId?: string;
          trackName?: string;
          range?: { startBeat: number; endBeat: number };
          relation?: "overlaps" | "contained";
        } = {};
        for (const key of ["name", "trackId", "trackName"] as const) {
          const value = stringArg(args, key, false);
          if (value !== undefined && typeof value !== "string") return value;
          if (value !== undefined) query[key] = value;
        }
        if (args.range !== undefined) {
          const range = beatRange(args.range, "range");
          if ("content" in range) return range;
          query.range = range;
        }
        if (args.relation !== undefined) {
          if (args.relation !== "overlaps" && args.relation !== "contained") return fail(`"relation" must be "overlaps" or "contained".`);
          query.relation = args.relation;
        }
        const found = untracked(() => project.findClips(query));
        return toon({
          count: found.length,
          clips: found.map((clip) => ({
            id: clip.id,
            name: clip.name ?? "",
            kind: clip.kind,
            trackId: clip.trackId,
            track: clip.trackName,
            startBeat: round(clip.startBeat),
            durationBeats: round(clip.durationBeats),
            startSeconds: round(clip.startSeconds),
            durationSeconds: round(clip.durationSeconds),
            ...windowFields(timelineClip(project, clip.id)),
          })),
        });
      }),
    },
    {
      name: "read_notes",
      category: "read",
      description:
        "List the notes of one MIDI clip as TOON rows `id,pitch,start,duration,velocity,hidden`. Pass `range` (content beats) when you only need part of a long clip. start and duration are CONTENT beats (the beats addNotes, editNotes and setClipSourceRange use; the clip plays the window starting at `window.sourceOffset`, so a note at start 0 is not at the clip's start when sourceOffset is not 0). `hidden` is true for a note the clip's window or loop does not play. Optional `range` { startBeat, endBeat } (content beats, half-open) keeps only notes that overlap it. Works for timeline and Session clips; linked clips share notes.",
      inputSchema: {
        type: "object",
        properties: {
          clipId: { type: "string" },
          range: { ...BEAT_RANGE_SCHEMA, description: "Content beats; keeps notes overlapping [startBeat, endBeat)." },
        },
        required: ["clipId"],
        additionalProperties: false,
      },
      call: guard((args) => {
        const clipId = stringArg(args, "clipId", true);
        if (typeof clipId !== "string") return clipId!;
        const unknown = Object.keys(args).find((key) => key !== "clipId" && key !== "range");
        if (unknown !== undefined) return fail(`Unknown field "${unknown}"; allowed: clipId, range.`);
        let range: { startBeat: number; endBeat: number } | undefined;
        if (args.range !== undefined) {
          const checked = beatRange(args.range, "range");
          if ("content" in checked) return checked;
          range = checked;
        }
        const project = workspace.project;
        const clip = untracked(() => timelineClip(project, clipId) ?? findSlotClip(project, clipId));
        if (!clip) return fail(`No clip "${clipId}". Use read_project or find to get clip ids.`);
        if (clip.kind !== "midi") return fail(`Clip "${clipId}" is an audio clip: it has no notes.`);
        const all = untracked(() => clip.midi.notes.value);
        const passes = midiPasses(clip.sourceOffset, clip.loop, clip.duration);
        const plays = (note: { start: number; duration: number }) =>
          passes.some(({ from, to }) => note.start < to && (note.start + note.duration > from || note.start >= from));
        const shown = range
          ? all.filter((note) => note.start < range.endBeat && (note.start + note.duration > range.startBeat || note.start >= range.startBeat))
          : all;
        return toon({
          clipId,
          version: untracked(() => project.cells.version.value),
          window: {
            sourceOffset: round(clip.sourceOffset),
            durationBeats: round(clip.duration),
            loopStart: clip.loop ? round(clip.loop.startBeat) : "",
            loopEnd: clip.loop ? round(clip.loop.endBeat) : "",
          },
          count: shown.length,
          hiddenCount: shown.filter((note) => !plays(note)).length,
          notes: shown.map((note) => ({
            id: note.id,
            pitch: note.pitch,
            start: round(note.start),
            duration: round(note.duration),
            velocity: round(note.velocity),
            hidden: !plays(note),
          })),
        });
      }),
    },
    {
      name: "read_automation",
      category: "read",
      description:
        "List the points of one automation curve in the shape the replace ops take: `{ trackId }` returns a track's volume curve as rows `atBeat, atSeconds, value, shape` (send them to setVolumeAutomation); `{ trackId, expression, channel, controller? }` returns that MIDI controller lane of the track in the same rows (send them to setControllerLane); `{ clipId }` returns an audio clip's gain curve as rows `atSourceSeconds, value, shape` (send them to setAudioClipGainAutomation). read_project shows only a count with the first and last position for a curve of more than 32 points. Optional `range` keeps the points inside it: for a track { startBeat, endBeat } or { startSeconds, endSeconds } in project time, for a clip { startSeconds, endSeconds } in seconds of the recording (half-open). A range gives only part of the curve: replace a curve only with its full list.",
      inputSchema: {
        type: "object",
        properties: {
          trackId: { type: "string" },
          clipId: { type: "string" },
          expression: {
            enum: ["channelController", "pitchBend", "channelPressure", "polyPressure", "programChange"],
            description: "With trackId: read a MIDI controller lane instead of the volume curve.",
          },
          channel: { type: "integer", minimum: 0, maximum: 15 },
          controller: { type: "integer", minimum: 0, maximum: 127, description: "The controller number (channelController) or key (polyPressure)." },
          range: { description: "Half-open; beats or seconds of the project for a track, seconds of the recording for a clip.", type: "object" },
        },
        additionalProperties: false,
      },
      call: guard((args) => {
        const unknown = Object.keys(args).find((key) => !["trackId", "clipId", "range", "expression", "channel", "controller"].includes(key));
        if (unknown !== undefined) return fail(`Unknown field "${unknown}"; allowed: trackId, clipId, range, expression, channel, controller.`);
        if (args.clipId !== undefined && (args.expression !== undefined || args.channel !== undefined || args.controller !== undefined))
          return fail(`"expression", "channel" and "controller" name a controller lane of a track: give them with "trackId".`);
        if ((args.trackId === undefined) === (args.clipId === undefined)) return fail(`Give exactly one of "trackId" and "clipId".`);
        const project = workspace.project;
        const version = untracked(() => project.cells.version.value);
        return untracked(() => {
          if (args.trackId !== undefined) {
            const trackId = stringArg(args, "trackId", true);
            if (typeof trackId !== "string") return trackId!;
            const track = project.tracks.find((item) => item.id === trackId);
            if (!track) return fail(`No track "${trackId}". Use read_project to get track ids.`);
            let keep = (_seconds: number) => true;
            if (args.range !== undefined) {
              const range = timeRange(args.range);
              if ("content" in range) return range;
              const seconds =
                "startBeat" in range
                  ? { start: project.tempoMap.beatToSeconds(range.startBeat), end: project.tempoMap.beatToSeconds(range.endBeat) }
                  : { start: range.startSeconds, end: range.endSeconds };
              keep = (time) => time >= seconds.start && time < seconds.end;
            }
            if (args.expression !== undefined) {
              const lane = track.controllerLanes.find(
                (item) => item.expression === args.expression && item.channel === args.channel && item.controller === (args.controller ?? 0),
              );
              if (!lane) {
                const expression = args.expression as ControllerExpression;
                return toon({
                  trackId,
                  expression,
                  channel: args.channel,
                  ...(numberedLane(expression) ? { controller: args.controller ?? 0 } : {}),
                  version,
                  total: 0,
                  count: 0,
                  points: [],
                  note: "This lane does not exist yet; setControllerLane creates it from points in these rows.",
                });
              }
              const laneShape = controllerCurve(project);
              const inside = lane.points.filter((point) => keep(project.tempoMap.beatToSeconds(point.time)));
              return toon({
                trackId,
                expression: lane.expression,
                channel: lane.channel,
                ...(numberedLane(lane.expression) ? { controller: lane.controller } : {}),
                version,
                total: lane.points.length,
                count: inside.length,
                points: inside.map(laneShape.row),
              });
            }
            if (args.channel !== undefined || args.controller !== undefined)
              return fail(`"channel" and "controller" need "expression" to name a controller lane.`);
            const shape = volumeCurve(project);
            const shown = track.volumeAutomation.filter((point) => keep(point.time));
            return toon({ trackId, version, total: track.volumeAutomation.length, count: shown.length, points: shown.map(shape.row) });
          }
          const clipId = stringArg(args, "clipId", true);
          if (typeof clipId !== "string") return clipId!;
          const clip = timelineClip(project, clipId) ?? findSlotClip(project, clipId);
          if (!clip) return fail(`No clip "${clipId}". Use read_project or find to get clip ids.`);
          if (clip.kind !== "audio") return fail(`Clip "${clipId}" is a MIDI clip: it has no gain curve.`);
          let keep = (_seconds: number) => true;
          if (args.range !== undefined) {
            const range = timeRange(args.range);
            if ("content" in range) return range;
            if (!("startSeconds" in range)) return fail(`"range" for a clip must be { startSeconds, endSeconds } in seconds of the recording.`);
            keep = (time) => time >= range.startSeconds && time < range.endSeconds;
          }
          const all = clip.gainAutomation?.points ?? [];
          const shown = all.filter((point) => keep(point.time));
          return toon({ clipId, version, total: all.length, count: shown.length, points: shown.map(gainCurve.row) });
        });
      }),
    },
    {
      name: "read_device_params",
      category: "read",
      description:
        "List the parameters of one device in one shape for a WebCLAP plug-in and a built-in effect: `deviceId` is an ID from read_project `devices`, or `trackId:slotId` from `effectDevices`. Each row has `id`, `name`, `kind` (webclap or rack), `min`, `max`, `default`, `value` (what plays now, in the row's units), and where known `unit`, `step` (1: whole numbers; a set value snaps to the nearest one) and `text` (the plug-in's display string of the value). To change one, send apply_edits `{ type: \"setDeviceParameter\", deviceId, parameterId: row.id, value, expectedValue: row.value }`; `expectedValue` makes a value the person moved meanwhile come back as a conflict instead of being overwritten. A plug-in that has not loaded yet has no rows (ask the person to open the project in the page). The returned `version` is the project version the rows were read at.",
      inputSchema: { type: "object", properties: { deviceId: { type: "string" } }, required: ["deviceId"], additionalProperties: false },
      call: guard((args) => {
        const unknown = Object.keys(args).find((key) => key !== "deviceId");
        if (unknown !== undefined) return fail(`Unknown field "${unknown}"; allowed: deviceId.`);
        const deviceId = stringArg(args, "deviceId", true);
        if (typeof deviceId !== "string") return deviceId!;
        return untracked(() => {
          const parameters = workspace.deviceParameters(deviceId);
          return toon({
            deviceId,
            version: workspace.project.cells.version.value,
            count: parameters.length,
            parameters: parameters.map((row) => ({ ...row })),
          });
        });
      }),
    },
    {
      name: "apply_edits",
      category: "edit",
      description: [
        `Apply a list of edit operations as ONE undoable step (the person presses Undo once to remove all of it).`,
        `Pass the \`version\` you last read as expectedVersion.`,
        `If the person changed the project since, you get status "conflict" and nothing changes: call read_project, re-plan and send again.`,
        `Operations run in order and the whole request is all-or-nothing: a step that cannot run returns status "rejected" with its opIndex and a code, and nothing changes.`,
        `Positions: atBeat is project beats (quarter notes from the start), atSeconds is project seconds; give atBeat or atSeconds where an operation takes a position (both are accepted when they name the same moment, within 1e-6 s, so a row from read_project goes back unchanged). resizeClip start/end are absolute project beats for every clip; note start/duration, sourceOffset and setClipLoop beats are CONTENT beats (what read_notes shows); setClipSourceRange is content beats for MIDI and seconds of the recording for audio. Volumes, sends and gains are linear gain (0 or more, 1 is unity); pan is -1 (left) to 1 (right).`,
        `Naming results: give an operation that makes clips, tracks or scenes \`as: "name"\`; later steps select clips as { fromCopy: "name", trackName? } and tracks and scenes as { fromCopy: "name" } in trackId or sceneId. The receipt lists created, changed and removed clip IDs, createdNotes, deviceParameters (the value each setDeviceParameter applied), copies, createdTracks and createdScenes, changedTracks and removedTracks, changedScenes (scenes renamed or moved in the order; a filled slot is a clip in created or changed) and removedScenes, and song (any of tempo, timeSignature, markers, title, masterVolume).`,
        `Set-style operations (setTempoChanges, setTimeSignatureChanges, setMarkers, setVolumeAutomation, setControllerLane, setTrackEffects, ...) REPLACE the whole list: read the current one from read_project (read_automation for a curve of more than 32 points) and send the full new list; a row from read_project goes back unchanged.`,
        `Field shapes: clip = { clipId } or { fromCopy, trackId?, trackName?, name? }; trackId, sceneId, afterSceneId, busId, outputBusId = an ID string or { fromCopy } (outputBusId also null); slot = { sceneId, trackId }; notes = [{ pitch 0-127, start, duration, velocity? 0-1 }] in content beats; editNotes notes = [{ id, pitch?, start?, duration?, velocity? }]; range = { startBeat, endBeat } (rippleDelete also { startSeconds, endSeconds }); moveClip position = { atBeat } or { byBeats }; setClipLoop loop = null, { startBeat, endBeat } (MIDI) or { startSeconds, endSeconds } (audio); routing = { outputBusId, sends: [{ busId, gain }] }; tempo changes = [{ beat, bpm }]; time signature changes = [{ beat, numerator, denominator }]; markers = [{ name, atBeat and/or atSeconds }]; volume points = [{ atBeat and/or atSeconds, value, shape? "linear"|"hold" }]; controller lane points = [{ atBeat and/or atSeconds, value (integer), shape? }]; clip gain points = [{ atSourceSeconds, value, shape? }]; effects and preset as read_project shows trackEffects.`,
        `Operations (fields ending in ? are optional):`,
        ...PROJECT_EDIT_TYPES.map((type) => opLine(type, EDIT_OP_SPECS[type])),
        `Unknown fields are rejected with the allowed list.`,
        `The receipt says whether playback already has the edit (a structural change such as adding or removing a track needs the person's sync), or status "noop" when nothing changed.`,
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          expectedVersion: { type: "string", description: "The `version` from read_project or the last receipt." },
          label: { type: "string", description: 'What the edit does, shown in undo history as "Agent: <label>".' },
          ops: {
            type: "array",
            minItems: 1,
            description:
              "The operations in order; each is { type, ...fields } as listed in the tool description. Fields are checked when the operation runs.",
            items: { type: "object", properties: { type: { enum: [...PROJECT_EDIT_TYPES] } }, required: ["type"] },
          },
        },
        required: ["expectedVersion", "label", "ops"],
      },
      call: guard(async (args) => {
        const expectedVersion = stringArg(args, "expectedVersion", true);
        if (typeof expectedVersion !== "string") return expectedVersion!;
        const label = stringArg(args, "label", true);
        if (typeof label !== "string") return label!;
        if (!Array.isArray(args.ops) || args.ops.length === 0 || !args.ops.every(isRecord))
          return fail(`"ops" must be a non-empty array of operation objects, each with a "type".`);
        const project = workspace.project;
        const receipt = project.applyEdits({
          expectedVersion: expectedVersion as ProjectVersion,
          label: `${prefix}${label}`,
          ops: args.ops,
        } as unknown as ProjectEditRequest);
        if (receipt.status === "conflict")
          return json(
            {
              status: "conflict",
              currentVersion: receipt.version,
              reason: receipt.reason,
              next: "Nothing was changed and the person's edit is kept. Call read_project (read_device_params for a device parameter), check the new state, and send the edit again with the new version. Note and clip IDs usually stay valid when the person changed other material; re-read only what they touched.",
            },
            true,
          );
        if (receipt.status === "rejected")
          return json(
            {
              status: "rejected",
              currentVersion: receipt.version,
              code: receipt.code,
              reason: receipt.reason,
              ...(receipt.opIndex === undefined ? {} : { opIndex: receipt.opIndex }),
              next: "Nothing was changed. Fix the operation and send it again with the same version.",
            },
            true,
          );
        if (receipt.version === expectedVersion)
          return json({
            status: "noop",
            version: receipt.version,
            note: "The edits left the project exactly as it was, so there is no undo step. Check that the values differ from what the project already has.",
          });
        const playback = await playbackState(workspace, receipt.version);
        return json({
          status: "applied",
          version: receipt.version,
          undoLabel: `${prefix}${label}`,
          created: receipt.created,
          createdNotes: receipt.createdNotes,
          deviceParameters: receipt.deviceParameters,
          createdTracks: receipt.createdTracks,
          createdScenes: receipt.createdScenes,
          changed: receipt.changed,
          removed: receipt.removed,
          changedTracks: receipt.changedTracks,
          removedTracks: receipt.removedTracks,
          changedScenes: receipt.changedScenes,
          removedScenes: receipt.removedScenes,
          song: receipt.song,
          copies: receipt.copies,
          playback,
        });
      }),
    },
    {
      name: "run_operation",
      category: "operations",
      description:
        "Call one of the app's named operations (listed under `operations` in read_project, each with its `input` JSON Schema) with JSON `args` that use only the fields of that schema: unknown or missing fields are an error that lists the schema. It runs as one undoable step labelled by the operation. A `readOnly` operation is a query: it returns status `read` and its `result`, changes nothing and makes no undo step. Pass `expectedVersion` to refuse when the person has changed the project since you read it (ignored by read-only operations).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: { type: "object" },
          expectedVersion: { type: "string", description: "Optional. A different current version returns a conflict and runs nothing." },
        },
        required: ["name"],
      },
      call: guard(async (args) => {
        const name = stringArg(args, "name", true);
        if (typeof name !== "string") return name!;
        if (args.args !== undefined && !isRecord(args.args)) return fail(`"args" must be a JSON object.`);
        const project = workspace.project;
        const current = untracked(() => project.cells.version.value);
        const operations = untracked(() => project.operations.list());
        const known = operations.map((operation) => operation.name);
        if (!known.includes(name)) return fail(`No operation named "${name}". Available: ${known.length ? known.join(", ") : "none"}.`);
        const { input, readOnly } = operations.find((operation) => operation.name === name)!;
        const refusal = operationRefusal(allowed, readOnly === true, name);
        if (refusal) return fail(refusal);
        if (!readOnly && args.expectedVersion !== undefined && args.expectedVersion !== current)
          return json(
            {
              status: "conflict",
              currentVersion: current,
              reason: "The project changed since this version was read.",
              next: "Nothing ran. Call read_project and try again with the new version.",
            },
            true,
          );
        try {
          checkArguments(name, input, args.args ?? {});
        } catch (error) {
          return fail(`${error instanceof Error ? error.message : String(error)} Input schema: ${JSON.stringify(input)}`);
        }
        const result = project.operations.call(name, args.args ?? {});
        if (readOnly) return json({ status: "read", result: result ?? null, version: untracked(() => project.cells.version.value) });
        const version = untracked(() => project.cells.version.value);
        if (version === current)
          return json({
            status: "noop",
            result: result ?? null,
            version,
            note: "The operation ran but left the project exactly as it was, so there is no undo step.",
          });
        return json({
          status: "applied",
          result: result ?? null,
          version,
          undoLabel: untracked(() => project.cells.history.value.undo) ?? null,
          playback: await playbackState(workspace, version),
        });
      }),
    },
    {
      name: "listen",
      category: "read",
      description:
        "Render a range of the full mix offline (every track, device and effect; playback is not interrupted) and return evidence as JSON: peakDbFS, loudnessLUFS (null when silent or under 400 ms), silentSpans in project seconds, and a click check per `seamBeats` entry (`hasClick`). `range` is { startBeat, endBeat } or { startSeconds, endSeconds }. Renders the whole mix, or only `trackIds` (each through its own effects, instruments and the bus it outputs to; send returns fed by them are included; a muted track stays silent; the numbers measure the sum of those tracks; selecting a bus also brings in the tracks that feed it), so a track or a pair can be checked on its own. Returns numbers only, unless `audio: true` and the app allows sound: then a short WAV of the start of the range comes with the numbers. Renders the current version unless `expectedVersion` is given.",
      inputSchema: {
        type: "object",
        properties: {
          range: {
            oneOf: [
              BEAT_RANGE_SCHEMA,
              {
                type: "object",
                properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } },
                required: ["startSeconds", "endSeconds"],
              },
            ],
          },
          expectedVersion: { type: "string" },
          trackIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "Hear only these tracks (ids from read_project). Default: every track.",
          },
          audio: {
            type: "boolean",
            description: "Also return a short WAV of the start of the range, when the app allows it (it needs the export permission). Default false.",
          },
          seamBeats: {
            type: "array",
            items: { type: "number" },
            description: "Beats inside the range to check for clicks, such as the joins of an edit.",
          },
          prerollSeconds: { type: "number", minimum: 0 },
          silenceDb: { type: "number", description: "Level under which a stretch counts as silent. Default -60." },
          minSilenceSeconds: { type: "number", minimum: 0, description: "Shortest silent stretch to report. Default 0.1." },
        },
        required: ["range"],
      },
      call: guard(async (args) => {
        const range = timeRange(args.range);
        if ("content" in range) return range;
        const project = workspace.project;
        const expectedVersion = (args.expectedVersion ?? untracked(() => project.cells.version.value)) as ProjectVersion;
        if (typeof expectedVersion !== "string") return fail(`"expectedVersion" must be a string.`);
        let seamBeats: number[] | undefined;
        if (args.seamBeats !== undefined) {
          if (!Array.isArray(args.seamBeats) || !args.seamBeats.every((beat) => typeof beat === "number" && Number.isFinite(beat)))
            return fail(`"seamBeats" must be an array of numbers.`);
          seamBeats = args.seamBeats as number[];
        }
        let trackIds: string[] | undefined;
        if (args.trackIds !== undefined) {
          if (!Array.isArray(args.trackIds) || args.trackIds.length === 0 || !args.trackIds.every((id) => typeof id === "string"))
            return fail(`"trackIds" must be a non-empty array of track ids.`);
          trackIds = args.trackIds as string[];
        }
        if (args.audio !== undefined && typeof args.audio !== "boolean") return fail(`"audio" must be a boolean.`);
        for (const key of ["prerollSeconds", "silenceDb", "minSilenceSeconds"])
          if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]))) return fail(`"${key}" must be a number.`);
        const result = await renderMixRange(workspace, {
          expectedVersion,
          range,
          seamBeats,
          trackIds,
          prerollSeconds: args.prerollSeconds as number | undefined,
        });
        if (result.status === "conflict")
          return json(
            { status: "conflict", currentVersion: result.version, reason: result.reason, next: "Call read_project and listen again." },
            true,
          );
        let audio: McpToolResult["audio"];
        let audioNote: string | undefined;
        if (args.audio === true) {
          if (!listenAudio) audioNote = "Audio is not enabled by this app, so only the numbers are returned.";
          else if (!allowed.has("export"))
            audioNote =
              "Audio needs the export permission, which this app has not granted, so only the numbers are returned. Tell the person if you need to hear it.";
          else {
            const { sampleRate, channels } = result.audio;
            const frames = Math.min(channels[0].length, Math.floor(listenAudio.maxSeconds * sampleRate));
            const bytes = encodeWavBytes({ sampleRate, channels: channels.map((channel) => channel.subarray(0, frames)) }, { bitDepth: 16 });
            let binary = "";
            for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
            audio = { mimeType: "audio/wav", base64: btoa(binary) };
            if (frames < channels[0].length)
              audioNote = `The audio holds the first ${round(frames / sampleRate)} s of the range (the app's limit is ${listenAudio.maxSeconds} s); the numbers cover all of it.`;
          }
        }
        const evidence = {
          status: "rendered",
          version: result.version,
          ...(trackIds ? { trackIds } : {}),
          ...(audioNote ? { audioNote } : {}),
          startSeconds: round(result.startSeconds),
          durationSeconds: round(result.durationSeconds),
          peakDbFS: result.peakDbFS === null ? null : round(result.peakDbFS, 2),
          loudnessLUFS: result.loudnessLUFS === null ? null : round(result.loudnessLUFS, 2),
          silentSpans: silentSpans(
            result.audio.channels,
            result.audio.sampleRate,
            result.startSeconds,
            (args.silenceDb as number | undefined) ?? -60,
            (args.minSilenceSeconds as number | undefined) ?? 0.1,
          ),
          seams: result.seams.map(({ beat, hasClick, jump, localJump }) => ({
            beat,
            hasClick,
            jump: round(jump, 4),
            localJump: round(localJump, 4),
          })),
          historyTruncated: result.historyTruncated,
        };
        return audio ? { ...json(evidence), audio } : json(evidence);
      }),
    },
    {
      name: "save_as",
      category: "export",
      description:
        "Save the project as a .dawproject file through the app's save handler (the app decides where it goes). Pass `expectedVersion` to refuse if the project has moved on.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "File name, for example song.dawproject." }, expectedVersion: { type: "string" } },
        required: ["name"],
      },
      call: guard(async (args) => {
        const name = stringArg(args, "name", true);
        if (typeof name !== "string") return name!;
        if (!options.save) return fail("This app did not provide a save handler, so save_as is unavailable.");
        if (args.expectedVersion !== undefined && typeof args.expectedVersion !== "string") return fail(`"expectedVersion" must be a string.`);
        const bytes = await saveWorkspace(
          workspace,
          args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion as ProjectVersion },
        );
        await options.save(bytes, name);
        return json({ status: "saved", name, bytes: bytes.length, version: untracked(() => workspace.project.cells.version.value) });
      }),
    },
    {
      name: "export_midi",
      category: "export",
      description:
        "Save the project's MIDI tracks as a Standard MIDI File (format 1: tempo and time signatures, then one track per MIDI track with its channels, notes, pedal, controllers and pitch bend; clip windows, loops and linked clips as they play) through the app's save handler. Audio, volume, pan and devices are not in it. Pass `expectedVersion` to refuse if the project has moved on.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "File name, for example song.mid." },
          expectedVersion: { type: "string" },
          ppq: { type: "integer", minimum: 1, maximum: 32767, description: "Ticks per quarter note. Default 960." },
        },
        required: ["name"],
      },
      call: guard(async (args) => {
        const name = stringArg(args, "name", true);
        if (typeof name !== "string") return name!;
        if (!options.save) return fail("This app did not provide a save handler, so export_midi is unavailable.");
        if (args.expectedVersion !== undefined && typeof args.expectedVersion !== "string") return fail(`"expectedVersion" must be a string.`);
        if (args.ppq !== undefined && (typeof args.ppq !== "number" || !Number.isInteger(args.ppq) || args.ppq < 1 || args.ppq > 32767))
          return fail(`"ppq" must be an integer from 1 to 32767.`);
        const project = workspace.project;
        const version = untracked(() => project.cells.version.value);
        if (args.expectedVersion !== undefined && args.expectedVersion !== version)
          return json(
            {
              status: "conflict",
              currentVersion: version,
              reason: "The project changed since this version was read.",
              next: "Call read_project and export again.",
            },
            true,
          );
        const bytes = exportMidiFile(project, args.ppq === undefined ? {} : { ppq: args.ppq as number });
        await options.save(bytes, name);
        return json({ status: "saved", name, bytes: bytes.length, version });
      }),
    },
    {
      name: "export_stems",
      category: "export",
      description:
        "Render every audio and MIDI track to its own 24-bit WAV, all with the same start and length (the song's length plus `tailSeconds`), plus the full mix, and hand each file to the app's save handler as `<name>-<track>.wav` and `<name>-mix.wav`. A stem is the track alone through its own chain and the bus it outputs to; send returns are only in the mix. Muted tracks give silent stems, and the result lists a warning for each silent stem. Playback is not interrupted.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Base name of the files, for example song." },
          range: {
            oneOf: [
              BEAT_RANGE_SCHEMA,
              {
                type: "object",
                properties: { startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } },
                required: ["startSeconds", "endSeconds"],
              },
            ],
            description: "What to render. Default: from the start to the end of the last clip.",
          },
          tailSeconds: { type: "number", minimum: 0, description: "Seconds after the end for reverbs and delays. Default 2." },
          includeMix: { type: "boolean", description: "Also save the full mix. Default true." },
          expectedVersion: { type: "string" },
        },
        required: ["name"],
      },
      call: guard(async (args) => {
        const name = stringArg(args, "name", true);
        if (typeof name !== "string") return name!;
        if (!options.save) return fail("This app did not provide a save handler, so export_stems is unavailable.");
        if (args.expectedVersion !== undefined && typeof args.expectedVersion !== "string") return fail(`"expectedVersion" must be a string.`);
        if (args.tailSeconds !== undefined && (typeof args.tailSeconds !== "number" || !Number.isFinite(args.tailSeconds) || args.tailSeconds < 0))
          return fail(`"tailSeconds" must be seconds >= 0.`);
        if (args.includeMix !== undefined && typeof args.includeMix !== "boolean") return fail(`"includeMix" must be true or false.`);
        let range: { startBeat: number; endBeat: number } | { startSeconds: number; endSeconds: number } | undefined;
        if (args.range !== undefined) {
          const parsed = timeRange(args.range);
          if ("content" in parsed) return parsed;
          range = parsed;
        }
        const result = await renderStems(workspace, {
          ...(range ? { range } : {}),
          ...(args.tailSeconds === undefined ? {} : { tailSeconds: args.tailSeconds as number }),
          ...(args.includeMix === undefined ? {} : { includeMix: args.includeMix as boolean }),
          ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion as ProjectVersion }),
        });
        if (result.status === "conflict")
          return json(
            { status: "conflict", currentVersion: result.version, reason: result.reason, next: "Call read_project and export again." },
            true,
          );
        const safe = (text: string) => text.replace(/[^\p{L}\p{N}._-]+/gu, "_");
        const files: { name: string; bytes: number }[] = [];
        const used = new Set<string>();
        const put = async (file: string, audio: PCMData) => {
          let unique = file;
          for (let n = 2; used.has(unique); n++) unique = file.replace(/\.wav$/, `-${n}.wav`);
          used.add(unique);
          const bytes = encodeWavBytes(audio, { bitDepth: 24 });
          await options.save!(bytes, unique);
          files.push({ name: unique, bytes: bytes.length });
        };
        for (const stem of result.stems) await put(`${name}-${safe(stem.name)}.wav`, stem.audio);
        if (result.mix) await put(`${name}-mix.wav`, result.mix);
        return json({
          status: "saved",
          version: result.version,
          sampleRate: result.sampleRate,
          durationSeconds: round(result.durationSeconds),
          files,
          ...(result.warnings.length ? { warnings: result.warnings, next: "Tell the person about each warning: those files are silent." } : {}),
        });
      }),
    },
  ];
  return Object.freeze(restrictTools(tools, allowed));
}

/** What `connectMcpBridge` accepts of a WebSocket: the browser's `WebSocket` or a compatible class. */
export type McpBridgeSocket = {
  /** Connection-open callback installed by the bridge; null when unset. */
  onopen: ((event: unknown) => void) | null;
  /** Incoming-frame callback installed by the bridge; null when unset. */
  onmessage:
    | ((event: {
        /** Incoming WebSocket payload; only string frames are handled. */
        data: unknown;
      }) => void)
    | null;
  /** Connection-close callback installed by the bridge; null when unset. */
  onclose:
    | ((event: {
        /** WebSocket close code; 4000 means another page replaced this one, and omission is an ordinary close. */
        code?: number;
        /** Optional peer-provided text explaining why the connection closed. */
        reason?: string;
      }) => void)
    | null;
  /** Socket-error callback installed by the bridge; null when unset. */
  onerror: ((event: unknown) => void) | null;
  /** Sends one JSON text frame to the agent server; may throw if the socket is closed. */
  send(data: string): void;
  /** Closes this socket; the bridge decides whether to reconnect. */
  close(): void;
};

export type McpBridgeOptions = Readonly<{
  /** Default: the global `WebSocket`. */
  WebSocket?: new (url: string, protocols?: string[]) => McpBridgeSocket;
  /** First reconnect delay in ms. Default 500; it doubles after each failure. */
  reconnectMs?: number;
  /** Longest reconnect delay in ms. Default 10000. */
  maxReconnectMs?: number;
  /** Called with `true` when the server connects and `false` when it goes away. */
  onStatus?: (connected: boolean) => void;
  /**
   * Called when the server closed this page because a newer page connected (close code 4000). The bridge then stays closed and does not
   * reconnect, so two open pages do not take turns replacing each other; call `connect()` on the handle to take the connection back.
   */
  onReplaced?: () => void;
  /**
   * The pairing token, only for a server that requires one (`--token`, `AUDIORECTIVE_MCP_TOKEN` or the `token` option; a default server
   * needs none). It travels as a WebSocket subprotocol, not in the URL. Without the right token such a server refuses the page with
   * HTTP 403 and the page only sees a failed connection (`onStatus(false)`, retried with backoff). Throws when it is not 22 or more
   * letters, digits, `_` or `-`.
   */
  token?: string;
}>;

/**
 * Serve `tools` to an agent server over a WebSocket, and keep the connection alive (it reconnects with backoff).
 * Frames are JSON. The server sends `{ id, method: "list" }` and `{ id, method: "call", name, args }`; the page answers
 * `{ id, result }` (`list`: `[{ name, description, inputSchema }]`; `call`: an `McpToolResult`) or `{ id, error: string }`.
 */
export function connectMcpBridge(tools: readonly McpTool[], url: string, options: McpBridgeOptions = {}): { close(): void; connect(): void } {
  const Socket = options.WebSocket ?? (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => McpBridgeSocket }).WebSocket;
  const protocols = options.token === undefined ? undefined : bridgeProtocols(options.token);
  if (!Socket) return { close() {}, connect() {} };
  const first = options.reconnectMs ?? 500;
  const max = options.maxReconnectMs ?? 10_000;
  let delay = first;
  let socket: McpBridgeSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let replaced = false;

  const answer = async (current: McpBridgeSocket, text: string) => {
    let id: unknown;
    try {
      const message: unknown = JSON.parse(text);
      if (!isRecord(message)) return;
      id = message.id;
      if (message.method === "list")
        current.send(JSON.stringify({ id, result: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
      else if (message.method === "call") {
        const tool = tools.find((candidate) => candidate.name === message.name);
        if (!tool)
          current.send(
            JSON.stringify({
              id,
              error: `No tool named "${String(message.name)}". This page serves: ${tools.map(({ name }) => name).join(", ") || "none"}.`,
            }),
          );
        else current.send(JSON.stringify({ id, result: await tool.call(message.args) }));
      } else current.send(JSON.stringify({ id, error: `Unknown method "${String(message.method)}".` }));
    } catch (error) {
      try {
        current.send(JSON.stringify({ id, error: error instanceof Error ? error.message : String(error) }));
      } catch {
        // The socket closed while answering; the server's pending call times out.
      }
    }
  };

  const retry = () => {
    if (closed || replaced) return;
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, max);
  };

  const connect = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    replaced = false;
    let current: McpBridgeSocket;
    try {
      current = protocols ? new Socket(url, protocols) : new Socket(url);
    } catch {
      // A bad URL throws here instead of failing later; report it and keep trying, like any other failed connection.
      options.onStatus?.(false);
      retry();
      return;
    }
    socket = current;
    current.onopen = () => {
      delay = first;
      options.onStatus?.(true);
    };
    current.onmessage = (event) => void answer(current, String(event.data));
    current.onerror = () => {};
    current.onclose = (event) => {
      if (socket === current) socket = undefined;
      options.onStatus?.(false);
      if (closed) return;
      if (event?.code === REPLACED_CODE) {
        replaced = true;
        options.onReplaced?.();
        return;
      }
      retry();
    };
  };
  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
    /** Opens a connection again after the server replaced this page; does nothing while one is open or after `close()`. */
    connect() {
      if (!socket && replaced) connect();
    },
  };
}
