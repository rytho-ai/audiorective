---
title: Architecture
---

The audio layer must be fully operable without any UI framework. React (or any future binding) is a thin observation and mutation layer on top.

## The Rule

**All audio operations live as methods on `AudioProcessor` subclasses.** UI components call these methods — they never orchestrate audio logic themselves.

For how to write the class itself — skeleton, state, graph wiring, latency, lifecycle, tests — see [`authoring-processors.md`](./authoring-processors.md).

## The two axes

The system has two independent spans, and a class can sit on one, the other, or both:

| Axis      | Owned by                        | Answers                                 |
| --------- | ------------------------------- | --------------------------------------- |
| **Space** | `AudioProcessor` → `AudioNode`s | what sounds, how it's wired, what it is |
| **Time**  | `@audiorective/clock`           | when events happen, transport, tempo    |

They compose rather than compete. A processor that needs timing **holds a `Clock`**; it does not become something-other-than-a-processor by doing so. Membership on the space axis is decided by one question only: does this class own `AudioNode`s and produce output?

`apps/web/src/demos/sequencer`'s `DrumMachine` is the worked example — an `AudioProcessor` (master gain + four `Sampler`s, exposing `output`) that consumes a `Clock` for its scheduling.

## What belongs where

### Audio layer (`AudioProcessor` subclasses)

- Audio graph construction and wiring — via `defineGraph`; raw `.connect()`/`.disconnect()` only for leaf nodes inside a processor
- Envelope shaping, note triggering
- Parameter automation sequences (ramps, sweeps, scheduled transitions)
- Any operation that touches `AudioContext.currentTime` or schedules values on `AudioParam`

Look-ahead scheduling loops (sequencers, drum machines, loopers, transport
start/stop/seek) belong to **`@audiorective/clock`** — see `docs/clock.md`. An
`AudioProcessor` must not _reimplement_ them: no timer polling `currentTime`,
no hand-rolled bar math, no bespoke start/pause/seek state. It delegates to a
`Clock` and schedules from the `onTick` window it receives.

**Holding a `Clock` is expected; reproducing one is the error.**

### Structured state (plain classes with `Cell`)

- Step patterns, drum grids, sequence data
- Presets, configuration objects
- Any complex/nested state that doesn't own AudioNodes or do scheduling

Classes that only hold structured state should **not** extend `AudioProcessor`. Use `Cell` instead.

### UI layer (React components, etc.)

- Reading param values for display (`useValue(synth.volume)`)
- Reading cell values for display (`useValue(sequencer.pattern)`)
- Setting param values from user input (`synth.volume.value = 0.8`)
- Calling audio-layer methods (`synth.filterSweep()`, `sequencer.rampBpm(180, 4)`)
- Layout, styling, conditional rendering

## Layers and dependency direction

Packages sit in four layers. An import points down, never up or sideways inside a layer.

```
Layer 4  Apps          apps/daw-demo, a drum machine, a project-file tool, your app
Layer 3  Project and   widgets  ∥  daw (daw/runtime, daw/dawproject, daw/project)
         interaction
Layer 2  Capabilities  clock, midi, effects, host, player, recorder,
                       samples, pads,
                       sequencer, launcher
Layer 1  Foundation    core
Side     (core only)   react, threejs, playcanvas, devtools
```

`widgets` and `daw` are parallel and never import each other. The app is the one place that knows both, and the wiring is app code. Each box in the diagram is a responsibility; the capability boxes `player`, `recorder`, `samples`, `pads`, `sequencer` and `launcher` are separate packages.

| Module              | May import                                                                                      | Must not import                                              |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| App                 | any layer                                                                                       | n/a                                                          |
| `widgets`           | core; the pure `midi` root (values and types); types of `player`; or local structural contracts | `daw`; capability runtime classes, other capability packages |
| `daw/runtime`       | `daw/project`, core, the capability modules it needs                                            | `widgets`, `daw/dawproject`                                  |
| `daw/dawproject`    | `daw/project`, core                                                                             | the runtime, anything needing an `AudioContext`              |
| `daw/project`       | core (including `PCMData`), `midi` root, `effects/rack-preset`                                  | the runtime, the codec, `AudioContext`, the DOM              |
| A capability module | core                                                                                            | other capability modules, layer 3                            |
| `core`              | nothing                                                                                         | everything                                                   |

`pnpm check:layers` enforces these edges over the real import graph. A new edge between capability modules needs a written reason.

### Three kinds of capability module

"Independent" means two things: the module imports no sibling, and it works when taken out alone. They are separate questions.

| Kind           | Test                                                                     | Modules                                                                                          |
| -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Standalone** | Imports only core; give it an `AudioContext` and it works                | `clock`, `midi`, `effects`, `host`, `player`, `recorder`, `samples`, `pads`                      |
| **Borrowing**  | Imports only core, but cannot run until the caller supplies an interface | `sequencer` (attaches to a clock or transport), `launcher` (attaches to a clock)                 |
| **Composed**   | Imports a sibling capability module                                      | none; an exception needs a written reason and an edge that disappears when the feature is unused |

