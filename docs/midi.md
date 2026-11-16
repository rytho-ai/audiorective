---
title: MIDI and Piano Roll
---

Use `@audiorective/blocks/midi` for pure MIDI note data and `@audiorective/widgets/piano-roll` for visual presentation. Both entries can be imported without DOM or Web Audio globals. `MidiRecorder` is exported from the blocks root; recording requires a caller-provided `MIDIInput` and running `AudioContext`. Mounting a piano roll requires DOM, but never creates a player, synth, AudioContext or device connection.

## Record a MIDI take

`MidiRecorder` borrows one Web MIDI input and the app's audio clock. The app obtains permission, chooses the device, resumes the context and owns live synth playback. The recorder adds its own `midimessage` listener, leaving other listeners intact.

```typescript
import { MidiRecorder } from "@audiorective/blocks";
import { MidiSequence } from "@audiorective/blocks/midi";

const access = await navigator.requestMIDIAccess();
const input = access.inputs.values().next().value;
if (!input) throw new Error("Connect a MIDI input first.");
await input.open(); // app owns device availability and any access error
await context.resume();
const recorder = new MidiRecorder(context, input);
recorder.start({ when: context.currentTime + 0.1 });
// Later, from the stop control:
const take = recorder.stop();
const sequence = new MidiSequence({ notes: take.notes, duration: take.duration });
// A future clip owner receives take.startTime/endTime and places the sequence.
recorder.destroy();
```

`start({ when? })` accepts absolute AudioContext seconds; omitted means the current audible output position. It filters messages whose mapped time precedes the start. `stop()` ends at the current output position and returns immediately; call it when the desired end arrives. Stopping before a future start throws and leaves that take active. `cancel()` discards an active take. A recorder can make repeated takes, while `destroy()` only removes its own listener. `cells.state` is a read-only reactive `"idle" | "recording" | "destroyed"` value; `recording` means a take is active even if its future start has not arrived.

The returned `RecordedMidi` has absolute `startTime`/`endTime`, `duration`, an immutable `notes` array in **take-relative seconds**, and `events` in delivery order. Each event has an absolute `audioTime` and a copied `Uint8Array` of the MIDI bytes. Matched note-on/off events also carry the projected note's `noteId`; this links later edits to their original event order. The byte arrays themselves remain mutable. Notes use track 0 and retain channel, pitch and attack velocity. Same-channel, same-pitch overlapping note-ons pair with note-offs FIFO; a velocity-zero note-on is an off. Unreleased notes end at the take's end. Unmatched note-offs have no projected note. Controller, program-change and other messages remain in `events`, but sustain pedal does not extend the projected notes. A caller may use `MidiSequence.setData({ notes: take.notes, duration: take.duration })` to show one take; merging takes and clip placement belong to a higher owner.

### Play the edited take

`compileMidiPlaybackEvents(take, sequence.getState())` from `@audiorective/blocks/midi` returns an ordered list of MIDI messages in **take-relative seconds**. It regenerates note-on/off from the current `MidiSequence` notes and retains the recorded non-note messages, including sustain, program changes and pitch bend. This avoids playing stale raw notes after a pitch or timing edit. The function is pure: the app still chooses a synth or MIDI output, maps take-relative seconds to its clip/transport time, schedules messages and cancels obsolete voices after edits or transport changes.

```typescript
import { compileMidiPlaybackEvents, MidiSequence } from "@audiorective/blocks/midi";

const sequence = new MidiSequence(take);
sequence.updateNote(take.notes[0].id, { pitch: 62 });
const events = compileMidiPlaybackEvents(take, sequence.getState());
// The clip owner places each event.time on its timeline and sends event.data.
// event.noteId lets a voice-aware synth distinguish overlapping same-pitch notes.
```

At equal times, surviving recorded note endpoints and control messages retain their original delivery order, even when an edit moves an endpoint to that time. New note endpoints follow all recorded events at that time, in current note-array order. Zero-length and velocity-zero notes emit no note messages. An unmatched raw note-off is not replayed. Recompile after a note edit; do not replay `take.events` alongside the compiled result. The original event array is needed to preserve the ordering of note release versus pedal messages; `MidiSequence` alone does not contain that information. Events after an edited sequence's duration remain in the result, so a clip owner decides whether to trim them.

Recorded note-ons without `noteId` are rejected because their original order cannot be reconstructed reliably; re-record with a version that tags note messages. A source with no recorded events can still compile a note-only sequence.

