---
title: Clock
---

`@audiorective/clock` owns one musical transport and its look-ahead scheduling. Attach patterns, recorders, players and automation to it; UI handlers edit those owners and read their state. The clock reads absolute `AudioContext` seconds, while its musical axis uses quarter-note beats.

## Start a pattern from a click

This Vanilla browser example plays a built-in tone; it needs no sample download.

```typescript
import { Clock } from "@audiorective/clock";
import { StepSequencer } from "@audiorective/sequencer";

const context = new AudioContext();
const seq = new StepSequencer({ click: { pattern: "X...x...x...x...", sound: "C5" } }, { context });
const clock = new Clock({ context, bpm: 120 });
const detach = clock.attach(seq);

const button = document.createElement("button");
button.textContent = "Play";
button.addEventListener("click", async () => {
  await context.resume();
  clock.start();
});
document.body.append(button);

// Call when removing this app: it owns these resources.
function dispose() {
  button.remove();
  detach();
  seq.dispose();
  clock.dispose();
  void context.close();
}
```

An existing shared clock is enough: `clock.attach(seq)` returns an idempotent detach function. Close one panel by detaching and disposing its owner; shared context and clock stay with their host. See [Sequencer](./sequencer.md) for lane sounds, step edits and hooks; [Automation](./automation.md) for a repeating curve attached to the same clock.

## Transport and tempo

| Action                                       | Call / reading                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Start at an audio instant and musical offset | `clock.start(when?, offsetBeats?)`; defaults now, beat 0               |
| Half-second future start                     | `clock.start(context.currentTime + 0.5)`                               |
| Count in from beat −3                        | `clock.start(context.currentTime, -3)`                                 |
| Pause / continue                             | `clock.pause()` / `clock.resume()`                                     |
| Stop and reset to beat 0                     | `clock.stop()`                                                         |
| Seek on the quarter-note axis                | `clock.seek(beat)`                                                     |
| Current beat / state                         | `clock.beat` (live getter), `clock.state.value` (readonly cell)        |
| Read / set BPM                               | `clock.bpm.value`                                                      |
| Linear BPM ramp                              | `clock.bpm.linearRampToValueAtTime(targetBpm, endAudioTime)`           |
| Slider takes over a ramp                     | `clock.bpm.cancelAndHoldAtTime(context.currentTime)` then set `.value` |

`clock.state.value` is `"stopped" | "playing" | "paused"`; it is a transport state, not the AudioContext's `"running"` state. Calling `start()` again resets the transport, so a Play or launch handler that preserves playback uses:

```typescript
await context.resume(); // from a user gesture
if (clock.state.value === "stopped") clock.start();
else if (clock.state.value === "paused") clock.resume();
// Already playing: leave its position and queued work alone.
```

