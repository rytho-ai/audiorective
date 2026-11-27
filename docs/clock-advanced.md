---
title: "Clock: advanced"
---

Custom rulers, owned scheduling events, tempo mapping, offline rendering and deterministic tests. Start with [Clock](./clock.md) for the shared transport, basic lifecycle and completion contract. Package errors are in [Clock: Common errors](./clock.md#common-errors).

## Quick start — a metronome

```typescript
import { cell } from "@audiorective/core";
import { Clock, Timeline, LinearBarRuler } from "@audiorective/clock";

// The pattern the UI toggles is a cell, never a loose array: the clock reads it, the UI observes it.
const pattern = cell<boolean[]>(Array(16).fill(false));
const timeline = new Timeline({ audioContext: ctx, bpm: 120 }).addRuler("bar", new LinearBarRuler({ numerator: 4, denominator: 4 }));

const clock = new Clock({
  timeline,
  onTick(window) {
    for (const { when, index } of window.rulers.bar.grid(16)) {
      // `when` is absolute AudioContext time -- exactly what Sampler's `when` wants
      if (pattern.value[index % 16]) sampler.trigger({ when });
    }
  },
});

clock.start();

pattern.update((d) => {
  d[0] = true; // edit through update; the next tick reads the new value
});
```

### `ClockOptions`

```typescript
interface ClockOptions<TRulers extends Record<string, Ruler<unknown, unknown>>> {
  timeline?: Timeline<TRulers>; // borrow this Timeline ...
  context?: TimeSource; // ... or create one from this AudioContext (alias: audioContext)
  bpm?: number; // starting tempo of the created Timeline. Default 120; only with `context`
  meter?: TimeSignature; // starting `clock.meter`. Default [4, 4]
  onTick?: (window: TickWindow<TRulers>) => void; // called once per tick while playing
  lookAhead?: number; // seconds scheduled ahead of now. Default 0.1
  tickInterval?: number; // seconds between ticks for the default source. Default 0.025
  onMiss?: (gap: MissedGap) => void; // a tick landed past the previous window's end
  tickSource?: TickSource; // replaces the default WorkerTickSource
}

interface TickSource {
  start(onTick: () => void): void;
  stop(): void;
}
```

Keep `tickInterval` below `lookAhead`. `tickInterval` has no effect when you pass `tickSource`.

### Handing a grid point to a core player

A grid point's **`when`** is an absolute `AudioContext` timestamp in seconds. Pass it directly to core's players: `trigger({ when })` or `start(when)`.

```typescript prelude=window:TickWindow
for (const { when } of window.rulers.bar.grid(16)) {
  sampler.trigger({ when }); // Sampler
  bufferPlayer.start(when); // BufferPlayer takes it positionally
}
```

The point's `beat` is its musical position; `when` is the audio-clock instant at which it sounds. Use `when` to schedule audio, and `beat` or the ruler's index to select pattern content.

### Typing the window

`Timeline` accumulates its ruler types through `addRuler`, and `TickWindow<Rulers>` is the type of the `window` your `onTick` receives. To pass the window to a method or function, derive `Rulers` from the timeline instead of writing it out:

```typescript
import { Clock, Timeline, CycleBarRuler, type TickWindow } from "@audiorective/clock";

const timeline = new Timeline({ audioContext: ctx, bpm: 120 }).addRuler("loop", new CycleBarRuler({ numerator: 4, denominator: 4, bars: 1 }));

type Rulers = typeof timeline extends Timeline<infer R> ? R : never;

class Machine {
  schedule(window: TickWindow<Rulers>): void {
    for (const { when, step } of window.rulers.loop.grid(16)) {
      // schedule a hit at `when`
    }
  }
}

const machine = new Machine();
const clock = new Clock({ timeline, onTick: (window) => machine.schedule(window) });
```

When a class stores the timeline or clock as a field, annotate it `Timeline<Rulers>` / `Clock<Rulers>` with the same `Rulers`. Writing the record by hand also works: `Record<"loop", Ruler<CycleBarWindow, CycleBarPoint>>`.

## The window convention

**Derive each event from data the window hands you exactly once, and you will never double-schedule.** Grid iteration (`ruler.grid(division)`) does this automatically — it's the primary idiom and covers the large majority of sequencer/arpeggiator/metronome code.

The convention is not enforced by the clock — there's no validation API, no guard wrapper. Scheduling outside the current window is permitted, and is sometimes exactly right: a grace-note or humanize offset computed from an in-window grid point (`gridPointTime + 8ms`) may land past the window edge, and that's still safe, because ownership follows the grid point, which was handed out exactly once. What breaks the contract is deriving an event from something _other_ than data the current window gave you — recomputing a position from scratch, or reusing a beat range across ticks.

If you're an LLM writing an `onTick` callback: always iterate `grid()`/`spans()` rather than hand-computing beat positions, and you get the non-overlap guarantee for free.

## Repeat a source-second range

`new RangeLoop({ start, end }, when)` maps a half-open source interval onto repeated absolute audio times. Every repeat is measured from the original `when` anchor. The projection leaves the supplied Clock running on its own timeline and works without Workspace or any audio source.

```ts prelude=window:TickWindow fragment: application sketch; app-specific classes or callbacks omitted
const loop = new RangeLoop({ start: 1, end: 2.5 }, context.currentTime + 0.05);
// Inside your Clock's onTick:
const audioStart = timeline.beatToTime(window.beat.start);
for (const slice of loop.slices(audioStart, window.time.lookAheadEnd)) {
  // slice.start / slice.end are source seconds. slice.when is the absolute audio start.
  scheduleStems(slice, window);
}
```

Use `slice.cycle` when identifying scheduled events. Intersect each stem with the common range and let short stems fall silent until the shared repeat. See [DAW range audition](./daw.md#audition-a-range-across-audio-tracks) for an implementation.

## Timeline — the beat↔time mapping

`Timeline` owns the transport anchor and the tempo curve — the only two pieces of stored position state in the package. Beat position is always _derived_, never accumulated, so there's no drift over a long session.

```typescript
timeline.beatToTime(64); // absolute AudioContext time for beat 64
timeline.timeToBeat(ctx.currentTime); // current beat position
clock.beat; // the same, as a plain getter on the Clock: advances while playing, holds the paused beat, 0 when stopped, negative in a count-in
```

`timeline.bpm` is a standalone, event-list-backed tempo curve (`TempoParam`) — not an `AudioParam`. It mirrors the Web Audio scheduling methods (`setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime`, `setTargetAtTime`, `setValueCurveAtTime`, `cancelScheduledValues`, `cancelAndHoldAtTime`) plus a `valueAtTime(t)` query the AudioParam-backed `SchedulableParam` in `@audiorective/core` can never support (Web Audio gives no way to ask an `AudioParam` "what will your value be at time T?"). A direct write — `bpm.value = x` or `bpm.$(x)` — is a step at the current audio time. It leaves later scheduled events intact, so a queued step or ramp still overrides it when its time comes; the Clock refreshes the displayed value from the curve every tick.

```typescript fragment: signature listing, not runnable code
class TempoParam extends Param<number> {
  setValueAtTime(value: number, time: number): this; // step at an absolute audio time
  linearRampToValueAtTime(value: number, endTime: number): this; // linear in time from the previous event to `value` at `endTime`
  exponentialRampToValueAtTime(value: number, endTime: number): this; // constant ratio per second between the same points
  setTargetAtTime(target: number, startTime: number, timeConstant: number): this; // exponential approach to `target`, as 128 linear ramps over 8 time constants
  setValueCurveAtTime(values: Iterable<number>, startTime: number, duration: number): this; // exact: linear between evenly spaced values, then holds the last
  cancelScheduledValues(time: number): this; // drop every event at or after `time` (an unfinished ramp reverts to its start value)
  cancelAndHoldAtTime(time: number): this; // drop later events and hold the value in force at `time`, cutting a ramp mid-way
  valueAtTime(time: number): number; // the curve's value at any audio time, interpolated across ramps
}
```

**Ramps.** A ramp event runs from the previous scheduled event (its time and value) to `value` at `endTime`, then holds. With no event scheduled yet it starts from the current value at the current audio time, as for an `AudioParam`. Before a ramp's start event the value holds. A ramp whose `endTime` is not after the previous event is a step. `beatToTime` and `timeToBeat` integrate the curve exactly, so beat positions stay on the grid across an accelerando: beats over a linear segment are the integral of `bpm / 60` (quadratic in time), and an exponential segment has the closed form `(v(b) - v(a)) / ln(v1 / v0) * T / 60`. `bpm.value` follows the interpolated tempo, refreshed every tick. `cancelScheduledValues(t)` removes a ramp that ends at or after `t`, so the tempo falls back to the ramp's start value; `cancelAndHoldAtTime(t)` keeps the ramp's slope up to `t` and holds the interpolated value from there.

**Targets and curves.** `setValueCurveAtTime(values, startTime, duration)` is exact (at least 2 values, all above 0): the tempo is linear between evenly spaced points, which is a chain of linear ramps, then holds the last value. `setTargetAtTime(target, startTime, timeConstant)` starts from the value in force at `startTime` and approaches `target` as `target + (v0 - target) * e^(-(t - startTime) / timeConstant)`. The curve integrates beats analytically, so the approach is scheduled as 128 linear ramps over 8 time constants, each within 0.05% of the swing of the true exponential, and ends exactly on `target`; a zero time constant is a step. Both stop at the next event already scheduled after their start, and an event scheduled later inside their span cuts them there, holding the value reached. `cancelScheduledValues(t)` inside a span also cuts it at `t`.

An accelerando, +40 BPM over 8 bars of 4/4 (32 beats). A linear ramp's mean tempo is the average of its ends, so the end time is `start + beats * 60 / mean`. Hold the present tempo at `start` so the ramp has a defined start event, then check the landing with `beatToTime`:

```typescript
const start = ctx.currentTime;
const from = timeline.bpm.valueAtTime(start);
timeline.bpm.cancelAndHoldAtTime(start); // clear anything queued; a step at `start` is the ramp's first event
const endTime = start + (32 * 60) / (from + 20); // mean tempo = from + 20
timeline.bpm.linearRampToValueAtTime(from + 40, endTime);
// while playing, the ramp ends exactly 8 bars on:
timeline.beatToTime(timeline.timeToBeat(start) + 32); // === endTime
```

A user edit during a ramp needs `cancelAndHoldAtTime(now)` first: `bpm.value = x` alone is a step at `now`, but the ramp's end event is still queued and takes the tempo back toward its target. Hold, then write:

```typescript
timeline.bpm.cancelAndHoldAtTime(ctx.currentTime); // freeze the ramp where it is
timeline.bpm.value = 100; // the user's tempo, with nothing queued to override it
```

Scheduled steps and ramps are visible to `beatToTime` immediately, so scheduling a staircase or an accelerando one segment at a time and converting beats in between is valid.

**What "beat" means:** the axis unit is defined by the tempo curve and nothing else — `bpm` is axis-units per minute, so the unit is literally the B in BPM. It carries no time signature, no bars, no downbeat; it's musically meaningless on its own (like MIDI's quarter-note-normalized ppq ticks) until a ruler interprets it. This is Ableton Link's convention: a float beat plus a bpm, "beat = quarter note" by shared convention.

## Transport

```typescript
clock.start(); // beat 0 now. Also: clock.start(when, offsetBeats), e.g. clock.start(undefined, 16)
clock.pause(); // freezes position; unowned look-ahead audio keeps sounding (an accepted tail, ~lookAhead seconds)
clock.resume(); // continues from the frozen position, no re-scheduling
clock.stop(); // resets to beat 0
clock.seek(64); // jumps to beat 64
```

### Attach several schedulers

`onTick` is optional. `clock.attach(scheduler)` follows the clock with any `{ schedule(window, timing), reset?(reason), transport?(change), attached?(handle) }` and returns a detach function; several schedulers share one transport and stay beat-aligned because they all read the same windows and the clock's `timeline` (`clock.timeline`).

```typescript
const clock = new Clock({ timeline, lookAhead: 0.1 }); // no onTick
const detach = clock.attach({
  schedule(window, timing) {
    // window.beat, window.time.current, window.own(event, when); timing.beatToTime(beat)
  },
  reset(reason) {}, // "start" | "stop" | "pause" | "seek" | "detach": owned events are already cancelled
  transport(change) {}, // { type: "start" | "stop" | "pause" | "resume" | "seek" | "tempo", when, beat }
  attached(handle) {
    // handle.timeline, handle.state, handle.meter, handle.refresh(), handle.cancelFrom(time), handle.detach()
    return () => {}; // cleanup on detach or dispose
  },
});
```

`@audiorective/clock` re-exports the types `BeatTiming` and `CancellableEvent` from core, so a custom scheduler imports its `schedule(window, timing)` and `window.own(event, when)` types from the clock package. `MidiClip` and `MidiRecorder` from [MIDI](./midi.md) are schedulers.

`onTick` runs first, then each attached scheduler in attach order. Owned events registered by any scheduler are cancelled by `start`, `pause`, `stop`, `seek` and `dispose`, and `refresh()` re-queues every scheduler's pending events. Attaching while playing refreshes the look-ahead. An error thrown by one scheduler hook is logged and the others still run. `Scheduler`, `SchedulerHandle`, `SchedulerWindow`, `ResetReason`, `TransportChange` and `TransportChangeType` are exported types; `Workspace.clock` (also `workspace.transport`) is a Clock, so the same `attach` serves a Workspace.

**`reset(reason)`** runs before the transport state changes, after owned events are cancelled. `start()` passes `"start"` (the first window begins at its `offsetBeats`), `stop()` `"stop"`, `pause()` `"pause"` and `seek()` `"seek"`; `detach()` and `dispose()` pass `"detach"`. `resume()` calls none. A scheduler that ignores the reason clears its state on every one, so it behaves as if `reset()` took no argument. A scheduler that keeps work queued while the transport is stopped keeps it on `"start"` and clears it on the others: the first window after `start(when, offsetBeats)` begins at beat `offsetBeats`, which `timeline.beatToTime` maps to exactly `when`.

**`attached(handle)`** runs synchronously inside `attach`, before the first window. The handle carries `timeline` (beat and time mapping, `timeline.bpm`), `state` (the same cell as `clock.state`), `meter` (the same cell as `clock.meter`, read-only here), `refresh()` and `detach()`, so a scheduler can compute beats and know whether the transport plays before any window arrives. It may return a cleanup, which runs on detach or `dispose`, after `reset("detach")`.

**`handle.cancelFrom(time)`** retracts the events this scheduler registered through `window.own` whose start time is `time` (audio-context seconds) or later, synchronously, and nothing else: other schedulers' events, `onTick` events (a window's `own` for `onTick` is untagged) and the scheduler's own earlier events stay. Each event is cancelled as on a transport change (`event.cancel(time)`, errors logged; `time` is the `cancelFrom` time, or now for a transport change or `refresh()`), and an `own` call made while the cancels run is itself cancelled. It re-emits no window and does not move the clock's refill point, so the span from `time` to the end of the last window the scheduler was given stays empty until the scheduler fills it itself, through the `own` of its most recent window (valid until the transport jumps). A `time` earlier than now also cuts events that are sounding. It does nothing after detach and returns nothing. Use it to switch a pattern inside the look-ahead: `cancelFrom(boundary)`, then register the new pattern's events from `boundary` with the last window's `own`. `refresh()` is unchanged and retracts and re-emits every scheduler from now, so a scheduler that calls `cancelFrom` and then `refresh()` must not also replay events by hand.