A borrowing module names what it needs as a structural type in [core](./core.md#shared-contracts), so `Timeline`, `Clock`, `PadBank` or the DAW runtime can each satisfy it without the module importing any of them. `SampleLibrary` previews through core `BufferPlayer` for the same reason: it stays standalone.

### Features are not modules: the Mixer

A feature the user sees usually spans three layers. To place a decision, ask whether it survives closing the view and whether it survives saving the file.

| Part of the Mixer                                | Owner         | Code                                                                                                                          |
| ------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Faders, pan, mute and solo buttons, level meters | `widgets`     | `mountMixer`, which takes only `state`, `editTrack` and `editMaster`                                                          |
| Per-track volume, pan, mute, solo and routing    | `daw/project` | `ProjectTrack`                                                                                                                |
| Which tracks and paths stay audible under solo   | `daw/runtime` | `soloRouting` over `ProjectTrack`                                                                                             |
| Gain, pan and mute nodes, sends                  | `daw/runtime` | The runtime `Mixer` builds each strip from `effects` `Channel` and `SendBus`; `ProjectTrack` values are written to its params |

The piano roll, arrangement, automation lanes, clip grid and step grid split the same way: gestures and drawing in `widgets`, saved content in `daw/project`, sound in a capability module or the runtime. A widget that takes a local structural contract (`step-grid`, `sample-browser`, `clip-grid`, `warp-markers`, `clip-envelope-editor`, `mountMixer`) works over a DAW project or over your own model.

`effects` `Channel` and `SendBus` are the strip and send bus for any app, and the Workspace builds its strips from them. The strip is `Channel` with `channelCountMode: "max"`, so a mono track reaches the panner as mono and keeps the equal-power pan law. `soloRouting`'s per-edge decisions land on `channel.params.outputEnabled` (main output) and `send.enabled` (one send), and its strip decision folds into `mute`. `Project` stays the only owner of gain, pan, mute and solo: `applyMixer` projects `ProjectTrack` values into the `Channel` params, the same way it once wrote plain nodes, and nothing reads them back. `trackMixerOutput` borrows `channel.tap`, the post-mute node ahead of the output gate.

### Inside the runtime

`daw/runtime` splits by responsibility, not by layer: `Workspace` keeps the public API, transport and Project-edit reconciliation, and delegates to internal collaborators that depend on `daw/project` and the capability modules but not on `Workspace`.

| Module                                  | Owns                                                                                                                                                                             | Reads                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `runtime.ts` (`Workspace`)              | The public API, the `cells`, the track-runtime map, the graph build, transport (`play`, `pause`, `stop`, `seek`), and Project-edit reconciliation (`flush`, `sync`, light edits) | Everything below, through narrow handles                  |
| `mixer.ts` (`Mixer`)                    | The `Channel` and `SendBus` strips, send routing, and writing Project mixer values into them                                                                                     | The track map, the current Project, the master `GainNode` |
| `clip-scheduler.ts` (`ClipScheduler`)   | Scheduled audio handles, media chunk loading, decoded-buffer caches, one tick window of MIDI and audio clips                                                                     | Track runtimes and timing passed per call                 |
| `audition.ts` (`Audition`)              | The current clip or range audition cell and the clock or handle that plays it                                                                                                    | The current Project, the scheduler, the master output     |
| `clip-stretch.ts` (`ClipStretch`)       | One cancellable stretch job per clip and the prepared edit it returns                                                                                                            | The current Project                                       |
| `take-placement.ts`                     | Pure take-anchor validation and take-position maths                                                                                                                              | Nothing                                                   |
| `track-reconcile.ts`                    | Pure diffs between a live track and its Project track (rack settings, gain-automation-only edits, device keys)                                                                   | Nothing                                                   |
| `track-runtime.ts`, `project-lookup.ts` | The shared `TrackRuntime` type and a clip lookup by id                                                                                                                           | Nothing                                                   |

### Two reference compositions

| Application                         | Needs                                   | Optional                                                | Never loaded                                                             |
| ----------------------------------- | --------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| A drum machine with its own buffers | `core`, `clock`, `sequencer`, `pads`    | `widgets` (step grid), `samples` (load or browse sound) | `daw`, `player`, `host`, `effects`, `midi`, `recorder`, `launcher`       |
| A `.dawproject` tool in Node        | `core`, `daw/project`, `daw/dawproject` | `effects/rack-preset`, `midi`                           | `daw/runtime`, `clock`, `host`, `widgets`, the other capability packages |

Keep the dependency direction downward. Bind widgets to the module that already owns the value. Store project data once, and keep temporary runtime state where it is used.

## Examples

### Wrong — audio scheduling in React

```typescript
// Component knows about AudioContext timing and scheduling API
const handleFilterSweep = useCallback(() => {
  const now = synth.context.currentTime;
  const currentCutoff = synth.cutoff.value;
  synth.cutoff.setValueAtTime(currentCutoff, now);
  synth.cutoff.linearRampToValueAtTime(18000, now + 1);
  synth.cutoff.linearRampToValueAtTime(currentCutoff, now + 2);
}, [synth]);
```

### Right — audio method, thin UI call

```typescript
// Audio layer — self-contained, testable, no UI dependency
class StepSynth extends AudioProcessor {
  filterSweep(peakFreq = 18000, duration = 2): void {
    const now = this.context.currentTime;
    const currentCutoff = this.cutoff.value;
    this.cutoff.setValueAtTime(currentCutoff, now);
    this.cutoff.linearRampToValueAtTime(peakFreq, now + duration / 2);
    this.cutoff.linearRampToValueAtTime(currentCutoff, now + duration);
  }
}

// UI layer — just a trigger
const handleFilterSweep = useCallback(() => {
  synth.filterSweep();
}, [synth]);
```

### Simple `.value` assignments are fine in UI

```typescript
// This is OK — .value is the Param public API, not audio scheduling
<input onChange={(e) => synth.volume.value = Number(e.target.value)} />
```

Setting `.value` is a direct property assignment on the Param abstraction. It's the intended interface between UI and audio. No need to wrap these in setter methods.

### Wrong — sequencer as AudioProcessor when it has no audio nodes

```typescript
class DrumSequencer extends AudioProcessor<{ pattern: Param<boolean[]> }> {
  constructor(ctx: AudioContext) {
    super(ctx, ({ param }) => ({
      params: { pattern: param({ default: Array(16).fill(false) }) },
    }));
  }

  get output() {
    return undefined; // no audio output — red flag
  }
}
```

### Right — plain class with Cell for structured state

```typescript
class DrumSequencer {
  readonly pattern = cell<boolean[]>(Array(16).fill(false));

  toggleStep(index: number) {
    this.pattern.update((draft) => {
      draft[index] = !draft[index];
    });
  }
}
```

`AudioProcessor` is for things that actually process audio (own AudioNodes, use scheduling). If a class just holds data, it's a plain class with `Cell`.

Note what does _not_ decide this: whether the class holds a `Clock`. A pattern
store that owns no nodes stays a plain class even if it schedules; a drum
machine that owns samplers is an `AudioProcessor` even though a `Clock` drives
it. The question is always node ownership — the space axis.

## Why this matters

1. **Testability** — Audio behaviors can be tested without mounting components or simulating DOM events.
2. **Portability** — Same audio code works with React, Vue, Three.js, or no UI at all (headless, CLI, Node.js with web audio polyfill).
3. **Clarity** — Components become declarative bindings. Audio classes own all temporal and scheduling complexity.
4. **Composability** — Audio operations can call each other. A `Sequencer` can call `synth.filterSweep()` as part of a pattern, not just UI event handlers.

## Litmus test

> Can I run this audio behavior from a unit test or a script with no DOM?

If not, the logic is in the wrong layer.

---

# UI/UI Separation — Decoupling React from Imperative Views

The same principle extends to UI/UI: when React shares the screen with an imperative renderer (Three.js scene, Canvas2D, WebGPU, etc.), put **any state both views read or write** — selection, hover, mode, drag target, anything — on the engine as a `Cell` or `Param`. Both views then observe the engine independently.

Do not let React own the shared state and thread it into the imperative side via refs or callbacks. That creates back-channels and lifecycle bugs.

- React reads with `useValue(engine.foo)`, writes with `engine.foo.value = x`.
- The imperative view reads with alien-signals `effect(() => engine.foo.$())`, writes with the same `.value =` setter.

The React component for the imperative view collapses to a DOM host that constructs the scene class, mounts it, and disposes on unmount. No props, no `useRef` mirrors of React state, no callbacks crossing the boundary.

### Wrong — React owns state, scene needs back-channels

```typescript
function SpatialPanner({ selectedId, onSelect }: Props) {
  const selectedIdRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  // ...200 lines of three.js reading refs and calling onSelectRef.current(...)
}
```

### Right — engine owns state, React and the scene are peers

```typescript
// engine.ts — selection is engine state, not React state
export const engine = createEngine((ctx) => {
  const tracks = buildTracks(ctx);
  const selectedTrackId = cell<string>(tracks[0].id);
  return { tracks, selectedTrackId };
});

// scene/SpatialScene.ts — plain TS class, no React
import { effect } from "alien-signals";
class SpatialScene {
  constructor() {
    // ...
    this.disposers.push(effect(() => this.syncSelection(engine.selectedTrackId.$())));
  }
  private onPointerDown(/* ... */) {
    engine.selectedTrackId.value = entry.track.id; // write directly
  }
}

// SpatialPanner.tsx — DOM host only, ~15 lines
function SpatialPanner() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scene = new SpatialScene();
    scene.mount(ref.current!);
    return () => scene.dispose();
  }, []);
  return <div ref={ref} />;
}

// Any other React component reads/writes the same Cell
function TrackMatrix() {
  const { selectedTrackId } = useEngine();
  const id = useValue(selectedTrackId);
  // onSelect: selectedTrackId.value = track.id
}
```

The scene class becomes plain TypeScript — testable and mountable without React. The engine is the meeting point for _every_ observer. See `apps/sequencer-poc/src/scene/SpatialScene.ts` for a worked example.