Web MIDI `Event.timeStamp` uses the performance clock; `MidiRecorder` maps it to the AudioContext's **output timeline** with `getOutputTimestamp()`. Before the first audio block produces that correlation, it falls back to a sampled `performance.now()`/`currentTime` pair. This mapping is an estimate, not sample-accurate MIDI input timing or a device latency correction. The app should calibrate any desired performance/monitor offset when placing the take. See the [Web MIDI event timestamp](https://www.w3.org/TR/webmidi/#midimessageevent-interface) and [Web Audio output timestamp](https://www.w3.org/TR/webaudio/#dom-audiocontext-getoutputtimestamp) definitions.

## Load once, show two views

```typescript
import { MidiSequence, midiGrid } from "@audiorective/blocks/midi";
import { mountPianoRoll } from "@audiorective/widgets/piano-roll";

const sequence = new MidiSequence();
const parsed = sequence.load(await file.arrayBuffer());
const grid = midiGrid(parsed);
const a = mountPianoRoll(left, { model: sequence, grid, snap: "beat" });
const b = mountPianoRoll(right, { model: sequence, grid, snap: "beat" });
if (parsed.duration > 0) sequence.setSelection({ start: 0, end: Math.min(2, parsed.duration) });
const note = sequence.getState().notes[0];
if (note) sequence.updateNote(note.id, { pitch: 69, velocity: 100 });
a.destroy(); // The data and the other view remain available.
b.destroy();
sequence.destroy();
```

`load` is synchronous parsing of supplied bytes; URL fetches and File reads belong to the caller. Guard stale asynchronous reads before calling `load`. A parse failure leaves the previous data snapshot unchanged. The APIs are Unreleased; use a workspace build or matching packed artifacts.

## Data and time

`parseMidi(ArrayBuffer | Uint8Array): ParsedMidi` reads Standard MIDI Files in format 0 or 1 with PPQ division. It projects note events through the file tempo map into **source seconds**, retaining track/channel identity. It does not request Web MIDI permission or synthesize controller, sustain-pedal, pitch-bend or program-change behavior. Format 2 and SMPTE division are rejected. `MidiRecorder` captures live messages separately; it is not an SMF writer.

```typescript
type MidiNote = Readonly<{
  id: string;
  start: number;
  end: number; // source seconds
  pitch: number;
  velocity: number; // MIDI integers 0..127
  channel: number; // 0..15
  track: number; // non-negative track index
}>;
type MidiRange = Readonly<{ start: number; end: number }>;
type MidiData = Readonly<{ notes: readonly MidiNote[]; duration: number }>;
```

`ParsedMidi` additionally contains `ppq`, `tempos: readonly {tick, usPerQuarter}[]`, `signatures: readonly {tick, numerator, denominator}[]`, and `endTick`. Records and arrays are frozen. Notes are sorted by start, then pitch; equal keys retain pairing order. IDs are stable within the loaded sequence and across edits, not persistent global IDs across different files.

Velocity-zero note-on is treated as note-off. Overlapping notes of the same track/channel/pitch pair FIFO; an unmatched off is ignored and an unclosed on ends at the global file end. Duration includes silent tails. Unknown metadata/SysEx and other channel events are skipped with bounds checks. This is a note projection, not lossless SMF storage or export; controllers are not retained. Time signatures with denominator greater than 128 are outside this parser's supported subset.

`tickToSeconds(tempos, ppq, tick)` converts through the sorted tempo map. `midiGrid(parsed)` returns frozen `beats` and `downbeats` arrays in source seconds. Beats follow the time-signature denominator; signature changes start a new bar and tempo changes affect spacing. Empty files have a grid point at zero. Grid generation rejects requests exceeding 100,000 points; parsing/querying data does not require generating a grid. A fixed BPM conversion must not replace the file tempo map. Editing notes in seconds does not modify or rebuild the original tempo map.

`visibleMidiNotes(notes, range, pitches?)` returns notes intersecting an inclusive display interval, including sustained notes that start before it. Inputs must be sorted by start and immutable; cached prefix ends support the interval query. Optional `pitches` is `{low, high}`, inclusive. For audio scheduling use a half-open playback range and clip each note's sounding interval to it; a touching display boundary does not imply positive sounding duration.

## MidiSequence

`MidiSequence` owns note data and selection without requiring AudioProcessor inheritance, DOM or AudioContext. It exposes coherent immutable snapshots; it is not a transport or a duplicate store for a synth.

