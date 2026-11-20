---
title: Step Sequencer
---

Step patterns and lanes from `@audiorective/blocks/sequencer`. Part of [Blocks](./blocks.md). Signatures, option lists, field ranges and units are in the package's type declarations (`sequencer.d.ts`, JSDoc on every member); this page holds what the types do not say. Deep topics (custom `transform`, per-step field semantics, shared transports, step grid wiring, a full drum machine) are on [Step Sequencer: advanced](./sequencer-advanced.md).

`StepSequencer` owns looping lanes of steps and borrows its time from a clock or transport. There is one way to build it: a record of named lanes. It imports only `@audiorective/core`.

## Layer 1: a pattern as strings

```ts
import { Clock } from "@audiorective/clock";
import { StepSequencer } from "@audiorective/blocks/sequencer";

const seq = new StepSequencer({ kick: "X...X...X...X...", hat: "x.x.x.x.x.x.x.x." }, { context });
const clock = new Clock({ context, bpm: 120 }); // makes its own Timeline
const detach = clock.attach(seq); // or workspace.transport.attach(seq)
clock.start(context.currentTime + 0.5); // clock.bpm.value = 140 changes tempo
```

A pattern is `X` (velocity 1), `x` (0.8), `1`..`9` (tenths), `.` (rest), spaces ignored; or an array of velocities. `lane.length` is the pattern's length. Without a `sound` a lane only reports hits (`onHit`, `hit` events). `clock.attach(seq)` is all the wiring: each committed edit re-queues the look-ahead, and stop, pause and seek retract pending hits.

## Layer 2: per-lane options

```ts
const seq = new StepSequencer(
  {
    kick: { pattern: "X...X...X...X...", sound: kickBuffer },
    hat: { pattern: "x.x.x.x.x.x.x.x.", sound: "C6", rate: "16n", swing: "30%", params: { cutoff: { min: 200, max: 8000, default: 1200 } } },
    perc: { pattern: "x..x.", rate: "8t", direction: "bounce" }, // 5 steps against 16: polymeter
  },
  { context },
);
seq.lanes.hat.mute = true; // live setters: pattern, rate, swing, direction, mute, solo, sound, length
```

- **Each lane loops on its own length and rate** (true polymeter), starting at beat 0 of the transport.
- **`rate`** is a `Time` (`"16n"` a quarter of a beat, `"16n."` dotted, `"8t"` triplet, `"1m"` four beats) or a `StepRate` (`"1/16"`). Seconds (`"250ms"`, `"2s"`, a number) convert to beats at the tempo at beat 0, so a later tempo change does not rescale them; use note values to follow tempo.
- **`swing`** (0..1 or `"30%"`) delays the odd steps, counting from 0 (steps 1, 3, 5 ... late), by a fixed beat offset at any tempo.
- **`sound`** is a note name, an `AudioBuffer` or a function `(context, hit) => AudioScheduledSourceNode`, and needs `options.context`. Each hit gets its own voice into `lane.output` (a `GainNode` joined to the destination until `lane.connect(node)`). A note name or buffer follows a step's `pitch` automatically; a factory reads `hit.pitch` itself.
- **`solo`**: while any lane is soloed, only soloed lanes play.
- **Playhead:** `lane.playhead` is the 0-based step index the transport is on, and `lane.progress` is 0..1 through the lane's own loop; both are `null` while stopped and update once per scheduling window. They are tracked reads, so an effect or a framework hook re-runs on them.
- **`length` is settable**; growing it brings back the steps a shorter length hid.

## Layer 3: per-step fields

```ts
seq.lanes.kick.steps[4].velocity = 0.8; // 0-based: steps[0] is the first step, as hit.index is
seq.lanes.hat.steps[3].repeat = 3; // a ratchet
seq.lanes.hat.steps[0].values.cutoff = 400; // a declared per-step number
seq.lanes.kick.pattern = "X..x"; // also sets the length
```