**`transport(change)`** reports every change once, in call order, after it is applied: the timeline and `state` already show it, and `reset` has run first for the changes it covers. `change.type` is `"start"`, `"stop"`, `"pause"`, `"resume"`, `"seek"` or `"tempo"`; `change.when` is the audio-context time it takes effect and `change.beat` the beat position then (the start offset, the frozen beat of a pause or resume, the seek target, `0` for a stop). A `"tempo"` change fires once for each edit of `clock.bpm` (a `.value` write, `setValueAtTime`, a ramp, `setTargetAtTime`, `setValueCurveAtTime`, `cancelScheduledValues`, `cancelAndHoldAtTime`), not for the tick that refreshes `bpm.value`; its `when` is the time from which the tempo curve may differ, never earlier than now, so a scheduler re-times anything waiting on a beat from there. A clock that shares a `Timeline` hears tempo edits made through any other clock on it. Calls that change nothing (`stop()` on a stopped clock, `pause()` unless playing, `resume()` unless paused) report nothing, though `stop()` still calls `reset("stop")`. `refresh()` is not a transport change.

**`clock.meter`** is a writable `Cell<TimeSignature>` (`[numerator, denominator]`, default `[4, 4]`; `[6, 8]` is six eighths). It lives on the Clock, not the Timeline, because it is a property of what the schedulers play rather than of the beat/time mapping; rulers keep their own bar options. A scheduler reads it through `handle.meter`. A malformed `ClockOptions.meter` throws.

