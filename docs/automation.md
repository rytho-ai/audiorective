---
title: Automation
---

`@audiorective/core/automation` provides reactive finite curves and audio-clock
scheduling. Import this optional entry explicitly. It does not import blocks,
effects, a DOM, or create an AudioContext. Curve data and sampling work in Node.

## Automate a native parameter

An audio owner creates the curve and binding, starts them from its playback
methods, and destroys the binding before its target processor. UI edits the
same curve through `.value`; it does not run a scheduling loop.

```typescript
import { AudioProcessor, type SchedulableParam } from "@audiorective/core";
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";

class AutomatedGain extends AudioProcessor<{ gain: SchedulableParam }> {
  private readonly node: GainNode;
  readonly curve = new AutomationCurve([
    { time: 0, value: 0.2, shape: "linear" },
    { time: 2, value: 0.8, shape: "hold" },
  ]);
  readonly automation: AutomationBinding;

  constructor(ctx: AudioContext) {
    const gain = new GainNode(ctx);
    super(ctx, ({ param }) => ({ params: { gain: param({ default: 1, bind: gain.gain }) } }));
    this.node = gain;
    this.automation = new AutomationBinding(ctx, this.curve, audioParamTarget(this.params.gain.audioParam));
  }
  get input() {
    return this.node;
  }
  get output() {
    return this.node;
  }
  playAutomation() {
    this.automation.start();
  }
  stopAutomation() {
    this.automation.stop();
  }
  override destroy() {
    this.automation.destroy();
    super.destroy();
  }
}
```

Connect the processor to a destination and resume the AudioContext from a user
gesture. While it runs, replacing `processor.curve.value` immediately reprograms
the remaining timeline from the current curve position. Changes can cause an
intentional discontinuity at that position; smoothing is the caller's choice.

## Curve contract

`new AutomationCurve(points)` exposes `.value`, `$(points)`, `$()` and
`valueAt(time)`. Construction and `.value` replacements copy, sort and freeze
snapshots and their points. Invalid `.value` replacements preserve the old
snapshot. Use a new array to edit:

```typescript
processor.curve.value = processor.curve.value.map((p, i) => (i === 1 ? { ...p, value: 0.5 } : p));
```

`$` is the raw alien-signals accessor, matching core Param/Cell. Direct raw writes
bypass copying and validation: advanced callers must supply a valid sorted,
immutable snapshot (for example another curve’s `.value`). Use `.value` for editor
writes so validation runs before the snapshot is published.

Each `AutomationPoint` contains `{ time, value, shape }`:

- Times are finite, nonnegative and unique. Input order is normalized.
- Values are finite. There is no implicit normalization, clamping, snapping, or
  target-range enforcement; the caller validates its parameter's domain.
- `shape: "linear" | "hold"` describes the segment **leaving** the point.
  At an exact knot the new point's value applies.
- At least one point is required. Outside the curve, sampling holds the nearest
  endpoint. `valueAt` also accepts finite negative query times.
- Times use caller-chosen units. A source-seconds curve, a normalized 0–1
  envelope, and a beat curve are all data; the core attaches no musical identity.

Read `curve.value`/`curve.$()` inside an `alien-signals` effect or a framework
binding to redraw editors and previews. An editor can attach its own stable IDs
outside this numeric schedule. The curve has no audio resources or destroy
method. Each binding owns and disposes its own reactive subscription.

## Binding contract

```typescript
const binding = new AutomationBinding(context, curve, target);
binding.start({ when, from, to, secondsPerUnit });
binding.position;
binding.stop();
binding.destroy();
```

The context needs only a `currentTime` getter; native targets must belong to that
audio clock. Options are optional:

| Option           | Meaning                                                             | Default                    |
| ---------------- | ------------------------------------------------------------------- | -------------------------- |
| `when`           | Absolute audio seconds; past times clamp to now, starting at `from` | now                        |
| `from`           | Starting curve coordinate                                           | 0                          |
| `to`             | Ending curve coordinate, inclusive                                  | max(from, last point time) |
| `secondsPerUnit` | Positive constant time scale                                        | 1                          |

Times are finite and nonnegative, `to >= from`, and the computed audio endpoint
must be finite. Invalid options leave an existing run untouched. A zero-length
range sets a constant. `to` is captured at start; extending a curve does not
extend an existing run. Call `start` again to change the range or scale.

`position` follows the audio clock and clamps to the range. After the endpoint,
the final value holds and the binding remains subscribed until stop/destroy;
edits then update that endpoint. Future starts retain their `from` position
until `when`. `stop()` cancels events now, also before a future start, and retains
the stopped position. A later start replaces the old run.

All finite events are scheduled up front. Live edits replace events from now
onward using the same anchor, without restarting sources. There is no JS timer,
fixed scheduling lead, loop, tempo map or transport. Choose a common future
`when` if a source and automation need a shared start. Musical-time conversion,
repeat windows and tempo-driven re-anchoring belong to the caller/clock.

## Native targets, observation and ownership