The context belongs to its creator. `new Clock({ context, bpm })` creates its own timeline; pass `{ timeline }` to share an existing one. Both expose `clock.timeline` for beat/time conversion. A future start holds the start position until `when`; pauses hold musical position and seconds position. Tempo changes preserve the current beat. For live tempo curves, custom tick input, count-in and start boundaries, see [advanced](./clock-advanced.md#transport).

## Pattern edits and completion

A sequencer attached with `clock.attach` automatically rebuilds queued events after committed edits. A custom scheduler edits its own cell and calls `clock.refresh()`. It synchronously retracts owned hits at or after the first captured audio boundary, preserves earlier hits and position, then refills in a coalesced microtask. Editing inside a scheduling callback never re-enters scheduling synchronously. Multiple refresh calls in a task share the refill. Before a start or seek has dispatched its first window, refresh retains that requested beat even if audio time has advanced; after dispatch it refills from the captured current boundary.

```typescript
pattern.value = nextPattern; // the existing custom scheduler's cell
await clock.refresh();
const audio = await offlineContext.startRendering();
```

The returned Promise completes after the refill, including further refreshes requested synchronously by its callbacks. Start, pause, stop, seek or dispose cancels pending refill and completes its waiters. Stopped, paused or disposed clocks return an already-completed Promise. An attached scheduler's handle also exposes `refresh()`; after detach it completes without touching the host. Realtime edit handlers may ignore completion when nothing depends on it.

Use `batch` when observers should see one coherent multi-field edit. It is unnecessary solely to coalesce refills. For custom events, pair sound/cue cleanup with `withCancel` and register them with the window's `own`; [advanced ownership](./clock-advanced.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound) explains future cancellation and per-registration `cancelFrom`.

## Positions and rulers

A `Timeline` projects one transport into musical bars, cycles and seconds position. Rulers hold no second position store. Read `timeline.rulers.name.current.value` for tracked UI. A ruler’s `at` projects a chosen beat; time rulers also take the timeline.

| Reading             | Units / base                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `clock.beat`        | Quarter-note beats, negative during count-in                                                                   |
| `timeline.position` | Seconds position: start/seek seeds from the chosen beat and current BPM, then advances by real playing seconds |
| `LinearBarRuler`    | `bar` starts at 0; `beatInBar` is quarter-note axis beats                                                      |
| `CycleBarRuler`     | Zero-based cycle/bar offsets and phase `[0,1)`                                                                 |
| `LinearTimeRuler`   | Pause-aware seconds position                                                                                   |
| `CycleTimeRuler`    | Phase through a chosen played-seconds period                                                                   |
| Linear grid point   | `{ beat, when, index }`; `index` starts at 0                                                                   |
| Cycle grid point    | `{ beat, when, step, cycle }`; `step` starts at 0 within each cycle                                            |

`when` is an absolute audio timestamp: pass it directly to `trigger({ when })` or `start(when)`. A grid's range is half-open: includes the start, excludes the end. A linear grid's division is steps per bar; a cycle grid's is steps per entire cycle. In 6/8 one bar is three quarter-note beats, so twelve eighth steps span two bars, and musician-facing bar 5 is axis beat 12. Add 1 to zero-based bar readings for display.

Read [advanced rulers](./clock-advanced.md#rulers--reading-the-beat-axis) for constructing several projections on the same timeline and typing custom scheduling windows. Use a cycle ruler for repeating coordinates while the transport's beat axis keeps advancing.

## Offline rendering and custom scheduling

- Clock-driven graph or scripted edits during a print: [renderTimeline](./clock-advanced.md#rendering-offline--rendertimeline) supplies the render's tick input. Wait for edited look-ahead with `await clock.refresh()` before starting an offline render yourself.
- Several attached components or one removable panel: [scheduler lifecycle](./clock-advanced.md#attach-several-schedulers).
- Custom pattern rules, cancellation and paired cues: [window ownership](./clock-advanced.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).
- Source-second loops: [RangeLoop](./clock-advanced.md#repeat-a-source-second-range).
- Controlled time and native audio tests: [deterministic tests](./clock-advanced.md#testing-scheduling-deterministically).

## Common errors

Invalid constructor option combinations throw `TypeError`; numeric scheduling and meter limits throw `RangeError`. Attaching to a disposed Clock or attaching the same scheduler twice throws `DOMException` with `name === "InvalidStateError"`.

| Message                                                                                                                                                                | Cause                                                                                                              | Fix                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `Clock owned event time must be finite, non-negative seconds.`                                                                                                         | `window.own(event, when)` received an invalid audio time; the event is cancelled before the error is thrown.       | Pass the same absolute `AudioContext` time used to schedule that event.                                                      |
| `RangeLoop needs increasing finite source seconds and a non-negative audio start.` / `RangeLoop window needs finite audio seconds.`                                    | The time range or window contains an invalid bound.                                                                | Use finite seconds and place the source end after its start.                                                                 |
| `TempoParam ramp end time must be finite, got …`                                                                                                                       | `linearRampToValueAtTime` or `exponentialRampToValueAtTime` received NaN or an infinite end time.                  | Pass the absolute `AudioContext` time at which the ramp reaches its value.                                                   |
| `Clock takes either timeline or context, not both.` / `Clock needs a timeline or a context.` / `Clock bpm only applies with context; set it on the timeline you pass.` | The options named both a Timeline and a context, neither, or a `bpm` next to a `timeline`.                         | Pass `{ context, bpm? }` for a Clock-made Timeline, or `{ timeline }` and set the tempo on that Timeline.                    |
| `Clock is disposed.` / `Clock already has this scheduler attached.`                                                                                                    | `attach` was called on a disposed clock, or with a scheduler that is already attached.                             | Create a new Clock, or detach the scheduler first.                                                                           |
| `Clock meter must be [numerator, denominator] positive integers, got [n, d].`                                                                                          | `ClockOptions.meter` held a non-integer or a value below 1.                                                        | Pass whole numbers, for example `[4, 4]` or `[6, 8]`.                                                                        |
| `Clock start time must be finite seconds, got …` / `Clock start offset must be finite beats, got …`                                                                    | `start(when, offsetBeats)` or `start({ atBeat })` received NaN or an infinite number.                              | Pass a finite audio time and a finite beat.                                                                                  |
| `TempoParam start time must be finite, got …` / `TempoParam time constant must be finite and >= 0, got …`                                                              | `setTargetAtTime` or `setValueCurveAtTime` received a non-finite start, or a negative or non-finite time constant. | Pass an absolute `AudioContext` time and a time constant of 0 or more.                                                       |
| `TempoParam value curve needs at least 2 values.` / `TempoParam value curve duration must be finite and > 0, got …`                                                    | `setValueCurveAtTime` got fewer than two values, or a zero, negative or non-finite duration.                       | Pass two or more bpm values and a duration above 0 seconds.                                                                  |
| `RangeLoop period is below audio time precision.`                                                                                                                      | Consecutive repeat boundaries collapse at the current audio time.                                                  | Use a longer source range.                                                                                                   |
| `bpm must be a finite number > 0, got …`                                                                                                                               | A tempo point or the `bpm` value is zero, negative or not finite.                                                  | Pass a finite bpm above 0.                                                                                                   |
| `renderTimeline: tickInterval must be positive, got …`                                                                                                                 | `options.tickInterval` is zero, negative or NaN.                                                                   | Omit it for the default, or pass seconds above 0 (and below the clock look-ahead).                                           |
| `<option> must be a finite number > 0, got …`                                                                                                                          | A ruler option (`seconds`, `bars`, `numerator`, `denominator`) is zero, negative or not finite.                    | Pass a finite length above 0; the ruler rejects it at construction because a zero-length cycle would hang the tick callback. |
| `<option> must be a finite number, got …`                                                                                                                              | A ruler `from` offset is NaN or infinite.                                                                          | Pass a finite offset, or omit `from`.                                                                                        |

## Reference links

<span id="the-mental-model"></span>[the mental model](#_top).
<span id="one-time-unit-absolute-audiocontext-time"></span>[one time unit absolute audiocontext time](#positions-and-rulers).
<span id="quick-start--one-object"></span>[quick start — one object](#start-a-pattern-from-a-click).
<span id="quick-start--a-metronome"></span>[quick start — a metronome](./clock-advanced.md#quick-start--a-metronome).
<span id="clockoptions"></span>[clockoptions](./clock-advanced.md#clockoptions).
<span id="handing-a-grid-point-to-a-core-player"></span>[handing a grid point to a core player](./clock-advanced.md#handing-a-grid-point-to-a-core-player).
<span id="typing-the-window"></span>[typing the window](./clock-advanced.md#typing-the-window).
<span id="the-window-convention"></span>[the window convention](./clock-advanced.md#the-window-convention).
<span id="repeat-a-source-second-range"></span>[repeat a source second range](./clock-advanced.md#repeat-a-source-second-range).
<span id="timeline--the-beattime-mapping"></span>[timeline — the beattime mapping](./clock-advanced.md#timeline--the-beattime-mapping).
<span id="transport"></span>[transport](./clock-advanced.md#transport).
<span id="attach-several-schedulers"></span>[attach several schedulers](./clock-advanced.md#attach-several-schedulers).
<span id="start-at-an-audio-time"></span>[start at an audio time](./clock-advanced.md#start-at-an-audio-time).
<span id="start-with-a-count-in"></span>[start with a count in](./clock-advanced.md#start-with-a-count-in).
<span id="own-cancellable-events-when-transport-edits-must-cut-queued-sound"></span>[own cancellable events when transport edits must cut queued sound](./clock-advanced.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).
<span id="rulers--reading-the-beat-axis"></span>[rulers — reading the beat axis](./clock-advanced.md#rulers--reading-the-beat-axis).
<span id="linear-grids-count-cycle-grids-fold"></span>[linear grids count cycle grids fold](./clock-advanced.md#linear-grids-count-cycle-grids-fold).
<span id="miss-detection"></span>[miss detection](./clock-advanced.md#miss-detection).
<span id="live-pattern-editing"></span>[live pattern editing](./clock-advanced.md#live-pattern-editing).
<span id="tick-sources"></span>[tick sources](./clock-advanced.md#tick-sources).
<span id="rendering-offline--rendertimeline"></span>[rendering offline — rendertimeline](./clock-advanced.md#rendering-offline--rendertimeline).
<span id="scripted-user-actions-during-an-offline-render"></span>[scripted user actions during an offline render](./clock-advanced.md#scripted-user-actions-during-an-offline-render).
<span id="testing-scheduling-deterministically"></span>[testing scheduling deterministically](./clock-advanced.md#testing-scheduling-deterministically).
<span id="when-you-cant-inject--testing-a-type-that-owns-its-clock"></span>[when you cant inject — testing a type that owns its clock](./clock-advanced.md#when-you-cant-inject--testing-a-type-that-owns-its-clock).
<span id="non-goals"></span>[non goals](./clock-advanced.md#non-goals).
<span id="design"></span>[design](./clock-advanced.md#design).
