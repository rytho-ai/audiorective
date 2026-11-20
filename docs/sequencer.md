---
title: Step Sequencer
---

Step patterns and lanes from `@audiorective/blocks/sequencer`. Part of [Blocks](./blocks.md). Signatures, option lists and field lists are in the package's type declarations (`sequencer.d.ts`, JSDoc on every member); this page holds what the types do not say. The explicit `{ size, lanes }` form, `setCell`/`setLane`/`setSize`, `refreshOnEdit`, the `transforms` socket, custom per-step params, the step grid and the standalone drum machine are on [Step Sequencer: advanced](./sequencer-advanced.md).

## Step Sequencer

`StepSequencer` owns an editable looping pattern and borrows its time from a clock or transport. Name lanes, get hits; it imports only `@audiorective/core`.

### Quick start

```ts
import { Clock } from "@audiorective/clock";
import { StepSequencer } from "@audiorective/blocks/sequencer";

const seq = new StepSequencer(
  { kick: "X...X...X...X...", hat: { pattern: "x.x.x.x.x.x.x.x.", rate: "16n", sound: "C6", swing: "30%" } },
  {
    context,
    seed: 1,
    onHit: (hit) => {
      /* hit.lane, index, when, duration, velocity, values, loop */
    },
  },
);
const clock = new Clock({ context, bpm: 120 }); // makes its own Timeline
const detach = clock.attach(seq); // or workspace.transport.attach(seq)
clock.start(context.currentTime + 0.5); // clock.bpm.value = 140 changes tempo
```

### Semantics

- **Hits are scheduled ahead and can be retracted.** The clock looks ahead, so `onHit(hit)` (and the `hit` event, `seq.onhit`) runs before the hit sounds, with `hit.when` in audio-context seconds. A hit that has not sounded yet is retracted when an edit re-queues it, when the transport stops, pauses or seeks, or on `dispose()`. After a retraction `onHit` can run again for the same hit, so keep it free of state a retraction cannot undo (do not count hits in it).
- **Cleanup.** `onHit` may return a cleanup. It runs when that pending hit is retracted, before any re-run, like a React effect cleanup. Per-hit automation therefore never lingers or doubles:

  ```ts
  onHit: (hit) => {
    filter.frequency.setValueAtTime(hit.values.cutoff, hit.when);
    return () => filter.frequency.cancelScheduledValues(hit.when);
  };
  ```

  `cancelScheduledValues(hit.when)` drops that value and every later one on the param. That is right when this sequencer is the only writer of the param, because a re-queue retracts and rebuilds the whole look-ahead together. If the param is shared with another sequencer, an LFO or your own automation, their later values are dropped too: give each writer its own node or param (one filter per lane), or re-schedule the others after the cancel.