| Member                                           | Contract                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `new MidiSequence(data?)`                        | Optional `MidiData`; validates, copies and sorts notes.                                                                                         |
| `load(bytes): ParsedMidi`                        | Parses and commits data, clears selection; returns source tempo/signature metadata for grid creation.                                           |
| `setData(data): void`                            | Accepts generated/transcribed notes directly; replaces data and clears selection.                                                               |
| `getState()`                                     | `{notes, duration, selection, revision}`; arrays/records are read-only and frozen.                                                              |
| `subscribe(listener): unsubscribe`               | Notifications after complete commits, not an initial call. Render once before subscribing. A failing listener is logged without blocking peers. |
| `getSelection()` / `setSelection(range \| null)` | One shared time range; requires finite `0 <= start < end <= duration`. No audio is started or changed.                                          |
| `updateNote(id, patch)`                          | Validates before committing once; keeps ID and selection, extends duration if necessary. Invalid edits leave the previous snapshot intact.      |
| `query(range, pitches?)`                         | Same interval query against the owned sorted notes.                                                                                             |
| `destroy()`                                      | Clears model listeners; idempotent. Mutations/subscriptions after destroy throw. Views and caller audio have separate lifetimes.                |

### Observing state reactively

`sequence.cells` holds `ReadonlyCell<T>` values: `state` (the whole frozen snapshot, the same object `getState()` returns), and the slices `notes`, `duration`, `selection` and `revision`. The snapshot is the only store; `getState()` and `subscribe()` are thin wrappers over it, and `getState()`, `getSelection()` and `query()` are tracked reads. Read `.value` (or call `$()`) inside an `effect`, a `computed`, or `useValue`, and the reader re-runs when that value changes. Each slice tracks only itself: an effect reading `notes` does not re-run for a selection change. Every commit replaces the snapshot in one write, so an effect never observes new notes with an old selection or revision.

```typescript
import { effect } from "@audiorective/core";

effect(() => console.log(sequence.cells.notes.value.length, sequence.cells.selection.value));
sequence.setSelection({ start: 1, end: 2 }); // logs once
```

Assigning `.value` is a type error and writing through `$` throws a `TypeError`; change state with `load`, `setData`, `setSelection` and `updateNote`. `import "@audiorective/blocks/midi"` stays free of DOM and AudioContext; it needs only `@audiorective/core` and `alien-signals`, both plain JavaScript.

Note fields require unique nonempty IDs, finite `0 <= start <= end <= duration`, integer pitch/velocity 0..127, channel 0..15 and a non-negative integer track. Zero-duration notes may be shown as a minimum-width mark. A duration extension does not invent new tempo/grid metadata; the caller decides which grid to supply.

## Piano-roll view

`mountPianoRoll(root, options): PianoRollHandle` borrows a structural `model` implementing `getState`, `getSelection`, `setSelection`, and `subscribe`. `MidiSequence` satisfies it; other application-owned models can too. It reads state directly rather than copying notes/selection into a UI store. `onNoteEdit` can call your application's existing edit command; models do not need to inherit `MidiSequence` or expose an `updateNote` method.

Options include `label`, inclusive integer `pitches: {low, high}`, `grid: {beats, downbeats}`, `snap: "off" | "beat" | "downbeat"`, `renderer`, `layout`, `onNoteEdit(edit)`, `onNoteClick(note)` and `onCommit(event)`. Each view retains independent zoom/pitch presentation. Grid values use the same source seconds as notes.

Drag on the background to select a time range. Selection handles support arrow keys (0.01 seconds) and Shift (0.1 seconds); Alt bypasses pointer snap. Clicking or keyboard-activating a note calls `onNoteClick` for a caller-owned inspector. Omitting `onNoteEdit` keeps notes read-only for inspection. Providing it enables widget-owned note move and edge-resize gestures; apply the committed edit to your model. At compressed pitch scales, key labels show octave Cs to avoid overlapping text.

