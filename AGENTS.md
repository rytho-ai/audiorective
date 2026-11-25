# Audiorective — Agent Instructions

Modular toolkit for web audio development. Independent, composable packages that work alone or together.

## Documentation Tiers

- `AGENTS.md` (this file) — contributor conventions for working in this repo
- `docs/` — full API reference per package, also rendered on the site
- `skills/` — consumer-facing skills (install via `npx skills add audiorective/audiorective`): `audiorective` for building apps, `audio-processor-authoring` for writing processors. See "Skills" below.
- `evals/` — trigger and functional test sets for the skills, and API-affordance suites (`evals/affordance/`)
- `.claude/skills/` — contributor skills for developing audiorective itself (not shipped): `ar-affordance` (design an API agents guess right, measured by desire/guess runs), `ar-dogfood` (a fresh agent builds a page from a brief; judge by its friction log), `ar-eval` (measure skill/docs changes and classify failures)

## Monorepo Structure

```
@audiorective/
├── core         # Reactive state for audio parameters (alien-signals): Param, AudioProcessor, engine, peaks, automation
├── clock        # Timing and scheduling: transport, tempo, look-ahead tick windows, rulers
├── effects      # DSP effects, editable EffectChain, channel strips, send buses and offline time-stretch
├── devtools     # Dev-time validators, e.g. impulse-based latency measurement
├── player       # Headless range playback: WavePlayer (selection, loading, offline stretch)
├── recorder     # Headless AudioWorklet PCM take capture: AudioRecorder
├── samples      # Headless sample import, storage and previews: SampleLibrary
├── pads         # Headless choke-group sample hits: PadBank
├── sequencer    # Headless lane-based step sequencer: StepSequencer (notation and sounds)
├── launcher     # Headless clip launcher: ClipLauncher (tracks of clips on quantized boundaries of a clock)
├── midi         # MIDI note data and event projection (root); browser take recording (`/web`)
├── host         # Browser WebCLAP plug-in host (`/webclap`)
├── widgets      # Browser waveform, player, piano-roll and arrangement views
├── daw          # `/project` model, `/selection` shared selection, `/dawproject` codec (all pure), `/runtime` browser Workspace, `/mcp` MCP tools and page bridge; root joins them
├── mcp          # Node MCP stdio server relaying agent tool calls to a page over WebSocket (imports no audiorective package)
├── react        # React bindings
├── threejs      # Three.js bindings (engine glue, scene transform sync)
└── playcanvas   # PlayCanvas bindings (engine glue, entity-to-panner transform sync)
```

`apps/web` (site and demos) and `apps/daw-demo` consume these packages; nothing in `packages/` imports from `apps/`.

## Layering

Four layers; an import points down, never up, and never sideways inside layer 2 or 3:

```
4  apps          apps/web, apps/daw-demo, a drum machine, a project-file tool
3  widgets ∥ daw (daw/runtime, daw/dawproject, daw/selection, daw/project)
2  capabilities  clock, midi, effects, host, player, recorder, samples, pads, sequencer, launcher
1  core
   side          react, threejs, playcanvas, devtools: import core only
```

- `widgets` and `daw` are parallel and never import each other; the app wires them. `widgets` takes local structural contracts, the pure `midi` root and type-only `player` imports, not capability runtime classes.
- A capability module imports only `core`, never another capability module or layer 3. Each capability is its own package with a root entry. A module is _standalone_ (works given an `AudioContext`) or _borrowing_ (`sequencer`, `launcher` need a `BeatTiming` or transport from the caller). Cross-module contracts such as `CancellableEvent` and `BeatTiming` live in `core`. Importing a sibling capability module is an exception that needs a written reason.
- `daw/project` imports `core`, the `midi` root and pure `effects/equalizer-bands` validation; its rack-preset data lives inside `daw`. It takes PCM as core `PCMData`, not recorder types. `daw/dawproject` imports `daw/project` and `core`. `daw/runtime` imports `daw/project`, `core` and the capability modules it needs, and does not import `daw/dawproject` or `widgets`. Browser-storage helpers (`createOpfsAudioMediaWriter`) and the audio-fallback export (`exportAudioFallbackTo(workspace, …)`) live in `daw/runtime`; `portabilityReport(project)` lives in `daw/dawproject`. `daw/selection` imports only `daw/project` and `core`. `daw/mcp` (`mcpTools`, `connectMcpBridge`) imports `daw/project`, `daw/runtime`, the root's `saveWorkspace`, `core` and `@toon-format/toon`, never `daw/dawproject` or `widgets`. The `daw` root re-exports the four entries and adds `openWorkspace`, `openWorkspaceBlob`, `saveWorkspace` and `saveWorkspaceTo`, plus core's `encodeWav` for bouncing renders.
- `pnpm check:layers` enforces these edges over the import graph; run it after adding an import between packages or entries.

