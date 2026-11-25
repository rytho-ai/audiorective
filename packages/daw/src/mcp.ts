import { encode } from "@toon-format/toon";
import { untracked } from "@audiorective/core";
import { saveWorkspace } from "./compose";
import type { ProjectEditRequest, ProjectVersion } from "./project-edits";
import { renderMixRange } from "./mix-range";
import type { Workspace } from "./runtime";
import { selectionFor } from "./selection";
import { sessionFor } from "./session";
import type { Project, ProjectClip } from "./model";

/** What a tool hands back: text the agent reads, whether it failed, and the same facts as JSON for code. */
export type McpToolResult = Readonly<{
  /** The text the agent reads: TOON for summaries and queries, JSON for receipts and measurements. */
  content: string;
  /** `true` when the call did nothing useful: bad input, a conflict, a rejection or a failure. `content` says why. */
  isError?: boolean;
  /** The same facts as `content`, as a plain value. */
  data?: unknown;
}>;

/** One thing an agent can do to the open project. Transport-neutral: an MCP server, a WebSocket bridge or a test calls it the same way. */
export type McpTool = Readonly<{
  name: string;
  description: string;
  /** JSON Schema (type `"object"`) of the arguments. */
  inputSchema: Readonly<Record<string, unknown>>;
  /** Never rejects: bad arguments and failures come back as `{ isError: true }` results the agent can read. */
  call(args: unknown): Promise<McpToolResult>;
}>;

export type McpToolsOptions = Readonly<{
  /** Where `save_as` puts the file; the page decides (a download, a file handle, a server). Without it `save_as` returns an error. */
  save?: (bytes: Uint8Array, name: string) => void | Promise<void>;
  /** Text added to the `Agent: ` prefix of an undo label. Default none. */
  labelPrefix?: string;
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

const OP_TYPES = [
  "copyRange",
  "moveClip",
  "resizeClip",
  "setClipSourceRange",
  "setNoteVelocity",
  "renameClip",
  "rippleDelete",
  "makeClipUnique",
] as const;

/** The part of a clip's content that plays, as flat fields: beats for a MIDI clip, seconds of the recording for an audio clip. */
function windowFields(clip: ProjectClip | null | undefined) {
  if (!clip) return { sourceOffset: "", sourceLength: "", loopStart: "", loopEnd: "" };
  if (clip.kind === "midi")
    return {
      sourceOffset: round(clip.sourceOffset),
      sourceLength: "",
      loopStart: clip.loop ? round(clip.loop.startBeat) : "",
      loopEnd: clip.loop ? round(clip.loop.endBeat) : "",
    };
  return {
    sourceOffset: round(clip.sourceOffset),
    sourceLength: round(clip.sourceLength),
    loopStart: clip.loop ? round(clip.loop.startSeconds) : "",
    loopEnd: clip.loop ? round(clip.loop.endSeconds) : "",
  };
}

function timelineClip(project: Project, id: string): ProjectClip | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((candidate) => candidate.id === id);
    if (clip) return clip;
  }
  return undefined;
}

