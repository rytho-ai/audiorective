---
title: MIDI and Piano Roll
---

Use `@audiorective/midi` for MIDI notes that play in time with a clock, and `@audiorective/widgets/piano-roll` to show and edit them. The root entry (`MidiClip`, `parseMidi`, `midiGrid`, `visibleMidiNotes`, `compileMidiPlaybackEvents`) needs no DOM or Web Audio globals. `MidiRecorder` and `MidiKeyboard` come from `@audiorective/midi/web` and need Web MIDI and a running `AudioContext`. Mounting a piano roll needs the DOM, but never creates a synth, AudioContext or device connection.

## Notes, instruments and clips

A note is `{ id, pitch, velocity, start, duration, channel }`: `pitch` is a MIDI number 0-127, `velocity` is **0..1**, `start` and `duration` are in **beats** (quarter notes, so they follow the transport's tempo) and `channel` is 0-15 (default 0). A beat is counted from the clip's start, so `start: 1` is beat 2 of bar 1.

Notes play into an **instrument**, anything with two methods. A core `Sampler` and a `WebClapHost` already are one; for your own synth write a two-method adapter:

```typescript
interface Instrument {
  noteOn(note: number, options?: { velocity?: number; when?: number; channel?: number }): unknown;
  noteOff(note: number, when?: number): unknown;
}
```

`when` is absolute `AudioContext` seconds; `velocity` is 0..1. When a method returns an object with `cancel()` (a `Sampler` voice event, a `WebClapEvent`), the clip uses it to revoke a note that has not started.

`MidiClip` is the note model and the clock scheduler in one object. `clock.attach(clip)` plays it, with the clip's beat 0 at the transport's beat 0; there is no separate sequence, player or note scheduler to write.

The stop rule: when the transport stops, pauses or seeks, the clip detaches, or a `ClipLauncher` stops or replaces the clip, every note-on the clip already sent gets a note-off at `max(that time, the note's start time)` and its pending natural note-off is cancelled. A sounding note is cut at the launcher's quantized boundary, and a note that has not started never sounds (its note-on is cancelled when the instrument returns a cancellable event, as `WebClapHost` does, and then no note-off is sent; an instrument without one, such as `Sampler`, gets the note-off at the note's start time). A `clock.refresh()` never cuts a sounding note and never doubles it.

```typescript
import { Clock } from "@audiorective/clock";
import { MidiClip } from "@audiorective/midi";

const clip = new MidiClip(
  [
    { pitch: 60, velocity: 0.8, start: 0, duration: 1 },
    { pitch: 64, velocity: 0.8, start: 1, duration: 1 },
    { pitch: 67, velocity: 0.8, start: 2, duration: 2 },
  ],
  { instrument: sampler, loop: true, length: "1m" },
);
const clock = new Clock({ context });
clock.attach(clip);
clock.start();
// Edit while it plays:
clip.edit((notes) => {
  notes[0].pitch = 62;
});
// On teardown: clip.dispose();
```

