---
title: "Step Sequencer: advanced"
---

The explicit `{ size, lanes }` form, commands, `refreshOnEdit`, transform sockets, custom per-step params, a switchable clip and the standalone drum machine for `@audiorective/blocks/sequencer`. Start with [Step Sequencer](./sequencer.md) (the lane-record form, semantics and errors); the errors table there covers both forms.

## Lane-record details

`StepSequencer` owns an editable looping pattern: per-lane length, rate, direction and swing, per-step velocity, offset, length, repeat, pitch and chance, and any numbers you declare per step. It has two constructor forms: the **lane-record form** (name lanes, get hits), and the [explicit form](#explicit-form) (shared loop, your own trigger). A fuller lane-record example, with a sample `sound`, lane `swing` and a lane `params` entry:

```ts
import { Clock } from "@audiorective/clock";
import { StepSequencer } from "@audiorective/blocks/sequencer";

const seq = new StepSequencer(
  {
    kick: "X...X...X...X...",
    snare: { pattern: "....X.......X...", swing: "30%", rate: "16n", sound: snareBuffer },
    hat: { pattern: "x.x.x.x.x.x.x.x.", sound: "C6", params: { cutoff: { min: 200, max: 8000, default: 1200 } } },
  },
  {
    context: ctx,
    seed: 1,
    onHit: (hit) => {
      /* hit.lane, index, when, duration, velocity, values, loop */
    },
  },
);
const clock = new Clock({ context: ctx, bpm: 120 }); // one object: it makes its own Timeline
const detach = clock.attach(seq); // or workspace.transport.attach(seq)
clock.start(ctx.currentTime + 0.5); // clock.bpm.value = 140 changes tempo

Patterns are `X` (velocity 1), `x` (0.8), `1`..`9` (tenths), `.` (rest), spaces ignored; or an array of velocities. Each lane loops forever on its own length at its own rate (true polymeter: lanes of 5, 16 and 8 steps drift apart and realign), starting at beat 0. `rate` is a `Time`: `"16n"` (a quarter of a beat), `"16n."` dotted, `"8t"` triplet, `"1m"` four beats; `"250ms"`, `"2s"` or a number are seconds, converted to beats at the tempo at beat 0. The `StepRate` names (`"1/16"`) also work. `swing` is 0..1 or `"30%"` and delays every second step by that fraction of half a step. Index counts from 0: `hit.index` and `steps[i]` are zero-based: `steps[0]` is the first step, `steps[6]` the seventh.

- **Hear each hit.** `onHit(hit)` runs ahead of time for every hit that will sound; `seq.addEventListener("hit", (e) => e.hit)` and `seq.onhit = fn` receive the same `HitEvent`. A lane can also carry its own `onHit`.
- **Edit live.** `lane.pattern`, `rate`, `swing`, `mute` and `sound` are live setters. Lane `params` declare per-step numbers (`{ min, max, step?, default }`); each step holds one per name and `hit.values` carries them.
- **Give a lane a sound.** `sound` is a note name (`"C6"`, a built-in tone), an `AudioBuffer` or a function returning an `AudioScheduledSourceNode`, and needs `options.context`. The lane owns one voice per hit (velocity scales its gain; a retracted hit never sounds) and exposes `lane.output: GainNode`, joined to `context.destination` until `lane.connect(node)` reroutes it (returns `node`) or `lane.disconnect()`. Without a sound the sequencer only reports hits.

class StepSequencer extends EventTarget {
constructor(lanes: Record<string, Pattern | LaneOptions>, options?: { context?; seed?; onHit?; transform?; transforms?; signal?; random? });
readonly lanes: Readonly<Record<string, Lane>>;
lane(name: string): Lane;
onhit: ((this: StepSequencer, e: HitEvent) => unknown) | null;
attached(handle: { refresh(): void; detach(): void }): () => void; // called by clock.attach
dispose(): void;
}
class Lane {
name;
length;
pattern;
rate;
swing;
mute;
sound;
params;
output: GainNode;
connect(node): AudioNode;
disconnect();
readonly steps: readonly Step[];
} // steps: 0-based
type Step = { velocity: number; readonly values: Record<string, number> };
type Hit = { lane: string; index: number; when: number; duration: number; velocity: number; values: Readonly<Record<string, number>>; loop: number };

```

`attach` tells the sequencer which transport it follows (`Scheduler.attached(handle)`, see [Clock](./clock.md#attach-several-schedulers)); that is how edits re-queue without `refreshOnEdit`. A sequencer attached to two clocks queues on both.

## Explicit form

`new StepSequencer({ size, lanes }, trigger, options)` keeps the lanes in one shared loop of `size` 1/16 steps, calls your `trigger` for each hit and leaves routing and re-queuing to you (`refreshOnEdit`, `Workspace.attachStepSequencer`). Everything below documents it. `onHit`, `context` and `sound` belong to the lane-record form; `transform` and `signal` work in both.

```ts
type StepRate = "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "1/64" | "1/2T" | "1/4T" | "1/8T" | "1/16T" | "1/32T" | "1/64T";
type StepDirection = "forward" | "backward" | "bounce";
type StepCell = { velocity; offset; length; repeat; pitch; chance; custom: Readonly<Record<string, number>> };
type StepLane = { id; label; steps; rate; direction; swing; mute; solo; cells: readonly StepCell[] };
type StepPattern = { size: number; lanes: readonly StepLane[] };
new StepSequencer(pattern: StepPatternInput, trigger: (hit: StepHit) => CancellableEvent | null, options?: { seed?: number; random?: () => number; params?: readonly StepParamSpec[]; transforms?: readonly StepTransform[] });
```

`size` is the loop length in 1/16 steps (integer 1..128, so the loop lasts `size / 4` beats). Input is partial and filled with defaults: a lane gets `label = id`, `steps = size`, `rate = "1/16"`, `direction = "forward"`, `swing = 0`, `mute`/`solo` false and every cell off; a cell gets `velocity 0`, `offset 0`, `length 1`, `repeat 1`, `pitch 0`, `chance 1` and `custom` set to each declared param's default (`{}` without `params`). Every lane always holds `size` cells; cells beyond its `steps` are kept but not played.

| Cell field | Range           | Meaning                                            |
| ---------- | --------------- | -------------------------------------------------- |
| `velocity` | 0..1            | 0 turns the step off                               |
| `offset`   | -0.5..0.5       | shift of the hit, as a fraction of one lane step   |
| `length`   | 1/16..4         | hit duration in lane steps (divided among repeats) |
| `repeat`   | integer 1..8    | hits evenly spaced inside the step                 |
| `pitch`    | integer -24..24 | semitones, passed to the trigger                   |
| `chance`   | 0..1            | probability that the step plays                    |

The ranges are data, in one place. `sequencer.cellParams` (also exported as `stepCellParams`) lists these six fields as `readonly StepParamSpec[]` in the order above, as core `ParamSpec`s, the same `{ id, label, min, max, default, step }` shape as a custom param (`step` is the editing hint; `repeat` and `pitch` are enforced as integers). `sequencer.rates` (also `stepRates`) lists the twelve `StepRate`s in display order, straight 1/2 to 1/64 then the triplets. Validation and views read the same constants, so a view needs no copy of them.

Lane fields: `steps` (integer 1..`size`, the lane's own length, so lanes of different lengths drift against each other), `rate` (a `StepRate`; straight 1/2 = 2 beats down to 1/64 = 1/16 beat, and a `T` rate is two thirds of the straight one), `direction`, `swing` (0..1; the `stepSwing` transform delays every odd lane step by `swing * 0.5` lane steps, a fixed beat offset at any tempo), `mute` and `solo`.

**Timing.** Every lane restarts at each loop boundary, measured from beat 0 of the timing; a lane whose rate does not divide the loop is cut off at the loop end. With `k` the lane step counter in the loop, the played cell is `k mod steps` going forward, `steps - 1 - (k mod steps)` backward, and a ping-pong without repeating the end cells for `bounce` (`0 1 2 1 0 1 ...` for 3 steps; a 1-step lane stays on cell 0). A hit starts at beat `loopStart + k * rate`, plus `offset * rate`, then the transforms run in beats (by default `stepSwing` adds swing); the result is converted to seconds through the timing and a start already in the past plays at the window's current time. A step with `repeat = r` plays `r` hits at `i * rate / r` and each lasts `length * rate / r` beats. A lane plays when it is not muted and either no lane is soloed or it is soloed. A step plays when `velocity > 0` and its chance draw is below `chance`. The draw is a pure function of `options.seed` (default 0), the lane `id`, the loop and the step counter, so it is the same in every window, re-queue, edit and seek, and it happens once per step: all repeats of a step play or none do. Pass a different `seed` per instance or run for a different pattern. `options.random` replaces the draw with a sequential source (each call advances it, so a re-queue draws new numbers and pending chance steps can flip); use it only to script exact draws in tests.

The trigger receives a `StepHit` and returns a `CancellableEvent` (`cancel()` and `onEnded()`) or `null`; a `PadHit` is one.

```ts
type StepEvent = TimedBeatEvent & {
  // beat, durationBeats, velocity (core): where the hit sounds and how long, in beats, after offset and repeat
  laneId: string;
  step: number; // cell index
  count: number; // the lane's step counter k within the loop
  stepBeat: number; // beat of the lane step boundary (before offset and repeat)
  rateBeats: number;
  swing: number; // the lane's swing value
  pitch: number;
  custom: Readonly<Record<string, number>>;
  loop: number; // floor(stepBeat / loopBeats): loops since timing beat 0
  repeatIndex: number;
  repeatCount: number;
};
type StepHit = SecondsOf<StepEvent>; // the same fields with beat -> when and durationBeats -> duration
```

`StepEvent` is what transforms read and return. `StepHit` is what the trigger receives: final, after the transforms and the clamp to the window's current time.
On a `StepHit`, `when` is absolute audio-context seconds and `duration` is seconds. `loop` supports conditional triggers such as "every 2nd loop" (`hit.loop % 2 === 0`) without the block knowing about them.

The trigger can delegate to `PadBank.trigger(id, velocity, when, { pitch, duration })`. The sequencer tracks and cancels only events returned by that callback. Use a separate call to the instrument for manual hits.

`schedule(window, timing)` reads the caller's transport window and registers its hits via `window.own(event, when)`. `timing` is any `BeatTiming`; pass the same `Timeline` the window came from.

`schedule` takes a `StepWindow`, a structural subset of the clock's tick window, so you can pass the real window or a hand-built one:

```typescript
type StepWindow = Readonly<{
  beat: { start: number; end: number }; // beats this call may schedule
  time: { current: number }; // audio time hits are clamped to
  own(event: CancellableEvent, when: number): void; // registers each hit for cancel
}>;
```

### Edits and the look-ahead

The clock has already scheduled the next window when you edit, so an edit applies to later windows unless the look-ahead is rebuilt. `refreshOnEdit(sequencer, transport)` does that: it calls `transport.refresh()` once per committed change of `pattern` or `transforms` (a `batch` counts once) and returns a disposer. `Clock.refresh()` cancels owned hits at once but refills in a microtask, and repeated calls in one task share that refill, so any number of edits in the same task rebuild the look-ahead once.

```ts
import { refreshOnEdit } from "@audiorective/blocks/sequencer";

const stopRefresh = refreshOnEdit(sequencer, clock); // `transport` is anything with refresh(), such as a Clock
sequencer.setCell("closed", 4, { velocity: 0 }); // the queued look-ahead is rebuilt without a manual refresh()
stopRefresh(); // before the clock is destroyed
```

Each `setCell`, `toggle`, `setLane` or `setTransforms` call outside a `batch` is its own commit, so effects watching the pattern run once per call. The look-ahead refill is coalesced either way. To change many cells at once, such as filling a Euclidean pattern, wrap them in core's `batch` so observers (a grid, a counter) see one coherent change:

```ts
import { batch } from "@audiorective/core";

batch(() => {
  for (let step = 0; step < 16; step++) sequencer.setCell("kick", step, { velocity: hits[step] ? 1 : 0 });
});
```

It does not refresh on attach, and calling it inside an effect does not subscribe that effect. [The DAW runtime](./daw.md#step-sequencer) already uses it for an attached pattern.

## A pattern as a switchable clip

To start and stop a pattern on a launch boundary, make one `StepSequencer` per launch and give it a window and timing shifted so its beat 0 is the launch beat. Clip the window to the clip's beat range so it never schedules outside it.

```ts
// In the Clock's onTick; startBeat is the launch boundary, endBeat the stop boundary (or Infinity).
const start = Math.max(window.beat.start, startBeat);
const end = Math.min(window.beat.end, endBeat);
if (start < end) {
  sequencer.schedule(
    {
      beat: { start: start - startBeat, end: end - startBeat }, // pattern-local beats
      time: window.time,
      own: (event, when) => window.own(event, when),
    },
    {
      beatToTime: (local) => timeline.beatToTime(local + startBeat),
      timeToBeat: (time) => timeline.timeToBeat(time) - startBeat,
    },
  );
}
```

The pattern plays from step 0 at `startBeat` whatever the transport position was. To stop it, call `sequencer.reset()` to cancel its pending hits and stop calling `schedule`. Drive `startBeat` and `endBeat` from a [Clip Launcher](./launcher.md#clip-launcher) transition, or from your own state.

**A re-queue calls the trigger again.** `refresh()`, `reset()`, stop and seek cancel every owned hit that has not ended and the next window builds the hits again, so the trigger runs again for every still-pending hit, not only the edited one. Keep the trigger free of state that a cancel cannot undo: do not count hits in it, and do not leave behind scheduling on a node you own (a filter cutoff, a send level). Derive counts from the pattern, not from trigger calls. To retract extra scheduling, wrap the event with core's `withCancel(event, undo)`: its `cancel()` cancels the event and runs `undo` once.

```ts
import { withCancel } from "@audiorective/core";

const sequencer = new StepSequencer(
  pattern,
  ({ laneId, velocity, when, duration, custom }) => {
    const hit = bank.trigger(laneId, velocity, when, { duration });
    filter.frequency.setValueAtTime(200 * 2 ** (custom.cutoff * 6), when); // extra scheduling, so retractable
    return withCancel(hit, () => filter.frequency.cancelScheduledValues(when));
  },
  { params: [{ id: "cutoff", min: 0, max: 1, default: 0.5 }] },
);
```

`cancelScheduledValues(when)` drops that value and every later one on the param, which is right because the look-ahead is rebuilt together. `undo` runs once, and not for an event that already ended on its own. When the trigger returns `null` for an unknown pad, `withCancel(null, undo)` still gives the sequencer a handle to cancel.

**State and commands.** `pattern` is a read-only reactive cell of the `StepPattern`; `transforms` is a read-only cell of the transform list; `playheads` is a read-only cell of `Record<laneId, cellIndex | null>` (the cell each lane is on at the window's current time) and `loopProgress` is a read-only cell of the 0..1 loop position or `null`. Only the sequencer writes them. Commands:

- `setCell(laneId, step, patch)` changes any subset of one cell's fields in one write.
- `toggle(laneId, step)` turns an off cell on at velocity 1 and an on cell off; its other fields are kept.
- `setLane(laneId, patch)` changes any of `label`, `steps`, `rate`, `direction`, `swing`, `mute`, `solo`.
- `setSize(size)` truncates or pads every lane's cells with off cells and clamps each lane's `steps` to the new size.
- `setTransforms(list)` replaces the transform list in one write (see below).
- `reset()` cancels pending events and sets every playhead and `loopProgress` to `null`.

## Custom per-step parameters

The six built-in cell values affect timing, so the sequencer understands them. Anything else is caller data: declare it once and the sequencer stores, validates and passes it to the trigger.

```ts
const sequencer = new StepSequencer(pattern, ({ custom, when, laneId }) => /* set a filter from custom.cutoff at `when` */ null, {
  params: [{ id: "cutoff", label: "Cutoff", min: 0, max: 1, default: 0.5, step: 0.01 }], // StepParamSpec, an alias of core ParamSpec
});
sequencer.params; // the declared specs, read-only and fixed at construction
sequencer.setCell("kick", 0, { custom: { cutoff: 0.4 } }); // partial merge; other custom ids keep their values
```

Ids must be unique, nonempty, differ from the built-in cell keys and from `custom`, with `min < max` and `default` inside the range. Every cell carries `custom` with exactly the declared ids. `setCell` and the constructor reject undeclared ids and values outside `min..max`; `step` is a hint for views and is not enforced.

## Transform sockets

New expressive behaviour plugs in as a `StepTransform` (an `EventTransform<StepEvent>`, a core contract, see [Core](./core.md#shared-contracts)) instead of growing the block. After the sequencer has computed a window's hits it runs the `transforms` in array order over them, converts the result to seconds, then triggers every hit.

A transform works in beats by default: it reads and returns `StepEvent`s with `beat` and `durationBeats`, so moves are tempo-independent beat arithmetic. A transform that sets `unit: "second"` reads and returns the same hits as seconds (`when`, `duration`); the sequencer converts through the timing before it and back to beats after it.

```ts
import { defaultStepTransforms, stepSwing, StepSequencer, type StepTransform } from "@audiorective/blocks/sequencer";

// Beat transform: push odd lane steps late by a sixteenth of a beat, whatever the tempo.
const lazy: StepTransform = {
  id: "lazy",
  apply: (hits) => hits.map((hit) => (hit.count % 2 ? { ...hit, beat: hit.beat + 0.0625 } : hit)),
};

// Seconds transform: humanize each hit by up to 5 ms either way.
const humanize: StepTransform = {
  id: "humanize",
  unit: "second",
  apply: (hits, { randomFor }) => hits.map((hit) => ({ ...hit, when: hit.when + (randomFor(hit) - 0.5) * 0.01 })),
};
sequencer.setTransforms([...defaultStepTransforms, lazy, humanize]); // keep swing, add mine
```

`defaultStepTransforms` is `[stepSwing()]`, and it is the default for the `transforms` option. `stepSwing()` (`id: "step-swing"`) delays hits whose `count` is odd by `swing * 0.5 * rateBeats` beats, so swing stays a fixed beat offset when the tempo changes. Passing `transforms: []` or a list without it makes every lane's `swing` inert and gives straight timing.

Rules the sequencer enforces and never leaves to the transform:

- Transforms run in array order on each window's hits, before anything is triggered. The hits are converted between beats and seconds only where consecutive transforms differ in `unit`.
- `context.now` is the window's current time in the transform's unit (beats for a beat transform, seconds for a seconds transform).
- After the last transform the hits are converted to seconds through the timing, and a hit earlier than the window's current time plays at that time. The trigger never sees a `when` before it.
- A returned hit with a non-finite `beat` (`when` in a seconds transform), a `durationBeats` (`duration`) that is not above 0, or a `velocity` outside 0..1 throws an error that names the transform `id`; so does a `unit` other than `"beat"` or `"second"`. `velocity` 0 drops the hit.
- A transform never triggers or cancels audio. The sequencer triggers every returned hit and owns it with `window.own`, so `reset()`, stop and seek still retract added hits.
- A transform keeps no hidden state across windows: what it needs (beat, loop, lane data) is on the hit. Randomness comes only from `context.randomFor(hit, key?)`, a number in [0, 1) that is a pure function of `options.seed`, the hit's lane, loop, step counter and repeat index, and `key`, so a hit gets the same number however often or in whichever window it is scheduled; pass different `key`s for several independent draws per hit. `context.random` is a sequential source (`Math.random` unless `options.random` is set) whose numbers change on every re-queue, so a transform that uses it is not stable.

Chance, repeat, offset, mute/solo, direction and polymeter stay built in. `setTransforms` is a command like the others: it changes the `transforms` cell once and never subscribes a calling effect. Call the clock's `refresh()` afterwards to rebuild the unplayed look-ahead.

A `StepSequencer` holds no nodes, timers or effects, so `reset()` releases everything it owns and there is no `destroy()`. The commands, `schedule` and `reset` never subscribe an effect that calls them. [The DAW runtime](./daw.md#step-sequencer) wires the scheduling and refresh for an attached pattern.

## Standalone drum machine

A vanilla drum machine with no DAW: your decoded buffers, a `Clock` driving the sequencer, and the step grid for editing. Closed and open hat share a choke `group`, so each pad ID doubles as its lane ID. To give the two hat lanes separate effects, call `bank.routePad("open", openFilter)` and `bank.routePad("closed", closedFilter)`: choke still crosses them.

```ts
import { Clock, Timeline } from "@audiorective/clock";
import { PadBank } from "@audiorective/blocks/pads";
import { refreshOnEdit, StepSequencer, type StepPatternInput } from "@audiorective/blocks/sequencer";
import { mountStepGrid } from "@audiorective/widgets";

const context = new AudioContext(); // you own it; resume() it from a user gesture
// kick, snare, closedHat, openHat: AudioBuffers you decoded yourself
const bank = new PadBank(context, [
  { id: "kick", buffer: kick },
  { id: "snare", buffer: snare },
  { id: "closed", buffer: closedHat, group: "hat" },
  { id: "open", buffer: openHat, group: "hat" }, // a one-shot (no gate) is still choked by a later closed hit
]);
bank.output.connect(context.destination);

const steps = (...on: number[]) => Array.from({ length: 16 }, (_, step) => ({ velocity: on.includes(step) ? 1 : 0 }));
const pattern: StepPatternInput = {
  size: 16, // sixteenth notes; lanes default to 1/16 and 16 steps
  lanes: [
    { id: "kick", label: "Kick", cells: steps(0, 4, 8, 12) },
    { id: "snare", label: "Snare", cells: steps(4, 12) },
    { id: "closed", label: "Closed hat", cells: steps(0, 4, 8, 12) },
    { id: "open", label: "Open hat", cells: steps(2, 10) },
  ],
};
const sequencer = new StepSequencer(pattern, ({ laneId, velocity, when, pitch, duration }) =>
  bank.trigger(laneId, velocity, when, { pitch, duration }),
);
const timeline = new Timeline({ audioContext: context, bpm: 120 });
const clock = new Clock({ timeline, onTick: (window) => sequencer.schedule(window, timeline) });
const stopRefresh = refreshOnEdit(sequencer, clock); // every edit re-queues the look-ahead
const grid = mountStepGrid(document.querySelector("#grid")!, { sequencer }); // click toggles; drag a cell or use the arrow keys to edit the active parameter

await context.resume();
clock.start(); // clock.stop() ends playback and cancels queued hits
timeline.bpm.value = 140; // takes effect on the next look-ahead window

// Edits in the grid or code re-queue the look-ahead at once.
// A deleted closed-hat step that has not played yet no longer chokes the open hat.
sequencer.setCell("closed", 4, { velocity: 0 });

// Teardown: the caller keeps the AudioContext.
grid.destroy();
stopRefresh();
clock.destroy();
bank.destroy();
```

`TickWindow` already has the `beat`, `time` and `own` shape `schedule()` reads, and `Timeline` is the `BeatTiming`. The same wiring runs in `packages/blocks/tests/drum-machine-doc.browser.test.ts`.