Pure entries stay separate from browser-runtime entries so Node and server code can import them: `core/peaks`, `core/automation`, `effects/equalizer-bands`, `daw/project`, `daw/selection`, `daw/dawproject` and the `midi` root have no DOM or `AudioContext` dependency, while `midi/web`, `host/webclap`, `daw/runtime` and the widget entries are browser-only. `widgets/waveform` is a DOM view, not a pure entry.

When placing a feature, consult [Layers and dependency direction](docs/architecture.md#layers-and-dependency-direction). A feature usually spans layers: gestures and drawing in `widgets`, saved content in `daw/project`, sound in a capability module or `daw/runtime`.

## Core Conventions

### The `.value` Pattern

Matches native Web Audio API. Wraps alien-signals internally:

```typescript
synth.params.volume.value = 0.5; // set (calls signal internally)
synth.params.volume.linearRampToValueAtTime(1, time); // schedule — same as native AudioParam
```

### Signal Exposure via `$`

Raw alien-signals function exposed for advanced/framework use:

```typescript
synth.params.volume.value; // .value getter/setter (tracked by effects)
synth.params.volume.$(); // raw signal read (also tracked)
synth.params.volume.$(0.8); // raw signal write
```

### Build helpers — `param`, `schedulableParam`, `cell`

Subclasses pass a build callback to `super()` that returns the typed `params` (and optional `cells`) registry. The callback receives helpers that already know about the AudioContext and the processor's internal silencer:

```typescript
class Synth extends AudioProcessor<{
  bpm: Param<number>;
  volume: SchedulableParam;
  waveform: Param<OscType>;
}> {
  constructor(ctx: AudioContext) {
    const gain = new GainNode(ctx);
    const osc = new OscillatorNode(ctx);
    super(ctx, ({ param }) => ({
      params: {
        bpm: param({ default: 120 }), // JS scheduling (~16ms)
        volume: param({ default: 0.5, bind: gain.gain }), // native scheduling (sample-accurate)
        waveform: param<OscType>({
          // reactive sync to property
          default: "sine",
          bind: { get: () => osc.type, set: (v) => (osc.type = v) },
        }),
      },
    }));
  }
  // ...
}
```

Audio nodes are constructed as **locals** before `super()` so the callback can close over them. Anything you also need on `this` (e.g. `this.osc` for `playNote`) gets assigned after `super()` returns.

## `bind` Rules

| Shape          | When to use                     | Result                                       |
| -------------- | ------------------------------- | -------------------------------------------- |
| No `bind`      | Pure JS state (flags, arrays)   | `Param<T>`                                   |
| `AudioParam`   | Controls a Web Audio node param | `SchedulableParam` (native, sample-accurate) |
| `{ get, set }` | Sync to non-AudioParam property | `Param<T>` with reactive effect              |

The `schedulableParam` helper (without `bind`) creates a `SchedulableParam` backed by a phantom ConstantSourceNode — useful when you want scheduling without a real AudioParam (e.g., BPM).

### Subscribing

`Cell`, `ReadonlyCell`, `Param` and `SchedulableParam` expose `subscribe(listener, { immediate? })`, which returns an unsubscribe function and works directly with `useSyncExternalStore`. Framework bindings build on it rather than hand-rolling their own subscription.

## Scheduling Model

|           | `param({ bind: audioParam })` | `schedulableParam({})` (no bind)                  | `param({})` (no bind)  |
| --------- | ----------------------------- | ------------------------------------------------- | ---------------------- |
| Type      | `SchedulableParam`            | `SchedulableParam`                                | `Param<T>`             |
| Thread    | Audio                         | Audio (ConstantSourceNode)                        | Main                   |
| Precision | Sample-accurate               | Sample-accurate                                   | Immediate              |
| Use for   | Gain, frequency, filter       | BPM, intensity — anything needing scheduled ramps | Flags, arrays, strings |

**AudioParam sync strategy:** For native-backed params, scheduling methods delegate to the real AudioParam. A rAF poll reads `AudioParam.value` back into the signal so UI stays reactive during automations.

## Design Rules

1. **Web Audio API consistency** — `.value` pattern everywhere
2. **Signal exposure** — always expose `$` for raw signal access
3. **Method-based API** — `param()`, not decorators. Clear, type-safe, discoverable
4. **Automatic dependency tracking** — no manual dep arrays. Effects/computed auto-track
5. **`reactiveParam` for standalone use** — same `.value` API without AudioProcessor inheritance
6. **Graph helpers** — `defineGraph` wires an audio graph from a reactive edge list of direct node/processor references (no string keys), diffs it on every change, and compensates join-point latency automatically (PDC)
7. **Framework agnostic** — core works in Node.js, React, Vue, Svelte, vanilla
8. **No state duplication** — AudioProcessor owns all state. UI frameworks observe/mutate directly. No separate store.
9. **Unified SchedulableParam** — one type regardless of backing. `bind` with AudioParam is an internal optimization, not a type distinction.
10. **Observable state lives in `cells` or `params`** — for the capability packages as for core processors. A cell is the only store: no private field mirrored by `subscribe`. State whose change involves validation, playback or cancellation is registered as `readonlyCell(...)` over a private `Cell` and written only through the owner's methods; multi-field operations commit in one `batch`. Public readers are tracked, the owner's internal reads are `untracked`. Clock-derived values such as `position` stay plain getters. `getState()`/`subscribe()`, where a capability class has them, are thin wrappers over the cells. The tracking tests (`packages/{player,recorder,pads,sequencer,launcher,midi,daw}/tests/tracking*.test.ts`) enforce this: each tracked class is wrapped in `watch(...)`, and a completeness check fails when a public method or getter is neither exercised by a row nor excluded with a reason, so a new command or reader needs a row.
11. **Light edits propagate; interrupting rebuilds are explicit** — a running `Workspace` (`daw/runtime`) applies light `Project` edits automatically (coalesced, serialized, errors in `cells.error`). A structural rebuild that stops audio and reloads hosts never runs by itself: topology changes set `cells.needsSync` and the caller runs `sync()`. See [Project edits](docs/daw.md#apply-project-edits-to-the-live-graph) for the waiting and error contract.

## AudioProcessor Base Class

All processors extend `AudioProcessor<P, C>` with explicit registry generics:

- Must implement `get output(): AudioNode | undefined`
- Constructor passes a build callback to `super()` that returns `{ params, cells? }`
- Exposes typed `processor.params` (frozen) and `processor.cells` (frozen) registries; `cells` entries are `Cell` or `ReadonlyCell`
- Instance methods `computed()` and `effect()` for derived values declared after `super()`
- `connect(destination, output?, input?)` / `disconnect(destination?)` mirror `AudioNode`; the edges join the context's latency graph, so PDC sees them
- `dispose()` cleans up effects, params, and ConstantSources; safe to call twice, and `[Symbol.dispose]()` calls it. Every class that owns resources names its teardown `dispose()`

## Package Dependencies

Runtime `dependencies` from each `package.json`:

- `core`: `alien-signals`, `immer`
- `clock`: `core`, `alien-signals`
- `effects`: `core`; optional peer `signalsmith-stretch` (stretch pitch engine only; dev: `devtools`)
- `devtools`: `core`
- `player`, `recorder`, `samples`, `pads`, `sequencer`, `launcher`: `core` each
- `midi`: `core`
- `host`: `core`
- `widgets`: `core`, `player`, `midi`
- `daw`: `core`, `launcher`, `player`, `recorder`, `clock`, `effects`, `host`, `midi`, `@xmldom/xmldom`, `fflate`
- `react`: `core`, `alien-signals`; peer-depends on `react`
- `threejs`: `core`; peer-depends on `three`
- `playcanvas`: `core`; peer-depends on `playcanvas`

## Skills

The skills are the product's front door for agents, so they're maintained like public API.

**Layout.** Each skill is `skills/<name>/SKILL.md` plus `references/`. Reference files are **symlinks into `docs/`** (and `CHANGELOG.md`), never copies — a doc change is a skill change with no second edit. To give a skill a new reference: write `docs/<topic>.md` with a `title` frontmatter, add it to the sidebar in `apps/web/astro.config.mjs`, then `ln -s ../../../docs/<topic>.md skills/<skill>/references/<topic>.md` and route to it from the skill's "What to read next" table.

**SKILL.md shape.** Frontmatter has `name`, `description`, `license`, `compatibility`. The body is task-oriented and loads whole when the skill triggers, so it has a budget: keep `SKILL.md` under 300 lines, and keep each section to what fits on one screen — a setup pointer, a runnable quick start, a capability-selection table (what to use for a job, and what not to), the routing tables, the rules that always apply, the cross-cutting errors plus an errors-by-area routing table, and a references list. Rules and details that belong to one capability package, widget or effect go in that reference, not in the always-on rules. Anything deeper (full API surface, long walkthroughs, rationale) belongs in a reference doc that is loaded only when a task needs it. The `description` is the only thing an agent sees before deciding to open the skill — state what it does and the concrete situations that should trigger it, including ones where the user never names audiorective.

**Evergreen.** Docs and skills describe current behaviour in the present tense. Release history — "added in", "now supports", "previously", version numbers — goes in `CHANGELOG.md`, which the skill reads only to diagnose version drift. When a public API changes: update the doc, add the changelog entry, and update or add the eval in `evals/` that exercises it, in the same PR.

**Errors are documentation, in two tiers.** Every thrown error has a row (message text an agent will actually see → cause → fix) in the "Common errors" table of the reference doc for its area (`docs/player.md`, `docs/recorder.md`, `docs/pads.md`, `docs/sequencer.md`, `docs/samples.md`, `docs/launcher.md`, `docs/widgets.md`, `docs/midi.md`, `docs/automation.md`, the TimeStretch and PCM sections). `SKILL.md` holds only the errors that cut across areas or block getting started (engine, client boundary, autoplay, version drift, graph wiring), plus an "Errors by area" table that routes a message prefix to its reference. A new error therefore needs its row in the reference, and a routing entry in `SKILL.md` only if its message prefix is not already routed. `pnpm check:errors` enforces this: it collects every message thrown in `packages/*/src` (template parts match as wildcards, and the plugin host's messages expand to each widget that creates a host), fails with `file:line` for any message no error table covers, and takes a row that ends in `…` as covering every message that starts with its text. A message that users cannot act on goes in the script's `ALLOWLIST` with a one-line reason.

**Evals.** `evals/<skill>/trigger_eval.json` checks the description fires for the right requests and stays quiet for near-misses; `evals/<skill>/evals.json` checks output quality with verifiable expectations. Run them after editing a description or a rule (`evals/README.md`).

**Judging a change.** Agent correctness decides; tokens and cost are reported beside it. Measure isolated from personal Claude settings (the runners' default), with three runs per eval and deterministic checks before the LLM grader (`ar-eval`). Before implementing a reshaped API, list the decisions already made for that component and keep each one unless the maintainer revisits it (`ar-affordance`).

## Showroom demos

A demo is an Astro page in `apps/web/src/pages/showroom/<slug>.astro` plus one entry in the `demos` array of `apps/web/src/data/demos.ts` (`slug`, `title`, `blurb`, `thumb`, `route`, `source`, `packages`). `DemoCard.astro` renders each entry on the showroom index, so a page without an entry is unreachable from it. Put the card thumbnail in `apps/web/public/showroom/` (an `.svg` or `.jpg`; `thumb` is its path under `public`). Demo-only code imports packages by their public entries, and a doc example that a demo exercises is mirrored by a test next to its package.

## Releasing

- All packages version together via `pnpm release` (`bumpp -r --all`).
- When a release adds, changes, or removes a public API, add an entry to
  `CHANGELOG.md` under the new version. The skill ships this file (symlinked at
  `skills/audiorective/references/changelog.md`) so agents can detect when an
  installed package predates a documented API.
- `.claude-plugin/plugin.json` has its own `version`, and `bumpp` does not
  touch it. Bump it by hand whenever skill content changes (minor for new
  guidance, patch for corrections) so plugin installs see an update, and lift
  it to the package version at a release if it has fallen behind.