Options: `transform` and `seed` (below), `instrument` (assignable later as `clip.instrument`; a change applies to notes scheduled afterwards), `loop` (repeat every `length` while attached to a clock directly; default false), `length` (where a loop wraps: beats, or a note value of the clock's meter such as `"2m"` for two bars or `"4n"` for one beat; default the end of the last note rounded up to a whole bar) and `signal` (aborting calls `dispose()`). Put the clip in a `ClipLauncher` with `{ scheduler: clip }`; there the launcher clip's `loop` and `length` decide repeats, and the clip's beat 0 is the launch.

The clip pairs every note-on with its note-off and trims a note at the loop seam. On `stop`, `pause`, `seek`, `detach` and `dispose` it sends a note-off for every note-on it already sent, at `max(now, that note's start time)`, so no note hangs. A tempo change re-times the notes not yet played. Notes are `ReadonlyCell` values, so a view re-renders on a change without a second store.

In a `ClipLauncher` the launcher clip's `loop` and `length` are the only source of repeats (`{ scheduler: clip, loop: true, length: "2m" }`); the clip's own `loop` and `length` apply only to `clock.attach(clip)`. The clip sends each note-off in the scheduling window that contains it, not together with its note-on, so a cut before that window sends only the cut and an instrument never receives a stray late note-off. A `Sampler` moves a pending release earlier when a `noteOff` names an earlier time, so a cut reaches it. A note the clock revokes before it starts gets its note-off at its own start time, which silences it.

`transform(note, random)` adjusts or drops each note just before it is scheduled, with the same shape as `StepSequencer`'s `transform`: move `beat` (tempo-locked) or `when` (milliseconds), change `velocity` or `durationBeats`, or return `null`. `note.loop` is the pass. `random(key?)` is in [0, 1) and fixed by `seed` (default 0), the note's id and `key`, so every loop pass and every re-queue draws the same numbers (mix `note.loop` into the key to vary by pass). A moved note never outlives its loop pass; `pitch` and `channel` are read-only.

```typescript
const clip = new MidiClip(notes, {
  instrument: sampler,
  seed: 7,
  transform: (note, random) => ({ ...note, when: note.when + (random() - 0.5) * 0.02, velocity: 0.7 + random("v") * 0.3 }), // +-10 ms, humanized velocity
});
```

| Member                       | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new MidiClip(notes?, opts)` | Validates, copies and sorts `NoteInit[]` (`id` and `channel` optional; ids are generated).                                                                                                                                                                                                                                                                                                                                                          |
| `clip.notes`                 | Tracked `ReadonlyCell<readonly MidiNote[]>`, sorted by start then pitch, frozen. Read it in an `effect`, a `computed` or `useValue`.                                                                                                                                                                                                                                                                                                                |
| `clip.revision`              | Tracked `ReadonlyCell<number>`; increments once per commit.                                                                                                                                                                                                                                                                                                                                                                                         |
| `clip.setNotes(notes)`       | Replaces every note in one commit.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `clip.edit(draft => ...)`    | Mutates a draft array (change fields, `push`, `splice`) and commits once; a pushed or unshifted note needs only `pitch`, `velocity`, `start` and `duration` (`id` is generated, `channel` is 0), and existing notes keep their ids: one `revision`, one notification. A looping clip plays the edit from the next loop pass (the pass playing keeps its notes); a clip that does not loop is heard from the next window. A sounding note plays out. |
| `clip.instrument`            | Writable. `null` plays nothing.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `clip.dispose()`             | Releases sent notes, detaches from every transport; safe to call twice; also `[Symbol.dispose]`. Writes after dispose throw.                                                                                                                                                                                                                                                                                                                        |

Assigning `.value` on `clip.notes` is a type error; change notes only through `setNotes` and `edit`. A custom scheduler imports its `BeatTiming` and `CancellableEvent` types from `@audiorective/clock`.

## Record a take

`MidiRecorder` mirrors `AudioRecorder`: it borrows one Web MIDI input and the app's `AudioContext`, is a clock scheduler (`clock.attach(recorder)`) and resolves one take per `record()`. The app obtains permission, chooses the device and resumes the context; the recorder adds its own `midimessage` listener and does not make sound.

```typescript
import { MidiRecorder } from "@audiorective/midi/web";
import { MidiClip } from "@audiorective/midi";

const access = await navigator.requestMIDIAccess();
const input = access.inputs.values().next().value;
if (!input) throw new Error("Connect a MIDI input first.");
await context.resume();
const recorder = new MidiRecorder(context, input); // input: a MIDIInput or a MidiKeyboard
clock.attach(recorder); // optional: lets quantize and note-value lengths follow the clock
const take = await recorder.record({ quantize: "1m", length: "4m" }); // starts on the next bar, ends after four bars
const clip = new MidiClip(take.notes, { instrument: sampler, loop: true, length: take.duration });
clock.attach(clip);
// Stop early from a button: recorder.stop() resolves the pending record() with what was captured. recorder.cancel() discards it.
```

`record({ when?, quantize?, length?, signal? })` resolves with a `MidiTake` after the take ends, at `length` or at `stop()`:

- `when`: absolute AudioContext seconds to start at (a past time starts now); default now. Not together with `quantize`.
- `quantize`: `"none"` (default, start at once) or the next boundary of the attached, playing clock: `"1m"` the next bar line of its meter, `"2m"` two bars, `"4n"` a beat, `"8n"` half a beat. A call exactly on a boundary starts there, not on the next one; otherwise the first boundary at least 50 ms ahead. It rejects with `InvalidStateError` when the recorder is not attached to a Clock or the clock is not playing.
- `length`: seconds, or a note value measured at the clock's tempo from the start (`"4m"` four bars). A note value needs the attached, playing clock. Default: until `stop()`.
- `signal`: aborting discards the take and rejects with `AbortError`, like `cancel()`.

`stop({ when? })` ends the active take at `when` (default now) and resolves it, the same take `record()` resolves. `cancel()` discards it and rejects `record()` with `AbortError`. `cells.state` is `"idle" | "armed" | "recording" | "disposed"`; `cells.startsAt` is the AudioContext time an armed take starts at (else null); `cells.startedAt` is when the recording began (else null). A recorder makes repeated takes; `dispose()` cancels an active take and removes its listener.

A `MidiTake` holds:

| Field                  | Contract                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notes`                | `MidiNote[]` in beats from the take's start (at the clock's tempo; 120 BPM when no clock is attached), velocity 0..1, ready for `new MidiClip(take.notes)`. A note held at the end is closed there; events outside the window are ignored. |
| `duration`             | Take length in beats.                                                                                                                                                                                                                      |
| `startBeat`            | The clock beat at `startTime` when the recorder was attached to a playing clock, else `null`.                                                                                                                                              |
| `startTime`, `endTime` | AudioContext seconds of the take's start and end.                                                                                                                                                                                          |
| `events`               | `{ beat, data }[]`: every other accepted message (controllers, pitch bend, program change) with the MIDI bytes, in delivery order.                                                                                                         |

