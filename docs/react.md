---
title: React
---

React bindings for audiorective signals. Direct mutation model — no dispatch, no actions. The processor is the source of truth.

## Dependencies

```json
{
  "dependencies": {
    "@audiorective/core": "workspace:*"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0"
  }
}
```

## Package Structure

```
react/src/
├── hooks.ts
├── context.tsx
└── index.ts
```

---

## Hooks

### `useValue(source)`

Subscribe to a reactive source. Accepts either:

- A `Readable<T>` — `Param`, `SchedulableParam`, or `Cell`
- A `ComputedAccessor<T>` — a callable `() => T` produced by `alien-signals` `computed` or `this.computed(...)` inside an `AudioProcessor`

Re-renders when the value changes. Always returns a read-only snapshot — to mutate, write to the source directly (`param.value = x`, `cell.update(...)`). Computeds have no setter on the source, so they are read-only by construction.

```typescript
// Param
const volume = useValue(synth.volume);

// Cell
const pattern = useValue(machine.pattern); // Cell<boolean[]>

// A tracked getter on a headless capability class (a StepSequencer step or playhead): pass a function
const velocity = useValue(useCallback(() => seq.lanes.kick.steps[i].velocity, [seq, i]));

// Computed
const label = useValue(synth.displayLabel); // ComputedAccessor<string>
```

#### Writing back — direct mutation

```typescript
function VolumeSlider({ synth }) {
  const volume = useValue(synth.volume);
  return (
    <input
      type="range"
      value={volume}
      onChange={(e) => {
        synth.volume.value = +e.target.value;
      }}
    />
  );
}
```

#### Cell example

```typescript
function StepGrid() {
  const { machine } = useEngine();
  const pattern = useValue(machine.pattern); // Cell<boolean[]>

  return (
    <div>
      {pattern.map((active, i) => (
        <button key={i} data-active={active} onClick={() => machine.toggleStep(i)} />
      ))}
    </div>
  );
}
```

#### Step sequencer lanes

A `StepSequencer` lane's `steps[i].velocity` and `playhead` are tracked getters, not cells, so read them through a function source and keep the function's identity stable (`useCallback`, or one per child component); an inline arrow resubscribes on every render, and one that returns a new array or object each call re-renders in a loop. Read one primitive per call.

```typescript
function Step({ seq, lane, i }: { seq: StepSequencer; lane: string; i: number }) {
  const velocity = useValue(useCallback(() => seq.lanes[lane].steps[i].velocity, [seq, lane, i]));
  return <button data-active={velocity > 0} onClick={() => (seq.lanes[lane].steps[i].velocity = velocity > 0 ? 0 : 1)} />;
}

function Playhead({ seq }: { seq: StepSequencer }) {
  const step = useValue(useCallback(() => seq.lanes.kick.playhead, [seq])); // number | null
  return <span>{step ?? "-"}</span>;
}
```

---

## Context

### `createEngineContext(engine)`

Creates a typed `EngineProvider` and `useEngine` hook for an engine created by `createEngine`. Accepts `T extends { core: AudioEngine }`. Works with React 18 and 19.

`EngineProvider` always renders children immediately. Safe because `createEngine` wires up all processors eagerly at construction time. Components use `useValue(engine.core.state)` to know whether audio is running and show UI accordingly.

The `autoStart` prop (default `true`) delegates to [`engine.core.autoStart(document)`](./core.md) — a one-shot gesture listener (`click`/`keydown`/`touchstart`) that calls `engine.core.start()` on the first user interaction. Re-arms automatically if the engine state drops from running (e.g. mobile background suspend).

```typescript
// audio/engine.ts
import { createEngine } from "@audiorective/core";
import { createEngineContext } from "@audiorective/react";

export const engine = createEngine((ctx) => {
  const synth = new Synthesizer(ctx);
  synth.output.connect(ctx.destination);
  return { synth };
});

export const { EngineProvider, useEngine } = createEngineContext(engine);

function App() {
  return (
    <EngineProvider>
      <SynthUI />
    </EngineProvider>
  );
}

function SynthUI() {
  const { synth } = useEngine();
  const volume = useValue(synth.volume);
  return (
    <input
      value={volume}
      onChange={(e) => {
        synth.volume.value = +e.target.value;
      }}
    />
  );
}
```

## Who owns the AudioContext