| Handle                            | Contract                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `setPlayhead(seconds \| null)`    | Shows an externally supplied clock position; no clock is created.                              |
| `setZoom(factor)`                 | Finite factor 1..64; 1 fits the source, changes retain the viewport center.                    |
| `scrollTo(seconds)`               | Moves the horizontal viewport using finite source seconds.                                     |
| `setPitchRange({low, high})`      | Integer `0 <= low <= high <= 127`, inclusive.                                                  |
| `attach(plugin)`                  | Attaches a `WaveformPlugin`; returns an independently destroyable `PluginAttachment`.          |
| `getViewport()`                   | `{duration, pixelsPerSecond, scrollLeft, width, height}` in content/viewport pixels.           |
| `setSnap(mode)` / `setGrid(grid)` | Changes this view's snapping/grid; selection remains in the borrowed model.                    |
| `destroy()`                       | Detaches observers, listeners, selection and renderer; preserves model, other views and audio. |

## Replace note drawing

A `PianoRollRenderer` is `(root) => { render(frame), destroy?() }`. Allocate SVG/Canvas/DOM once, then update it from frames. The supplied root spans the full scrolling content.

A frame contains viewport/pitch-filtered `notes` (including spanning notes), content `width`/`height`, `duration`, `pitches`, `viewport`, `timeToX(seconds)`, `pitchToY(pitch)`, `editable`, `onNotePointerDown(note, event, kind?)` and `onNoteClick(note)`. `pitchToY` returns the row's top; row height is `height / (high - low + 1)`. Use these coordinates rather than a separate time-to-pixel mapping. Drawings live under the selection handles and external playhead. Forward note pointer presses to `frame.onNotePointerDown(note, event)` to keep inspection and editing separate from background range dragging. The widget infers move/start-edge/end-edge from source-time geometry; a renderer can explicitly pass `"move"`, `"resize-start"` or `"resize-end"`. Keep click/keyboard inspection connected to `frame.onNoteClick`.

Theme with the shared `--waveform-*` appearance variables, `--piano-roll-height` and `--piano-roll-note-text`. The [showroom](/showroom/piano-roll) demonstrates default note buttons and a custom SVG renderer sharing one sequence. Use `renderer` for note drawing and `attach(plugin)` for time-based overlays and interactions.

## Replace keyboard, toolbar and layout

`layout` has the same mount/render/destroy lifecycle as `renderer`. The factory receives `(root, viewport, controls)`. Mount the **supplied viewport** inside root; the widget retains its content, scrolling, selection, plugins and note gestures. The layout owns the surrounding DOM, keyboard drawing and controls. Use your own classes and elements instead of internal widget selectors.

```typescript
import { mountPianoRoll, type PianoRollLayout } from "@audiorective/widgets/piano-roll";

const compact: PianoRollLayout = (root, viewport, controls) => {
  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.textContent = "Zoom in";
  let factor = 1;
  zoom.onclick = () => controls.setZoom(Math.min(64, factor * 2));
  root.append(viewport, zoom); // No keyboard; controls below the plot.
  return {
    render(frame) {
      factor = frame.zoom;
      zoom.disabled = factor >= 64;
    },
    destroy() {
      zoom.onclick = null;
      root.replaceChildren();
    },
  };
};
const view = mountPianoRoll(root, { model: sequence, layout: compact });
```

`controls` exposes `setZoom`, `scrollTo`, `setPitchRange`, `setSnap` and `setGrid`. Layout frames contain `duration`, `height`, inclusive `pitches`, `viewport`, `pitchToY`, `zoom` and `snap`. Initialize custom snap controls from `frame.snap` (`"off"`, `"beat"` or `"downbeat"`) and read it again in each render; `setSnap` synchronously refreshes the layout, including calls through the returned handle or layout controls. The widget owns this state, so an external snap change also updates your control without a second store. Use `pitchToY` and `height / (high-low+1)` to draw your keyboard aligned with the content. Viewport frames follow scroll/zoom/resize/pitch/data changes; render updates presentation without calling control mutations recursively. `root` excludes the widget's base style element, so a layout may replace its own children. Keep the supplied viewport identity and mount it once; cloning/removing it breaks the interaction owner. A missing viewport throws `Piano roll layout must mount its viewport inside the supplied root.`

Layouts can set public viewport styles and inherited CSS variables. Preserve finite dimensions, horizontal overflow scrolling and an accessible keyboard-focusable viewport. Interactive controls need labels, focus styles and responsive wrapping. Destroy removes layout resources even if another cleanup fails. The showroom's second view draws its numeric keyboard on the right and its wrapping toolbar below, without implementing any drag logic.

## Widget-owned note moves and resizes

```typescript
const editable = mountPianoRoll(root, {
  model: sequence,
  onNoteEdit({ note }) {
    // Pause/cancel caller-owned voices here if needed, before changing note data.
    sequence.updateNote(note.id, { start: note.start, end: note.end, pitch: note.pitch });
  },
});
```