Same-channel, same-pitch overlapping note-ons pair with note-offs first in, first out; a note-on with velocity 0 is an off; an unmatched note-off yields no note. Sustain pedal messages stay in `events` and do not lengthen notes. Web MIDI `Event.timeStamp` uses the performance clock; the recorder maps it to the AudioContext's output timeline with `getOutputTimestamp()` (falling back to a sampled `performance.now()`/`currentTime` pair). The mapping is an estimate, not sample-accurate input timing or a device-latency correction; calibrate any monitor offset when placing the take.

### Keep controllers when playing an edited take

`clip.notes` carries notes only. To replay recorded controllers (sustain, pitch bend) together with edited notes, compile the current notes with the take's `events`:

```typescript
import { compileMidiPlaybackEvents } from "@audiorective/midi";

const events = compileMidiPlaybackEvents(
  { events: take.events.map((e) => ({ beat: e.beat, data: e.data })) },
  { notes: clip.notes.value, duration: take.duration },
);
// events: { beat, data, noteId? }[] sorted by beat; send each data to a MIDI output, or schedule it with a clock window.
```

The result regenerates note-on/off bytes from the current notes (velocity 0..1 becomes a 1-127 byte; zero-length and velocity-zero notes emit none) and keeps the source's non-note messages. At equal beats, surviving source events keep their delivery order and new note endpoints follow them. `take.events` holds only the non-note messages, so the order of a note release and a control message recorded at the same instant is not retained: the control message comes first. A source event that is a note-on must carry a `noteId`, or it is rejected because its original order cannot be reconstructed. Recompile after an edit and do not replay the raw events beside the result. The function is pure: the app maps beats to its transport and sends the messages. Playing notes through `MidiClip` needs no compile step; use this only when controllers must follow edited notes.

## Play a keyboard live

`MidiKeyboard` plays every Web MIDI input into an instrument at the current audio time (no look-ahead, lowest latency). Open it from a click: browsers prompt for MIDI permission.

```typescript
import { MidiKeyboard } from "@audiorective/midi/web";

button.onclick = async () => {
  const keyboard = await MidiKeyboard.open(context, { instrument: sampler });
  effect(() => console.log([...keyboard.held.value])); // notes sounding now, lowest first
  // On teardown: keyboard.dispose();
};
```

`MidiKeyboard.open(context, { instrument, sustain?, access?, signal? })` resolves listening to every input (`access` is a `MIDIAccess` you already hold, or `null` for on-screen keys only with no permission prompt). It decodes note-on (velocity / 127 becomes 0..1), note-off and note-on with velocity 0 on any channel, ignoring other messages except the sustain pedal (CC 64). With `sustain` true (default) a key released while the pedal is down keeps sounding until the pedal comes up; pass `false` to send every note-off at once. Inputs plugged in later join; unplugging an input releases the notes it held; `dispose()` (also `[Symbol.dispose]`, or abort the `signal`) releases every note and removes the listeners. `keyboard.inputs` lists the connected `MIDIInput`s, `keyboard.held` the sounding notes and `keyboard.sustain` whether a pedal is down; all are tracked cells. `open` rejects with the `DOMException` from `navigator.requestMIDIAccess` (`NotAllowedError` when the user denies access). On-screen keys use the same path as hardware: `keyboard.press(note, { velocity?, when?, channel? })`, `keyboard.release(note, when?)` and `keyboard.setSustain(down, when?)` reach the instrument at `when` (default now) and update `held`, `sustain` and the sustain deferral. Striking a key the pedal alone is holding sends that note's note-off at the new `when` just before the new note-on, so the keyboard keeps one voice per pitch and pedal-up releases only the new note (a `Sampler` used directly still layers voices). A `MidiKeyboard` is a `MidiSource`, so `new MidiRecorder(context, keyboard)` records every input and the on-screen keys together; a `MIDIInput` is also a `MidiSource`.

