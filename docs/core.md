---
title: Core
---

Reactive primitives for Web Audio. Bridges audio parameter automation and UI frameworks.

**Powered by alien-signals 3.x** — lightweight, zero-dependency, automatic dependency tracking. Signals use a callable API: `signal()` to read, `signal(value)` to write. Custom types `SignalAccessor<T>` and `ComputedAccessor<T>` are defined in types.ts (alien-signals no longer exports `Signal<T>`, `Effect<T>`, or `Computed<T>`).

Audio state is the single source of truth. UI frameworks observe and mutate directly. No state duplication.

For data-only waveform summaries, use the [`@audiorective/core/peaks`](#pcm-peak-summaries) entry. It requires neither Web Audio nor a DOM.

For reactive curves, native parameter scheduling and domain adapters, use the optional
[`@audiorective/core/automation`](./automation) entry.

## Quick Start

```typescript
import { AudioProcessor, Param, SchedulableParam } from "@audiorective/core";

class Synth extends AudioProcessor<{
  volume: SchedulableParam;
  bpm: Param<number>;
}> {
  private readonly _gain: GainNode;

  constructor(ctx: AudioContext) {
    const gain = new GainNode(ctx);
    super(ctx, ({ param }) => ({
      params: {
        volume: param({ default: 0.5, bind: gain.gain }),
        bpm: param({ default: 120 }),
      },
    }));
    this._gain = gain;
  }

  get output() {
    return this._gain;
  }
}

const ctx = new AudioContext();
const synth = new Synth(ctx);
synth.output.connect(ctx.destination);

synth.params.volume.value = 0.8;
synth.params.volume.linearRampToValueAtTime(0, ctx.currentTime + 2);
```

Subclasses declare their reactive surface as a generic type parameter and build it inside a callback passed to `super()`. The `params` field is a frozen, fully-typed object — `synth.params.volume` resolves to `SchedulableParam` and `synth.params.bpm` to `Param<number>` end-to-end.

**Why a build callback?** Params must be constructed _before_ `super()` returns so that `this.params` is set by the time field initializers and the subclass body run. The base constructor invokes the callback partway through its own setup, exposing helpers (`param`, `schedulableParam`, `cell`) that already have access to the AudioContext and the processor's internal silencer. The callback closes over locals declared before `super()` (audio nodes, etc.), so binding params to `node.frequency` works without `this`.

## Core Concepts

### The `.value` Pattern

Wraps alien-signals with a `.value` property matching Web Audio API conventions — `gainNode.gain.value = 0.5` and `synth.volume.value = 0.5` are identical patterns. The `$` property exposes the raw `SignalAccessor<T>` (callable: `$()` to read, `$(value)` to write) for framework adapters.

### Parameter Types

Two param types, opt-in scheduling:

- **`Param<T>`** — reactive signal with `.value` getter/setter. The default for all params. Used for BPM, step position, boolean flags, string enums, or any value that's set immediately.
- **`SchedulableParam`** — extends `Param<number>` with Web Audio scheduling methods (`linearRampToValueAtTime`, `setTargetAtTime`, etc.). Created when the `param` helper receives `bind: AudioParam`, or via the `schedulableParam` helper.

### When does a param become schedulable?

| Helper call                                      | Result             | Why                                                               |
| ------------------------------------------------ | ------------------ | ----------------------------------------------------------------- |
| `param({ default: 120 })`                        | `Param<number>`    | Just a reactive number, no scheduling                             |
| `param({ default: 0.5, bind: gain.gain })`       | `SchedulableParam` | Bind is an AudioParam instance                                    |
| `schedulableParam({ default: 440 })`             | `SchedulableParam` | No AudioParam bound; uses a phantom ConstantSourceNode internally |
| `param({ default: "sine" })`                     | `Param<string>`    | Non-numeric, always plain Param                                   |
| `param({ default: "sine", bind: { get, set } })` | `Param<string>`    | Object bind — reactive sync via effect, not scheduling            |

### ParamSync

`ParamSync` keeps the reactive layer in sync with the audio thread. It runs a `requestAnimationFrame` loop that periodically reads `AudioParam.value` back into the signal at a configurable per-param rate (~10 Hz by default).

- Singleton per `AudioContext` via `ParamSync.for(ctx)`
- Auto-starts when the first `SchedulableParam` registers, auto-stops when all unregister
- Each param can have its own `syncInterval` (in milliseconds)

### ConstantSourceNode Scheduling Engine

When `schedulableParam` is called without `bind`, `AudioProcessor` internally creates a `ConstantSourceNode` and delegates scheduling to its `offset` AudioParam. This gives sample-accurate scheduling for free, backed by the browser's native automation engine.

**How it works:** The ConstantSourceNode connects through a per-processor `GainNode(gain=0)` (the silencer) to `ctx.destination`. This keeps the node in an active audio graph (required for automations to evaluate) without producing audible output.

**Why not just disconnect?** A disconnected ConstantSourceNode gets optimized away by the browser — automations stop evaluating and the offset value freezes.

Both scheduling paths (`bind: AudioParam` and unbound `schedulableParam`) use the same API and deliver sample-accurate scheduling via native `AudioParam`.

---

## API Reference

### ParamBind\<T\>

```typescript
interface ParamBind<T> {
  get?: () => T; // read from external state: seeds the initial value (`default` is the fallback when it returns undefined)
  set?: (value: T) => void; // push to external state (via effect)
}
```

### ParamOptions\<T\>

```typescript
interface ParamOptions<T> {
  default: T;
  bind?: ParamBind<T>;
  label?: string; // same fields as ParamSpec
  min?: number;
  max?: number;
  step?: number;
  display?: (value: T) => string;
}
```

### ValueRange, ParamRange and ParamSpec

One set of types describes a numeric parameter's range, so every package that declares one uses the same shape. They are pure data and load without the DOM or an `AudioContext`.

```typescript
type ValueRange = Readonly<{ min: number; max: number }>; // inclusive interval
type ParamRange = ValueRange & Readonly<{ default: number; step?: number }>; // step is an editing hint, not enforced
type ParamSpec = ParamRange & Readonly<{ id: string; label?: string }>; // a named numeric parameter
```

A `StepSequencer` lane declares per-step numbers as `params: Record<string, ParamRange>` (a `ParamSpec` without the `id`). `ValueRange` alone types ranges with no default or id: the `EffectRack` macro mappings, and the CLAP parameter info in `host.parameterInfo`. To declare your own numeric parameter, write a `ParamSpec` (`{ id: "cutoff", label: "Cutoff", min: 0, max: 1, default: 0.5, step: 0.01 }`) and import the type from `@audiorective/core`.

### Param\<T\>

Basic reactive parameter for any type. Supports optional `bind` for syncing to external state.

```typescript
class Param<T> implements Readable<T> {
  readonly $: SignalAccessor<T>;
  get value(): T;
  set value(v: T);
  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  subscribe(listener: (value: T) => void, options?: { immediate?: boolean }): () => void;
  dispose(): void; // stops bind effect (no-op if no bind); safe to call twice
  [Symbol.dispose](): void;
}
```

When `bind.set` is provided, an internal effect pushes value changes to the target. Call `dispose()` to stop it. When `bind.get` is provided, the param starts from `bind.get()` rather than `default` (`default` still applies if the getter returns `undefined`); it is read once at construction, and later changes to the external state are not polled.

### SchedulableParamOptions

```typescript
interface SchedulableParamOptions extends ParamOptions<number> {
  audioParam: AudioParam;
  audioContext: AudioContext;
  syncInterval?: number; // ms, default 100 (~10Hz)
}
```

### SchedulableParam

Numeric parameter with Web Audio scheduling methods. All scheduling methods return `this` for chaining.

```typescript
class SchedulableParam extends Param<number> {
  /** Fires on every change, including while a scheduled ramp moves the value. */
  subscribe(listener: (value: number) => void, options?: { immediate?: boolean }): () => void;
  read(): number; // read directly from AudioParam (realtime)
  syncFromAudio(): void; // pull AudioParam value into signal
  rebind(audioParam: AudioParam, opts?: { reassert?: boolean }): void; // re-point at a new AudioParam

  setValueAtTime(value: number, startTime: number): this;
  linearRampToValueAtTime(value: number, endTime: number): this;
  exponentialRampToValueAtTime(value: number, endTime: number): this;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): this;
  cancelScheduledValues(cancelTime: number): this;
  cancelAndHoldAtTime(cancelTime: number): this;

  dispose(): void; // unregisters from ParamSync
}
```

**Raw writes.** `$(x)` and `.value = x` are the same write: both update the signal and the backing `AudioParam`. `$()` reads are unchanged. Only `syncFromAudio()` updates the signal without writing back, so a ParamSync read-back never overwrites a value you set through `$`.

**`read()` vs `.value`:** `.value` returns the signal's last-synced value (updated by `ParamSync` at ~10Hz). `read()` returns the live `AudioParam.value` directly — more accurate during active automations, but doesn't trigger reactive updates.

**`rebind()`:** re-points the param at a different `AudioParam`, keeping the same `SchedulableParam` instance (and its reactive `.value`/`$` surface). For sources whose node is recreated on each restart — an `AudioBufferSourceNode` is one-shot, so each `start()` makes a fresh `playbackRate`. `ParamSync` is keyed on the param, not the AudioParam, so `read()`/`syncFromAudio()` follow automatically with no re-registration; automation queued on the old (dead) node is gone, which is the desired semantics. `reassert` (default `true`) mirrors the current value onto the new param. Used internally by `BufferPlayer`.

### Automation Gotchas

- Always anchor with `setValueAtTime(currentValue, now)` before any ramp — otherwise the ramp starts from whatever value the AudioParam holds at the _previous_ scheduled point, not "now".
- Call `cancelScheduledValues(now)` before starting a new automation sequence if previous automations may still be queued.
- Don't bind a volume `Param` directly to an envelope gain node — use a separate gain. Otherwise envelope writes and volume writes fight for the same `AudioParam`.

### ParamSync

```typescript
const DEFAULT_SYNC_INTERVAL_MS = 100; // ~10Hz

class ParamSync {
  static for(ctx: BaseAudioContext): ParamSync; // singleton per context
  register(param: SchedulableParam, intervalMs?: number): void;
  unregister(param: SchedulableParam): void;
  get size(): number;
  get running(): boolean;
}
```

`SchedulableParam` auto-registers/unregisters on construction/dispose — you rarely need to use `ParamSync` directly.

### Readable\<T\>

Shared interface for anything that can be read and tracked: `Param<T>`, `Cell<T>` and `ReadonlyCell<T>` satisfy it. React's `useValue` accepts any of them.

```typescript
interface Readable<T> {
  readonly $: () => T;
  readonly value: T;
  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  subscribe(listener: (value: T) => void, options?: { immediate?: boolean }): () => void;
}
```

### `subscribe(listener, options?)`

`Cell`, `ReadonlyCell`, `Param` and `SchedulableParam` share one subscription method: `subscribe(listener, { immediate? })` calls `listener(value)` after each change and returns a function that unsubscribes. With `immediate: true` it also calls the listener once with the current value at subscribe time. Several writes in one `batch` call it once with the final value, and a write that leaves the value unchanged does not call it.

```typescript
const stop = synth.params.volume.subscribe((v) => label.set(v.toFixed(2)), { immediate: true });
// ...later
stop();
```

`subscribe` is a bound method, so it can be passed on directly, for example as the first argument of React's `useSyncExternalStore(cell.subscribe, () => cell.value)`. The listener runs outside tracking: what it reads does not subscribe it to anything, and a subscription made inside an `effect` is not torn down when that effect re-runs. On a `SchedulableParam` it fires on every change, including while a scheduled ramp moves the value (the `ParamSync` read-back updates the signal at its sync interval, 100 ms by default), so a UI bound with `subscribe` follows an automation without polling. The audio thread only advances a param whose node is part of a running graph, so a ramp on a node that nothing pulls does not move the value.

### Cell\<T\>

Reactive container for structured/complex data. Uses Immer `produce` for ergonomic immutable updates via `.update()`. Usable standalone, or attached to an `AudioProcessor` via the `cell` build helper, in which case it appears in the processor's `cells` registry.

```typescript
class Cell<T> implements Readable<T> {
  readonly $: SignalAccessor<T>;
  get value(): T;
  set value(v: T);
  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  subscribe(listener: (value: T) => void, options?: { immediate?: boolean }): () => void;
  update(recipe: (draft: Draft<T>) => void): void;
}

function cell<T>(initial: T): Cell<T>;
```

**Example:**

```typescript
import { cell } from "@audiorective/core";

interface StepPattern {
  steps: boolean[];
  velocity: number[];
}

const pattern = cell<StepPattern>({
  steps: Array(16).fill(false),
  velocity: Array(16).fill(0.8),
});

pattern.update((draft) => {
  draft.steps[0] = true;
  draft.steps[4] = true;
  draft.velocity[4] = 1.0;
});

pattern.value; // { steps: [true, false, false, false, true, ...], velocity: [...] }
```

`update` runs the recipe through Immer `produce`. A recipe may mutate the draft or return a replacement value, never both. An expression-bodied arrow does both when it mutates and returns the draft, as `Object.assign` does, and Immer throws `An immer producer returned a new value *and* modified its draft. Either return a new value *or* modify the draft.` Use a block body so the arrow returns nothing:

```typescript
pattern.update((p) => Object.assign(p, patch)); // throws: mutates the draft and returns it
pattern.update((p) => {
  Object.assign(p, patch); // ok: block body returns undefined
});
```

To replace the whole value, assign `pattern.value = next` instead.

### ReadonlyCell\<T\>

A tracked view that cannot be written: `.value` has no setter, `$` takes no argument, and there is no `.update()`. Use it for state that may only change through its owner's methods, because the change needs validation, playback, or cancellation. The owner keeps the writable `Cell` private and registers the view.

```typescript
class ReadonlyCell<T> implements Readable<T> {
  readonly $: () => T;
  get value(): T;
  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  subscribe(listener: (value: T) => void, options?: { immediate?: boolean }): () => void;
}

function readonlyCell<T>(source: Cell<T> | (() => T)): ReadonlyCell<T>;
```

Pass a `Cell` to view it, or a function to view a value derived from other cells and params. A derived view re-runs its readers only when its own value changes. A writable `Cell` is not assignable where a `ReadonlyCell` is declared, so the owner has to opt in with `readonlyCell(...)`.

```typescript
class Looper extends AudioProcessor<{}, { region: ReadonlyCell<Region | null> }> {
  private readonly _region: Cell<Region | null>;

  constructor(ctx: AudioContext) {
    const region = cell<Region | null>(null); // a local, like audio nodes, so the build callback can close over it
    super(ctx, () => ({ params: {}, cells: { region: readonlyCell(region) } }));
    this._region = region;
  }

  setRegion(next: Region | null) {
    if (next && next.start >= next.end) throw new RangeError("Region must satisfy start < end.");
    this._region.value = next;
  }
}

looper.cells.region.value; // tracked read
looper.cells.region.value = r; // type error, and throws: use looper.setRegion(r)
```

### effect, computed, batch and untracked

```typescript
function effect(fn: () => void): () => void; // runs now and on every change; returns stop
function computed<T>(fn: () => T): () => T; // cached derived value; call it to read
function batch<T>(fn: () => T): T;
function untracked<T>(fn: () => T): T;
```

`effect` and `computed` are the alien-signals observers, exported from core so an app that is not using a framework binding can observe params and cells without depending on `alien-signals` itself. Call the function `effect` returns to stop it.

`batch` applies several writes as one change: effects run once, after `fn` returns, and never observe a state in between. Use it in an owner method that updates more than one cell. `untracked` runs `fn` without subscribing the surrounding effect to what it reads. Use it for an owner's internal reads, so that calling one of its methods inside an effect does not subscribe that effect to the owner's state.

### Cell vs Param

| Use case                                         | Primitive                                   | Why                                                |
| ------------------------------------------------ | ------------------------------------------- | -------------------------------------------------- |
| Numeric audio value, needs ramps/scheduling      | `Param` (`param`/`schedulableParam` helper) | Backs an `AudioParam`; lives in `processor.params` |
| Simple reactive value (BPM, boolean, enum)       | `Param` (`param` helper)                    | Lightweight; lives in `processor.params`           |
| Structured data (step patterns, presets, config) | `Cell` (`cell` helper or standalone)        | Immer-based `.update()`                            |
| State that doesn't belong to an AudioProcessor   | `Cell` (standalone)                         | Usable anywhere                                    |
| State only the owner's methods may change        | `ReadonlyCell` over a private `Cell`        | Tracked reads; writes go through validation        |

### AudioProcessor (abstract)

Base class for audio processing units. Generic over the param and cell registries it exposes. Subclasses pass a build callback to `super()` that returns those registries.

```typescript
abstract class AudioProcessor<
  P extends Record<string, Param<any>> = Record<string, Param<any>>,
  C extends Record<string, Cell<any> | ReadonlyCell<any>> = Record<string, Cell<any> | ReadonlyCell<any>>,
> {
  readonly context: BaseAudioContext; // processors also build against an OfflineAudioContext
  readonly params: Readonly<P>; // frozen, fully typed
  readonly cells: Readonly<C>; // frozen, fully typed
  readonly latency: Param<number>; // samples — see Latency (PDC)

  protected constructor(context: BaseAudioContext, build: (helpers: BuildHelpers) => { params?: P; cells?: C; latency?: number | Param<number> });

  abstract get output(): AudioNode | undefined;
  get input(): AudioNode | undefined; // default: undefined

  /** Connects this processor's output to `destination` like AudioNode.connect and returns `destination`; a processor destination receives its `input`. The edge joins the latency graph, so delay compensation sees it. */
  connect<T extends AudioNode | AudioProcessor | AudioParam | SchedulableParam>(destination: T, output?: number, input?: number): T;
  /** Removes the connection made by connect(destination), or all of this processor's connections when omitted. */
  disconnect(destination?: AudioNode | AudioProcessor | AudioParam | SchedulableParam): void;

  protected computed<T>(fn: () => T): ComputedAccessor<T>;
  protected effect(fn: () => void): () => void;
  protected defineGraph(fn: () => EdgeList, opts?: { compensate?: boolean }): GraphHandle;

  /** Stops, disconnects and releases everything this processor owns. Safe to call twice. */
  dispose(): void;
  [Symbol.dispose](): void; // calls dispose(), so `using processor = new Synth(ctx)` works
}

interface BuildHelpers {
  // overloads — `bind: AudioParam` upgrades to SchedulableParam
  param<T extends number>(opts: Omit<ParamOptions<T>, "bind"> & { bind: AudioParam }): SchedulableParam;
  param<T>(opts: ParamOptions<T> & { bind: ParamBind<T> }): Param<T>;
  param<T>(opts: ParamOptions<T>): Param<T>;
  schedulableParam(opts: Omit<ParamOptions<number>, "bind"> & { bind?: AudioParam }): SchedulableParam;
  cell<T>(initial: T): Cell<T>;
}
```

**`connect(destination, output?, input?)`** mirrors `AudioNode.connect`: it wires the processor's `output` to an `AudioNode`, an `AudioParam`, a `SchedulableParam` (its backing `AudioParam`) or another `AudioProcessor` (its `input`), and returns `destination`, so calls chain: `osc.connect(filter).connect(ctx.destination)`. `output` and `input` pick channel indices. Connecting the same edge twice is one connection. `disconnect(destination)` removes that destination's edges and `disconnect()` removes every connection the processor made through `connect`. Edges that nodes make among themselves (`node.connect(processor.input)`) are plain Web Audio and untouched. See [Latency (PDC)](#latency-pdc) for how a `connect` edge takes part in compensation.

**`dispose()`** disconnects everything the processor connected with `connect()` and every edge that fed it, stops all effects, calls `dispose()` on every param in the registry (cleaning up bind effects and `ParamSync` registrations), and stops and disconnects any internally-created `ConstantSourceNode`s and the internal silencer gain that keeps them alive. Cells are not disposed automatically — they're plain reactive containers with no audio-graph resources. A second call does nothing, and `[Symbol.dispose]()` calls `dispose()` (including a subclass override), so a `using` declaration disposes at scope exit.

**`Symbol.dispose` in TypeScript.** The `[Symbol.dispose]` member needs the `esnext.disposable` lib (included in `"lib": ["esnext"]`) or `@types/node` 20+ in the consuming project; add `"esnext.disposable"` to `compilerOptions.lib` when the editor reports `Property 'dispose' does not exist on type 'SymbolConstructor'`. At runtime it needs a JavaScript engine that defines `Symbol.dispose` (Node 20+, current Chromium and Firefox); `dispose()` itself works everywhere.

**Effects vs instruments — the `.input` convention.** A processor that **transforms** incoming audio (EQ, compressor, reverb, distortion) declares both `input` and `output`. A processor that **produces** audio from scratch (synth, sampler, oscillator) declares only `output`; `input` returns `undefined` from the base class. There are no `EffectProcessor`/`InstrumentProcessor` subclasses — the convention is purely about which getters a processor exposes. Downstream code that needs to insert a processor as an effect (e.g. `bindEffect` in `@audiorective/playcanvas`) checks `processor.input !== undefined`. Spatial's `input` getter is the prototype: it returns the entry `GainNode` that connects into the underlying `PannerNode`.

Every processor also exposes `readonly latency: Param<number>` — see [Latency (PDC)](#latency-pdc) below.

### Graph helpers (`defineGraph`)

`defineGraph` wires an audio graph declaratively from a reactive edge list, instead of hand-rolled `.connect()`/`.disconnect()` calls. Edges reference nodes and processors directly — no string keys, no registry — so a nonexistent node cannot be named and rename/autocomplete work natively.

```typescript
import { AudioProcessor, type Param } from "@audiorective/core";

class Layered extends AudioProcessor<{ useShifter: Param<boolean> }> {
  private readonly _out: GainNode;

  constructor(ctx: AudioContext, shifter: AudioProcessor) {
    // locals before super(), per the build-callback convention
    const osc = new OscillatorNode(ctx);
    const filter = new BiquadFilterNode(ctx);
    const lfo = new OscillatorNode(ctx, { frequency: 5 });
    const out = new GainNode(ctx);

    super(ctx, ({ param }) => ({
      params: { useShifter: param({ default: false }) },
    }));

    osc.start();
    lfo.start();
    this._out = out;

    this.defineGraph(() => [
      [osc, filter],
      [filter, this.params.useShifter.value ? shifter : out],
      this.params.useShifter.value && [shifter, out], // falsy entries are skipped
      [lfo, filter.frequency], // AudioParam sink — no options bag
    ]);
  }

  get output() {
    return this._out;
  }
}
```

- **Edge forms:** `[from, to]`, `[from, to, { output?, input?, label? }]` for multi-channel connections and a debug `label` used in error messages, or a falsy value (`false`/`null`/`undefined`) to skip the edge — so branches can be written inline with `condition && [from, to]`.
- **Endpoints:** `from` is an `AudioNode` or an `AudioProcessor` (connects from its `output`); `to` additionally accepts an `AudioParam` or `SchedulableParam` (resolves to its backing `AudioParam`), like `[lfo, filter.frequency]`. `AudioParam` sinks carry no latency and don't participate in compensation.
- **Worklet rejection.** A bare `AudioWorkletNode` is rejected both at the type level (structurally: any value with `port`/`parameters` narrows to `never` at that edge position, in both `this.defineGraph` and the standalone `defineGraph`) and at runtime (`instanceof AudioWorkletNode` throws) — its latency can't be known from outside. Wrap it in an `AudioProcessor` that declares `latency` instead.
- **`this.defineGraph(fn, opts?)`** is the protected instance method, used after `super()` (like `effect()`/`computed()`) so the edge callback can read `this.params`. **`defineGraph(fn, { context, compensate? })`** is the standalone export for a graph owned by no processor — the engine's root graph uses this form (see [`AudioEngine`](#audioengine) below).
- The edge function runs inside an `effect()`; every re-run diffs the new edge list against the current one (keyed by endpoint identity) and applies only the minimal `connect`/`disconnect` calls, then re-solves compensation.
- `defineGraph(fn, { compensate: false })` keeps the diffing but turns off compensating delays for that graph.
- Returns a `GraphHandle` with `dispose()`. `AudioProcessor.dispose()` disposes every graph the processor created.
- `GraphOptions.onSolve?: (handle: GraphHandle) => void` runs after every solve — the engine uses it to keep `AudioEngine.latency` current, and any caller can use it the same way to react to a fresh solve. `handle.snapshot()` returns a `GraphSnapshot` (`{ solveId, nodes, edges }`) reflecting the graph's last solve: each node carries its `kind` (`"native"` or `"processor"`), `label`, declared/derived `latency`, and solved `arrival`; each edge carries its `kind` (`"audio"`, `"param"` for an `AudioParam` sink, `"virtual"` for a processor's own internal input→output path, or `"back"` for an excluded feedback edge) and `compensationSamples` (always `0` for anything but an `"audio"` edge, and `0` everywhere when `compensate: false`). `handle.idOf(endpoint)` returns the same id `snapshot()` assigned that endpoint (for an `AudioProcessor`, its output node's id — the input side, when different, is reachable via a `"virtual"` edge), so ids stay stable across solves and a consumer can filter by `kind` to render only what it cares about. `handle.reaches(from, to)` reports whether `from` forward-connects to `to` in the last solve, `false` for either endpoint outside that solve — `AudioEngine.getPathLatency` uses it to reject a processor sitting in a disconnected component of the same graph.

### Latency (PDC)

Every processor exposes `readonly latency: Param<number>` — its processing latency in samples: the fixed delay before the earliest output for an impulse at the input. Intentional musical delay (a delay line, a reverb tail, chorus modulation) is not latency; those effects declare `0`. Web Audio renders every node synchronously per quantum, so a native node — `ConvolverNode` and `DelayNode` included — never adds signal-path latency on its own; real latency only comes from a processor that buffers beyond the quantum (worklet lookahead, an FFT hop).

`latency` defaults to `0`. Declare it in the build callback three ways:

```typescript
super(ctx, ({ param }) => ({
  params: {
    /* ... */
  },
  latency: 512, // fixed sample count
}));

super(ctx, ({ param }) => ({
  params: { lookahead: param({ default: 512 }) },
  latency: param({ default: 512 }), // changes at runtime, e.g. a limiter's lookahead
}));

super(ctx, ({ param }) => ({
  params: {
    /* ... */
  },
  // time-based: derive from the context so it survives a sample-rate change
  latency: Math.round(0.01 * ctx.sampleRate),
}));
```

A `latency` created with the `param()` helper but not also placed in the returned `params` registry has nothing to dispose it — `AudioProcessor.dispose()` only disposes params it owns via `params`. Track a param-backed `latency` in `params` yourself, or declare a plain number when it never changes at runtime.

When a processor calls `this.defineGraph(...)` and declares no `latency`, it's **derived**: the longest path in samples from `input` to `output` through its own graph. A processor that declares a value and also has a `defineGraph` uses the declared value (a worklet-backed processor may still use `defineGraph` for its surrounding wiring).

Compensation runs on every re-solve of a `defineGraph`: at any join with two or more incoming edges, the branches that arrive early get a helper-owned `DelayNode` so every branch lands in step with the latest one. Edges declared through `defineGraph` and edges made with `processor.connect(...)` are tracked and compensated; a raw `node.connect(...)` between native nodes is invisible to it.

**How `connect` edges are solved.** Every `processor.connect(...)` edge on one `AudioContext` joins a single shared graph, solved like any `defineGraph` graph (compensating delays at unequal joins, `getPathLatency` and `AudioEngine.latency` answering for it). The engine on that context reads its destination arrival together with its own `defineGraph` graphs, so `engine.latency` is the longest path across all of them. Each graph is solved on its own: a join between a `connect` edge and a `defineGraph` edge is not compensated across the two, so put both branches of a join in the same mechanism. Do not wire the same pair through both `connect` and `defineGraph`: the two share one physical connection, and removing it from one removes it for both. A bare `AudioWorkletNode` destination is connected directly and stays outside the solve, because its latency is unknowable; wrap it in a processor that declares `latency` to include it. `defineGraph` remains the form for edge lists that change reactively; `connect` is for fixed wiring.

**Engine queries** (on `AudioEngine`, so `engine.core.latency` for a `createEngine` consumer):

```typescript
engine.latency: ReadonlyCell<number>;       // samples — longest path into ctx.destination across every engine-owned graph
engine.perceivedTime: number;                // ctx.currentTime - latency/sampleRate - ctx.outputLatency (0 where unsupported)
engine.getPathLatency(proc: AudioProcessor): number; // samples from proc's output to ctx.destination
```

`perceivedTime` is the schedule time the listener is hearing right now — sound scheduled at `t` is still travelling the graph and the output stage, so the ear lags `ctx.currentTime` by both. It is what a visualizer or a record-quantize step should compare against instead of `ctx.currentTime`. `getPathLatency(proc)` throws [`LatencyUnknownError`](#latencyunknownerror) when `proc` isn't part of the current solve — built but never wired into a `defineGraph`, dropped from the edge list, its graph disposed, or wired only to an `AudioParam` — a processor with no path to measure.

See the [Step Sequencer demo](../apps/web/src/demos/sequencer)'s latency lab for compensation, bypass, a runtime-adjustable worklet latency, and a playhead that reads the clock's ruler at `perceivedTime` rather than at `ctx.currentTime`.

### `LatencyUnknownError`

```typescript
class LatencyUnknownError extends Error {}
```

Thrown by `engine.getPathLatency(proc)` when `proc` isn't part of the current solve of any `defineGraph` (its own or the engine's) or of the `connect` graph — never wired in, dropped from the edge list, its graph disposed, or wired only to an `AudioParam` — naming the processor. This is a loud failure rather than a silent `0`.

### Spatial

Built-in `AudioProcessor` that owns a `PannerNode` (HRTF) and exposes its seven properties as reactive `Param<T>`s. Lives in core — audio works end-to-end without any 3D renderer. `@audiorective/threejs` provides `PannerAnchor` to bind a scene `Object3D`'s world transform to the panner.

```typescript
import { Spatial, type SpatialOptions } from "@audiorective/core";

class Spatial extends AudioProcessor<{
  refDistance: Param<number>;
  maxDistance: Param<number>;
  rolloffFactor: Param<number>;
  distanceModel: Param<DistanceModelType>;
  coneInnerAngle: Param<number>;
  coneOuterAngle: Param<number>;
  coneOuterGain: Param<number>;
}> {
  readonly panner: PannerNode;
  override get input(): GainNode; // entry gain feeding the panner
  get output(): AudioNode; // returns panner

  constructor(context: AudioContext, options?: SpatialOptions);
}

interface SpatialOptions {
  distanceModel?: DistanceModelType; // default "inverse"
  refDistance?: number; // default 1
  maxDistance?: number; // default 10000
  rolloffFactor?: number; // default 1
  coneInnerAngle?: number; // default 360
  coneOuterAngle?: number; // default 0
  coneOuterGain?: number; // default 0
}
```

Feed audio into `spatial.input` (a `GainNode`) and connect `spatial.output` to `ctx.destination` (or further). Writing to any of the seven `Param<T>`s propagates to the underlying `PannerNode` via a bind effect.

```typescript
const synth = new MySynth(ctx);
const spatial = new Spatial(ctx, { distanceModel: "inverse", refDistance: 2 });
synth.output.connect(spatial.input);
spatial.output.connect(ctx.destination);

spatial.params.maxDistance.value = 500;
spatial.params.rolloffFactor.value = 0.5;
```

Position/orientation are plain `AudioParam`s on `spatial.panner`. Drive them directly from a render loop, or hand `spatial.panner` to `PannerAnchor` in `@audiorective/threejs` for automatic world-transform sync.

---

### Analyser

Built-in `AudioProcessor` that owns an `AnalyserNode` as a **pass-through tap** — wire it inline (`source → analyser.input`, `analyser.output → destination`) and read the realtime spectrum or waveform. The primitive every visualizer needs, so you don't hand-roll an `AnalyserNode` + byte buffer each time.

```typescript
import { Analyser, type AnalyserOptions } from "@audiorective/core";

class Analyser extends AudioProcessor {
  readonly node: AnalyserNode;
  override get input(): AudioNode; // === output; the pass-through node
  get output(): AudioNode;
  get binCount(): number; // fftSize / 2 — length of a frequency buffer
  get fftSize(): number; // length of a waveform buffer

  createFrequencyBuffer(): Uint8Array; // sized to binCount
  createWaveformBuffer(): Uint8Array; // sized to fftSize
  readFrequencies(out: Uint8Array): void; // 0–255 per bin (getByteFrequencyData)
  readWaveform(out: Uint8Array): void; // 0–255, 128 = silence (getByteTimeDomainData)

  constructor(context: BaseAudioContext, options?: AnalyserOptions);
}

interface AnalyserOptions {
  fftSize?: number; // default 2048
  smoothingTimeConstant?: number; // default 0.8
  minDecibels?: number;
  maxDecibels?: number;
}
```

```typescript
const analyser = new Analyser(ctx, { fftSize: 256 });
synth.output.connect(analyser.input);
analyser.output.connect(ctx.destination);

const bins = analyser.createFrequencyBuffer();
// each render frame (ticker / requestAnimationFrame / useFrame):
analyser.readFrequencies(bins); // bins[i] = 0–255
```

**Analyser data is not reactive** — it changes every audio frame with no signal to subscribe to. Poll it from your render loop, **not** from an `effect()` or `useValue()`. See [pixijs.md](./pixijs.md) for the `effect`-vs-render-loop decision in a full app.

---

## PCM peak summaries

`@audiorective/core/peaks` is a pure PCM entry for browsers, Node.js, and Workers. It imports no audio-runtime implementation and creates no nodes or DOM. The root entry also exports these functions and types.

```typescript
import { summarizePeaks, peakFrameRange, type PCMData } from "@audiorective/core/peaks";

const pcm: PCMData = {
  channels: [Float32Array.of(0.25, 0.75, 0.5)],
  sampleRate: 48000,
};
const summary = summarizePeaks(pcm, { framesPerPeak: 2 });
// summary.min: [0.25, 0.5]; summary.max: [0.75, 0.5]
const tail = peakFrameRange(summary, 1);
// { startFrame: 2, endFrame: 3, startTime: 2 / 48000, endTime: 3 / 48000 }
```

`PCMData` has readonly `channels: readonly Float32Array[]` and `sampleRate: number`. Channels must have equal lengths and finite samples, with at least one channel and a finite positive sample rate. Equally empty channels are valid.

`summarizePeaks(pcm, { framesPerPeak? })` uses **source frames per bin**, defaulting to `128`; the option must be a positive safe integer. Each bin merges the true minimum and maximum across all supplied channels. Channels are not summed. It preserves DC offsets and amplitudes outside ±1, without clipping, zero-baseline expansion or display normalization. It creates `Math.ceil(frameCount / framesPerPeak)` bins, including the full final partial bin, and never changes the source arrays.

`PeakSummary` has readonly fields `min: Float32Array`, `max: Float32Array`, `sampleRate`, `frameCount`, `framesPerPeak`, and `duration` (`frameCount / sampleRate`). Empty input produces empty extrema arrays and duration zero. Readonly fields do not freeze typed-array elements; treat shared summaries as read-only.

`peakFrameRange(summary, index)` returns a half-open `[startFrame, endFrame)` range and its `startTime`/`endTime` in seconds. Coordinates are local to the supplied PCM, including a channel created with `subarray`; the final range ends at `frameCount`. Indices must identify existing bins. Source offsets, source/output edit mapping, cache lifetime and rendering density belong to callers.

| Error                                                           | Fix                                               |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `summarizePeaks: sampleRate must be a finite positive number`   | Supply the PCM's positive sample rate.            |
| `summarizePeaks: framesPerPeak must be a positive safe integer` | Use an integer of at least 1.                     |
| `summarizePeaks: at least one channel is required`              | Supply at least one channel, which may be empty.  |
| `summarizePeaks: every channel must be a Float32Array`          | Convert each channel to a Float32Array.           |
| `summarizePeaks: channels must have equal frame counts`         | Supply equally sized channels.                    |
| `summarizePeaks: samples must be finite numbers`                | Remove NaN and infinite samples.                  |
| `peakFrameRange: index must identify an existing peak`          | Use a valid bin index; empty summaries have none. |

## Sound Playback

Three primitives cover audio playback (`Sampler` plays any `Sound`, `BufferPlayer` and `FilePlayer` are single playheads). They split on two axes — **source** (in-memory `AudioBuffer` vs streamed file) and **voice model** (polyphonic vs single playhead). For a how-to-choose walkthrough see `choosing-playback.md`.

|               | `Sampler`                        | `BufferPlayer`                                | `FilePlayer`                                         |
| ------------- | -------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| **Metaphor**  | Drum pad / sampler               | Deck / tape loop                              | Transport / track                                    |
| **Source**    | `Sound` (buffer or factory)      | `AudioBuffer` (in memory)                     | `HTMLAudioElement` (streams; no decode)              |
| **Voices**    | Polyphonic: hits overlap         | Single persistent playhead                    | Single playhead                                      |
| **Clock**     | sample-accurate (ctx)            | sample-accurate (ctx)                         | media clock                                          |
| **Transport** | none (fire-and-forget voices)    | `start`/`stop`/loop, **schedulable `rate`**   | `play`/`pause`/`seek`/`stop`                         |
| **Good for**  | SFX, one-shots, hits             | beat-locked loops/stems, DJ pitch/tempo moves | music, long-form, scrubbing                          |
| **API entry** | `sampler.trigger()` / `noteOn()` | `player.start()` / `player.stop()`            | `player.play()` / `player.pause()` / `player.seek()` |

All three are output-only `AudioProcessor`s. Compose them by routing `player.output` through `Spatial`, an EQ, or directly to `ctx.destination`.

### `loadAudioBuffer` / `AudioBufferCache`

Before a `Sampler` can play anything it needs an `AudioBuffer`. Two helpers handle fetching and decoding; both take any `BaseAudioContext`, so they serve `renderOffline` too:

```typescript
import { loadAudioBuffer, AudioBufferCache } from "@audiorective/core";

// one-shot fetch + decode
const buffer = await loadAudioBuffer(ctx, "/sounds/snare.wav");

// cached — dedupes concurrent loads, evicts on failure
const cache = new AudioBufferCache(ctx);
const [kick, snare] = await Promise.all([cache.load("/sounds/kick.wav"), cache.load("/sounds/snare.wav")]);
cache.clear(); // drop all cached entries
```

`AudioBufferCache.load()` is safe to call multiple times with the same URL — concurrent callers share the in-flight request and receive the same resolved `AudioBuffer`.

### Sampler

Polyphonic player of one `Sound`. Each `trigger()` or `noteOn()` starts a new voice that layers over the others, up to `polyphony`. Its output is not connected: `sampler.connect(context.destination)`.

```typescript
import { Sampler, loadAudioBuffer } from "@audiorective/core";

const kick = new Sampler(ctx, { sound: await loadAudioBuffer(ctx, "/sounds/kick.wav") });
kick.connect(ctx.destination);
const voice = kick.trigger({ velocity: 0.8, when: time }); // one hit at natural pitch
voice?.stop(); // fade out over `release`

const piano = new Sampler(ctx, { sound: pianoC4, rootNote: 60, lowNote: 36, highNote: 96 });
piano.connect(ctx.destination);
piano.noteOn("E4"); // transposed +4 semitones from rootNote
piano.noteOff("E4"); // releases the held voices of that note
```

**Constructor options** (`SamplerOptions`):

| Option      | Type                 | Default    | Description                                                                                                          |
| ----------- | -------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `sound`     | `Sound`              | none       | What each voice plays; settable later through `sampler.sound`.                                                       |
| `rootNote`  | `number`             | `60`       | MIDI note at which `sound` plays at its natural pitch; `noteOn(n)` transposes by `n - rootNote`.                     |
| `lowNote`   | `number`             | `0`        | Lowest note `noteOn` plays; lower notes are ignored (it returns `null`).                                             |
| `highNote`  | `number`             | `127`      | Highest note `noteOn` plays; higher notes are ignored.                                                               |
| `polyphony` | `number`             | `32`       | Maximum voices sounding or scheduled at once.                                                                        |
| `steal`     | `"oldest" \| "none"` | `"oldest"` | At the cap: release the oldest voice and play the new hit, or drop the new hit.                                      |
| `release`   | `number`             | `0.005`    | Start value of `params.release`: seconds a voice fades out when stopped (`noteOff`, `voice.stop`, steal, `stopAll`). |
| `volume`    | `number`             | `1`        | Start value of `params.volume` (0..1).                                                                               |
| `signal`    | `AbortSignal`        | none       | Aborting the signal calls `dispose()`.                                                                               |

**Public surface:**

```typescript
sampler.sound: Sound | null                     // tracked; the next hit uses it
sampler.output: GainNode                        // summing gain; use sampler.connect(...)
sampler.params.volume: SchedulableParam         // output gain 0..1
sampler.params.release: Param<number>           // seconds of fade-out applied when a voice is released; changes apply to voices released afterwards
sampler.params.sustain: Param<boolean>          // sustain pedal (MIDI CC64), default false: while true, noteOff keeps the held voices sounding; false releases them
sampler.cells.activeVoices: ReadonlyCell<number> // voices sounding (started, not ended); a voice scheduled ahead joins at its start time
sampler.cells.heldNotes: ReadonlyCell<readonly number[]> // notes with at least one sounding voice, ascending

sampler.trigger(options?: PlayOptions): Voice | null
// null when there is no sound, or steal:"none" dropped the hit.
sampler.noteOn(note: number | NoteName, options?: PlayOptions): Voice | null
// pitch = note - rootNote + options.pitch. A note struck again adds a voice. null outside lowNote..highNote.
sampler.noteOff(note: number | NoteName, when?: number): void // releases the held voices of `note` started by `when`
sampler.stopAll(when?: number): void
sampler.dispose(): void
```

`PlayOptions` (all optional, shared by `Sampler`, `PadBank` and `playSound` callers):

```typescript
type PlayOptions = Readonly<{
  velocity?: number; // 0..1, scales this voice's level (default 1)
  when?: number; // AudioContext seconds to start (default now; a past time plays now)
  pitch?: number; // semitones added to the hit's transposition (default 0)
  offset?: number; // seconds into a buffer where playback starts (default 0)
  duration?: number; // seconds to play: a buffer's portion (default to its end) or hit.duration for a factory or tone (default held until stop)
}>;
```

`when` is absolute `AudioContext` time, the unit `@audiorective/clock` hands you as `time` on each grid point, so a sequencer passes it straight through as `trigger({ when: time })`. See `clock.md`.

**Sustain and release.** `params.release` is read when a voice is released, so a release knob is `sampler.params.release.value = seconds` with no rebuild. With `params.sustain` on, `noteOff` marks the held voices of the note as sustained instead of releasing them; setting it back to `false` releases every sustained voice at the current time. A sustained note struck again adds a voice as usual. `cells.heldNotes` and `cells.activeVoices` are the state a keyboard or meter view reads: a voice scheduled with a future `when` is not counted, and not `playing`, until the context clock reaches `when` (a timer aligned to audio time flips it, like the `PadBank` cleanup timer).

**Polyphony and steal.** With `polyphony: 1` and `steal: "oldest"` each hit replaces the last one over `release`: the pad recipe. `cells.activeVoices` is then `1` while the latest hit plays and never exceeds the cap during a steal. With `steal: "none"` the new hit is dropped and `trigger` returns `null`. For clock-scheduled dynamics automate `params.volume` (linear gain; convert dB with `dbToGain` from `@audiorective/effects`).

### Sound

`Sound` is what every player plays per hit: a note name (`"C4"`, the built-in triangle tone), an `AudioBuffer`, or a `SoundFactory`. `Sampler`, `PadBank` pads, `StepSequencer` lanes and `ClipLauncher` `{ sound }` clips all take it, so one object serves a button and a lane.

```typescript
type SoundFactory = (context: BaseAudioContext, hit: SoundHit) => AudioScheduledSourceNode | SoundVoice;
type SoundHit = Readonly<{ when: number; velocity: number; pitch: number; duration: number }>;
type SoundVoice = Readonly<{ output: AudioNode; sources: readonly AudioScheduledSourceNode[]; duration?: number }>;
```

```typescript
const zap: SoundFactory = (ctx, hit) => {
  const osc = new OscillatorNode(ctx, { frequency: 440 * 2 ** (hit.pitch / 12) });
  osc.frequency.exponentialRampToValueAtTime(80, hit.when + 0.2);
  return osc; // a bare source node is both the output and the only source
};
const two = (ctx) => {
  const a = new OscillatorNode(ctx);
  const b = new OscillatorNode(ctx, { detune: 7 });
  const mix = new GainNode(ctx);
  a.connect(mix);
  b.connect(mix);
  return { output: mix, sources: [a, b] };
};
```

The voice rules, the same for every player:

- The factory never connects or starts nodes. Return the nodes unconnected and unstarted; schedule envelopes from `hit.when`. The player connects `output` (behind one velocity gain), starts every source at `hit.when`, stops every source, fades the voice out over `release`, disconnects the nodes when the sources have ended and updates its cells.
- Velocity is applied once, by the player, after the factory's output. `hit.velocity` is for timbre only; scaling gain by it in the factory applies it twice.
- A voice without its own `duration` is held for `hit.duration`, then faded out over `release`. `hit.duration` is the step length for a sequencer lane, the clip length for a launcher clip, and `Infinity` for `trigger` and `noteOn`, which are held until `voice.stop()` or `noteOff`.
- A `SoundVoice` with `duration` is a one-shot: its sources stop that many seconds after `hit.when` however long the hit is held.
- `hit.pitch` is semitones from the natural pitch. A factory applies it itself; a buffer follows it as `playbackRate = 2 ** (pitch / 12)`. A buffer plays from `offset` for `duration` seconds of buffer (default to its end, its length divided by the rate), mirroring `AudioBufferSourceNode.start(when, offset, duration)`; a sequencer step's or clip's length does not cut it. For a factory or tone the `duration` option becomes `hit.duration`.
- A note name plays a triangle oscillator at that note's frequency times `2 ** (hit.pitch / 12)` through a 4 ms attack and, for a finite `hit.duration` (at least 50 ms), an exponential decay over it; with `Infinity` it sustains at the tone's peak (0.5, headroom for several voices) until stopped.
- `hit.when` is never in the past.

### Voice

`trigger()` and `noteOn()` return a `Voice`, freed by the player when it ends. You never construct one.

```typescript
interface Voice {
  readonly note: number | null; // MIDI note, or null from trigger
  readonly when: number; // AudioContext seconds it starts
  readonly playing: ReadonlyCell<boolean>; // false while scheduled ahead, true from `when` until it has ended (stopped, stolen, choked or ran out)
  stop(when?: number): void; // fade out over `release` from `when` (default now), then end
}
```

`stop()` with no time or a past time ends the voice for its callers at once (`playing` is `false`, `activeVoices` drops) while the nodes ring out over `release` and then disconnect. A later `stop(when)` replaces an earlier pending one, like `AudioScheduledSourceNode.stop`; stopping a voice that has not started yet drops it silently (`playing` stays `false`), like Web Audio's `stop` before `start`. Calling `stop()` again after the voice has been released does nothing.

### `playSound`

`playSound(context, sound, destination, hit, options?)` is the voice machinery under `Sampler`, `PadBank`, sequencer lanes and launcher clips, exported for blocks that own their own routing. It returns a `Voice`.

```typescript
const voice = playSound(ctx, zap, bus, { when, velocity: 1, pitch: 0, duration: 0.25 }, { release: 0.01 });
```

`options` (`PlaySoundOptions`): `release` (seconds, or a function read each time the voice is released; default `0.005`), `note` (the MIDI note the voice reports, default `null`), `hold` (default `true`; `false` leaves `hit.duration` informational so only `stop` ends an open-ended voice) `onFree` (called once when every node is disconnected, after a release has rung out) and `onEnd` (called once when the voice is over for its callers, including one stopped before it started). `assertSound(value)` throws unless `value` is a note name, an `AudioBuffer` or a function, and `noteNumber(note)` returns the MIDI number of a number or note name (`"C4"` is 60) or throws. Use `Sampler` unless you need your own gating, as `PadBank` does for choke.

### BufferPlayer

Buffer-backed **single-playhead transport** — the "deck". One persistent source you `start()`, `stop()`, and loop on the sample-accurate AudioContext clock. Where `Sampler` fires throwaway voices, `BufferPlayer` keeps its source alive for the whole play session, so its **`rate` is a real schedulable `AudioParam`** — ramp it for tempo/pitch moves (vinyl spin-down, tempo-match). Use it for beat-locked loops and stems; use `Sampler` for SFX, `FilePlayer` for streamed long-form.

```typescript
import { BufferPlayer, AudioBufferCache } from "@audiorective/core";

const cache = new AudioBufferCache(ctx);
const deck = new BufferPlayer(ctx, { loop: true, loopEnd: 3.69 }); // loopEnd = musical length, guards opus decode tail
deck.output.connect(ctx.destination);
deck.buffer = await cache.load("/loops/break.opus");

deck.start(ctx.currentTime + 0.1); // sample-accurate, phase-locked to a shared t0
deck.params.volume.linearRampToValueAtTime(0, ctx.currentTime + 2);

// DJ spin-down — schedule on the live source's playbackRate
const at = ctx.currentTime;
deck.params.rate
  .cancelScheduledValues(at)
  .setValueAtTime(deck.params.rate.read(), at)
  .exponentialRampToValueAtTime(0.04, at + 1.3);
```

**Constructor options** (`BufferPlayerOptions`):

| Option         | Type                  | Default | Description                                                                              |
| -------------- | --------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `buffer`       | `AudioBuffer \| null` | `null`  | Initial buffer (hot-swappable via `.buffer =`, applies next `start()`)                   |
| `loop`         | `boolean`             | `false` | Loop the buffer                                                                          |
| `loopStart`    | `number`              | `0`     | Loop start (seconds)                                                                     |
| `loopEnd`      | `number`              | `0`     | Loop end (seconds); `0` → buffer end. Set it for musical-loop length / decode-tail guard |
| `playbackRate` | `number`              | `1`     | Starting rate; also the rate a restart re-anchors to                                     |
| `volume`       | `number`              | `1`     | Output gain 0–1                                                                          |

**Public surface:**

```typescript
player.buffer: AudioBuffer | null      // hot-swap; takes effect on next start(). Reads and writes `params.buffer`
player.output: AudioNode               // output gain; connect → Spatial / EQ / destination
player.params.volume: SchedulableParam // output gain 0..1
player.params.rate: SchedulableParam   // playback rate — schedulable (the point of this primitive)
player.params.buffer: Param<AudioBuffer | null> // `player.buffer` reads and writes it; tracked by effects
player.params.loop: Param<boolean>      // `player.loop` reads and writes it; applies to a playing source immediately
player.params.loopStart: Param<number> // `player.loopStart`
player.params.loopEnd: Param<number>   // `player.loopEnd`
player.cells.isPlaying: ReadonlyCell<boolean> // written only by the player

player.start(when?: number, offset?: number): void  // sample-accurate; no-op while playing or with no buffer
player.stop(when?: number): void                     // immediate, or future-dated (plays until `when`)
player.loop = true; player.loopStart = 0; player.loopEnd = 3.69;  // same as writing params.loop / loopStart / loopEnd; write through to the live source
player.dispose(): void
```

**Why `rate` is schedulable but the others aren't special.** An `AudioBufferSourceNode` is one-shot — `stop()` permanently kills it, so each `start()` builds a fresh node with a fresh `playbackRate`. `BufferPlayer` keeps `params.rate` a **stable reference** (so `useValue(player.rate)` gives a live pitch readout) and re-points it at the new node's `playbackRate` via [`SchedulableParam.rebind`](#schedulableparam) on every `start()`. Consequences:

- Scheduled rate automation belongs to the **current play session**. `stop()` ends it; the next `start()` re-anchors to the base rate (no stale spin-down carries over).
- `params.volume` binds once to the persistent output gain — it never rebinds, and fades just work across starts.
- `read()` returns the live `playbackRate` during an automation; `.value` returns the last `ParamSync`-sampled value (~10 Hz).

A phase-locked multi-stem "instrument" (e.g. a beat made of layered loops) is **N `BufferPlayer`s** sharing one `start(t0)` and ramped together — the library primitive stays one buffer; the layering is composition.

### FilePlayer

Streaming track player backed by `HTMLAudioElement`. Suitable for music and long-form audio where fully decoding into an `AudioBuffer` would be prohibitive. Has a single playhead; use `Sampler` when you need polyphony.

```typescript
import { FilePlayer } from "@audiorective/core";

const player = new FilePlayer(ctx, { src: "/music/track.mp3", volume: 0.8 });
player.output.connect(ctx.destination);

await player.play(); // also resumes after pause
player.pause();
player.seek(30); // jump to 30 s
player.stop(); // pause + rewind to 0

player.src = "/music/other.mp3"; // swap track; resets currentTime / duration

player.onEnded(() => console.log("track finished")); // natural end only

player.dispose();
```

**Constructor options** (`FilePlayerOptions`):

| Option         | Type                         | Default       | Description                         |
| -------------- | ---------------------------- | ------------- | ----------------------------------- |
| `src`          | `string`                     | —             | Initial source URL                  |
| `loop`         | `boolean`                    | `false`       | Loop playback                       |
| `volume`       | `number`                     | `1`           | Output gain 0–1                     |
| `playbackRate` | `number`                     | `1`           | Playback rate                       |
| `crossOrigin`  | `string \| null`             | `"anonymous"` | CORS attribute on the audio element |
| `preload`      | `"none"\|"metadata"\|"auto"` | `"metadata"`  | `<audio>` preload hint              |

**Public surface:**

```typescript
player.audio: HTMLAudioElement         // escape hatch for direct DOM access
player.output: AudioNode               // MediaElementSource → connect here
player.src: string | null              // getter/setter; setter loads + resets state; the getter is tracked by effects
player.params.volume: SchedulableParam
player.params.loop: Param<boolean>
player.params.playbackRate: Param<number>
player.cells.isPlaying: ReadonlyCell<boolean>    // cells are written only by the player,
player.cells.currentTime: ReadonlyCell<number>   // from the element's events and its own methods
player.cells.duration: ReadonlyCell<number>      // NaN until loadedmetadata fires

// property forms of the params
player.loop = true;
player.playbackRate = 1.5;

player.play(): Promise<void>   // swallows autoplay-gesture + AbortError
player.pause(): void
player.seek(t: number): void
player.stop(): void            // pause + seek(0)
player.onEnded(cb: () => void): () => void   // returns an unsubscribe
player.dispose(): void
```

**`play()` swallows two error classes silently:** autoplay-gesture errors (browser blocked playback before a user gesture) and `AbortError` (the element was replaced or unloaded mid-play). Read `player.cells.isPlaying` for actual playback state; a false value after `play()` cannot distinguish a blocked request from an interrupted one. For a plain control bar that reports its own play failures, use [`mountPlayer` with `fromFilePlayer(player)`](./widgets.md#plain-player-controls); its adapter calls the documented `audio.play()` escape hatch and ignores `AbortError`.

```typescript
// React example — bind transport cells to UI
const isPlaying = useValue(player.cells.isPlaying);
const currentTime = useValue(player.cells.currentTime);
const duration = useValue(player.cells.duration);
```

### `renderOffline`

Renders a graph to an `AudioBuffer` through an `OfflineAudioContext`. `setup` may be async — await any processor's `ready` inside it before returning.

```typescript
import { renderOffline, Sampler, loadAudioBuffer } from "@audiorective/core";

const rendered: AudioBuffer = await renderOffline({ seconds: 8, channels: 2, sampleRate: 44100 }, async (ctx) => {
  const kick = new Sampler(ctx, { sound: await loadAudioBuffer(ctx, "/kick.wav") });
  kick.connect(ctx.destination);
  for (let beat = 0; beat < 16; beat++) kick.trigger({ when: beat * 0.5 });
});
// `rendered` is an AudioBuffer (decoded PCM), not file bytes. Play it, pass it to a PadBank pad, or encode it yourself.
```

The same call synthesizes a sample: build an oscillator or noise burst with a gain envelope in `setup`, render a fraction of a second, and use the returned `AudioBuffer` as a `PadBank` pad or `Sampler` sound, with no file to decode.

`Sampler`, `BufferPlayer`, and every `@audiorective/effects` processor accept a `BaseAudioContext`, so the same classes run live and offline.

A graph driven by a `@audiorective/clock` `Clock` needs its ticks driven in step with the render — use that package's `renderTimeline`, which wraps `renderOffline`. See [`docs/clock.md`](./clock.md#rendering-offline--rendertimeline).

---

## Usage Examples

### Basic Processor with AudioParam Binding

```typescript
class GainProcessor extends AudioProcessor<{ volume: SchedulableParam }> {
  private readonly _gain: GainNode;

  constructor(ctx: AudioContext) {
    const gain = new GainNode(ctx);
    super(ctx, ({ param }) => ({
      params: { volume: param({ default: 0.5, bind: gain.gain }) },
    }));
    this._gain = gain;
  }

  get output() {
    return this._gain;
  }
}

const proc = new GainProcessor(ctx);
proc.output.connect(ctx.destination);

proc.params.volume.value = 0.8; // immediate
proc.params.volume.linearRampToValueAtTime(0, ctx.currentTime + 2); // 2s fade out
```

### Virtual Schedulable Param (ConstantSourceNode)

```typescript
class Sequencer extends AudioProcessor<{ intensity: SchedulableParam }> {
  constructor(ctx: AudioContext) {
    super(ctx, ({ schedulableParam }) => ({
      // no AudioParam to bind to, but we want sample-accurate scheduling
      params: { intensity: schedulableParam({ default: 0 }) },
    }));
  }

  get output() {
    return undefined;
  }

  schedulePattern(startTime: number) {
    this.params.intensity
      .setValueAtTime(0, startTime)
      .linearRampToValueAtTime(1, startTime + 0.5)
      .linearRampToValueAtTime(0, startTime + 1);
  }
}
```

### Computed Values & Effects

`computed()` and `effect()` remain instance methods. They run after `super()` returns, so they can read `this.params` directly:

```typescript
class Metronome extends AudioProcessor<{ bpm: Param<number> }> {
  readonly beatDuration: () => number;

  constructor(ctx: AudioContext) {
    super(ctx, ({ param }) => ({
      params: { bpm: param({ default: 120 }) },
    }));

    this.beatDuration = this.computed(() => 60000 / this.params.bpm.value);

    this.effect(() => {
      console.log("Beat duration:", this.beatDuration(), "ms");
    });
  }

  get output() {
    return undefined;
  }
}

const met = new Metronome(ctx);
// logs: "Beat duration: 500 ms"
met.params.bpm.value = 240;
// logs: "Beat duration: 250 ms"
```

### Object Bind (Non-AudioParam Properties)

```typescript
class Synth extends AudioProcessor<{ waveform: Param<OscillatorType> }> {
  private readonly osc: OscillatorNode;

  constructor(ctx: AudioContext) {
    const osc = new OscillatorNode(ctx);
    super(ctx, ({ param }) => ({
      params: {
        waveform: param<OscillatorType>({
          default: "sawtooth",
          bind: {
            get: () => osc.type,
            set: (v) => {
              osc.type = v;
            },
          },
        }),
      },
    }));
    this.osc = osc;
    this.osc.start();
  }

  get output() {
    return this.osc;
  }
}

const synth = new Synth(ctx);
synth.params.waveform.value = "square"; // effect pushes to osc.type
```

### Standalone Params (Outside AudioProcessor)

```typescript
import { Param, SchedulableParam } from "@audiorective/core";

// simple reactive value
const isPlaying = new Param({ default: false });
isPlaying.value = true;

// param with bind — syncs to external state
const osc = new OscillatorNode(ctx);
const waveform = new Param<OscillatorType>({
  default: "sine",
  bind: {
    set: (v) => {
      osc.type = v;
    },
  },
});
waveform.value = "square"; // pushes to osc.type
waveform.dispose(); // cleanup

// schedulable param bound to an existing AudioParam
const gain = new GainNode(ctx);
const vol = new SchedulableParam({
  default: 0.5,
  audioContext: ctx,
  audioParam: gain.gain,
});
vol.linearRampToValueAtTime(0, ctx.currentTime + 1);
vol.dispose(); // cleanup when done
```

---

## AudioEngine

### Lifecycle

`AudioEngine` manages the top-level audio system lifecycle. The `AudioContext` is created eagerly at construction time (browser suspends it automatically via autoplay policy). Processors are registered via `register()` and wired up in the `createEngine` setup callback.

Because the context is created eagerly, construction requires a browser. In an environment with no `AudioContext` constructor the engine throws [`EngineEnvironmentError`](#engineenvironmenterror) instead of building a half-formed graph.

```
createEngine() / new Engine()  →  context created                           →  state mirrors context ("suspended" until the browser allows audio)
.core.resume()                 →  context.resume() (needs user gesture)      →  'running'
.core.suspend()                →  context.suspend()                          →  'suspended'
.core.dispose()                →  processors disposed, context closed*      →  'closed' (terminal)
```

\* **Context ownership.** An engine that creates its own `AudioContext` closes it on `dispose()`. A context passed in (`new AudioEngine(ctx)`, `createEngine(setup, { context })`) is borrowed and is never closed by the engine; the caller closes it, though `engine.state` still reads `"closed"` after `dispose()`. The engine listens with `addEventListener("statechange")` rather than assigning `onstatechange`, so a borrowed context keeps its own handler, and `dispose()` removes the engine's listener.

`engine.state` mirrors `AudioContext.state` as a `ReadonlyCell<AudioContextState>` (`"suspended" | "running" | "closed"`): read `engine.state.value`, track it in an effect, or `subscribe` to it. `engine.latency` is a `ReadonlyCell<number>`. Only the engine writes them. `suspend()`, `resume()` and `untilReady()` read the state untracked, so calling them inside an effect does not subscribe it. `dispose()` and an external close of the context (state `"closed"`) reject any pending `untilReady()` with an error. `resume()` resolves at once when the context is already running.

After `dispose()`, `resume()` and `suspend()` reject with `new DOMException("AudioEngine is disposed.", "InvalidStateError")`. A `resume()` or `suspend()` still awaiting the context when it closes leaves the state `"closed"`.

The engine mirrors every `statechange` its context reports, not just the transition its own methods cause: a raw `context.resume()`/`context.suspend()` called on the underlying `AudioContext`, Safari's non-standard `interrupted` state (a phone call, Siri, another app taking the audio session), and `closed`. `interrupted` reads as `"suspended"`. `resume()` checks the real `context.state` rather than the mirror, so it reliably means "make sure the context is running now" even if the mirror was stale. A context that the browser lets run without a gesture starts `"running"` after its first `statechange`.

**Cancelling with a signal.** The constructor and `createEngine` take `{ signal }`; aborting it calls `dispose()`, and an already aborted signal disposes the engine at construction. `engine[Symbol.dispose]()` calls `dispose()` too.

### AudioEngine

```typescript
class AudioEngine {
  /** Without a context it creates one and closes it on dispose(). Aborting `options.signal` calls dispose(). */
  constructor(existingContext?: AudioContext, options?: { signal?: AbortSignal });

  get context(): AudioContext;
  /** Mirrors AudioContext.state: "suspended" until resume() runs, then "running"; "closed" after dispose(). */
  readonly state: ReadonlyCell<AudioContextState>;
  readonly latency: ReadonlyCell<number>; // samples — see Latency (PDC)
  get perceivedTime(): number;
  untilReady(): Promise<void>; // resolves when state becomes 'running'; rejects if the engine is disposed first

  /** Suspends the context. Rejects with InvalidStateError after dispose(). */
  suspend(): Promise<void>;
  /** Resumes the context; call it from a user gesture. Resolves at once when already running; rejects with InvalidStateError after dispose(). */
  resume(): Promise<void>;
  /** Disposes registered processors and graphs, and closes a context the engine created. Safe to call twice. */
  dispose(): void;
  [Symbol.dispose](): void;

  register<T extends AudioProcessor>(processor: T): T;
  defineGraph(fn: () => EdgeList, opts?: Omit<GraphOptions, "context">): GraphHandle; // root graph, sink = ctx.destination
  getPathLatency(proc: AudioProcessor): number; // throws LatencyUnknownError

  autoStart(
    target: EventTarget,
    options?: { events?: readonly string[] }, // default: ["click", "keydown", "touchstart"]
  ): () => void; // returns a detach function
}
```

### `autoStart(target, options?)`

Arms one-shot gesture listeners on `target` that call `resume()` on the first user interaction. Re-arms automatically if the engine state later drops from `running` (e.g. mobile background suspend). Disarms permanently when the engine is disposed. Returns a detach function that stops the effect and removes any armed listeners.

This is the engine-side primitive used by `@audiorective/react`'s `EngineProvider` and `@audiorective/threejs`'s `attach()`. Use it directly in frameworks without a wrapper.

```typescript
// Vanilla
const detach = engine.core.autoStart(document);
// ...later
detach();

// Custom events
engine.core.autoStart(canvas, { events: ["pointerdown"] });
```

### Build the engine after async assets

`createEngine`'s `setup` is synchronous. When the engine needs decoded buffers or an offline render, load them first and create the engine afterwards, inside an effect that disposes it on cleanup. Module-scope `createEngine` and `createEngineContext(engine)` assume the engine already exists, so use plain state in this shape:

```tsx
function App() {
  const [engine, setEngine] = useState<ReturnType<typeof build> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let built: ReturnType<typeof build> | undefined;
    let detach: (() => void) | undefined;
    void renderLoops().then((buffers) => {
      if (cancelled) return;
      built = build(buffers); // createEngine((ctx) => ({ ... })) with the buffers in hand
      detach = built.core.autoStart(document);
      setEngine(built);
    });
    return () => {
      cancelled = true;
      detach?.();
      built?.core.dispose();
    };
  }, []);

  return engine ? <Session engine={engine} /> : <Loading />;
}
```

### First gesture resumes, then schedule

A suspended context's `currentTime` is frozen, so anything scheduled "now" before the context runs lands at a stale time. When the gesture that starts audio is also the one that issues a command (a launch, a play button), await `resume()` first, then run the command:

```typescript
async function onPlay() {
  await engine.core.resume(); // resumes inside the click; resolves at once when already running
  clock.start(); // now context.currentTime is live
}
```

`resume()` is safe to call on every command; it resolves immediately while the context is running.

### `EngineEnvironmentError`

```typescript
class EngineEnvironmentError extends Error {}
```

Thrown by the `AudioEngine` constructor — and therefore by `createEngine` — when no `AudioContext` constructor exists and no context was supplied. It replaces a bare `ReferenceError: AudioContext is not defined`, and its message names the fix for the environment it landed in:

- **No `window`** (a server or build-time render): audiorective is client-only. Render the audio subtree client-only so its modules are never evaluated on the server — see [Server-rendered frameworks](/docs/client-boundary/).
- **A `window` but no Web Audio** (jsdom, for instance): pass a context explicitly, or run in a browser.

---

### `createEngine(setup, options?)`

Vue setup-style factory that replaces subclassing for the common case. User-defined properties are top-level; engine lifecycle is accessed via `.core`.

```typescript
function createEngine<T extends Record<string, unknown>>(
  setup: (context: AudioContext, helpers: EngineSetupHelpers) => T,
  options?: { context?: AudioContext; signal?: AbortSignal }, // aborting the signal disposes the engine
): T & { core: AudioEngine };

interface EngineSetupHelpers {
  defineGraph: AudioEngine["defineGraph"];
}
```

Auto-registers all `AudioProcessor` instances from the returned object. Only one reserved key: `"core"` — using it in the returned object is a compile-time type error and a runtime throw.

Throws [`EngineEnvironmentError`](#engineenvironmenterror) if the environment has no `AudioContext` constructor. Passing your own context — `createEngine(setup, { context })` — bypasses the check entirely, which is how you run against a mock or a host-provided context. The throw happens before `setup` runs, so a failed call never leaves a partly built graph behind.

**What gets registered.** Only values that are `AudioProcessor` instances at the top level of the returned object are registered, and `engine.core.dispose()` disposes exactly those, then closes a context the engine created. A processor nested inside another object (a plain composite such as a drum machine that owns processors) is not registered, and neither is the composite itself. Return the composite beside its processors, so the engine disposes the processors; the composite's own non-audio state (cells, timers, a `Clock`) is yours to tear down:

```typescript
const engine = createEngine((ctx) => {
  const kit = new Kit(ctx); // AudioProcessor: registered and disposed by the engine
  const machine = new DrumMachine(kit); // plain composite: kept on the result, not registered
  return { machine, kit };
});

engine.machine.clock.dispose(); // yours to dispose
engine.core.dispose(); // disposes kit
```

A processor you build later, outside `setup`, joins with `engine.core.register(processor)`.

The `setup` callback's original one-argument form (`createEngine((ctx) => …)`) still works — `helpers` is a second argument, so no existing consumer breaks.

```typescript
const engine = createEngine((ctx, { defineGraph }) => {
  const synth = new Synth(ctx);
  const sequencer = new Sequencer(synth, ctx);

  // root graph — its sink is ctx.destination, referenced directly, no reserved name
  defineGraph(() => [[synth, ctx.destination]]);

  return { synth, sequencer };
});

engine.synth; // Synth — fully typed, no ! assertion
engine.sequencer; // Sequencer
engine.core.resume(); // resume AudioContext
engine.core.state.value; // AudioContextState
engine.core.latency.value; // samples — longest path into ctx.destination
engine.core.perceivedTime; // ctx.currentTime minus latency and output latency — what the listener hears now
engine.core.getPathLatency(synth); // samples from synth.output to ctx.destination
engine.core.dispose(); // cleanup
engine.core.context; // AudioContext
```

---

## Shared contracts

Structural types let capability modules cooperate without importing each other. A module that needs one declares it as a parameter type; any object with the same members satisfies it.

```typescript
import type {
  BeatTiming,
  CancellableEvent,
  ScheduledEvent,
  TimedEvent,
  BeatEvent,
  TimedBeatEvent,
  SecondsOf,
  EventTransform,
  EventTransformContext,
  EventTransformInput,
} from "@audiorective/core";
import { applyEventTransforms, withCancel, hash01 } from "@audiorective/core";

interface CancellableEvent {
  cancel(): void;
  onEnded(listener: () => void): void;
}
type BeatTiming = Readonly<{ beatToTime(beat: number): number; timeToBeat(time: number): number }>;

// Seconds form: what a scheduler triggers.
type ScheduledEvent = Readonly<{ when: number }>; // audio-context seconds
type TimedEvent = ScheduledEvent & Readonly<{ duration: number; velocity: number }>;
// Beat form: what a transform reads and returns by default.
type BeatEvent = Readonly<{ beat: number }>;
type TimedBeatEvent = BeatEvent & Readonly<{ durationBeats: number; velocity: number }>;
type SecondsOf<E extends BeatEvent> = /* E with `beat` -> `when` and `durationBeats` -> `duration`; other fields unchanged */;

type EventTransformContext = Readonly<{ now: number; timing: BeatTiming; random: () => number; randomFor(event: object, key?: number | string): number }>;
// What a scheduler passes to applyEventTransforms: the context without randomFor, plus the inputs randomFor is built from.
type EventTransformInput = Omit<EventTransformContext, "randomFor"> & Readonly<{ seed?: number; keyOf?: (event: never) => number | string }>;
hash01(...parts: readonly (number | string)[]): number; // pure 32-bit hash to [0, 1)
type EventTransform<E extends BeatEvent = BeatEvent> = Readonly<{ id: string; params?: Readonly<Record<string, unknown>> }> &
  (
    | Readonly<{ unit?: "beat"; apply(events: readonly E[], context: EventTransformContext): readonly E[] }>
    | Readonly<{ unit: "second"; apply(events: readonly SecondsOf<E>[], context: EventTransformContext): readonly SecondsOf<E>[] }>
  );
applyEventTransforms<E extends BeatEvent>(events: readonly E[], transforms: readonly EventTransform<E>[], context: EventTransformInput): SecondsOf<E>[];
withCancel(event: CancellableEvent | null, undo: () => void): CancellableEvent;
```

A structural contract that exposes reactive state, such as a sequencer's `pattern` or a plugin context's cells, types it as `Readable<T>` (see [Readable](#readablet)). Read it with `.value` or with the raw accessor `$()`; both are tracked inside an effect and give the same value.

- `CancellableEvent` is a consumer-owned audio event that a scheduler may revoke after a transport or edit change. `Clock`'s `window.own(event, when)` accepts one (`@audiorective/clock` re-exports the type). A core `Voice` is not one; wrap it as in the Clock docs.
- `BeatTiming` converts between beats and absolute audio-context time. `Timeline` satisfies it, `applyEventTransforms` uses it for the unit conversions, and `StepSequencer.schedule(window, timing)` and `ClipLauncher.schedule(window, timing)` take it.
- An event has two forms. Inside a transform pipeline it is positioned in beats: `BeatEvent` is `{ beat }`, and `TimedBeatEvent` adds `durationBeats` and `velocity` (0..1) for note-like events such as a step hit. What a scheduler triggers is the seconds form: `ScheduledEvent` is `{ when }`, absolute audio-context seconds, and `TimedEvent` adds `duration` (seconds) and `velocity`. `SecondsOf<E>` is the seconds form of a beat event type `E` (`beat` becomes `when`, `durationBeats` becomes `duration`, every other field is kept). Because the two are distinct types, a trigger's event type says "final, clamped, seconds". A scheduler whose events have no duration or velocity (a clip launch) uses `BeatEvent` and the same transform contract.
- `EventTransform<E>` is a pluggable step a scheduler runs between computing its events and triggering them. It is data-shaped (`id`, serialisable `params`, a pure `apply`) so it can be saved later. By default it reads and returns beat events, so swing, offset and nudges are beat arithmetic that holds at any tempo. Set `unit: "second"` to read and return the seconds form instead, for adjustments that are really about time, such as millisecond jitter. `context.now` is the earliest position an event may sound, in the transform's own unit (beats for a beat transform, seconds for a seconds transform), `context.timing` maps between beats and seconds, `context.randomFor(event, key?)` is the randomness a transform should use: a number in [0, 1) that is a pure function of the scheduler's `seed`, the event's identity and `key`, so an event gets the same number however often or in whichever window it is scheduled (different `key`s give independent numbers for one event). The scheduler gives `applyEventTransforms` a `keyOf(event)` that builds the identity from fields that survive a transform's `{ ...event }` copy (a step hit uses lane, loop, step counter and repeat index); without `keyOf` the identity is the event's `beat` (or `when`), which is stable only while no earlier transform moves it. `context.random` is the scheduler's sequential source: it advances on every call, so a re-queue draws new numbers and results that use it are not stable. `hash01(...parts)` is the pure hash behind `randomFor`, for a scheduler that draws its own position-keyed numbers. A transform keeps no state across windows and never triggers or cancels audio.

```ts
// Beat transform (default): push every event a sixteenth of a beat late, at any tempo.
const late: EventTransform<TimedBeatEvent> = { id: "late", apply: (events) => events.map((e) => ({ ...e, beat: e.beat + 0.0625 })) };

// Seconds transform: jitter each event by up to 5 ms either way.
const jitter: EventTransform<TimedBeatEvent> = {
  id: "jitter",
  unit: "second",
  apply: (events, { randomFor }) => events.map((e) => ({ ...e, when: e.when + (randomFor(e) - 0.5) * 0.01 })),
};
```

- `withCancel(event, undo)` returns a `CancellableEvent` whose `cancel()` cancels `event`, then runs `undo` once (later calls do nothing); `onEnded` passes through to `event`. Use it when a trigger does more than start a sound, such as scheduling a filter change: a scheduler that cancels and re-triggers pending events (a Clock `refresh()`, a stop, a `StepSequencer.reset()`) then retracts the extra scheduling too. `undo` does not run for an event that already ended. With a `null` event it still runs on cancel, and the returned event ends at that cancel.
- `applyEventTransforms(events, transforms, context)` (`context` is an `EventTransformInput`) is the enforcement every scheduler shares. `events` are beat events and `context.now` is in seconds. It runs the transforms in array order and converts the events through `context.timing` only where the unit changes: a seconds transform gets the events as `when` and `duration`, and its output is mapped back to `beat` and `durationBeats` before the next beat transform, so consecutive transforms of one unit never round-trip. It throws `Event transform "<id>" ...` naming the transform for an output with a non-finite `beat` (`when` for a seconds transform), a `durationBeats` (`duration`) that is not a finite number above 0, or a `velocity` outside 0..1 (checked only on events that have them), or for a `unit` other than `"beat"` or `"second"`, and it drops events with `velocity` 0. After the last transform it converts to seconds, moves any event earlier than `context.now` to `now`, and returns the seconds events. The scheduler then triggers and owns every returned event. `StepSequencer` uses it ([Step Sequencer: advanced](./sequencer-advanced.md#custom-transform)).

## registerWorklet

```typescript
registerWorklet(ctx: BaseAudioContext, name: string, source: string): Promise<void>
```

Loads a worklet module into `ctx` once per `(context, name)`: concurrent and repeated calls share the first load, and a failed load can be retried. The source is served from a Blob URL, so no bundler setup is needed. It rejects with `WorkletUnavailableError` when the context has no `audioWorklet`. Both are exported from `@audiorective/core`; `@audiorective/effects` re-exports them. Packages and apps that ship their own worklet use this instead of calling `addModule` themselves.

## Package Structure

```
signals/src/
├── AudioEngine.ts       # engine lifecycle + createEngine factory
├── AudioProcessor.ts    # base class with param/computed/effect factories
├── Cell.ts              # reactive container for structured data (Immer-based)
├── Param.ts             # reactive parameter wrapper
├── SchedulableParam.ts  # numeric param with Web Audio scheduling
├── ParamSync.ts         # per-context RAF sync loop
├── Spatial.ts           # AudioProcessor wrapping a PannerNode
├── Analyser.ts          # AudioProcessor wrapping an AnalyserNode (spectrum/waveform tap)
├── peaks.ts             # pure PCM summaries and frame/time bin ranges
├── contracts.ts         # CancellableEvent, BeatTiming and EventTransform contracts (beat and seconds event forms) + applyEventTransforms, withCancel; hash.ts: hash01
├── types.ts             # SignalAccessor, ComputedAccessor, Readable, ParamBind, etc.
└── index.ts             # public exports
```

## Exports

Every name below is exported from the `@audiorective/core` root. `scripts/check-core-exports.test.mjs` fails when this list and `packages/core/src/index.ts` differ.

```typescript
// Classes
export { Param, SchedulableParam, ParamSync, AudioProcessor, AudioEngine, Cell, ReadonlyCell, Spatial, Analyser };
export { Sampler, BufferPlayer, FilePlayer };
export { AudioBufferCache };
export { EngineEnvironmentError, LatencyUnknownError, WorkletUnavailableError };

// Factories and functions
export { createEngine, cell, readonlyCell, defineGraph };
export { batch, untracked, effect, computed };
export { loadAudioBuffer, registerWorklet, reverseBuffer, renderOffline, playSound, assertSound, noteNumber };
export { applyEventTransforms, withCancel, hash01 };
export { summarizePeaks, peakFrameRange };

// Constants
export { DEFAULT_SYNC_INTERVAL_MS };

// Types
export type {
  AudioEngineOptions,
  ValueRange,
  ParamRange,
  ParamSpec,
  ParamBind,
  ParamOptions,
  Readable,
  SignalAccessor,
  ComputedAccessor,
  BuildHelpers,
  BuildResult,
  SpatialOptions,
  AnalyserOptions,
  SamplerOptions,
  NoteName,
  Sound,
  SoundFactory,
  SoundHit,
  SoundVoice,
  PlayOptions,
  PlaySoundOptions,
  Voice,
  BufferPlayerOptions,
  FilePlayerOptions,
  CancellableEvent,
  BeatTiming,
  ScheduledEvent,
  TimedEvent,
  BeatEvent,
  TimedBeatEvent,
  SecondsOf,
  EventTransformUnit,
  EventTransformContext,
  EventTransformInput,
  EventTransform,
  RenderOfflineOptions,
  GraphEdge,
  EdgeList,
  EdgeOptions,
  GraphHandle,
  GraphOptions,
  GraphSource,
  GraphSink,
  GraphSnapshot,
  PCMData,
  PeakSummary,
};
```

## Common errors

| Message                                                                                                      | Cause                                                                                                                                            | Fix                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `Sound needs a note name like "C4", an AudioBuffer or a sound factory function.`                             | A `sound` (Sampler, pad, lane, clip) is not a note name, an `AudioBuffer` or a function.                                                         | Pass `"C4"`, a decoded `AudioBuffer` or a `SoundFactory`.                                                           |
| `Sound hit needs finite seconds from 0 for offset and duration.`                                             | A hit's `offset` or `duration` is negative or not finite.                                                                                        | Pass seconds from 0, or omit them.                                                                                  |
| `Note needs a MIDI number from 0 to 127 or a note name like "C4".`                                           | `noteOn`, `noteOff` or `rootNote` got a value that is not a note.                                                                                | Pass a MIDI number from 0 to 127 or a name like `"C4"`, `"F#3"`.                                                    |
| `Sound factory needs to return an AudioScheduledSourceNode or { output, sources } with at least one source.` | A sound factory returned something else, or a chain without sources.                                                                             | Return one source node, or `{ output, sources: [...] }` with the nodes unconnected and unstarted.                   |
| `Sound factory duration needs finite seconds from 0.`                                                        | A `SoundVoice.duration` is negative or not finite.                                                                                               | Return finite seconds from 0, or omit it to hold for `hit.duration`.                                                |
| `Sound hit needs a finite time in seconds.`                                                                  | `when` is NaN or infinite.                                                                                                                       | Pass finite audio-context seconds, or omit it for now.                                                              |
| `Sound hit needs a velocity from 0 to 1.`                                                                    | `velocity` is NaN or infinite.                                                                                                                   | Pass a number from 0 to 1.                                                                                          |
| `Sound hit needs finite semitones for pitch.`                                                                | `pitch` is NaN or infinite.                                                                                                                      | Pass finite semitones.                                                                                              |
| `Sampler is disposed.`                                                                                       | `trigger` or `noteOn` after `dispose()` or an aborted `signal`.                                                                                  | Create a new `Sampler`.                                                                                             |
| `AudioEngine disposed before it became ready`                                                                | `untilReady()` was called on, or was pending when, a disposed engine.                                                                            | Create a new engine; `dispose()` is final. Do not await readiness across a teardown.                                |
| `An immer producer returned a new value *and* modified its draft. …`                                         | Immer's message, thrown from `Cell.update` when an expression-bodied recipe such as `p => Object.assign(p, x)` mutates the draft and returns it. | Use a block body, `p => { Object.assign(p, x); }`, or assign `cell.value = next` to replace the value.              |
| `createEngine: setup returned reserved key "core"`                                                           | The object returned by `setup` has a `core` property, which the engine reserves for itself.                                                      | Rename that property; read the engine core as `engine.core`.                                                        |
| `Event transform "<id>" returned an event without a finite "beat".`                                          | A beat transform (the default unit) returned an event whose `beat` is missing or not finite.                                                     | Fix that transform; return finite beats, or set `unit: "second"` to work with `when`.                               |
| `Event transform "<id>" returned an event without a finite "when".`                                          | A seconds transform (`unit: "second"`) returned an event whose `when` is missing or not finite.                                                  | Fix that transform; return finite seconds.                                                                          |
| `Event transform "<id>" returned an event whose "durationBeats" is not a finite number above 0.`             | A beat transform returned an event with a `durationBeats` that is zero, negative or not finite.                                                  | Fix that transform; omit `durationBeats` or return a finite number above 0.                                         |
| `Event transform "<id>" has a unit other than "beat" or "second".`                                           | A transform's `unit` is something else, such as `"ms"`.                                                                                          | Use `"beat"` (or omit `unit`) or `"second"`.                                                                        |
| `Event transform "<id>" returned an event whose "duration" is not a finite number above 0.`                  | A seconds transform returned an event with a `duration` that is zero, negative or not finite.                                                    | Fix that transform; omit `duration` or return a finite number above 0.                                              |
| `Event transform "<id>" returned an event whose "velocity" is not a finite number from 0 to 1.`              | A transform returned a hit with a `velocity` outside 0..1 or not finite.                                                                         | Fix that transform; clamp velocity to 0..1.                                                                         |
| `Event transform "<id>" must return an array of events.`                                                     | A transform returned something other than an array.                                                                                              | Return an array (possibly empty) from `apply`.                                                                      |
| `<name>'s path latency is unknown: …`                                                                        | A latency query on a processor that appears in no `defineGraph` and has no `connect` edge (`LatencyUnknownError`).                               | Wire it with `defineGraph`, its own or the engine's, or with `processor.connect(...)`, not a raw node `.connect()`. |
| `AudioEngine is disposed.`                                                                                   | `resume()` or `suspend()` was called after `dispose()` (rejects with a `DOMException` named `InvalidStateError`).                                | Create a new engine; `dispose()` is final. Stop callers (gesture handlers, `autoStart`) before disposing.           |
| `AudioProcessor.connect: <name> has no output`                                                               | `connect()` was called on a processor whose `output` getter returns `undefined`.                                                                 | Give the processor an `output`, or connect a node that has one.                                                     |
| `AudioProcessor.connect: <name> has no input`                                                                | `connect()` was given a processor destination whose `input` getter returns `undefined` (an instrument or output-only processor).                 | Connect to a processor that declares `input`, or to a node or param.                                                |
| `<name> is disposed.`                                                                                        | `connect()` was called on a processor after `dispose()`.                                                                                         | Create a new processor; `dispose()` is final.                                                                       |
| `defineGraph: <name> is a bare AudioWorkletNode …`                                                           | A worklet node was used directly as an edge endpoint, so its latency is unknowable.                                                              | Wrap it in an `AudioProcessor` that declares `latency`.                                                             |
| `defineGraph: <name> used as source has no output` / `defineGraph: <name> has no output`                     | A processor with no `output` (an input-only sink) was used as an edge source or endpoint.                                                        | Check the edge direction; give the processor an `output` or route from a node that has one.                         |
| `loadAudioBuffer: failed to fetch <url> (<status>)`                                                          | The URL answered with a non-2xx HTTP status.                                                                                                     | Check the URL and server response; decode errors surface from `decodeAudioData` instead.                            |
| `registerWorklet: this AudioContext has no audioWorklet, so "<name>" cannot be loaded. …`                    | The context has no `audioWorklet` (old browser, some test contexts); this is `WorkletUnavailableError`.                                          | Run in a browser with AudioWorklet support, or choose an engine that needs no worklet.                              |