`StepSequencer` (see [Step Sequencer](./sequencer.md)) uses `attached` to re-queue after its own edits and to detach on `dispose()`; it ignores the reason and has no `transport` hook, so it resets on every call.

### Start at an audio time

`start(when = now, offsetBeats = 0)` has the shape of `AudioScheduledSourceNode.start`: beat `offsetBeats` sounds at audio-context time `when`, exactly, and later beats follow the tempo curve from there (the tempo in force at `when` sets the pace of the first beats).

```typescript
clock.start(ctx.currentTime + 0.5); // beat 0 sounds 0.5 s from now
clock.start(buffer.when, 8); // beat 8 sounds at `buffer.when`, in step with a buffer started there
```

- A `when` in the past is clamped to now.
- A `when` in the future puts the transport in `"playing"` at once. Nothing is scheduled to sound before `when`: windows begin at `offsetBeats`, `position` stays at its start value until `when`, and `refresh()` or `pause()` before `when` keep the pending start.
- `offsetBeats` may be negative (a count-in before beat 0).
- A non-finite `when` or `offsetBeats` throws.

### Start with a count-in

`start(undefined, offsetBeats)` accepts a negative beat. The first window begins at that beat, so beat 0 arrives `-atBeat` beats after the call. A launcher or sequencer whose first boundary is beat 0 then waits that long instead of a full bar:

