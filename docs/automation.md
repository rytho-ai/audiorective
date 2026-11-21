---
title: Automation
---

`@audiorective/core/automation` provides editable curves, finite native bindings and
beat-domain transport automation. Import this optional entry explicitly. It does not import the capability packages,
effects, a DOM, or create an AudioContext. Curve data and sampling work in Node.

## Choose the automation owner

| Job                                                                 | Owner                                  |
| ------------------------------------------------------------------- | -------------------------------------- |
| Store, draw or sample numeric points                                | `AutomationCurve`                      |
| Play a finite range in seconds, source coordinates or a fixed scale | `AutomationBinding`                    |
| Play a curve in transport beats, with tempo changes or repetition   | `AutomationClip` attached to a `Clock` |

## Follow the transport

`AutomationClip` treats curve times as beats. Its beat 0 is the transport's beat 0;
attaching during playback uses the current position. `loop: true` repeats at
`length` beats. An explicit length is positive and fixed; without it, length
follows the last point, including after edits. A shorter length truncates the
curve; a longer one holds its last value before wrapping. A looping curve needs
a positive length. A finite single-point curve holds its constant value.

```typescript
import { Clock } from "@audiorective/clock";
import { AutomationClip, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";

const clock = new Clock({ context, bpm: 120 });
const curve = new AutomationCurve([
  { time: 0, value: 0.2, shape: "linear" },
  { time: 2, value: 0.8, shape: "hold" },
  { time: 3, value: 0.4, shape: "hold" },
]);
const clip = new AutomationClip(curve, {
  target: audioParamTarget(gain.gain),
  loop: true,
  length: 4,
});
const detach = clock.attach(clip);
const unsubscribe = clip.cells.attached.subscribe(showAttached, { immediate: true });
// From a user gesture:
await context.resume();
clock.start(context.currentTime + 0.1);
// A tempo edit, clock.seek(), or curve.value replacement keeps the beat mapping.
// Cleanup: unsubscribe(); detach(); clip.dispose();
```

The clip schedules ahead on the audio timeline and follows tempo ramps and live
curve edits. Linear curves in beats become short linear segments in audio time
(up to 1 ms each under a changing tempo); knots, hold jumps and loop seams retain
their mapped event times. A future start leaves the target unchanged until it.
Pause, stop, seek and detach cancel queued automation while holding the actual
current target value. Resume and seek then continue at the transport's position.

`cells.attached` is read-only owner state. The function returned by `clock.attach`
detaches the clip; attach again to enable it at the current position. One clip
follows one clock at a time; a second attachment rejects and preserves the first.
`dispose()` and `[Symbol.dispose]()` detach and release the clip's curve watcher,
and are safe twice. An optional constructor `signal` disposes on abort. The clip
borrows its target and clock; dispose it before its target, and leave a shared
clock alive when closing one panel.

## Automate a native parameter