**`createEngine` does — never a component.** This is the single most important lifecycle rule in the package, and it is easy to drift off because building an `AudioContext` in an `onClick` feels like the obvious way to satisfy the browser's user-gesture requirement.

It isn't necessary. `AudioEngine` creates the context at module scope and holds it for the page's lifetime; `EngineProvider`'s `autoStart` resumes it on the first interaction. So there is nothing to construct in an effect, nothing to `resume()` by hand, and nothing to close on unmount — which is why the entire class of teardown bugs below cannot occur. Both apps in this repo follow it: `apps/web/src/demos/livehouse/audio/engine.ts` and `apps/web/src/demos/sequencer/audio/engine.ts`.

audiorective is client-only, so this rule has a corollary in server-rendered frameworks: the engine module must never be evaluated on the server. Module-scope `createEngine` stays the canonical pattern there — it is correct _inside_ a client-only island, because the island guarantees the module only ever loads in a browser. Reaching for a lazy accessor or a nullable engine to survive SSR is the wrong fix. See [Server-rendered frameworks](/docs/client-boundary/).

If a host application hands you a context, pass it in rather than reaching for `new AudioContext()`:

```typescript
export const engine = createEngine((ctx) => ({ machine: new DrumMachine({ audioContext: ctx }) }), { context: hostContext });
```

Note that `createEngine`'s setup callback still receives `ctx` and you still pass it explicitly to every node and processor — that part is the normal pattern, not a smell. What `createEngine` owns is the context's _lifecycle_, not its plumbing.

### Starting the transport on the same click

`autoStart` and an explicit `core.start()` are both idempotent, so a transport button can safely do both:

```tsx
async function togglePlay() {
  await core.start(); // resolves immediately once running
  playing ? machine.pause() : machine.play();
}
```

Doing it explicitly removes an ordering question. React attaches its handlers to the root container while `autoStart` listens on `document`, so the button's `onClick` runs _first_ — and a transport started against a still-suspended context anchors itself to a frozen `currentTime`. Awaiting `core.start()` makes the ordering irrelevant.

### If you genuinely must own one in a component

Rare — multiple independent contexts on one page, or a context whose lifetime is shorter than the app's. The trap is the teardown, and it is worth knowing because the symptom is silent.

**Wrong — the cleanup closes the context it just created:**

```tsx
const [machine, setMachine] = useState<DrumMachine | null>(null);
const ctxRef = useRef<AudioContext | null>(null);

useEffect(() => {
  return () => {
    machine?.dispose();
    void ctxRef.current?.close(); // runs on null -> instance, not just unmount
  };
}, [machine]);

function powerOn() {
  const ctx = new AudioContext();
  ctxRef.current = ctx;
  setMachine(new DrumMachine({ audioContext: ctx /* ... */ }));
}
```

When `machine` goes `null → instance`, React runs the _previous_ render's cleanup before the next effect. `machine?.dispose()` is null-safe and no-ops, but `ctxRef.current` is already the live context — so it gets closed immediately.

The symptom is nasty because nothing throws: the clock's ticks keep firing, `state` still reads `"playing"`, and the only tell is that `ctx.currentTime` never advances, so every derived position freezes at its start value.

**Right — context and engine are one state value, torn down together:**

```tsx
const [rig, setRig] = useState<{ ctx: AudioContext; machine: DrumMachine } | null>(null);

useEffect(() => {
  if (!rig) return; // nothing to clean up before power-on
  return () => {
    rig.machine.dispose();
    void rig.ctx.close();
  };
}, [rig]);

function powerOn() {
  const ctx = new AudioContext();
  void ctx.resume();
  setRig({ ctx, machine: new DrumMachine({ audioContext: ctx /* ... */ }) });
}
```

The early `return` means the pre-power-on render registers no cleanup at all, so the only teardown that ever runs is the real one. Keeping the context in state beside the thing that uses it — rather than in a ref the effect can reach across renders — is what makes that possible.

There is no worked example of this in the repo, deliberately: `apps/web/src/demos/sequencer` was written this way first, hit exactly this bug, and was rewritten onto `createEngine`. Reach for the pattern above only when `createEngine`'s `context` option genuinely cannot express what you need.

## Common errors

| Message                                           | Cause                                                                            | Fix                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| `useEngine must be used within an EngineProvider` | `useEngine()` was called outside the provider returned by `createEngineContext`. | Render the component under that `EngineProvider`. |