```typescript
clock.start(undefined, -0.5); // beat 0, the first launch boundary, is half a beat away
```

### Own cancellable events when transport edits must cut queued sound

The default remains unchanged: `Clock` does not cancel sound scheduled by `onTick`, so an unowned event may keep playing for up to the look-ahead interval after `pause()`. For a hard stop or an editable pattern, register a returned event handle with `window.own(event, when)`. `when` is its finite, nonnegative absolute `AudioContext` start time. The handle is a core `CancellableEvent` (`cancel(time?)` and `onEnded(listener)`, re-exported by this package; `time` is when the retraction takes effect, so an event that is already sounding can stop there); Clock drops naturally ended events from its registry. A core `Voice` (from `PadBank.trigger()` in [Pads](./pads.md#pad-bank) or `Sampler.trigger()`) is wrapped as one: `{ cancel: (time) => voice.stop(time), onEnded: (done) => void voice.playing.subscribe((playing) => playing || done()) }`. `Timeline` satisfies core's `BeatTiming`, so it can be passed to `StepSequencer.schedule(window, timing)` without any other package in between.

```typescript prelude=timeline:CycleTimeline
const clock = new Clock({
  timeline,
  onTick(window) {
    for (const { when, step } of window.rulers.pattern.grid(16)) {
      if (!pattern.value[step]) continue;
      const voice = instruments.trigger("closed-hat", { when });
      if (voice) {
        // this sequencer owns this hit and its choke
        window.own({ cancel: (when) => voice.stop(when), onEnded: (done) => void voice.playing.subscribe((playing) => playing || done()) }, when);
      }
    }
  },
});

// An edit inside the queued horizon: cancel owned hits at/after now and refill it.
pattern.update((d) => {
  d[3] = false;
});
clock.refresh();
```

For a lane/step pattern use `StepSequencer` (its `onHit` does this registration for you); keep this loop for patterns that are not step lanes.

`pause()`, `stop()`, `seek()`, a fresh `start()`, and `dispose()` cancel all owned events, including those already sounding. `resume()` starts new windows without reviving cancelled events. `refresh()` acts only while playing. It captures one `AudioContext` time, then synchronously cancels owned events whose registered `when` is **at or after** that time, preserves events before it and the transport position, and increments the window generation. The refill happens after the current synchronous work, in one microtask, so `onTick` never runs inside the caller: a launcher method, an effect or an `onTick` itself can call `refresh()` without being re-entered. Calls made before that microtask share the one refill, which starts from the first captured boundary, so any number of edits in one task rebuild the look-ahead once and no beat is skipped; the retraction stays immediate. `pause()`, `stop()`, `seek()`, `start()` and `dispose()` cancel a pending refill (after a `seek` the regular tick starts at the seek target), and a tick that runs first performs it. A hit exactly at `now` belongs to the refill and is emitted once; an already-started hit with `when < now` stays active. It does not touch manual pad hits or other unregistered sound. If an edit must end an earlier hit, its audio owner cancels that handle explicitly. Do not register the same handle with multiple clocks; the caller chooses its owner. Await `clock.refresh()` when subsequent work needs the rebuilt horizon, especially before `ctx.startRendering()`. Its Promise completes after the coalesced refill and any additional refresh requested synchronously by a refill callback. A transport change cancels pending work and completes the waiter; inspect `clock.state.value` if the operation requires playback to remain active. Calling refresh while stopped, paused or disposed resolves without refilling. Detaching cancels only that registration’s owned events, sounding and future, at the current audio instant before its reset and cleanup; other registrations remain active. An attached handle returns the same completion behavior; after detaching, its refresh resolves without touching other registrations. Ordinary realtime edit handlers may ignore the Promise. No timeout, manual tick or microtask drain is needed for completion.

Because the refill is coalesced, filling 16 cells and calling `refresh()` after each write (or letting an attached `StepSequencer` re-queue after each write) costs one refill, so `batch()` is not needed for the re-queue. Use core's `batch` only when observers (an effect, `useValue`) should see one pattern change instead of sixteen.

`pause()` and `resume()` are each a no-op unless the transport is in the state
they act on — only a playing clock pauses, only a paused clock resumes. So
`start()` is the sole entry into playback, and a stray `pause()`/`resume()`
pair on a stopped clock leaves it stopped rather than starting it mid-segment.

`clock.state` is a `ReadonlyCell<"stopped" | "playing" | "paused">` — the same store as `timeline.state`. Read it with `.value` (tracked) or `$()`; only `start`, `pause`, `resume` and `stop` change it, so it cannot be written from outside.

Every jump (`seek`, `start(when, offsetBeats)`, stop→start) bumps `window.generation` and begins a new continuity segment — windows are non-overlapping only _within_ a segment, so beats may legitimately reappear across a backward seek. Consumers holding derived state (step counters, generator positions) should reset when `generation` changes.

Pausing leaves already-committed **unowned** audio alone: up to `lookAhead` seconds of scheduled events keep sounding after `pause()`. This is an accepted tail. Events registered with `window.own()` are cancelled; a consumer that needs a hard stop registers its own handles without making Clock own audio nodes.

## Rulers — reading the beat axis

Musical rulers project the quarter-note beat axis into bars and cycles. Time rulers read the timeline’s pause-aware seconds position directly. Both are **rulers** registered on one Timeline and hold no separate playback position; each reading comes from that shared owner.

```typescript
const withBars = timeline.addRuler("bar", new LinearBarRuler({ numerator: 4, denominator: 4 }));
withBars.rulers.bar.current.value; // tracked read-only point reading, refreshed every tick -- for UI/visuals
```

`current` is the visual-sync surface: a step sequencer lights its current step, a DAW draws its playhead, from the `current` of the ruler that represents the timeline the app is showing.

Four built-ins, crossed along two axes — **unit** (bar vs. raw time) × **topology** (linear, counts forever / cycle, wraps):

|          | Linear                                       | Cycle                                                    |
| -------- | -------------------------------------------- | -------------------------------------------------------- |
| **Bar**  | `LinearBarRuler({ numerator, denominator })` | `CycleBarRuler({ numerator, denominator, bars, from? })` |
| **Time** | `LinearTimeRuler()`                          | `CycleTimeRuler({ seconds, from? })`                     |

**Looping is a `CycleBarRuler` reading, not transport state.** The beat axis never jumps — a loop region `[from, from + bars*beatsPerBar)` is read modulo its length, so scheduling across the loop boundary needs no special case: `grid()` emits points from both sides of the wrap at their correct axis positions, converting to strictly increasing absolute times. The window reading also exposes `spans` — the window's cycle-relative sub-ranges, each with its own conversion back to absolute time — for note content that isn't grid-snapped (the same cycle position converts to a different absolute time on each pass).

### Linear grids count; cycle grids fold

The two kinds of ruler yield different grid points, and the difference is the whole reason to pick one over the other:

| Ruler            | Grid point                               | `division` means    |
| ---------------- | ---------------------------------------- | ------------------- |
| `LinearBarRuler` | `{ beat, when, index }` — counts forever | steps per **bar**   |
| `CycleBarRuler`  | `{ beat, when, step, cycle }`            | steps per **cycle** |

Pass a pattern's length as `division` on a cycle ruler and `step` indexes that pattern directly — the cycle region holds exactly one pass, so no `% length` is needed at the call site:

```typescript prelude=window:TickWindow
for (const { when, step } of window.rulers.pattern.grid(steps.length)) {
  if (steps[step]) sampler.trigger({ when });
}
```

`cycle` is per grid point, not per window: a window can straddle the wrap, so points within one callback may belong to different passes. The global count is still recoverable as `cycle * division + step`.

The fold uses floored division rather than `%`. JavaScript's remainder keeps the sign of the dividend, so a hand-written `index % 16` returns `-1` for the step before the origin and reads off the front of a pattern array — reachable, since `seek()` accepts negative beats and `from` may be positive.

**Swing and per-note micro-timing are deliberately not a ruler concern.** They're a transformation of event placement, which is note-content territory — future work for a track/clip primitive that consumes the clock, not something the clock itself models.

Write a custom ruler for anything else (e.g. polyrhythm — one scheduling loop, a different musical grid) by implementing `Ruler<TWindow, TPoint>`:

`timeline.position` is the transport’s seconds position. Start seeds it from the chosen beat offset at the BPM scheduled at its start instant; seek seeds `targetBeat * 60 / bpm.valueAtTime(now)`. It then advances by real playing seconds. Pauses and a future start hold it; stop resets it. A tempo edit leaves the current seconds position unchanged. Thus bar 5 in 6/8 seeks to beat 12 and seconds position 6 at 120 BPM, or 4 at instantaneous 180 BPM during a ramp. Negative count-in seeds a negative seconds position; a time-cycle ruler normalizes its phase into `[0,1)`.

`TimelineLike` is `BeatTiming` (`beatToTime`, `timeToBeat`: the `timing` argument every `Scheduler.schedule` receives) plus `position`, so a `Timeline` is a `TimelineLike` and a `TimelineLike` is accepted wherever a `BeatTiming` is.

```typescript
interface Ruler<TWindow, TPoint> {
  read(window: CoreTickWindow, timeline: TimelineLike): TWindow; // window-scoped; grid()/spans close over its bounds
  at(beat: number, timeline: TimelineLike): TPoint; // point reading, feeds `current`
}
```

## Miss detection

If the clock fires late and audio time has moved past the previous window's end, those beats are gone — Web Audio cannot schedule into the past. The clock reports the gap via `onMiss` and continues; it does not try to recover. Gone is gone.

```typescript
new Clock({
  timeline,
  onTick /* ... */,
  onMiss(gap) {
    console.warn(`missed ${gap.gapDuration}s`, gap);
  },
});
```

Remedy: raise `lookAhead`.

A freshly-started or freshly-seeked segment's very first tick is exempt from this check — there's no prior emitted window in the new segment to have fallen behind, so comparing against one would be a false positive on every single transport start.

## Live pattern editing

For unowned events, toggling a step whose window has already been committed takes effect on the _next_ pass, leaving up to `lookAhead` seconds of queued sound. If the step's event was registered with `window.own()`, call `clock.refresh()` after the edit to cancel owned events at or after the captured audio time and refill that window in a microtask. A hit that began before that boundary remains active until its owner cancels it.

## Tick sources

`Clock` defaults to `WorkerTickSource` (a Web-Worker timer, so ticks continue in background tabs). `IntervalTickSource` (setInterval fallback) and `ManualTickSource` (deterministic, hand-driven ticks — how this package's own tests work without a real `AudioContext`) are also exported.

A `TickSource` serves one `Clock`: the Clock calls `start(onTick)` on construction and `stop()` on `dispose()`, whether it created the source or you passed it as `tickSource`. Do not share a source between clocks, and create a fresh one per Clock.

## Rendering offline — `renderTimeline`

`renderOffline` (from `@audiorective/core`) builds an `OfflineAudioContext`, runs your setup, and renders. That is enough when everything is scheduled up front at absolute times, but not for a `Clock`: an offline context's `currentTime` never moves before rendering starts and then races through the whole render in milliseconds, so a timer-driven tick source emits one `lookAhead` window and starves.

`renderTimeline` is `renderOffline` for a clock-driven graph. It hands `setup` a tick source to build the `Clock` on, fires the first tick at time 0 once `setup` returns, then suspends the render every `tickInterval` (default 25 ms, the clock's own default), ticks, and resumes. The clock reads the context's real `currentTime` throughout, so nothing else changes — same `Timeline`, same rulers, same `onTick`.

```typescript
import { Sampler, loadAudioBuffer } from "@audiorective/core";
import { Clock, Timeline, CycleBarRuler, renderTimeline } from "@audiorective/clock";

const wav = await renderTimeline({ seconds: 8, channels: 2, sampleRate: 44100 }, async (ctx, tickSource) => {
  const kick = new Sampler(ctx, { sound: await loadAudioBuffer(ctx, "/kick.wav") });
  kick.connect(ctx.destination);

  const timeline = new Timeline({ audioContext: ctx, bpm: 120 }).addRuler("pattern", new CycleBarRuler({ numerator: 4, denominator: 4, bars: 1 }));
  const clock = new Clock({
    timeline,
    tickSource, // the one injection -- everything else is the live code
    onTick(window) {
      for (const { when, step } of window.rulers.pattern.grid(16)) if (pattern.value[step]) kick.trigger({ when });
    },
  });
  clock.start(); // inside setup: the first window is emitted as soon as setup returns
});
```

Two rules carry over from live playback. Keep `tickInterval` below the clock's `lookAhead`, or the clock reports misses offline exactly as it would live. And one tick source drives one clock — the one-clock rule below. One rule is offline-only: a render can pause only on a 128-frame render-quantum boundary, so ticks are never closer than one quantum (about 2.9 ms at 44.1 kHz), and a smaller `tickInterval` ticks once per quantum.

### Scripted user actions during an offline render

To launch a clip, edit a pattern or change tempo at a named audio time, wrap the injected tick source and run the actions from inside the tick, on the clock's own schedule:

```typescript
const actions = [{ at: 2, run: () => launcher.tracks.drums.clips[1]?.launch({ quantize: "1m" }) }];

const wav = await renderTimeline({ seconds: 8, channels: 2, sampleRate: 44100 }, (ctx, source) => {
  const tickSource: TickSource = {
    start: (onTick) =>
      source.start(() => {
        while (actions.length && actions[0].at <= ctx.currentTime) actions.shift()!.run();
        onTick();
      }),
    stop: () => source.stop(),
  };
  const clock = new Clock({ timeline, tickSource, onTick });
  clock.start();
});
```

An action lands on the first tick at or after its time, and ticks are one render quantum apart at best, so record `ctx.currentTime` when it runs and use that, not the requested time, in expectations.

**Actions and asynchronous results.** `options.actions` is a list of `{ at, run }` closures (a user pressing record, launching a clip) that run at audio time `at`, on the render quantum at or before it and before that quantum's tick. When `run` returns a promise the render stays suspended until it settles, so an action that returns `recorder.record(...)`'s take, or awaits one delivered by an AudioWorklet, sees it complete before the next tick instead of arbitrarily late in audio time. A rejection fails the render, and an action beyond the render is ignored.

A type that owns its `Clock` needs to accept `tickSource` to be renderable this way — `apps/web/src/demos/sequencer`'s `DrumMachine` does, and its tests render the whole machine through its limiter graph with `renderTimeline`. Unlike a fake `currentTime`, that is a real seam and not a test-only option: it is how the same class runs live and exports offline.

## Testing scheduling deterministically

The repo's rule is that audio logic runs in a unit test with no DOM. For time, that needs **two** injections, and they are separate parameters on purpose:

- `tickSource: new ManualTickSource()` — ticks fire only when the test calls `tick()`.
- `audioContext: { currentTime }` — a plain object the test advances by hand. `Timeline` only ever reads `currentTime`, so it accepts any object with that property.

```typescript
const fakeClock = { currentTime: 0 };
const tickSource = new ManualTickSource();
const timeline = new Timeline({ audioContext: fakeClock, bpm: 120 }).addRuler("bar", new LinearBarRuler({ numerator: 4, denominator: 4 }));
const clock = new Clock({ timeline, tickSource, onTick: (w) => collect(w) });

clock.start();
for (let t = 0; t <= 1.85; t += 0.05) {
  fakeClock.currentTime = t; // "now" moves only here
  tickSource.tick(); // windows are emitted only here
}
```

Every assertion is then exact — no tolerances, no polling, no flake.

### When you can't inject — testing a type that owns its Clock

The two parameters above are the right approach when the code under test _takes_ a `Timeline` or a `Clock`. A class that builds its own — as `apps/web/src/demos/sequencer`'s `DrumMachine` does — shouldn't grow constructor options that exist only for tests (`tickSource` earns its place there because offline rendering needs it; a fake `currentTime` would not). Mock the seams instead:

```typescript fragment: application sketch; app-specific classes or callbacks omitted
// "now": an own property shadowing the prototype getter on a real context
let now = 0;
Object.defineProperty(ctx, "currentTime", { get: () => now, configurable: true });

// ticks: capture the callback, so no Worker ever spawns
let tick: (() => void) | undefined;
vi.spyOn(WorkerTickSource.prototype, "start").mockImplementation((onTick) => {
  tick = onTick;
});
vi.spyOn(WorkerTickSource.prototype, "stop").mockImplementation(() => {});

// what was scheduled: read the real call, not a parallel notification
const kick = vi.spyOn(machine.tracks[0].sampler, "trigger");
```

**Shadow the instance; don't wrap it in a `Proxy`.** Web Audio constructors brand-check their context argument, so a proxied context fails with `Failed to construct 'GainNode': parameter 1 is not of type 'BaseAudioContext'`. Defining an own `currentTime` on the real context has no such problem — the nodes keep working, only the reading changes.

Two consequences worth planning for. The prototype spies are global state, so `vi.restoreAllMocks()` in `afterEach` is not optional. And with no callback reporting step indices, you recover them from the scheduled `when` (`Math.round(when / stepDuration) % patternLength`) — which assumes beat 0 sits at time 0, so any test that crosses a `stop()`/`play()` restart must assert on the times themselves, since a restart re-anchors beat 0 to "now".

Two things to remember when writing assertions:

- A window at `now` already covers `now + lookAhead`, so a loop ending at `t` has committed events up to `t + 0.1` with the defaults. Pick loop bounds accordingly, or you will "lose" a step you expected or gain one you didn't.
- Pair the deterministic tests with one real-`WorkerTickSource` smoke test, and poll for the data instead of sleeping a fixed duration.

## Non-goals

- **Multiple clocks.** One scheduling loop, one source of temporal truth — rich windows + rulers cover metronome/secondary-loop/polyrhythm use cases.
- **Syncing `FilePlayer`.** It runs on the media clock and cannot sample-lock to ctx-clocked sources; the clock governs ctx-clocked sources (`BufferPlayer`, `Sampler`, synths).
- **Note content and micro-timing** live in [StepSequencer](./sequencer.md) and [MIDI](./midi.md); they attach to this timing owner.
- **String time notation.** Plain floats only.