`onNoteEdit` enables pointer editing and receives frozen `{kind, previous, note}` (`PianoRollNoteEdit`). `kind` is `"move"`, `"resize-start"` or `"resize-end"`. Moving changes time/pitch while preserving duration and metadata; resizing changes one time endpoint. The widget previews locally after a 3px movement threshold and commits **once on pointer release** through the synchronous callback. Peers observe the authoritative model after that callback updates it. Returning without writing leaves the model and final drawing unchanged; a thrown callback is logged as `Piano roll note edit failed:` and the preview is discarded. This callback is a model command, not another persistent store or an audio transport.

The default renderer uses the first/last up-to-6px (at most one quarter of note width) for edge resizing. Other presses move the note. Time edits use the same nearest-beat/downbeat rule as selection; Alt bypasses snapping, and setters update both. A vertical-only move retains its original onset rather than quantizing time. Moves stay within the current source duration and visible pitch range. Resizes stay ordered within source bounds and retain at least the smaller of 0.01s and the original duration. These gestures do not extend the source timeline.

Escape, pointer cancellation, lost capture, window blur/scroll, viewport/pitch geometry changes, source/note replacement and destruction cancel previews without committing. Capture belongs to the stable content surface, so SVG/Canvas/DOM redraws do not lose the gesture. Renderers forward pointerdown and may provide explicit resize modes; they do not implement delta conversion, snapping, cancellation or model mutation. For Canvas, hit-test the note and forward it to the same handler.

A click without a drag and keyboard activation still inspect the note. Background range dragging and its keyboard handles remain separate. This interface does not add note insertion/deletion, multi-note editing, auto-scroll, keyboard note movement or touch navigation gestures.

## Add a time-based overlay or interaction

`view.attach(plugin)` uses the same `WaveformPlugin` / `WaveformPluginContext` contract as `mountWaveform`. Both types and `PluginAttachment` are exported from the piano-roll entry. A marker plugin can be reused in either widget without a second coordinate mapping.

```typescript
import { mountPianoRoll, type WaveformPlugin } from "@audiorective/widgets/piano-roll";

function markerAt(seconds: number): WaveformPlugin {
  return {
    attach(ctx) {
      const layer = document.createElement("div");
      const marker = document.createElement("span");
      marker.textContent = "Cue";
      marker.style.cssText = "position:absolute;top:4px;border-left:2px solid currentColor";
      layer.append(marker);
      ctx.mountOverlay(layer);
      const draw = () => {
        marker.style.left = `${ctx.timeToX(seconds)}px`;
      };
      ctx.onViewportChange(draw);
      ctx.onDataChange(draw);
      draw(); // Subscriptions do not call back immediately.
    },
  };
}

const view = mountPianoRoll(root, { model: sequence });
const marker = view.attach(markerAt(1));
// marker.destroy() removes just this overlay and its subscriptions.
// view.destroy() removes every attachment, preserving the borrowed sequence/audio.
```

The context provides `surface`, live `duration`, `getViewport()`, `getViewportRect()`, `timeToX(seconds)`, `clientXToTime(clientX)`, `scrollBy(pixels)`, `mountOverlay(element)`, `onViewportChange`, `onDataChange`, `listen` and `onCleanup`. Times are source seconds; `timeToX` returns pixels in the full scrolling note surface. `clientXToTime` accounts for the actual content origin and current scroll. `getViewportRect` is the visible viewport's browser rectangle, including its border; `surface.getBoundingClientRect()` gives the scrolling content origin. Keyboard width is internal: callers do not calculate or inspect it.

Overlay layers fill the note surface and default to `pointer-events: none`. Interactive children can set `pointer-events: auto`; stop their `pointerdown` propagation when they should not start native background range selection. Use `ctx.listen` for events and `ctx.onCleanup` for caller resources such as observers or animation frames. Data notifications occur on note-array or duration replacement, before layout; viewport notifications follow layout, horizontal scroll, zoom and pitch-range changes. Selection-only changes are observed through the borrowed model's subscription.