## MIDI files

`parseMidi(ArrayBuffer | Uint8Array): ParsedMidi` reads Standard MIDI Files in format 0 or 1 with PPQ division. Notes are in **beats** (ticks / ppq) with velocity 0..1; **the file's own tempo is not applied**, so notes follow the transport. Format 2 and SMPTE division are rejected. The result:

```typescript
type ParsedMidi = Readonly<{
  notes: readonly MidiNote[]; // every note of every track, frozen, sorted by start then pitch
  duration: number; // beats to the last note or end-of-track
  ppq: number;
  tempos: readonly { beat: number; bpm: number }[]; // the file's tempo map, for display
  signatures: readonly { beat: number; numerator: number; denominator: number }[];
}>;
```

Load a file into a clip with `new MidiClip(parseMidi(bytes).notes, { instrument })`. To follow the file's tempo, set the transport tempo from `tempos[0].bpm` yourself. A velocity-zero note-on is a note-off; overlapping notes of the same track, channel and pitch pair first in, first out; an unmatched off is ignored and an unclosed on ends at the file end. Controllers, pedal, pitch bend and program changes are not retained; this is a note projection, not lossless SMF storage or export. URL fetches and File reads belong to the caller.

`midiGrid(parsed)` returns frozen `beats` and `downbeats` arrays in beats. Beats follow the time-signature denominator; a signature change starts a new bar. Grid generation rejects more than 100,000 points.

`visibleMidiNotes(notes, range, pitches?)` returns notes intersecting an inclusive beat interval, including sustained notes that start before it. Inputs must be sorted by start and immutable. Optional `pitches` is `{ low, high }`, inclusive.

## Piano-roll view

Select and edit a clip with the piano roll. `pianoRollModel(clip)` (from `@audiorective/widgets/piano-roll`) adapts a `MidiClip` to the view's model: its notes follow the clip, and the selection is the model's own `selection` cell (a beat range, or null).

```typescript
import { MidiClip, midiGrid, parseMidi } from "@audiorective/midi";
import { mountPianoRoll, pianoRollModel } from "@audiorective/widgets/piano-roll";

const parsed = parseMidi(await file.arrayBuffer());
const clip = new MidiClip(parsed.notes, { instrument: sampler });
const model = pianoRollModel(clip, { duration: parsed.duration });
const grid = midiGrid(parsed);
const a = mountPianoRoll(left, {
  model,
  grid,
  snap: "beat",
  onNoteEdit: ({ note }) => clip.edit((draft) => Object.assign(draft.find((n) => n.id === note.id)!, note)),
});
const b = mountPianoRoll(right, { model, grid, snap: "beat" });
a.dispose(); // The clip and the other view remain available.
b.dispose();
model.dispose();
clip.dispose();
```

The view reads the model directly rather than copying notes into a UI store, and `MidiClip` notes edited by anything (the view, a form, a recording) appear in every view. All times the view shows (notes, duration, grid, playhead, scroll, plugin coordinates) are in beats.

`mountPianoRoll(root, options): PianoRollHandle` borrows a structural `model` implementing `getState`, `getSelection`, `setSelection`, and `subscribe`. `pianoRollModel(clip)` provides one over a `MidiClip`; other application-owned models can too. `onNoteEdit` calls your application's edit command (for a clip, `clip.edit`); models do not need an `updateNote` method.

Options include `label`, inclusive integer `pitches: {low, high}`, `grid: {beats, downbeats}`, `snap: "off" | "beat" | "downbeat"`, `renderer`, `layout`, `onNoteEdit(edit)`, `onNoteClick(note)` and `onCommit(event)`. Each view retains independent zoom/pitch presentation. Notes, duration, grid, playhead, scroll and plugin coordinates are all in beats, and the default note labels show beats. `getViewport().pixelsPerUnit` states the display scale in pixels per beat; `pixelsPerSecond` is an alias with the same number on the viewport shape shared with the waveform.

Drag on the background to select a time range. Selection handles support arrow keys (0.01 beat) and Shift (0.1 beat); Alt bypasses pointer snap. Clicking or keyboard-activating a note calls `onNoteClick` for a caller-owned inspector. Omitting `onNoteEdit` keeps notes read-only for inspection. Providing it enables widget-owned note move and edge-resize gestures; apply the committed edit to your model. At compressed pitch scales, key labels show octave Cs to avoid overlapping text.