An audio owner creates the curve and binding, starts them from its playback
methods, and disposes the binding before its target processor. UI edits the
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
  override dispose() {
    this.automation.dispose();
    super.dispose();
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

`$` is the signal accessor, matching core Param/Cell. Reads through `$()` are tracked
like `.value`. Writes through `$(points)` go through the same copy, sort, freeze and
validation as `.value =`, so an invalid raw write throws and keeps the old snapshot.

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
outside this numeric schedule. The curve has no audio resources or dispose
method. Each binding or clip owns and disposes its own reactive subscription.

## Binding contract

```typescript
const binding = new AutomationBinding(context, curve, target);
binding.start({ when, from, to, secondsPerUnit });
binding.position;
binding.stop();
binding.dispose();
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
the final value holds and the binding remains subscribed until stop/dispose;
edits then update that endpoint. Future starts retain their `from` position
until `when`. `stop()` cancels events now, also before a future start, and retains
the stopped position. A later start replaces the old run.

All finite events are scheduled up front. Live edits replace events from now
onward using the same anchor, without restarting sources. There is no JS timer,
fixed scheduling lead, loop, tempo map or transport. Choose a common future
`when` if a source and automation need a shared start. Use `AutomationClip` for musical-time conversion, repeat windows and
tempo-driven re-anchoring through a `Clock`.

## Native targets, observation and ownership

`audioParamTarget(audioParam)` implements `AutomationTarget` with native
`setValueAtTime`, `linearRampToValueAtTime` and `cancelAndHoldAtTime`. Stop holds
the audio timeline, including an in-progress ramp, rather than using a stale UI
snapshot. This requires native `cancelAndHoldAtTime` support.

Pass a native `AudioParam` explicitly, for example `effect.params.wet.audioParam`.
A plain `Param<number>` supports immediate values only. A macro implemented by
a SchedulableParam subclass may have additional fanout semantics; exposing its
native backing here would bypass those semantics. Use a domain adapter instead.

A binding or clip exclusively owns its target's scheduled events from its start time
onward. Coordinate other writers yourself: stop the binding before a manual
`.value` write, target rebind, preset restore, bypass/reconnection, or processor
destruction. Bindings borrow targets and contexts; they dispose neither. Dispose
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

- `WavePlayer` (`@audiorective/player`): decoded audio, selection, audition and stretch mapping.
- waveform widget: drawing, selection gestures and external playhead.
- core curve/binding: source-time envelope and native gain schedule.
- a GainNode or effect's native parameter: the actual processing.

For output-time selection `[start, end]` and a source-time curve, the mapping is
`from = player.outputToSource(start)`, `to = player.outputToSource(end)` and
`secondsPerUnit = player.duration / player.sourceBuffer.duration`.
`WavePlayer.attachSourceAutomation()` applies it at each start and re-anchors
its binding on selection changes; custom owners can use these same conversions.
The core does not read clip IDs, peaks,
tracks or a Rack. It does not alter source PCM or waveform peaks. A processed
preview or offline render must separately apply the same curve in the same time
coordinates.

For a non-looping selection, attach the source-time binding directly to the
`WavePlayer`. It reads the current selection and stretch version and shares
the effective start time with the source:

```typescript
const detach = player.attachSourceAutomation(binding);
await player.play({ when: context.currentTime + 0.1 });
// Manual target takeover: detach(); gain.gain.value = manualValue;
// Cleanup: detach(); binding.dispose(); player.dispose();
```

The attachment replaces the caller's operation token and mapping for this
single-playhead case. It invalidates a play still waiting for `context.resume()`
when selection or stretch changes, and reprograms both source and binding after
a queued selection edit. A stretch edit cancels a queued start. `play()` still
resolves with the effective start time, or `null` when nothing started. Schedule
with enough lookahead for `resume()` to settle; when a requested start has passed,
source and envelope can only align at the next render quantum. Detach before
direct writes to the target or replacing it. The player borrows the binding, so
dispose the binding separately. Looping requires a different, repeating
automation owner; this attachment rejects it. For custom players or multiple
clip timelines, the app still owns their transport and coordinate conversion.

For a Rack, keep the adapter in the app: resolve macro targets and program
each native timeline in `program`, and hold all of them in `hold`. Rack lifetime,
presets and mappings stay there. The private Rack probe is not a published package.

## Common errors

| Message                                                                                              | Cause                                              | Fix                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AutomationCurve needs nonempty finite points with nonnegative unique times and linear/hold shapes.` | Invalid curve replacement                          | Supply finite `{ time, value, shape }` points with unique times >= 0; replace `.value` instead of mutating frozen snapshots. |
| `AutomationCurve sample time must be finite.`                                                        | Nonfinite query                                    | Pass finite curve coordinates to `valueAt`.                                                                                  |
| `AutomationBinding needs finite nonnegative times, to >= from, and positive secondsPerUnit.`         | Invalid start/range/scale or overflow              | Correct start options; current run is preserved.                                                                             |
| `AutomationClip target needs program and hold methods.`                                              | Invalid target adapter                             | Supply an `AutomationTarget`, or wrap a native parameter with `audioParamTarget`.                                            |
| `AutomationClip length must be positive finite beats.`                                               | Invalid explicit length                            | Supply a finite length greater than zero, or omit it to follow the last point.                                               |
| `AutomationClip loop needs a positive length in beats.`                                              | A looping curve has no positive endpoint or length | Supply a positive `length` or a curve whose last point is after beat zero.                                                   |
| `AutomationClip is disposed.`                                                                        | Attaching a disposed clip                          | Create a new clip.                                                                                                           |
| `AutomationClip is already attached to a clock.`                                                     | One clip was attached to two clocks                | Detach it from the first clock before attaching elsewhere.                                                                   |
| `AutomationBinding is disposed.`                                                                     | Reusing disposed binding                           | Create a new binding; dispose bindings before their borrowed targets.                                                        |