Each step holds `velocity` (0 is a rest), `offset`, `length`, `repeat`, `pitch`, `chance` and one number per declared lane `params` entry (`values`). Units and ranges are in the `Step` JSDoc, semantics in [advanced](./sequencer-advanced.md#per-step-fields). Writes validate and commit through the sequencer; a running transport hears them on the next pass. Several writes in one task re-queue once; wrap many in core's `batch` so observers see one change.

## Layer 4: hooks

```ts
const seq = new StepSequencer(lanes, {
  context,
  seed: 1,
  onHit: (hit) => {
    filter.frequency.setValueAtTime(hit.values.cutoff, hit.when);
    return () => filter.frequency.cancelScheduledValues(hit.when); // cleanup
  },
  transform: (hit, random) => ({ ...hit, when: hit.when + (random("t") - 0.5) * 0.01 }), // humanize; return null to drop
});
```

- **Hits are scheduled ahead and can be retracted.** `onHit(hit)`, the `hit` event (`seq.addEventListener("hit", e => e.hit)`, `seq.onhit = fn`) and a lane's own `onHit` run before the hit sounds, with `hit.when` in audio-context seconds. A pending hit is retracted when an edit re-queues it, when the transport stops, pauses or seeks, or on `dispose()`. After a retraction `onHit` can run again for the same hit, so keep it free of state a retraction cannot undo (do not count hits in it).
- **Cleanup.** `onHit` may return a cleanup. It runs when that pending hit is retracted, before any re-run, like a React effect cleanup. `cancelScheduledValues(hit.when)` drops that value and every later one on the param. That is right when this sequencer is the only writer of the param; if another sequencer, an LFO or your own automation writes it too, give each writer its own node or param.
- **`transform(hit, random)`** runs on seconds-valued hits just before scheduling and may move, reshape or drop each one. `random(key?)` is stable for the same `seed`, lane, loop, index and `key`, so a re-queued hit gets the same number. Details and validation in [advanced](./sequencer-advanced.md#custom-transform).
- **Seeding.** `seed` (default 0) fixes `chance` draws and `random`. The `random` option replaces the `chance` draw with a sequential source that changes on re-queue; use it only to script exact draws in tests.
- **Teardown.** `seq.dispose()` (also `using seq = ...`, or the `signal` option) detaches from every transport, retracts pending hits and runs their cleanups, releases lane outputs and removes listeners. The transport keeps running, so dispose the sequencer, not a clock others share. A disposed sequencer cannot be attached again.
- **Shared transports.** One sequencer attached to two clocks queues on both. See [advanced](./sequencer-advanced.md#sharing-a-transport) and [Clock](./clock.md#attach-several-schedulers).

## When not to use it

`StepSequencer` fits lanes of steps with per-step velocity, offset, length, repeat, pitch and chance. For per-lane state machines, polyrhythm rules of your own or note logic that is not a step edit, schedule directly: iterate `window.rulers.<name>.grid(division)` in a `Clock` `onTick`, trigger the sound at each point's `time`, and register the handle with `window.own(hit, time)` so transport edits cut it. See [Clock](./clock.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).

## Common errors

<!-- prettier-ignore -->
| Step Sequencer message | Cause and fix |
| --- | --- |
| `Step Sequencer takes a record of lanes and an options object.` | The first argument is not a plain record of lanes (an array, `null`), or the second is not an options object. Pass `new StepSequencer({ kick: "X..." }, { context })`. |
| `Step Sequencer lanes need nonempty names mapped to a pattern or to lane options with a pattern.` | A lane name is empty, or its value is neither a pattern nor an object with `pattern`. Pass `{ kick: "X..." }` or `{ kick: { pattern: "X..." } }`. |
| `Step Sequencer lane needs a length from 1 to 128, a known direction and boolean mute and solo.` | `lane.length`, `direction`, `mute` or `solo` was set out of range. Use an integer length 1..128, `"forward"`, `"backward"` or `"bounce"`, and booleans. |
| `Step Sequencer cell needs velocity and chance from 0 to 1, offset from -0.5 to 0.5, length from 1/16 to 4, an integer repeat from 1 to 8 and an integer pitch from -24 to 24.` | A `steps[i]` write is out of range. Keep each field inside the ranges in the `Step` JSDoc. |
| `Step Sequencer custom values need declared param ids and finite numbers from each param's min to max.` | `steps[i].values.<id>` named an undeclared param or fell outside its `min`..`max`. Declare it in the lane's `params` and stay in range. |
| `Step Sequencer lane params need nonempty names that differ from the built-in step keys, a finite min below max, a step above 0 and a default from min to max.` | A lane `params` entry is malformed. Do not name one `velocity`, `offset`, `length`, `repeat`, `pitch`, `chance` or `custom`; keep `min < max`, `step > 0` and `default` in range. |
| `Step Sequencer pattern has an invalid character "…" at position …: use X, x, 1-9 or . (spaces are ignored).` | Write patterns with `X`, `x`, `1`..`9` and `.` only. |
| `Step Sequencer pattern velocities need numbers from 0 to 1.` / `Step Sequencer pattern needs a string like "X...x..." or an array of velocities from 0 to 1.` | Pass a string or an array of numbers from 0 to 1. |
| `Step Sequencer pattern needs from 1 to 128 steps.` | Give each lane 1..128 steps. |
| `Step Sequencer needs a Time such as "16n", "16n.", "8t", "1m", "250ms", "2s" or a number of seconds.` | Use a note value (`n`, `n.`, `t`, `m` suffix), `ms`/`s` or a number for `rate`. |
| `Step Sequencer needs a rate that is a StepRate or a Time, at least 1/128 of a beat long.` | Use a longer step length such as `"64n"`. |
| `Step Sequencer swing needs a number from 0 to 1 or a percentage like "30%".` | Pass `0.3` or `"30%"`. |
| `Step Sequencer sound needs a note name like "C4", an AudioBuffer or a function returning an audio source node.` | Give `sound` a note name, an `AudioBuffer` or a factory. |
| `Step Sequencer sound factory needs to return an AudioScheduledSourceNode (…).` | Return an oscillator, buffer source or constant source from the factory. |
| `Step Sequencer needs options.context for a lane with a sound.` | Pass `{ context }` in the options when a lane has a `sound`, or read `lane.output`. |
| `Step Sequencer onHit and transform need functions.` | Pass functions for `onHit` and `transform`. |
| `Step Sequencer needs an existing lane.` | `seq.lane(name)` needs a lane name from the constructor record. |
| `Step Sequencer is disposed.` | Create a new sequencer; a disposed one cannot be attached again. |
| `Event transform "<id>" returned an event without a finite "when".` (also `"duration"`, `"velocity"`, `must return an array`) | The `transform` returned a hit whose `when` is not finite, whose `duration` is not above 0, whose `velocity` is outside 0..1, or a non-object. Fix the transform; return `null` to drop a hit. |
