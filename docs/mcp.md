---
title: MCP
---

`@audiorective/daw/mcp` gives an AI agent the same project a person has open: it reads what the person selected, queries the song, applies one compound edit the person can undo in one step, listens to the result and saves. The agent never rewrites the `.dawproject` file; it reads a compact text summary and sends JSON operations.

```
 agent (Claude Code, Codex)
   │  MCP over stdio
   ▼
 server side   @audiorective/mcp          Node process the agent starts; relays tools/list and tools/call
   │  WebSocket (127.0.0.1:7777)
   ▼
 page side     @audiorective/daw/mcp      mcpTools(workspace) + connectMcpBridge(...); runs in the browser with the Workspace
```

All logic is in `mcpTools`. The MCP server only relays `tools/list` and `tools/call`, so any other transport (a test, an in-page chat box) calls the same tools.

## Wire it up

```ts
import { mcpTools, connectMcpBridge } from "@audiorective/daw/mcp";

const tools = mcpTools(workspace, {
  save: (bytes, name) => download(new Blob([bytes]), name), // the page decides where a saved file goes
});
const bridge = connectMcpBridge(tools, "ws://127.0.0.1:7777"); // reconnects with backoff
// bridge.close() when the page unmounts
```

Run the server and register it with the agent (see `packages/mcp/README.md`):

```sh
claude mcp add audiorective -- npx -y @audiorective/mcp --port 7777
# Codex, in ~/.codex/config.toml:
# [mcp_servers.audiorective]
# command = "npx"
# args = ["-y", "@audiorective/mcp", "--port", "7777"]
```

`mcpTools(workspace, options?)` returns `readonly McpTool[]`. Each tool is `{ name, description, inputSchema, call(args) }` and `call` never rejects: bad input, a conflict or a failure comes back as `{ content, isError: true }` so the agent can read it. `McpToolResult` is `{ content: string, isError?: boolean, data?: unknown }`; `content` is what the agent reads and `data` is the same facts as a value.

## Tools

