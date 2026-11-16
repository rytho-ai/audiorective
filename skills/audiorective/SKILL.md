---
name: audiorective
description: >
  Build web audio apps with the @audiorective/* packages — synthesizers, drum
  machines and step sequencers, DAW-style transports, samplers and loop players,
  audio visualizers, waveform selection, MIDI files and piano rolls, positional/3D
  audio attached to three.js or PlayCanvas objects, effects racks, and offline rendering or WAV export of a Web Audio
  graph. Use whenever a project depends on @audiorective/*, whenever an error
  names one of its APIs (EngineEnvironmentError, createEngine, defineGraph,
  LatencyUnknownError), and whenever the user asks for reactive audio state
  bound to a UI, sample-accurate scheduling or tempo, parameter automation,
  audio/UI separation, or to replace or migrate away from Tone.js — even if
  they never say "audiorective" and even when the request touches the Web Audio
  API (AudioContext, AudioParam, AudioWorklet) only indirectly.
license: MIT
compatibility: Browser DOM for widgets; Web Audio API for audio (client-only, no server rendering). TypeScript or JavaScript. Packages install from npm as @audiorective/*.
---

# Audiorective

Modular toolkit for web audio apps. An `AudioProcessor` owns the Web Audio nodes
and all audio state as reactive params; UI frameworks observe and mutate that
state directly, so nothing is duplicated between the audio graph and the view.

> **Setup:** see [Installation](references/installation.md) for which packages to
> install, peer dependencies, and keeping versions aligned.

## Quick start

Install the core package and, for React, the bindings:

```sh
npm install @audiorective/core @audiorective/react
```

A processor owns nodes, exposes them as params, and puts audio behaviour in
methods. Nodes are built as locals _before_ `super()` so the build callback can
close over them:

```typescript
import { AudioProcessor, createEngine, type Param, type SchedulableParam } from "@audiorective/core";

class Synth extends AudioProcessor<{ volume: SchedulableParam; bpm: Param<number> }> {
  private readonly _gain: GainNode;

  constructor(ctx: AudioContext) {
    const gain = new GainNode(ctx);
    super(ctx, ({ param }) => ({
      params: {
        volume: param({ default: 0.5, bind: gain.gain }), // AudioParam-backed → sample-accurate
        bpm: param({ default: 120 }), // plain reactive value
      },
    }));
    this._gain = gain;
  }

  get output() {
    return this._gain;
  }

  fadeOut(seconds = 2) {
    const now = this.context.currentTime;
    this.params.volume.setValueAtTime(this.params.volume.value, now);
    this.params.volume.linearRampToValueAtTime(0, now + seconds);
  }
}

export const engine = createEngine((ctx) => {
  const synth = new Synth(ctx);
  synth.output.connect(ctx.destination);
  return { synth };
});
```

The `AudioContext` starts suspended by browser autoplay policy. Resume it from a
user gesture — `engine.core.start()` in a click handler, or
`engine.core.autoStart(document)` to do that on the first click/key/touch.

**React** — the provider auto-starts the engine on the first gesture; `useValue`
subscribes a component to a param and the component writes back directly:

```tsx
import { createEngineContext, useValue } from "@audiorective/react";
import { engine } from "./audio/engine";

export const { EngineProvider, useEngine } = createEngineContext(engine);

function VolumeSlider() {
  const { synth } = useEngine();
  const volume = useValue(synth.params.volume);
  const setVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    synth.params.volume.value = +e.target.value; // write straight to the processor
  };
  return <input type="range" min={0} max={1} step={0.01} value={volume} onChange={setVolume} />;
}

export function App() {
  return (
    <EngineProvider>
      <VolumeSlider />
      <button onClick={() => engine.synth.fadeOut()}>Fade</button>
    </EngineProvider>
  );
}
```

## Packages

| Package                    | Purpose                                                                                                                                         | Reference                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `@audiorective/core`       | Reactive audio primitives, `AudioProcessor`, engine, `defineGraph`, `Spatial`, `Analyser`, `Sampler`, `BufferPlayer`, `FilePlayer`.             | `references/core.md`       |
| `@audiorective/clock`      | Timing/scheduling engine — transport, tempo, look-ahead tick windows, rulers (bars, cycles/loops, seconds).                                     | `references/clock.md`      |
| `@audiorective/effects`    | DSP effects — Filter, Distortion, Phaser, FrequencyShifter, PingPongDelay, Convolver, Compressor, Limiter, PitchShift; Channel strip + SendBus. | `references/effects.md`    |
| `@audiorective/widgets`    | DOM waveform selector and audition; audio-independent waveform view and visual plugins.                                                         | `references/widgets.md`    |
| `@audiorective/blocks`     | Headless `WavePlayer` for audio; pure MIDI note data and shared `MidiSequence`.                                                                 | `references/blocks.md`     |
| `@audiorective/react`      | React bindings (`useValue`, `createEngineContext` → `EngineProvider`, `useEngine`).                                                             | `references/react.md`      |
| `@audiorective/threejs`    | three.js scene bindings (`attach`, `PannerAnchor`).                                                                                             | `references/threejs.md`    |
| `@audiorective/playcanvas` | PlayCanvas scene bindings (`attach`, `bindPanner`).                                                                                             | `references/playcanvas.md` |
| `@audiorective/devtools`   | `measureLatency` / `assertLatency` for testing a processor's declared latency.                                                                  | `references/core.md`       |

## What to read next

**`references/core.md` is the core API reference**. Read
the section you need rather than the whole file:

| Task                                                            | Section of `core.md`                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Param vs SchedulableParam vs Cell, `bind` rules, `.value` / `$` | Core Concepts; API Reference → Param, SchedulableParam, Cell |
| Automation ramps that don't behave                              | API Reference → Automation Gotchas                           |
| Wiring processors together, bypass, latency compensation        | API Reference → Graph helpers (`defineGraph`), Latency (PDC) |
| Playing samples, loops, or a streamed track                     | Sound Playback                                               |
| Engine lifecycle, autoplay, `createEngine`                      | AudioEngine                                                  |
| Spatial audio, spectrum/waveform analysis                       | API Reference → Spatial, Analyser                            |

Then load only what the task needs:

| If you're doing…                                                                           | Also read                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Designing a whole audio app (multiple sources, multiple UIs, spatial)                      | `references/designing-audio-apps.md`             |
| Choosing a playback primitive (Sampler vs BufferPlayer vs FilePlayer)                      | `references/choosing-playback.md`                |
| Sequencing, transport, tempo, a step sequencer or drum machine                             | `references/clock.md`                            |
| Deciding what goes in the audio layer vs the UI; Cell vs Param                             | `references/architecture.md`                     |
| Writing or modifying an `AudioProcessor` subclass                                          | the `audio-processor-authoring` skill            |
| Waveform drawing (`renderer`), range selection/audition, external playhead, visual plugins | `references/widgets.md`                          |
| Curves, native automation binding, range/time scaling, macro target adapters               | `references/automation.md`                       |
| Stretching PCM, preserving pitch, cancelling a render                                      | `references/effects.md` → TimeStretch            |
| PCM min/max summaries and source-frame/time metadata                                       | `references/core.md` → PCM peak summaries        |
| MIDI files, piano-roll layout/drawing/plugins, note drag/resize and caller-owned audition  | `references/midi.md`                             |
| Observing block state (`cells`), loading phases, cancel, cached sources, audition          | `references/blocks.md` + `references/widgets.md` |
| React UI bound to an engine                                                                | `references/react.md`                            |
| Next.js / Remix / Astro / any app that renders on a server                                 | `references/client-boundary.md`                  |
| 3D scene with spatial audio (three.js)                                                     | `references/threejs.md` + `architecture.md`      |
| 3D scene with spatial audio (PlayCanvas)                                                   | `references/playcanvas.md` + `architecture.md`   |
| PixiJS (2D) audio visualizer or interactive canvas                                         | `references/pixijs.md`                           |
| Sharing state between React and an imperative view (three.js, Canvas2D, WebGPU)            | `references/architecture.md`                     |
| Adding effects, building an FX rack, replacing Tone.js effects, offline export             | `references/effects.md`                          |
| Understanding rationale ("why does this exist?")                                           | `references/overview.md`                         |

## The one rule that always applies

**Audio graphs and playback live as methods on `AudioProcessor` subclasses.** The complete
waveform selector delegates to `WavePlayer`: pass a caller-owned shared `player`,
or supply `context` to let the selector own a player; route its `output` once.
Destroying a view leaves a supplied player alive. For metadata-only views, import from
`@audiorective/widgets/waveform`; visual plugins own no audio transport. UI
components call these methods — they never orchestrate audio logic themselves.
Pure PCM computation uses ordinary functions/classes: core `summarizePeaks`, and
effects `TimeStretch.process`. Use `WavePlayer(ctx, { stretch })` and
`await player.setStretch(ratio)` to commit PCM/peaks/selection together while stopped.
Every edit renders the original source; pending results never overwrite newer edits.

- **Audio layer owns:** graph construction, envelope shaping, parameter
  automation, transport logic, anything touching `AudioContext.currentTime`.
- **UI layer does:** read params (`useValue(processor.params.foo)`), set params
  (`processor.params.foo.value = x`), call audio methods (`synth.filterSweep()`).

Keep UI callbacks thin, such as `() => synth.filterSweep()`. Read
`references/architecture.md` for scheduling examples, Cell vs Param choices and
sharing state with imperative views.

## Audio runtime is client-only

Pure `@audiorective/core/peaks` imports and computation work in Node/Workers.
`@audiorective/effects/time-stretch` imports no audio implementation; processing
requires browser Web Workers and a caller-provided compiled Rubber Band WASM module.
It is an offline PCM processor, not an input/output wet/dry insert.

`createEngine` builds a real `AudioContext`; there is none on a server, and
there is no SSR mode to enable. In Next.js, Remix, or Astro, mount the audio
subtree behind a client-only boundary — `next/dynamic(..., { ssr: false })` or
`client:only` — and keep `createEngine` at module scope _inside_ that subtree.
`'use client'` is not a boundary: the server still evaluates the module.

`EngineEnvironmentError` means an audio module leaked across the boundary. Don't
patch it with a lazy accessor, a nullable engine, or a `typeof window` guard —
find the import path that reaches the engine module and move it inside the
island. Read `references/client-boundary.md`.

## Version mismatches

This skill and the npm packages install through different channels, so a
project may have an older package than the APIs documented here. On an API
surprise — `X is not a function`, an `undefined` import, a missing export, or a
type error on a documented API:

1. Read `references/changelog.md` to find the version that introduced or
   changed the API.
2. Check the installed version:
   `node -p "require('@audiorective/core/package.json').version"`.
3. If the API postdates the installed version, tell the user to upgrade
   (`npm i @audiorective/core@latest`, all `@audiorective/*` together) rather
   than hand-rolling the missing API. APIs under **Unreleased** require a workspace
   build or packed artifact; `@latest` cannot supply an unreleased API.

## Common errors

| Symptom                                                                 | Cause                                                            | Fix                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `EngineEnvironmentError: createEngine() is client-only…` during a build | An engine module is evaluated on the server                      | Move the importer inside the client-only island — `references/client-boundary.md`             |
| `EngineEnvironmentError: … no AudioContext constructor` in a jsdom test | DOM without Web Audio                                            | Pass a mock context: `createEngine(setup, { context })`, or run in a real browser             |
| No sound; `engine.core.state` stays `"idle"`                            | `AudioContext` suspended by autoplay policy                      | Call `engine.core.start()` from a user gesture, or use `autoStart` (on by default in React)   |
| `X is not a function` / `undefined` import on a documented API          | Installed package predates the docs                              | "Version mismatches" above                                                                    |
| UI silently stops updating, no error                                    | Two copies of `alien-signals` in the bundle                      | Dedupe or alias the package — `references/installation.md`                                    |
| `LatencyUnknownError: X's path latency is unknown`                      | A latency query on a processor that appears in no `defineGraph`  | Wire it with `defineGraph` (its own or the engine's) instead of raw `.connect()`              |
| `defineGraph: X is a bare AudioWorkletNode`                             | A worklet node used directly as an edge endpoint                 | Wrap it in an `AudioProcessor` that declares `latency` — `audio-processor-authoring` skill    |
| `defineGraph: X used as sink has no input`                              | Routing audio into an instrument or player                       | Only effects have `input`; instruments are sources. Check the edge direction                  |
| `WorkletUnavailableError` from `@audiorective/effects`                  | Context without `audioWorklet` (old browser, some test contexts) | Use a browser with AudioWorklet, or the `granular` `PitchShift` engine which needs no worklet |
| `Cannot start a destroyed engine`                                       | Reusing an engine after `destroy()`                              | Create a new engine; `destroy()` is final                                                     |

### Waveform and MIDI errors

| Symptom                                                                                                                                                        | Cause                                              | Fix                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Piano roll layout must mount its viewport inside the supplied root.`                                                                                          | Layout omitted/cloned the supplied viewport        | Append the supplied viewport inside the layout root; retain its identity.           |
| `Piano roll is destroyed.`                                                                                                                                     | Attaching after view cleanup                       | Mount another view; keep the borrowed model if still needed.                        |
| `Plugin is already attached to this piano roll.`                                                                                                               | Same object attached twice to one view             | Destroy its attachment first, or create another plugin instance.                    |
| `Waveform selector is destroyed.`                                                                                                                              | Calling `load` or `setSelection` after cleanup     | Mount a new selector.                                                               |
| `Range player is destroyed.`                                                                                                                                   | Mutating or subscribing after block cleanup        | Create a new WavePlayer; shared views must not destroy their caller's player.       |
| `Position must be finite seconds.` / `Start time must be finite, non-negative seconds.`                                                                        | Invalid `seek` position or `play({ when })` time   | Pass finite seconds; `when` is an absolute `AudioContext` time, clamped to now.     |
| `Enter an audio URL.`                                                                                                                                          | Empty URL passed to `load`                         | Supply a URL or File.                                                               |
| `Audio request failed: HTTP 404.` (status varies)                                                                                                              | URL response is unsuccessful                       | Check the URL, access, and server response; call `load` again to recover.           |
| `Audio request returned text instead of audio.`                                                                                                                | URL served HTML/text                               | Fix routing/proxy to return audio, then retry load.                                 |
| `Audio download size does not match Content-Length.`                                                                                                           | Truncated or incorrect byte length                 | Fix the transfer/length, then retry load.                                           |
| `Load progress needs non-negative byte counts and a null or matching total.` / `Unknown audio loading phase.`                                                  | Invalid cache adapter reports                      | Use download/read with safe byte counts or decode; total may be null.               |
| `Audio file has no playable duration.`                                                                                                                         | Decoded audio has zero duration                    | Supply audio with a positive duration.                                              |
| `Waveform is destroyed.`                                                                                                                                       | Mutating or attaching to a destroyed view          | Mount a new view.                                                                   |
| `Waveform data needs finite peaks and a positive duration.`                                                                                                    | Invalid peaks or duration                          | Supply nonempty finite peaks, matching extrema arrays, and finite positive seconds. |
| `Zoom must be finite and at least 1.`                                                                                                                          | Invalid zoom factor                                | Use `1` to fit, or a larger finite factor.                                          |
| `Playhead must be finite or null.`                                                                                                                             | Invalid playhead                                   | Supply finite source seconds or `null` to hide it.                                  |
| `Plugin is already attached to this waveform.`                                                                                                                 | Duplicate attachment of one instance               | Reuse its attachment or detach it before attaching again.                           |
| `Plugin attachment is destroyed.`                                                                                                                              | Mounting an overlay from a disposed attachment     | Stop asynchronous work during cleanup; use a live attachment context.               |
| `Selection plugin is not attached.`                                                                                                                            | Setting metadata before attachment or after detach | Call `view.attach(selection)` before `selection.setSelection`.                      |
| `Selection plugin is already attached.`                                                                                                                        | Reusing a selection plugin across live views       | Detach first, or create one plugin per view.                                        |
| `Waveform already has a Selection owner.`                                                                                                                      | Multiple selection plugins on one view             | Keep one selection plugin per view.                                                 |
| `Selection must satisfy 0 <= start < end <= duration (finite seconds).`                                                                                        | Invalid programmatic range                         | Await loading, then pass ordered finite endpoints within duration, or `null`.       |
| `Invalid MIDI file.` / `Only MIDI format 0 and 1 are supported.` / `SMPTE MIDI time division is not supported.`                                                | Unsupported or corrupt SMF                         | Supply intact format0/1 PPQ note data; see MIDI reference.                          |
| `MIDI ticks need positive PPQ and finite non-negative time.` / `MIDI grid needs valid PPQ, end tick and time signatures.` / `MIDI grid exceeds 100000 points.` | Invalid or oversized grid                          | Use parsed metadata and a bounded grid, or omit grid generation.                    |
| `MIDI duration must be finite and non-negative.` / `MIDI notes need unique ids, valid source seconds and integer pitch/velocity/channel/track.`                | Invalid note data                                  | Normalize records to MIDI reference bounds.                                         |
| `MidiSequence is destroyed.` / `MIDI note was not found.`                                                                                                      | Stale owner or source-local ID                     | Use a live sequence and IDs from its current snapshot.                              |
| `Piano roll zoom must be between 1 and 64.` / `Piano roll pitches must satisfy 0 <= low <= high <= 127.` / `Piano roll scroll time must be finite.`            | Invalid viewport input                             | Use finite zoom/seconds and ordered integer pitches.                                |

### PCM and stretch errors

| Symptom                                                                                              | Cause                                 | Fix                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `summarizePeaks: sampleRate must be a finite positive number`                                        | Invalid PCM rate                      | Provide the actual finite positive source sample rate.                                                                       |
| `summarizePeaks: framesPerPeak must be a positive safe integer`                                      | Invalid bin size                      | Use whole source frames, default 128.                                                                                        |
| `summarizePeaks: at least one channel is required`                                                   | No PCM channels                       | Provide at least one Float32Array.                                                                                           |
| `summarizePeaks: every channel must be a Float32Array`                                               | Wrong sample representation           | Convert decoded samples to Float32Array.                                                                                     |
| `summarizePeaks: channels must have equal frame counts`                                              | Unequal channel lengths               | Use planar channels of equal length.                                                                                         |
| `summarizePeaks: samples must be finite numbers`                                                     | NaN/Infinity samples                  | Repair or reject invalid PCM.                                                                                                |
| `peakFrameRange: index must identify an existing peak`                                               | Invalid bin index                     | Check min.length; empty input has no bins.                                                                                   |
| `TimeStretch requires a compiled WebAssembly.Module.`                                                | Missing/wrong backend                 | Compile the caller-hosted compatible WASM before construction.                                                               |
| `TimeStretch is destroyed.`                                                                          | Processor already cleaned up          | Create a new processor; block borrows it.                                                                                    |
| `TimeStretch processing was aborted.`                                                                | Cancelled render                      | Handle AbortError; do not publish partial output.                                                                            |
| `TimeStretch ratio must be positive and produce at least one frame.`                                 | Invalid ratio/result size             | Use a finite positive duration ratio; output rounds to whole frames.                                                         |
| `TimeStretch needs finite equal-length PCM channels and an integer sampleRate from 8000 to 192000.`  | Unsupported PCM                       | Use equal finite Float32 channels at a supported integer rate.                                                               |
| `TimeStretch requires Web Workers.`                                                                  | No browser Worker runtime             | Process in a browser with Workers.                                                                                           |
| `TimeStretch: unsupported Rubber Band WASM ABI.`                                                     | Wrong module exports                  | Use the documented rubberband-wasm3.3 C ABI.                                                                                 |
| `TimeStretch produced an unexpected frame count.`                                                    | Backend duration mismatch             | Check WASM compatibility; keep the prior block version.                                                                      |
| `TimeStretch produced nonfinite PCM.`                                                                | Backend produced invalid samples      | Reject this render and check the backend/input.                                                                              |
| `TimeStretch could not create a Rubber Band state.`                                                  | Backend initialization failed         | Check module/input support and available memory.                                                                             |
| `TimeStretch allocation failed.`                                                                     | Backend allocation failed             | Use a smaller source/job or release other jobs.                                                                              |
| `Rubber Band exited: …`                                                                              | Backend exited                        | Check the supplied module and input; retain prior playback.                                                                  |
| `TimeStretch worker failed.`                                                                         | Worker startup/execution failure      | Check Worker/blob CSP and supplied module.                                                                                   |
| `Stretch ratio must be finite and positive.`                                                         | Invalid block edit                    | Use a finite duration multiplier greater than zero.                                                                          |
| `No audio source is loaded.`                                                                         | Edit before load                      | Await player.load before setStretch.                                                                                         |
| `WavePlayer needs a stretch processor.`                                                              | No injected processor                 | Construct WavePlayer(ctx, { stretch }); caller destroys stretch.                                                             |
| `Stretch processor returned incompatible PCM.`                                                       | Wrong rendered shape                  | Keep original sample rate/channel count and round(originalFrames\*ratio) frames.                                             |
| `AutomationCurve needs nonempty finite points with nonnegative unique times and linear/hold shapes.` | Invalid curve replacement             | Supply finite `{ time, value, shape }` points with unique times >= 0; replace `.value` instead of mutating frozen snapshots. |
| `AutomationCurve sample time must be finite.`                                                        | Nonfinite query                       | Pass finite curve coordinates to `valueAt`.                                                                                  |
| `AutomationBinding needs finite nonnegative times, to >= from, and positive secondsPerUnit.`         | Invalid start/range/scale or overflow | Correct start options; current run is preserved.                                                                             |
| `AutomationBinding is destroyed.`                                                                    | Reusing disposed binding              | Create a new binding; destroy bindings before their borrowed targets.                                                        |
| `Time must be finite seconds.`                                                                       | Invalid coordinate conversion         | Pass finite source/output seconds.                                                                                           |

## References

- [Installation](references/installation.md) · [Blocks](references/blocks.md) · [Widgets](references/widgets.md) · [MIDI/Piano Roll](references/midi.md) · [Core](references/core.md) · [Automation](references/automation.md) · [Architecture](references/architecture.md) · [Designing Audio Apps](references/designing-audio-apps.md) · [Choosing Playback](references/choosing-playback.md) · [Clock](references/clock.md) · [Effects](references/effects.md) · [React](references/react.md) · [three.js](references/threejs.md) · [PlayCanvas](references/playcanvas.md) · [PixiJS](references/pixijs.md) · [Server-rendered frameworks](references/client-boundary.md) · [Overview](references/overview.md) · [Changelog](references/changelog.md)