Each attachment owns its overlays, listeners and subscriptions. `attachment.destroy()` is idempotent and leaves peer plugins, the view, model and audio alive. A failed attach rolls back registered resources. Registrations made after detachment are cleaned up immediately; `mountOverlay` then throws. A plugin can return a disposer or `{destroy()}`. Throwing cleanup is logged while other resources continue to clean up. The same plugin object cannot be attached twice to one view simultaneously; create an instance per view if the plugin holds mutable state. The built-in selection plugin remains the single selection owner; added plugins extend visualization/interaction rather than attaching a second selection owner.

This context covers the time axis. Custom note drawing uses the renderer frame's `pitchToY`; plugins do not expose a pitch-editing contract.

## Audio integration

The application chooses instruments, scheduling and routing. Read the selected interval and `sequence.query(range)`, clip notes to that interval, and schedule them on the caller's audio clock. Keep cancellation handles for active and already-scheduled voices: pause, seek, source replacement, edits and destroy must cancel obsolete sound. A view's destruction must not cancel application-owned audio.

This split supports both a silent MIDI inspector and an audible application without putting a specific synth, device permission, transport or whole DAW into the widget. The showroom's sine-note auditioner is example application code, not a public MIDI sequencer or Web MIDI output.

## Common errors

| Message                                                                                      | Cause and fix                                                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Invalid MIDI file.`                                                                         | Invalid/truncated header, track or event; zero PPQ/tempo or unsupported signature. Supply intact supported SMF bytes.  |
| `Only MIDI format 0 and 1 are supported.`                                                    | Type 2 is not supported; convert the file upstream.                                                                    |
| `SMPTE MIDI time division is not supported.`                                                 | Use a PPQ-based file.                                                                                                  |
| `MIDI ticks need positive PPQ and finite non-negative time.`                                 | Pass the parsed PPQ and a finite non-negative tick.                                                                    |
| `MIDI grid needs valid PPQ, end tick and time signatures.`                                   | Use parsed metadata or valid positive finite signatures.                                                               |
| `MIDI grid exceeds 100000 points.`                                                           | Use a bounded caller-supplied grid or omit grid generation for very long data.                                         |
| `MIDI duration must be finite and non-negative.`                                             | Repair the supplied duration.                                                                                          |
| `MIDI notes need unique ids, valid source seconds and integer pitch/velocity/channel/track.` | Normalize note records to the documented bounds.                                                                       |
| `MidiSequence is destroyed.`                                                                 | Create another owner; remove its borrowed views before final owner cleanup.                                            |
| `MidiRecorder is destroyed.`                                                                 | Construct a new recorder after final cleanup.                                                                          |
| `MidiRecorder already has an active take.` / `MidiRecorder has no active take to stop.`      | Finish or cancel the current take before starting another; start before stopping.                                      |
| `MidiRecorder needs a running AudioContext.`                                                 | Resume the caller-owned context from a user gesture before recording.                                                  |
| `MidiRecorder time must be finite, non-negative seconds.`                                    | Pass an absolute finite AudioContext start time.                                                                       |
| `MidiRecorder stop must follow its start time.`                                              | Stop after the requested start time, or cancel the armed take.                                                         |
| `MIDI playback needs finite, non-negative times and valid MIDI notes.`                       | Supply a valid take and current `MidiSequence` snapshot; do not pass corrupt times or note fields.                     |
| `MIDI playback needs note IDs on recorded note-ons.`                                         | The raw take predates note-ID capture or was assembled without IDs; capture a tagged take.                             |
| `MIDI note was not found.`                                                                   | Use an ID from the current source snapshot.                                                                            |
| `Selection must satisfy 0 <= start < end <= duration (finite seconds).`                      | Use ordered endpoints within the loaded duration.                                                                      |
| `Piano roll zoom must be between 1 and 64.`                                                  | Pass a finite zoom factor in that interval.                                                                            |
| `Piano roll pitches must satisfy 0 <= low <= high <= 127.`                                   | Pass ordered integer MIDI pitches.                                                                                     |
| `Piano roll scroll time must be finite.`                                                     | Use finite seconds.                                                                                                    |
| `Playhead must be finite or null.`                                                           | Use finite seconds or null to hide it.                                                                                 |
| `Piano roll layout must mount its viewport inside the supplied root.`                        | Layout omitted/cloned the supplied viewport. Append the supplied viewport inside the layout root; retain its identity. |
| `Piano roll is destroyed.`                                                                   | Attaching after view cleanup. Mount another view; keep the borrowed model if still needed.                             |
| `Plugin is already attached to this piano roll.`                                             | Same object attached twice to one view. Destroy its attachment first, or create another plugin instance.               |
