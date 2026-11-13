---
title: MIDI and Piano Roll
---

Use `@audiorective/blocks/midi` for headless MIDI note data and `@audiorective/widgets/piano-roll` for its visual presentation. Both entries can be imported without DOM or Web Audio globals. Mounting a piano roll requires DOM, but never creates a player, synth, AudioContext or device connection.

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

`parseMidi(ArrayBuffer | Uint8Array): ParsedMidi` reads Standard MIDI Files in format 0 or 1 with PPQ division. It projects note events through the file tempo map into **source seconds**, retaining track/channel identity. It does not request Web MIDI permission or synthesize controller, sustain-pedal, pitch-bend or program-change behavior. Format 2 and SMPTE division are rejected.

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

Note fields require unique nonempty IDs, finite `0 <= start <= end <= duration`, integer pitch/velocity 0..127, channel 0..15 and a non-negative integer track. Zero-duration notes may be shown as a minimum-width mark. A duration extension does not invent new tempo/grid metadata; the caller decides which grid to supply.

## Piano-roll view

`mountPianoRoll(root, options): PianoRollHandle` borrows a structural `model` implementing `getState`, `getSelection`, `setSelection`, and `subscribe`. `MidiSequence` satisfies it; other application-owned models can too. It reads state directly rather than copying notes/selection into a UI store.

Options include `label`, inclusive integer `pitches: {low, high}`, `grid: {beats, downbeats}`, `snap: "off" | "beat" | "downbeat"`, `renderer`, `onNoteClick(note)` and `onCommit(event)`. Each view retains independent zoom/pitch presentation. Grid values use the same source seconds as notes.

Drag on the background to select a time range. Selection handles support arrow keys (0.01 seconds) and Shift (0.1 seconds); Alt bypasses pointer snap. Clicking or keyboard-activating a note calls `onNoteClick` for a caller-owned inspector. Notes intercept pointer presses for inspection; this version does not drag/resize individual notes. Update notes through the model or your controls. At compressed pitch scales, key labels show octave Cs to avoid overlapping text.

| Handle                            | Contract                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `setPlayhead(seconds \| null)`    | Shows an externally supplied clock position; no clock is created.                              |
| `setZoom(factor)`                 | Finite factor 1..64; 1 fits the source, changes retain the viewport center.                    |
| `scrollTo(seconds)`               | Moves the horizontal viewport using finite source seconds.                                     |
| `setPitchRange({low, high})`      | Integer `0 <= low <= high <= 127`, inclusive.                                                  |
| `getViewport()`                   | `{duration, pixelsPerSecond, scrollLeft, width, height}` in content/viewport pixels.           |
| `setSnap(mode)` / `setGrid(grid)` | Changes this view's snapping/grid; selection remains in the borrowed model.                    |
| `destroy()`                       | Detaches observers, listeners, selection and renderer; preserves model, other views and audio. |

## Replace note drawing

A `PianoRollRenderer` is `(root) => { render(frame), destroy?() }`. Allocate SVG/Canvas/DOM once, then update it from frames. The supplied root spans the full scrolling content.

A frame contains viewport/pitch-filtered `notes` (including spanning notes), content `width`/`height`, `duration`, `pitches`, `viewport`, `timeToX(seconds)`, `pitchToY(pitch)` and `onNoteClick(note)`. `pitchToY` returns the row's top; row height is `height / (high - low + 1)`. Use these coordinates rather than a separate time-to-pixel mapping. Drawings live under the selection handles and external playhead. For custom note controls, stop pointerdown propagation to keep inspection separate from background range dragging, and support keyboard activation.

Theme with the shared `--waveform-*` appearance variables, `--piano-roll-height` and `--piano-roll-note-text`. The [showroom](/showroom/piano-roll) demonstrates default note buttons and a custom SVG renderer sharing one sequence. No additional preset/plugin system is required.

## Audio integration

The application chooses instruments, scheduling and routing. Read the selected interval and `sequence.query(range)`, clip notes to that interval, and schedule them on the caller's audio clock. Keep cancellation handles for active and already-scheduled voices: pause, seek, source replacement, edits and destroy must cancel obsolete sound. A view's destruction must not cancel application-owned audio.

This split supports both a silent MIDI inspector and an audible application without putting a specific synth, device permission, transport or whole DAW into the widget. The showroom's sine-note auditioner is example application code, not a public MIDI sequencer or Web MIDI output.

## Common errors

| Message                                                                                      | Cause and fix                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Invalid MIDI file.`                                                                         | Invalid/truncated header, track or event; zero PPQ/tempo or unsupported signature. Supply intact supported SMF bytes. |
| `Only MIDI format 0 and 1 are supported.`                                                    | Type 2 is not supported; convert the file upstream.                                                                   |
| `SMPTE MIDI time division is not supported.`                                                 | Use a PPQ-based file.                                                                                                 |
| `MIDI ticks need positive PPQ and finite non-negative time.`                                 | Pass the parsed PPQ and a finite non-negative tick.                                                                   |
| `MIDI grid needs valid PPQ, end tick and time signatures.`                                   | Use parsed metadata or valid positive finite signatures.                                                              |
| `MIDI grid exceeds 100000 points.`                                                           | Use a bounded caller-supplied grid or omit grid generation for very long data.                                        |
| `MIDI duration must be finite and non-negative.`                                             | Repair the supplied duration.                                                                                         |
| `MIDI notes need unique ids, valid source seconds and integer pitch/velocity/channel/track.` | Normalize note records to the documented bounds.                                                                      |
| `MidiSequence is destroyed.`                                                                 | Create another owner; remove its borrowed views before final owner cleanup.                                           |
| `MIDI note was not found.`                                                                   | Use an ID from the current source snapshot.                                                                           |
| `Selection must satisfy 0 <= start < end <= duration (finite seconds).`                      | Use ordered endpoints within the loaded duration.                                                                     |
| `Piano roll zoom must be between 1 and 64.`                                                  | Pass a finite zoom factor in that interval.                                                                           |
| `Piano roll pitches must satisfy 0 <= low <= high <= 127.`                                   | Pass ordered integer MIDI pitches.                                                                                    |
| `Piano roll scroll time must be finite.`                                                     | Use finite seconds.                                                                                                   |
| `Playhead must be finite or null.`                                                           | Use finite seconds or null to hide it.                                                                                |