`audioParamTarget(audioParam)` implements `AutomationTarget` with native
`setValueAtTime`, `linearRampToValueAtTime` and `cancelAndHoldAtTime`. Stop holds
the audio timeline, including an in-progress ramp, rather than using a stale UI
snapshot. This requires native `cancelAndHoldAtTime` support.

Pass a native `AudioParam` explicitly, for example `effect.params.wet.audioParam`.
A plain `Param<number>` supports immediate values only. A macro implemented by
a SchedulableParam subclass may have additional fanout semantics; exposing its
native backing here would bypass those semantics. Use a domain adapter instead.

The binding exclusively owns its target's scheduled events from its start time
onward. Coordinate other writers yourself: stop the binding before a manual
`.value` write, target rebind, preset restore, bypass/reconnection, or processor
destruction. Bindings borrow targets and contexts; they destroy neither. Dispose
the binding before the processor and create/restart bindings for replaced nodes.

A curve describes the intended schedule. Existing SchedulableParam/ParamSync
continues to poll native values into `.value`/`$` for UI; the binding adds no
poller and does not redefine that behavior. Disconnected nodes can expose stale
native getters. `binding.position` and `curve.valueAt(position)` give the planned
value, not a measurement of rendered output. This API does not fix bypassed
parameter readback or make a plain reactive Param sample-accurate.

## Domain adapters and waveform composition

`AutomationTarget` is a structural interface:

```typescript
interface AutomationTarget {
  program(points: readonly AutomationPoint[], when: number): void;
  hold(time: number): void;
}
```

`program` receives nonempty frozen points in **relative seconds**, beginning at
zero, plus an absolute audio start. It must replace subsequent events while
preserving earlier ones. `hold(time)` cancels subsequent events and preserves
the value at that absolute time. Adapters must implement the full contract; they
own target resolution and nonlinear fanout. If programming throws, the binding
attempts an immediate hold, becomes stopped, and rethrows the original error.
Domain errors are not wrapped. Adapter signal reads do not become scheduling
dependencies.

For a waveform selection, an audio owner combines:

- `WavePlayer` (block): decoded audio, selection, audition and stretch mapping.
- waveform widget: drawing, selection gestures and external playhead.
- core curve/binding: source-time envelope and native gain schedule.
- a GainNode or effect's native parameter: the actual processing.

For output-time selection `[start, end]` and a source-time curve, use
`from = player.outputToSource(start)`, `to = player.outputToSource(end)` and
`secondsPerUnit = player.duration / player.sourceBuffer.duration`. Apply these
when starting the audition; changing stretch or selection requires the owner to
stop/re-anchor playback and automation. The core does not read clip IDs, peaks,
tracks or a Rack. It does not alter source PCM or waveform peaks. A processed
preview or offline render must separately apply the same curve in the same time
coordinates.

Start the player and the binding from one shared `when`.
[`WavePlayer.play({ when })`](./blocks.md#scheduled-start) schedules the first
sound at that absolute audio time and resolves with the effective start time, or
`null` when it started nothing:

```typescript
const token = ++operation; // owner's counter, also bumped on selection/stretch change
const started = await player.play({ when: context.currentTime + 0.1 });
if (started === null || token !== operation) return;
binding.start({ when: started, from, to, secondsPerUnit });
```

Anchor the binding to the resolved value, not the requested one. With a
lookahead long enough for `context.resume()` to settle, the resolved value equals
the requested `when` and the source onset and the automation share that sample.
A `when` that has passed clamps to now for both; the source then begins on the
next render quantum, so that case is aligned to the quantum, not the sample.
`from` must match the position the player starts from: with a selection, seek to
its start (or stop) before playing.

Keep a pending play operation’s source revision and selection alongside its
operation token. A selection/stretch change must invalidate that token and stop
the queued player start as well as the binding, even while `resume()`/`play()` is
still awaiting: a `seek` or selection change before `when` re-issues the player
start from a new position at the same `when`, and a stretch commit cancels it, so
a binding programmed for the old range no longer matches. Observing only an
already-active binding misses this race.

For a Rack, keep the adapter in the block/app: resolve macro targets and program
each native timeline in `program`, and hold all of them in `hold`. Rack lifetime,
presets and mappings stay there. The private Rack probe is not a published block.

## Common errors

| Message                                                                                              | Cause                                 | Fix                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AutomationCurve needs nonempty finite points with nonnegative unique times and linear/hold shapes.` | Invalid curve replacement             | Supply finite `{ time, value, shape }` points with unique times >= 0; replace `.value` instead of mutating frozen snapshots. |
| `AutomationCurve sample time must be finite.`                                                        | Nonfinite query                       | Pass finite curve coordinates to `valueAt`.                                                                                  |
| `AutomationBinding needs finite nonnegative times, to >= from, and positive secondsPerUnit.`         | Invalid start/range/scale or overflow | Correct start options; current run is preserved.                                                                             |
| `AutomationBinding is destroyed.`                                                                    | Reusing disposed binding              | Create a new binding; destroy bindings before their borrowed targets.                                                        |