| Handle                            | Contract                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `setPlayhead(beat \| null)`       | Shows an externally supplied clock position; no clock is created.                                   |
| `setZoom(factor)`                 | Finite factor 1..64; 1 fits the source, changes retain the viewport center.                         |
| `scrollTo(beat)`                  | Moves the horizontal viewport to a finite beat.                                                     |
| `setPitchRange({low, high})`      | Integer `0 <= low <= high <= 127`, inclusive.                                                       |
| `attach(plugin)`                  | Attaches a `TimeViewPlugin`; returns an independently disposable `PluginAttachment`.                |
| `getViewport()`                   | `{duration, pixelsPerUnit, pixelsPerSecond, scrollLeft, width, height}` in content/viewport pixels. |
| `setSnap(mode)` / `setGrid(grid)` | Changes this view's snapping/grid; selection remains in the borrowed model.                         |
| `dispose()`                       | Detaches observers, listeners, selection and renderer; preserves model, other views and audio.      |

## Replace note drawing

A `PianoRollRenderer` is `(root) => { render(frame), dispose?() }`. Allocate SVG/Canvas/DOM once, then update it from frames. The supplied root spans the full scrolling content.

A frame contains viewport/pitch-filtered `notes` (including spanning notes), content `width`/`height`, `duration`, `pitches`, `viewport`, `timeToX(beat)`, `pitchToY(pitch)`, `editable`, `onNotePointerDown(note, event, kind?)` and `onNoteClick(note)`. `pitchToY` returns the row's top; row height is `height / (high - low + 1)`. Use these coordinates rather than a separate time-to-pixel mapping. Drawings live under the selection handles and external playhead. Forward note pointer presses to `frame.onNotePointerDown(note, event)` to keep inspection and editing separate from background range dragging. The widget infers move/start-edge/end-edge from beat-time geometry; a renderer can explicitly pass `"move"`, `"resize-start"` or `"resize-end"`. Keep click/keyboard inspection connected to `frame.onNoteClick`.

Theme with the shared `--waveform-*` appearance variables, `--piano-roll-height` and `--piano-roll-note-text`. The [showroom](/showroom/piano-roll) demonstrates default note buttons and a custom SVG renderer sharing one clip. Use `renderer` for note drawing and `attach(plugin)` for time-based overlays and interactions.

## Replace keyboard, toolbar and layout