- **Auto re-queue when attached.** After `clock.attach(seq)`, every committed edit (a step, `pattern`, `rate`, `swing`, `mute`, `sound`, a transform) retracts the pending hits and queues them again; several edits in one task re-queue once. No `refreshOnEdit` call is needed in this form. Edits before attaching need no re-queue.
- **Edits apply on the next pass.** `seq.lanes.kick.steps[4].velocity = 0.8` or `seq.lanes.hat.steps[0].values.cutoff = 400` writes through the cells. `steps` is zero-based: `steps[0]` is the first step, `hit.index` too. Assigning `lane.pattern` also sets the lane's length.
- **Each lane loops on its own length** (polymeter): lanes of 5, 16 and 8 steps drift apart and realign, each starting at beat 0 of the transport.
- **Humanize with `transform(hit, random)`.** It runs on seconds-valued hits just before scheduling. Return the hit moved, e.g. `{ ...hit, when: hit.when + (random("t") - 0.5) * 0.016 }`, or `null` to drop it. `random(key?)` is a pure function of `seed`, lane, loop, index and `key`, so a retracted and re-queued hit draws the same number and a re-queue never changes what plays. The sequential `random` option and `Math.random` do change on re-queue; keep them for tests.
- **Seconds-valued rates** (`"250ms"`, `"2s"`, a number) convert to beats at the tempo at beat 0, so a later tempo change does not rescale them; use note values (`"16n"`) to follow tempo.
- **Swing parity.** Swing delays the odd steps by counting from 0: steps 1, 3, 5, ... move late, steps 0, 2, 4, ... stay on the grid. It is a fixed beat offset at any tempo and applies only while `defaultStepTransforms` (or `stepSwing()`) is in `transforms`.
- **Sound.** A lane `sound` (note name, `AudioBuffer`, source factory) needs `options.context`; each hit gets its own voice into `lane.output`, joined to the destination until `lane.connect(node)`. Without a sound the sequencer only reports hits.
- **Teardown.** `seq.dispose()` (also `using seq = ...`, or the `signal` option) detaches from every transport, retracts pending hits and runs their cleanups, releases lane outputs and removes listeners. The transport keeps running; stopping a clock that other schedulers share stops them too, so dispose the sequencer, not the clock. A disposed sequencer cannot be attached again.
- **Following a shared transport.** With a `Workspace`, `workspace.transport.attach(seq)` follows the project transport (play, pause, seek, tempo) and returns the detach function; one sequencer attached to two clocks queues on both. See [Clock](./clock.md#attach-several-schedulers).

### When not to use it

`StepSequencer` fits a lane-and-step grid with per-cell velocity, offset, length, repeat, pitch and chance. For per-lane state machines, polyrhythm rules of your own or note logic that is not a cell edit, schedule directly: iterate `window.rulers.<name>.grid(division)` in a `Clock` `onTick`, trigger the sound at each point's `time`, and register the handle with `window.own(hit, time)` so transport edits cut it. See [Clock](./clock.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound) and [Typing the window](./clock.md#typing-the-window).

## Common errors

<!-- prettier-ignore -->
| Step Sequencer message | Fix |
| --- | --- |
| `Step Sequencer needs an integer size from 1 to 128.` | Pass a whole `size` in 1/16 steps from 1 to 128 to the constructor or `setSize`. |
| `Step Sequencer needs lanes with unique, nonempty IDs.` | Give every lane a different, nonempty string `id`. |
| `Step Sequencer lane needs steps from 1 to the pattern size, a known rate and direction, ...` | Keep `steps` within `size`, use a listed `StepRate`, `forward`/`backward`/`bounce`, swing 0..1, boolean `mute`/`solo` and no more than `size` cells. |
| `Step Sequencer cell needs velocity and chance from 0 to 1, offset from -0.5 to 0.5, length from 1/16 to 4, ...` | Keep cell values in range; `repeat` is an integer 1..8 and `pitch` an integer -24..24. |
| `Step Sequencer params need unique nonempty ids that differ from the built-in cell keys ...` | Fix the `params` option: unique ids that are not `velocity`, `offset`, `length`, `repeat`, `pitch`, `chance` or `custom`, `min < max`, `default` in range. |
| `Step Sequencer custom values need declared param ids and finite numbers from each param's min to max.` | Declare the id in `params` at construction, and keep each `custom` value within that param's range. |
| `Step Sequencer transforms need an array of objects that each have a nonempty string id and an apply function.` | Pass `transforms` / `setTransforms` a list of `{ id, apply }` objects. |
| `Event transform "<id>" returned an event without a finite "beat".` (also `"when"`, `"durationBeats"`, `"duration"`, `"velocity"`, `must return an array`, `has a unit other than`) | The named transform returned a hit with a non-finite `beat` (`when` if it sets `unit: "second"`), a `durationBeats` (`duration`) not above 0, a `velocity` outside 0..1, a non-array, or a `unit` other than `"beat"` or `"second"`. Fix that transform. |
| `Step Sequencer pattern has an invalid character "…" at position …: use X, x, 1-9 or . (spaces are ignored).` | Write patterns with `X`, `x`, `1`..`9` and `.` only. |
| `Step Sequencer pattern velocities need numbers from 0 to 1.` / `Step Sequencer pattern needs a string like "X...x..." or an array of velocities from 0 to 1.` | Pass a string or an array of numbers from 0 to 1. |
| `Step Sequencer pattern needs from 1 to 128 steps.` | Give each lane 1..128 steps. |
| `Step Sequencer needs a Time such as "16n", "16n.", "8t", "1m", "250ms", "2s" or a number of seconds.` | Use a note value (`n`, `n.`, `t`, `m` suffix), `ms`/`s` or a number for `rate`. |
| `Step Sequencer needs a rate that is a StepRate or a Time, at least 1/128 of a beat long.` | Use a longer step length such as `"64n"`. |
| `Step Sequencer swing needs a number from 0 to 1 or a percentage like "30%".` | Pass `0.3` or `"30%"`. |
| `Step Sequencer sound needs a note name like "C4", an AudioBuffer or a function returning an audio source node.` | Give `sound` a note name, an `AudioBuffer` or a factory. |
| `Step Sequencer sound factory needs to return an AudioScheduledSourceNode (…).` | Return an oscillator, buffer source or constant source from the factory. |
| `Step Sequencer needs options.context for a lane with a sound.` | Pass `{ context }` in the options when a lane has a `sound`, or read `lane.output`. |
| `Step Sequencer lane params need nonempty names that differ from the built-in cell keys, …` | Name lane `params` something other than `velocity`, `offset`, `length`, `repeat`, `pitch`, `chance`, `custom`; keep `min < max`, `step > 0` and `default` in range. |
| `Step Sequencer lanes need nonempty names mapped to a pattern or to lane options with a pattern.` | Pass `{ kick: "X..." }` or `{ kick: { pattern: "X..." } }`. |
| `Step Sequencer onHit and transform need functions.` | Pass functions for `onHit` and `transform`. |
| `Step Sequencer onHit and context belong to the lane-record form: …` | Pass lanes as a record of names to patterns to use `onHit`/`context`; the explicit form has `trigger`. |
| `Step Sequencer is disposed.` | Create a new sequencer; a disposed one cannot be attached again. |
| `Step Sequencer needs an existing lane and step.` | `setCell`/`toggle` need a current lane ID and a zero-based step below `size`. |
| `Step Sequencer needs an existing lane.` | `setLane` needs a current lane ID. |