| Tool            | Input                                                                                                          | Returns                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_project`  | none                                                                                                           | TOON text: title, tempo, meter, markers, tracks, clips (beats and seconds, plus the window and loop that plays: below), Session scenes and slot clips, the person's **selection**, `version`, playback, undo labels, the app's `extensions` (each `{ id, summary }`), named operations (with `readOnly`)                     |
| `find`          | `{ type: "clips", name?, trackId?, trackName?, range?, relation? }` or `{ type: "marker", name, occurrence? }` | TOON: `count` and matching clips, or one marker. Ranges are half-open beats; `occurrence` counts from 1                                                                                                                                                                                                                      |
| `read_notes`    | `{ clipId, range? }`                                                                                           | TOON: the clip's `window` (`sourceOffset`, `durationBeats`, `loopStart`, `loopEnd`), `count`, `hiddenCount` and one row per note `id,pitch,start,duration,velocity,hidden`. `start` and `duration` are content beats; `hidden` marks notes the window or loop does not play. `range` (content beats) keeps overlapping notes |
| `apply_edits`   | `{ expectedVersion, label, ops }`                                                                              | JSON receipt: `status` `applied`, `noop` (nothing changed), `conflict` or `rejected`, versions, `undoLabel`, `created`/`changed`/`removed` ids, `createdNotes`, `copies`, and `playback`                                                                                                                                     |
| `run_operation` | `{ name, args?, expectedVersion? }`                                                                            | JSON: `status` (`applied`, `noop`, or `read` for a read-only query), the operation's `result`, the `version`, `undoLabel`, `playback`                                                                                                                                                                                        |
| `listen`        | `{ range, expectedVersion?, seamBeats?, prerollSeconds?, silenceDb?, minSilenceSeconds? }`                     | JSON evidence (below). Never audio                                                                                                                                                                                                                                                                                           |
| `save_as`       | `{ name, expectedVersion? }`                                                                                   | JSON `{ status: "saved", name, bytes, version }`; an error when the app gave no `save` handler                                                                                                                                                                                                                               |

`range` for `listen` is `{ startBeat, endBeat }` or `{ startSeconds, endSeconds }`.

## Clip windows

`read_project` (timeline `clips` and `slotClips`) and `find` give every clip the part of its content that plays, as flat fields: `sourceOffset`, `sourceLength` (audio only; empty for MIDI), `loopStart` and `loopEnd` (empty without a loop). A MIDI clip's values are content beats: it plays content `[sourceOffset, sourceOffset + durationBeats)`, so `sourceOffset` 4 on a clip starting at beat 0 means its first bar is content beat 4 (a value below 0 means empty space before the content). An audio clip's values are seconds of the recording: `sourceOffset` is where in the recording the clip begins and `sourceLength` the recording's total length.

## Edit operations

`apply_edits` runs these operations in order (all are `project.applyEdits` operations):

| `type`               | Fields                                                                                      | Does                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `copyRange`          | `range: {startBeat,endBeat}`, `atBeat`, `placement: "insert"`, `as`                         | Copies the range and opens room at `atBeat` on every track; the copies are named `as`                                                 |
| `moveClip`           | `clip`, `position: {atBeat}` or `{byBeats}`                                                 | Moves a clip, in project beats                                                                                                        |
| `resizeClip`         | `clip`, `start?`, `end?` (absolute **project beats**, every clip kind)                      | Moves one or both edges and deletes nothing: a MIDI clip's start edge moves its `sourceOffset`, an audio clip's reveals its recording |
| `setClipSourceRange` | `clip`, `start`, `end` (**content beats** for MIDI, **seconds of the recording** for audio) | Chooses which part of the content plays; the clip keeps its position. Rejected for a clip with a loop or time-stretch                 |
| `setNoteVelocity`    | `clip`, `noteId`, `velocity` 0..1                                                           | Sets one note's velocity                                                                                                              |
| `addNotes`           | `clip`, `notes: [{pitch,start,duration,velocity?}]` (content beats)                         | Adds notes to a MIDI clip; the receipt's `createdNotes: [{ clipId, ids }]` lists the new IDs in the order of `notes`                  |
| `removeNotes`        | `clip`, `noteIds`                                                                           | Deletes notes by ID                                                                                                                   |
| `editNotes`          | `clip`, `notes: [{id,pitch?,start?,duration?,velocity?}]`                                   | Changes notes by ID; an omitted field stays                                                                                           |
| `renameClip`         | `clip`, `name`                                                                              | Renames a clip                                                                                                                        |
| `rippleDelete`       | `range: {startBeat,endBeat}` or `{startSeconds,endSeconds}`, `crossfade?`                   | Removes the range on every track and closes the gap                                                                                   |
| `makeClipUnique`     | `clip`                                                                                      | Gives a linked MIDI clip its own notes                                                                                                |

`clip` is `{ clipId }` or `{ fromCopy: "<as name>", trackName? }`. A field an operation does not take is rejected with the allowed list. Note `start` is in content beats, so for a clip with `sourceOffset` 4 the first played beat is note start 4: `read_notes` shows the window.

## The TOON summary

`read_project` encodes a flat view of `project.overview()` with `@toon-format/toon`: uniform lists such as `clips` become one header and one row per clip, which costs far fewer tokens than the same JSON. The `selection` block is what the person has selected (`selectionFor(project)`): `trackId`, `clipIds`, `openClipId`, `noteIds`, `range`. "This clip" or "the part I marked" means that block. The selection is not saved, not undoable and does not change `version`.

## Edits, conflicts and undo

`apply_edits` takes the operations of `project.applyEdits` (see [Edit a project as one undoable step](./daw.md#edit-a-project-as-one-undoable-step)) with the `version` the agent last read as `expectedVersion`. The undo label is `Agent: <label>`, so the person presses Undo once in the app and the whole agent edit goes.

- `applied`: the edit is in the project. The receipt waits for the running Workspace to apply it, then reports `playback: { status, inPlayback, needsSync, error }`. `inPlayback: true` means it is audible now. `needsSync: true` means a structural change (a track or device) waits for `workspace.sync()`, which the page runs when the person accepts a glitch; the agent should say so instead of claiming it plays.
- `noop`: the edit ran but left the project as it was (for example a velocity already at that value); there is no undo step and the receipt says so.
- `conflict`: the person changed the project after the agent read it. Nothing changed and the person's edit is kept. The receipt carries `currentVersion`; the agent calls `read_project`, re-plans and sends again.
- `rejected`: the request is invalid (`code`, `reason`, `opIndex`). Nothing changed.

**Tempo changes travel with a copy.** `copyRange` (and so a duplicated section) copies the tempo changes inside the range along with the clips. Copying beats 32-48 to 48 with `placement: "insert"` where the range holds a change to 90 BPM at beat 40 leaves a second change to 90 BPM at beat 56, and the copy plays at its own tempo. The agent should report it, for example "the copied chorus repeats its tempo change at beat 56", and not call the copy tempo-neutral.

**`version` only counts up.** Every commit, including the person's Undo, produces a new, higher `version`; undo never restores an older number. After an undo, the agent compares content (`read_project` again, or the receipt's `changed` ids), not version numbers, and uses the new `version` as `expectedVersion`.

`run_operation` runs one of the app's named operations (the `operations` list in `read_project`, each with its `input` JSON Schema) as one Undo step labelled by the operation itself (the receipt's `undoLabel`). Fields outside the schema, a missing required field or a wrong type return an error that quotes the schema. `status: "noop"` means the project did not change (no undo step). Pass `expectedVersion` to refuse after a human edit. Agents have no undo tool: only the person undoes.

**App data and queries.** An app's extension data is not shown unless its `defineExtension` has a `summary`: `read_project` then lists `extensions: [{ id, summary }]`, the app's own picture of its data (for a pattern DAW, which pattern sits at which bars and which clip ids). Use it to find the app's concepts instead of guessing from clip names. An operation with `readOnly: true` in `operations` is a query: `run_operation` returns `status: "read"`, the `result` and the current `version`, makes no undo step and never needs `expectedVersion`. See [Extensions](./daw.md#extensions).

## Listening

`listen` renders a range of the full mix offline (every track, device and effect; playback keeps going) with `renderMixRange` and returns numbers, not audio:

```json
{
  "status": "rendered",
  "version": "…",
  "startSeconds": 4,
  "durationSeconds": 4,
  "peakDbFS": -9.1,
  "loudnessLUFS": -22.4,
  "silentSpans": [{ "startSeconds": 6, "endSeconds": 6.5 }],
  "seams": [{ "beat": 16, "hasClick": false, "jump": 0.0021, "localJump": 0.0019 }],
  "historyTruncated": false
}
```

`peakDbFS` is `null` for digital silence and `loudnessLUFS` is `null` under 400 ms. `silentSpans` are stretches at least `minSilenceSeconds` (default 0.1) below `silenceDb` (default -60), in project seconds. `seams` check the beats in `seamBeats` for clicks, such as the joins of an edit. It renders the whole mix; there is no per-track listen. A stale `expectedVersion` returns `status: "conflict"`.

## Bridge protocol

Frames are JSON text. The server sends, the page answers with the same `id`:

| Server to page                                  | Page to server                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `{ "id": 1, "method": "list" }`                 | `{ "id": 1, "result": [{ "name", "description", "inputSchema" }] }` |
| `{ "id": 2, "method": "call", "name", "args" }` | `{ "id": 2, "result": { "content", "isError?", "data?" } }`         |
| anything it cannot serve                        | `{ "id": 2, "error": "message" }`                                   |

`connectMcpBridge(tools, url, options?)` returns `{ close(), connect() }`. It reconnects with a doubling delay (`reconnectMs` 500, `maxReconnectMs` 10000) and reports `onStatus(connected)`; a `WebSocket` constructor that throws (a bad URL) is reported as `onStatus(false)` and retried like any failed connection. `@audiorective/mcp` accepts one page at a time and listens on `127.0.0.1` only.

**Two pages: the newest wins.** When a second page connects, the server closes the first with WebSocket close code `4000` and reason `replaced by another page`. The bridge does not reconnect on that code (two pages that reconnected would take turns replacing each other forever): it calls `options.onReplaced()` and stays closed until the page calls `bridge.connect()` or reloads. Show the person a "taken over by another page" state with a button for `connect()`.

**Listing before the page connects.** `tools/list` waits up to `--wait-ms` (default 10000) for a page, then answers with an empty list. A page that is connected but fails to answer `tools/list` (it errors, leaves or times out) makes `tools/list` fail with that message instead of returning an empty list. The server declares `tools.listChanged` and sends `notifications/tools/list_changed` when a page connects or disconnects, and its `instructions` tell the agent that an empty list means no page is connected yet. `tools/call` without a page returns the `No audiorective page is connected…` error at once.

## Common errors

| Message or result                                           | Cause                                                                                  | Fix                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `status: "conflict"` from `apply_edits` or `listen`         | The project changed after `expectedVersion` was read                                   | Call `read_project`, re-plan with the new `version`, send again           |
| `This app did not provide a save handler…`                  | `mcpTools` was created without `options.save`                                          | Pass `save: (bytes, name) => …` to `mcpTools`                             |
| `No audiorective page is connected…`                        | The MCP server has no page                                                             | Open the app with `connectMcpBridge` pointing at the server's port        |
| `The page did not answer within … ms.`                      | The page is busy or hung, or a render is longer than the timeout                       | Retry with a shorter range                                                |
| `Operation "…" is read-only and cannot change the project.` | A read-only operation of the app tried to edit                                         | App bug: it must drop `readOnly` or stop writing; report it to the person |
| `No operation named "…". Available: …`                      | `run_operation` with a name `read_project` does not list                               | Use a listed name                                                         |
| `Operation "…": args has unknown field "…"; allowed: …`     | `run_operation` args use a field the operation's `input` does not list                 | Send only the listed fields (the error includes the schema)               |
| `… has unknown field "…"; allowed: …`                       | An `apply_edits` operation, `clip`, `range` or note has a field its type does not take | Use the listed fields                                                     |