`layout` has the same mount/render/dispose lifecycle as `renderer`. The factory receives `(root, viewport, controls)`. Mount the **supplied viewport** inside root; the widget retains its content, scrolling, selection, plugins and note gestures. The layout owns the surrounding DOM, keyboard drawing and controls. Use your own classes and elements instead of internal widget selectors.

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
    dispose() {
      zoom.onclick = null;
      root.replaceChildren();
    },
  };
};
const view = mountPianoRoll(root, { model, layout: compact });
```

`controls` exposes `setZoom`, `scrollTo`, `setPitchRange`, `setSnap` and `setGrid`. Layout frames contain `duration`, `height`, inclusive `pitches`, `viewport`, `pitchToY`, `zoom` and `snap`. Initialize custom snap controls from `frame.snap` (`"off"`, `"beat"` or `"downbeat"`) and read it again in each render; `setSnap` synchronously refreshes the layout, including calls through the returned handle or layout controls. The widget owns this state, so an external snap change also updates your control without a second store. Use `pitchToY` and `height / (high-low+1)` to draw your keyboard aligned with the content. Viewport frames follow scroll/zoom/resize/pitch/data changes; render updates presentation without calling control mutations recursively. `root` excludes the widget's base style element, so a layout may replace its own children. Keep the supplied viewport identity and mount it once; cloning/removing it breaks the interaction owner. A missing viewport throws `Piano roll layout must mount its viewport inside the supplied root.`

Layouts can set public viewport styles and inherited CSS variables. Preserve finite dimensions, horizontal overflow scrolling and an accessible keyboard-focusable viewport. Interactive controls need labels, focus styles and responsive wrapping. Dispose removes layout resources even if another cleanup fails. The showroom's second view draws its numeric keyboard on the right and its wrapping toolbar below, without implementing any drag logic.

## Widget-owned note moves and resizes

```typescript
const editable = mountPianoRoll(root, {
  model,
  onNoteEdit({ note }) {
    // One commit; a looping clip plays the edit from its next pass.
    clip.edit((draft) => {
      const target = draft.find((n) => n.id === note.id);
      if (target) Object.assign(target, { start: note.start, duration: note.duration, pitch: note.pitch });
    });
  },
});
```

`onNoteEdit` enables pointer editing and receives frozen `{kind, previous, note}` (`PianoRollNoteEdit`). `kind` is `"move"`, `"resize-start"` or `"resize-end"`. Moving changes time/pitch while preserving duration and metadata; resizing changes one time endpoint. The widget previews locally after a 3px movement threshold and commits **once on pointer release** through the synchronous callback. Peers observe the authoritative model after that callback updates it. Returning without writing leaves the model and final drawing unchanged; a thrown callback is logged as `Piano roll note edit failed:` and the preview is discarded. This callback is a model command, not another persistent store or an audio transport.

The default renderer uses the first/last up-to-6px (at most one quarter of note width) for edge resizing. Other presses move the note. Time edits use the same nearest-beat/downbeat rule as selection; Alt bypasses snapping, and setters update both. A vertical-only move retains its original onset rather than quantizing time. Moves stay within the current source duration and visible pitch range. Resizes stay ordered within source bounds and retain at least the smaller of 0.01 beat and the original duration. These gestures do not extend the source timeline.

Escape, pointer cancellation, lost capture, window blur/scroll, viewport/pitch geometry changes, source/note replacement and destruction cancel previews without committing. Capture belongs to the stable content surface, so SVG/Canvas/DOM redraws do not lose the gesture. Renderers forward pointerdown and may provide explicit resize modes; they do not implement delta conversion, snapping, cancellation or model mutation. For Canvas, hit-test the note and forward it to the same handler.

A click without a drag and keyboard activation still inspect the note. Background range dragging and its keyboard handles remain separate.

Pass `onNoteAdd` to add notes by double-clicking empty space: it receives `{ pitch, start, duration, velocity }` for the clicked pitch row and grid cell, and your callback adds it to the model. Pass `onNoteDelete` to delete by double-clicking a note, or by pressing Delete or Backspace on the focused or last-clicked note. Set `velocityLane: true` for a lane under the notes (height `--piano-roll-velocity-height`): each note gets a stem with a round handle at its start, kept fully inside the lane for a note at beat 0. Dragging a handle previews the velocity (a 1-127 label follows it) and commits once on release through `onNoteEdit` with `kind: "velocity"`. In a chord the bars share one x: the active note (the last one clicked, or the one set with `setActiveNote`) is drawn on top and highlighted, and is the one dragged. With a note active, ArrowUp and ArrowDown change its velocity by 1 (Shift: 10) and commit the same way. The note bodies fade with velocity. Each callback is a model command, so wrap it in your undo, for example `project.edit`. After remounting the view, call `handle.setActiveNote(noteId)` with the app's selected note so Delete and a chord's velocity drag act on it.

```typescript
mountPianoRoll(root, {
  model: pianoRollModel(clip),
  velocityLane: true,
  onNoteAdd: (note) => clip.edit((draft) => void draft.push({ ...note, id: crypto.randomUUID(), channel: 0 })),
  onNoteDelete: ({ id }) => clip.setNotes(clip.notes.value.filter((note) => note.id !== id)),
  onNoteEdit: ({ note }) => clip.edit((draft) => void Object.assign(draft.find(({ id }) => id === note.id)!, note)),
});
```

The piano roll does not provide multi-note editing, auto-scroll, keyboard note movement or touch navigation gestures.

## Add a time-based overlay or interaction

`view.attach(plugin)` uses the shared [`TimeViewPlugin` contract](./widgets-advanced.md#write-a-visual-plugin) for piano roll, waveform, and waveform selector. The piano-roll entry exports `TimeViewPlugin`, `TimeViewPluginContext`, and `PluginAttachment`. `ctx.timeUnit` is `"beats"` here.

```typescript
import { mountPianoRoll, type TimeViewPlugin } from "@audiorective/widgets/piano-roll";

function markerAt(time: number): TimeViewPlugin {
  return {
    attach(ctx) {
      const layer = document.createElement("div");
      const marker = document.createElement("span");
      marker.textContent = "Cue";
      marker.style.cssText = "position:absolute;top:4px;border-left:2px solid currentColor";
      layer.append(marker);
      ctx.mountOverlay(layer);
      const draw = () => {
        marker.style.left = `${ctx.timeToX(time)}px`;
      };
      ctx.onViewportChange(draw);
      ctx.onDataChange(draw);
      draw(); // Subscriptions do not call back immediately.
    },
  };
}