/** A compact, readable view of the project for `read_project`. */
function projectView(workspace: Workspace) {
  return untracked(() => {
    const project = workspace.project;
    const overview = project.overview();
    const selection = selectionFor(project).state.value;
    const tracks = overview.tracks.map(({ id, name, kind, clips }) => ({ id, name, kind, clips: clips.length }));
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
    return {
      title: overview.title,
      version: overview.version,
      bpm: overview.bpm,
      signature: `${overview.signature[0]}/${overview.signature[1]}`,
      tempoChanges: overview.tempoChanges.map(({ beat, bpm }) => ({ beat, bpm })),
      markers: overview.markers.map(({ name, time }) => ({ name, seconds: round(time), beat: round(project.tempoMap.secondsToBeat(time)) })),
      tracks,
      clips,
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
      operations: project.operations.list().map(({ name, description }) => ({ name, description })),
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
      description:
        "Read the open project as TOON text: title, tempo and meter, markers, tracks, every clip with its beats and seconds, Session scenes, what the person has SELECTED (selection.clipIds, openClipId, range), the current `version`, playback state, undo labels and the app's named operations. Clips carry sourceOffset, sourceLength (audio) and loopStart/loopEnd: the window of the content that plays, in beats for MIDI clips and seconds of the recording for audio clips. Call it first and again after any conflict. Positions are in beats (quarter notes from the start) unless named seconds.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: guard(async () => toon(projectView(workspace))),
    },
    {
      name: "find",
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
      name: "apply_edits",
      description: `Apply a list of edit operations as ONE undoable step (the person presses Undo once to remove all of it). Pass the \`version\` you last read as expectedVersion. If the person changed the project since, you get status "conflict" and nothing changes: call read_project, re-plan and send again. Operations run in order: ${OP_TYPES.join(", ")}. Units: beats are project beats; resizeClip start/end are absolute project beats for every clip; setClipSourceRange start/end are content beats for a MIDI clip and seconds of the recording for an audio clip. Shapes: { type: "copyRange", range: {startBeat,endBeat}, atBeat, placement: "insert", as: "name" } (insert opens room at atBeat on every track); { type: "moveClip", clip: {clipId} | {fromCopy: "name", trackName?}, position: {atBeat} | {byBeats} }; { type: "resizeClip", clip, start?, end? } (move one or both edges without deleting content; a MIDI clip's start edge moves its sourceOffset, an audio clip's reveals its recording); { type: "setClipSourceRange", clip, start, end } (which part of the content plays, the clip keeps its position); { type: "renameClip", clip, name }; { type: "setNoteVelocity", clip, noteId, velocity: 0..1 }; { type: "rippleDelete", range: {startBeat,endBeat} | {startSeconds,endSeconds}, crossfade? }; { type: "makeClipUnique", clip }. The receipt says whether playback already has the edit.`,
      inputSchema: {
        type: "object",
        properties: {
          expectedVersion: { type: "string", description: "The `version` from read_project or the last receipt." },
          label: { type: "string", description: 'What the edit does, shown in undo history as "Agent: <label>".' },
          ops: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                type: { enum: [...OP_TYPES] },
                clip: {
                  type: "object",
                  description:
                    "{ clipId } or { fromCopy, trackName? } (resizeClip, setClipSourceRange, moveClip, renameClip, setNoteVelocity, makeClipUnique).",
                },
                start: {
                  type: "number",
                  description:
                    "resizeClip: absolute project beat of the start edge. setClipSourceRange: content beat (MIDI) or recording second (audio).",
                },
                end: {
                  type: "number",
                  description:
                    "resizeClip: absolute project beat of the end edge. setClipSourceRange: content beat (MIDI) or recording second (audio).",
                },
              },
              required: ["type"],
            },
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
              next: "Nothing was changed and the person's edit is kept. Call read_project, check the new state, and send the edit again with the new version.",
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
        const playback = await playbackState(workspace, receipt.version);
        return json({
          status: "applied",
          version: receipt.version,
          undoLabel: `${prefix}${label}`,
          created: receipt.created,
          changed: receipt.changed,
          removed: receipt.removed,
          copies: receipt.copies,
          playback,
        });
      }),
    },
    {
      name: "run_operation",
      description:
        "Call one of the app's named operations (listed under `operations` in read_project) with JSON arguments. It runs as one undoable step labelled by the operation. Pass `expectedVersion` to refuse when the person has changed the project since you read it.",
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
        if (args.expectedVersion !== undefined && args.expectedVersion !== current)
          return json(
            {
              status: "conflict",
              currentVersion: current,
              reason: "The project changed since this version was read.",
              next: "Nothing ran. Call read_project and try again with the new version.",
            },
            true,
          );
        const known = untracked(() => project.operations.list().map((operation) => operation.name));
        if (!known.includes(name)) return fail(`No operation named "${name}". Available: ${known.length ? known.join(", ") : "none"}.`);
        const result = project.operations.call(name, args.args ?? {});
        const version = untracked(() => project.cells.version.value);
        return json({ status: "applied", result: result ?? null, version, playback: await playbackState(workspace, version) });
      }),
    },
    {
      name: "listen",
      description:
        "Render a range of the full mix offline (every track, device and effect; playback is not interrupted) and return evidence as JSON: peakDbFS, loudnessLUFS (null when silent or under 400 ms), silentSpans in project seconds, and a click check per `seamBeats` entry (`hasClick`). Never returns audio. `range` is { startBeat, endBeat } or { startSeconds, endSeconds }. Renders the whole mix; there is no per-track listen. Renders the current version unless `expectedVersion` is given.",
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
        for (const key of ["prerollSeconds", "silenceDb", "minSilenceSeconds"])
          if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]))) return fail(`"${key}" must be a number.`);
        const result = await renderMixRange(workspace, {
          expectedVersion,
          range,
          seamBeats,
          prerollSeconds: args.prerollSeconds as number | undefined,
        });
        if (result.status === "conflict")
          return json(
            { status: "conflict", currentVersion: result.version, reason: result.reason, next: "Call read_project and listen again." },
            true,
          );
        return json({
          status: "rendered",
          version: result.version,
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
        });
      }),
    },
    {
      name: "save_as",
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
  ];
  return Object.freeze(tools);
}

/** What `connectMcpBridge` accepts of a WebSocket: the browser's `WebSocket` or a compatible class. */
export type McpBridgeSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

export type McpBridgeOptions = Readonly<{
  /** Default: the global `WebSocket`. */
  WebSocket?: new (url: string) => McpBridgeSocket;
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
}>;

/**
 * Serve `tools` to an agent server over a WebSocket, and keep the connection alive (it reconnects with backoff).
 * Frames are JSON. The server sends `{ id, method: "list" }` and `{ id, method: "call", name, args }`; the page answers
 * `{ id, result }` (`list`: `[{ name, description, inputSchema }]`; `call`: an `McpToolResult`) or `{ id, error: string }`.
 */
export function connectMcpBridge(tools: readonly McpTool[], url: string, options: McpBridgeOptions = {}): { close(): void; connect(): void } {
  const Socket = options.WebSocket ?? (globalThis as { WebSocket?: new (url: string) => McpBridgeSocket }).WebSocket;
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
        if (!tool) current.send(JSON.stringify({ id, error: `No tool named "${String(message.name)}".` }));
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
      current = new Socket(url);
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
