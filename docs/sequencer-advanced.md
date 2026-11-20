---
title: "Step Sequencer: advanced"
---

Deep topics for the lane-record `StepSequencer` from `@audiorective/sequencer`: custom `transform`, per-step field semantics, stable randomness, sharing a transport, the step grid. Start with [Step Sequencer](./sequencer.md) (layers 1-4 and the errors table).

## Custom transform

`transform(hit, random)` is the last hook before a hit is scheduled. It sees each hit that will sound, after `offset`, `swing`, `repeat`, `chance`, `mute` and `solo` have been applied. Each hit carries both forms of its position: `beat` and `durationBeats` (the musical grid) and `when` and `duration` (audio-context seconds). It returns the hit (changed or not) or `null` to drop it.

```ts
const seq = new StepSequencer(lanes, {
  context,
  seed: 7,
  transform: (hit, random) => {
    if (hit.lane === "hat" && hit.loop % 4 === 3 && random("fill") < 0.5) return null; // thin the hats every 4th loop
    return { ...hit, when: hit.when + (random("jitter") - 0.5) * 0.01, velocity: Math.min(1, hit.velocity * (0.9 + 0.2 * random("vel"))) };
  },
});
```

- **Beats or seconds.** Move `beat` (or change `durationBeats`) for a musical shift: the sequencer maps it through the transport's timing, so it stays on the grid under tempo automation (`beat: hit.beat + 0.125` is always a 32nd late). Move `when` (or change `duration`) for a millisecond nudge, which stays that many seconds. If `beat` or `durationBeats` changed, `when` and `duration` are recomputed from the beats and the returned `when` and `duration` are ignored, with one exception: if both `beat` and `when` changed, the hit sounds at `beatToTime(beat)` plus the `when` delta (`when - hit.when`), and `duration` likewise gets its delta added to the beat-derived length. A hit that changes neither keeps the returned `when` and `duration`. A seconds-only transform is not tempo-locked: a fixed `when` push drifts off the grid as the tempo changes.
- **One hit in, one hit out.** A transform can move, reshape or drop a hit but not add one; use a step's `repeat` to add hits. Only `beat`, `durationBeats`, `when`, `duration`, `velocity`, `pitch` and `values` of the returned hit are read; `lane`, `index` and `loop` stay those of the input.
- **Validation.** The sequencer checks every returned hit and throws an `Event transform "transform" ...` error (see the errors table) for a `when` or `beat` that is not finite, a `duration` or `durationBeats` that is not above 0, a `velocity` outside 0..1, or a result that is not an object. A `velocity` of 0 drops the hit. `values` and `pitch` are passed on as given and are not range-checked.
- **Clamp.** A hit whose `when` ends up earlier than the window's current time plays at that time, so the sound never receives a past time.
- **Order.** A dropped hit never reaches `onHit`, the `hit` event or the lane's sound. A transform never starts or cancels audio; the sequencer owns every voice, so stop, seek, edit and `dispose()` retract what a transform moved.
- **Keep it pure.** The same hit can pass through `transform` again after every re-queue. Read what you need from the hit, draw randomness from `random(key?)`, and keep no state across calls. Use different `key`s for independent draws on one hit.
- **Fixed timing** (a constant push, swing, ratchets) belongs in the per-step and per-lane fields (`offset`, lane `swing`, `repeat`), which follow tempo and need no code; use `transform` for rules, randomness and conditions.
- **State a transform reads.** The sequencer re-queues pending hits for its own edits only. When a value the transform closes over changes (a humanize amount, a mode flag), call `clock.refresh()` (`workspace.transport.refresh()` for a Workspace) so pending hits pass through `transform` again; hits already sounding are unchanged.

## Per-step fields

Units and ranges are in the `Step` JSDoc. Semantics the types do not say:

- **`offset`** shifts the hit by a fraction of the lane's step in beats, before swing is added, so it follows tempo. For a fixed per-step push prefer `offset` (or lane `swing`) over a `transform`. A hit moved before the current time plays at once.
- **`length`** is the hit's duration in lane steps, divided among the repeats of that step. It matters for sustained sounds and gated pads; a one-shot buffer plays to its end.
- **`repeat`** `r` plays `r` hits evenly spaced inside the step; each lasts `length / r` steps. All repeats of one step share one `chance` draw: all play or none.
- **`pitch`** is semitones, carried as `hit.pitch`. A note-name or `AudioBuffer` `sound` transposes itself (frequency, playback rate); a source factory `(context, hit)` or a `PadBank.trigger(..., { pitch })` call applies it.
- **`chance`** is the probability a step plays. The draw is a pure function of `seed`, lane, loop and the step's position in the loop, so the same step gives the same answer in every window, after any edit, re-queue or seek, and at any tick size. Pass a different `seed` per instance or run for a different pattern.
- **`random` option vs `seed`.** `random: () => number` replaces the `chance` draw with a sequential source: each call advances it, so a re-queue draws fresh numbers and pending chance steps can flip. Use it to script exact draws in tests. `transform`'s `random(key?)` always uses the stable draw from `seed`.
- **Direction.** `"forward"`, `"backward"`, and `"bounce"` (`0 1 2 1 0 1 ...` for 3 steps, ends not repeated; a 1-step lane stays on step 0). `hit.index` is the step played; `hit.loop` counts every `length` counter steps from beat 0 whatever the direction.
- **Position.** Each lane's counter runs from beat 0 forever, so after changing `rate` or `length` on a playing lane the position is re-derived from beat 0 and the lane may jump. Swing counts from the start of each loop (odd steps late, by `swing` of half a step).

## Sharing a transport

```ts
const clock = new Clock({ context, bpm: 120 });
const detachDrums = clock.attach(drums);
const detachBass = clock.attach(bass); // two sequencers on one clock stay beat-aligned
workspace.transport.attach(seq); // follows the project transport: play, pause, seek, tempo
```

- `attach` returns a detach function. Detaching calls `reset()` once, which retracts that sequencer's pending hits (running their cleanups) and sets playheads and progress to `null`; the transport and other schedulers continue.
- Stop, pause and seek on the clock reset every attached scheduler. One sequencer attached to two clocks queues on both; each clock re-queues after an edit.
- `seq.dispose()` detaches from every transport. Stopping a clock that others share stops them too, so dispose the sequencer, not the clock.
- `schedule(window, timing)` and `reset()` are the transport's calls, not the application's. See [Clock](./clock.md#attach-several-schedulers).

## Step grid

`mountStepGrid(root, { sequencer: seq })` edits a `StepSequencer` directly: click toggles, drag edits the active per-step field, header controls change length, rate, direction and swing, and each lane shows its `playhead` and `progress`. `laneLabel(name)` names a lane for display (default: the lane name). Destroying the grid leaves the sequencer running. Options, keyboard and styling are in [Widgets](./widgets.md#step-grid-and-pads).

## Standalone drum machine

The runnable drum machine (`StepSequencer` + `PadBank` choke group + `Clock` + step grid) is on [Step Sequencer](./sequencer.md#standalone-drum-machine).