const view = mountPianoRoll(root, { model });
const marker = view.attach(markerAt(1));
// marker.dispose() removes just this overlay and its subscriptions.
// view.dispose() removes every attachment, preserving the borrowed clip/audio.
```

The context provides `surface`, live `duration`, `getViewport()`, `getViewportRect()`, `timeToX(time)`, `clientXToTime(clientX)`, `scrollBy(pixels)`, `mountOverlay(element)`, `onViewportChange`, `onDataChange`, `listen` and `onCleanup`. Times are beats; `timeToX` returns pixels in the full scrolling note surface. `clientXToTime` accounts for the actual content origin and current scroll. `getViewportRect` is the visible viewport's browser rectangle, including its border; `surface.getBoundingClientRect()` gives the scrolling content origin. Keyboard width is internal: callers do not calculate or inspect it.

Overlay layers fill the note surface and default to `pointer-events: none`. Interactive children can set `pointer-events: auto`; stop their `pointerdown` propagation when they should not start native background range selection. Use `ctx.listen` for events and `ctx.onCleanup` for caller resources such as observers or animation frames. Data notifications occur on note-array or duration replacement, before layout; viewport notifications follow layout, horizontal scroll, zoom and pitch-range changes. Selection-only changes are observed through the model's `selection` cell or subscription.

Each attachment owns its overlays, listeners and subscriptions. `attachment.dispose()` is idempotent and leaves peer plugins, the view, model and audio alive. A failed attach rolls back registered resources. Registrations made after detachment are cleaned up immediately; `mountOverlay` then throws. A plugin can return a disposer or `{dispose()}`. Throwing cleanup is logged while other resources continue to clean up. The same plugin object cannot be attached twice to one view simultaneously; create an instance per view if the plugin holds mutable state. The built-in selection plugin remains the single selection owner; added plugins extend visualization/interaction rather than attaching a second selection owner.

This context covers the time axis. Custom note drawing uses the renderer frame's `pitchToY`; plugins do not expose a pitch-editing contract.

## Common errors

| Message                                                                                                                                                                                                                                                                                               | Cause and fix                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Invalid MIDI file.`                                                                                                                                                                                                                                                                                  | Invalid or truncated header, track or event, zero PPQ or tempo, or an unsupported signature. Supply intact supported SMF bytes.                              |
| `Only MIDI format 0 and 1 are supported.`                                                                                                                                                                                                                                                             | Type 2 is not supported; convert the file upstream.                                                                                                          |
| `SMPTE MIDI time division is not supported.`                                                                                                                                                                                                                                                          | Use a PPQ-based file.                                                                                                                                        |
| `MIDI grid needs a valid duration and time signatures.`                                                                                                                                                                                                                                               | Pass a `ParsedMidi` or an object with a finite non-negative `duration` and positive signatures.                                                              |
| `MIDI grid exceeds 100000 points.`                                                                                                                                                                                                                                                                    | Use a bounded caller-supplied grid or omit grid generation for very long data.                                                                               |
| `MIDI needs a note value such as "4n" or "1m", got "…".`                                                                                                                                                                                                                                              | A `length` or `quantize` string is not `"<n>m"` (bars) or `"<n>n"` (note value). Use `"2m"`, `"4n"`, `"8n"`.                                                 |
| `MidiClip note pitch must be an integer 0-127.` / `MidiClip note velocity must be 0..1.` / `MidiClip note start must be finite beats >= 0.` / `MidiClip note duration must be finite beats >= 0.` / `MidiClip note channel must be an integer 0-15.` / `MidiClip note id must be a non-empty string.` | A note field is outside its range. Pitch is 0-127, velocity 0..1 (not 0-127), start and duration are beats, channel 0-15. Fix the value; no commit happened. |
| `MidiClip notes need unique ids.`                                                                                                                                                                                                                                                                     | Two notes share an `id`. Omit `id` to have one generated, or make them unique.                                                                               |
| `MidiClip length must be positive beats or a note value.`                                                                                                                                                                                                                                             | `length` is zero, negative or not finite. Pass beats above 0 or `"2m"`/`"4n"`.                                                                               |
| `MidiClip is disposed.`                                                                                                                                                                                                                                                                               | `setNotes`, `edit` or `attach` after `dispose()`. Create another clip.                                                                                       |
| `MidiRecorder is disposed.`                                                                                                                                                                                                                                                                           | `record()` after `dispose()`. Construct a new recorder.                                                                                                      |
| `MidiRecorder already has an active take.`                                                                                                                                                                                                                                                            | `record()` while a take is armed or recording. Await it, `stop()` or `cancel()` first.                                                                       |
| `MidiRecorder needs a running AudioContext.`                                                                                                                                                                                                                                                          | Resume the caller-owned context from a user gesture before `record()`.                                                                                       |
| `MidiRecorder record() takes \`when\` or \`quantize\`, not both.`                                                                                                                                                                                                                                     | Pass one start rule: an absolute `when`, or a `quantize` boundary.                                                                                           |
| `MidiRecorder length must be positive seconds or a note value.`                                                                                                                                                                                                                                       | `length` is zero, negative or not finite. Pass seconds above 0 or `"4m"`/`"4n"`.                                                                             |
| `MidiRecorder time must be finite, non-negative seconds.`                                                                                                                                                                                                                                             | `when` (or `stop({ when })`) is not an absolute finite AudioContext time.                                                                                    |
| `MidiRecorder quantize needs clock.attach(recorder).` / `MidiRecorder length needs clock.attach(recorder).` (`InvalidStateError`)                                                                                                                                                                     | A boundary or note-value length needs a clock. Call `clock.attach(recorder)`, or use seconds.                                                                |
| `MidiRecorder quantize needs a playing clock.` / `MidiRecorder length needs a playing clock.` (`InvalidStateError`)                                                                                                                                                                                   | The attached clock is stopped or paused. Start it, or record with `quantize: "none"` and a length in seconds.                                                |
| `MidiRecorder has no active take to stop.` (`InvalidStateError`)                                                                                                                                                                                                                                      | `stop()` with no take in progress. Call `record()` first.                                                                                                    |
| `MidiRecorder recording was cancelled.` (`AbortError`)                                                                                                                                                                                                                                                | `cancel()`, the `signal`, a clock stop, pause or seek before a quantized start, or `dispose()` ended the take. Catch it; nothing was captured.               |
| `MidiKeyboard note must be an integer 0-127.` / `MidiKeyboard velocity must be 0..1.` / `MidiKeyboard channel must be an integer 0-15.`                                                                                                                                                               | `press` or `release` got a value outside its range. Note 0-127, velocity 0..1 (not 0-127), channel 0-15. Nothing sounded.                                    |
| `MidiClip transform needs a function.` (`TypeError`)                                                                                                                                                                                                                                                  | The `transform` option is not a function. Pass `(note, random) => note \| null`.                                                                             |
| `Event transform "transform" returned an event without a finite "beat"` (likewise `when`, `durationBeats`) / `... whose "velocity" is not a finite number from 0 to 1.`                                                                                                                               | A `MidiClip` `transform` returned a bad field. Return the note with finite `beat`/`when`, `durationBeats` above 0 and `velocity` 0..1, or `null` to drop it. |
| `MidiKeyboard needs an instrument.` (`TypeError`)                                                                                                                                                                                                                                                     | `MidiKeyboard.open` was called without `instrument`. Pass a `Sampler`, a `WebClapHost` or a two-method adapter.                                              |
| `Web MIDI is not supported in this browser.` (`NotSupportedError`)                                                                                                                                                                                                                                    | The browser has no `navigator.requestMIDIAccess`. Offer another input; `NotAllowedError` from the same call means the user denied access.                    |
| `MIDI playback needs finite, non-negative times and valid MIDI notes.`                                                                                                                                                                                                                                | A source event beat or a note is invalid, a note extends past `duration`, or ids repeat. Pass the current `clip.notes.value` and a finite duration.          |
| `MIDI playback needs note IDs on recorded note-ons.`                                                                                                                                                                                                                                                  | A source note-on has no `noteId`. Tag note messages, or leave them out and pass only non-note events.                                                        |
| `Piano roll zoom must be between 1 and 64.`                                                                                                                                                                                                                                                           | Pass a finite zoom factor in that interval.                                                                                                                  |
| `Piano roll pitches must satisfy 0 <= low <= high <= 127.`                                                                                                                                                                                                                                            | Pass ordered integer MIDI pitches.                                                                                                                           |
| `Piano roll scroll time must be finite.`                                                                                                                                                                                                                                                              | Use a finite beat.                                                                                                                                           |
| `Playhead must be finite or null.`                                                                                                                                                                                                                                                                    | Use a finite beat, or null to hide it.                                                                                                                       |
| `Piano roll layout must mount its viewport inside the supplied root.`                                                                                                                                                                                                                                 | Layout omitted/cloned the supplied viewport. Append the supplied viewport inside the layout root; retain its identity.                                       |
| `Piano roll is disposed.`                                                                                                                                                                                                                                                                             | Attaching after view cleanup. Mount another view; keep the borrowed model if still needed.                                                                   |
| `Plugin is already attached to this piano roll.`                                                                                                                                                                                                                                                      | Same object attached twice to one view. Dispose its attachment first, or create another plugin instance.                                                     |
