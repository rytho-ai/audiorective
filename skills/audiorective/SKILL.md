---
name: audiorective
description: >
  Build web audio apps with the @audiorective/* packages — synthesizers, drum
  machines and step sequencers, DAW-style transports, audio recording, samplers and loop players,
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
| `@audiorective/widgets`    | Plain player controls; DOM waveform selector and audition; audio-independent waveform view and visual plugins.                                  | `references/widgets.md`    |
| `@audiorective/blocks`     | Headless `AudioRecorder`, `WavePlayer`, cancellable grouped sample hits, and pure MIDI note data.                                               | `references/blocks.md`     |
| `@audiorective/react`      | React bindings (`useValue`, `createEngineContext` → `EngineProvider`, `useEngine`).                                                             | `references/react.md`      |
| `@audiorective/threejs`    | three.js scene bindings (`attach`, `PannerAnchor`).                                                                                             | `references/threejs.md`    |
| `@audiorective/playcanvas` | PlayCanvas scene bindings (`attach`, `bindPanner`).                                                                                             | `references/playcanvas.md` |
| `@audiorective/devtools`   | `measureLatency` / `assertLatency` for testing a processor's declared latency.                                                                  | `references/core.md`       |

## Choosing a capability

Blocks and widgets cover specific workflows. When a request does not match one, build on
core with your own `AudioProcessor`; that is the intended path, not a fallback.

| You are building…                                           | Use                                                               | Not                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| One-shot hits, pads, SFX; overlapping voices                | core `Sampler` / `Voice`                                          | `WavePlayer` (one playhead)                          |
| Editable sequenced hits with future choke groups            | blocks `InstrumentEvents` + clock window `own(hit, when)`         | irreversible future `Voice.stop(when)`               |
| Record a short audio take against the audio clock           | blocks `AudioRecorder` with a caller-connected input              | `MediaRecorder` chunk intervals as sample positions  |
| A tempo-locked loop or stem with a scheduled start          | core `BufferPlayer` + `clock`                                     | `FilePlayer` (runs on the media clock)               |
| A long track, podcast or stream                             | core `FilePlayer`; `widgets/player` for a plain control bar       | `WavePlayer` / waveform selector (decode whole file) |
| Load a clip, select a range, audition, loop or stretch it   | blocks `WavePlayer`; widgets waveform selector for the UI         | a hand-drawn canvas and range logic                  |
| Automate a non-looping waveform selection in source seconds | `WavePlayer.attachSourceAutomation(binding)` with core automation | app-owned play token and duplicated time mapping     |
| A waveform picture from peaks, no audio                     | `@audiorective/widgets/waveform`                                  | the complete selector                                |
| MIDI file notes: parse, edit, select, piano roll            | `@audiorective/blocks/midi` + `@audiorective/widgets/piano-roll`  | live MIDI input (app code calling your synth)        |
| A step sequencer, drum machine or transport                 | `clock` + your own audio-layer class with a `Cell` pattern        | a sequencer block (there is none)                    |
| An editable curve driving a parameter over time             | `@audiorective/core/automation`                                   | hand-scheduled ramps                                 |
| A synth, custom effect, grains, anything else               | your own `AudioProcessor` on core                                 | forcing a block to fit                               |

For short audio takes, the app owns microphone permission and monitoring. Connect
its source to `new AudioRecorder(context).input`, await `recorder.ready` before a
precise start, then `await recorder.start({ when })` with absolute AudioContext
seconds. The stop control awaits `recorder.stop()` and handles rejection. Its
`RecordedAudio` contains PCM `channels`, `sampleRate`, and actual `startFrame` /
`endFrame` (`startTime` / `endTime`); pass those raw positions to the future clip
owner. `recorder.cancel()` discards a take; `recorder.destroy()` releases only
recorder resources. See `references/blocks.md` → Record an audio take for the full
example and ownership details. This is an in-memory short-take API, not a
continuous file recorder.

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

| If you're doing…                                                                           | Also read                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Designing a whole audio app (multiple sources, multiple UIs, spatial)                      | `references/designing-audio-apps.md`                |
| Choosing a playback primitive (Sampler vs BufferPlayer vs FilePlayer)                      | `references/choosing-playback.md`                   |
| Sequencing, transport, tempo, a step sequencer or drum machine                             | `references/clock.md`                               |
| Cancelling queued hits or re-filling a look-ahead window after an edit                     | `references/clock.md` + `references/blocks.md`      |
| Deciding what goes in the audio layer vs the UI; Cell vs Param                             | `references/architecture.md`                        |
| Writing or modifying an `AudioProcessor` subclass                                          | the `audio-processor-authoring` skill               |
| Waveform drawing (`renderer`), range selection/audition, external playhead, visual plugins | `references/widgets.md`                             |
| Plain Play/Pause, time, seek and volume controls without a waveform                        | `references/widgets.md` → Plain player controls     |
| Curves, native automation binding, range/time scaling, macro target adapters               | `references/automation.md`                          |
| Source-time automation on a stretched WavePlayer selection                                 | `references/blocks.md` + `references/automation.md` |
| Stretching PCM, preserving pitch, cancelling a render                                      | `references/effects.md` → TimeStretch               |
| PCM min/max summaries and source-frame/time metadata                                       | `references/core.md` → PCM peak summaries           |
| MIDI files, piano-roll layout/drawing/plugins, note drag/resize and caller-owned audition  | `references/midi.md`                                |
| Observing block state (`cells`), loading phases, cancel, cached sources, audition          | `references/blocks.md` + `references/widgets.md`    |
| Capturing a short audio take at an audio-clock time with caller-owned input                | `references/blocks.md` → Record an audio take       |
| React UI bound to an engine                                                                | `references/react.md`                               |
| Next.js / Remix / Astro / any app that renders on a server                                 | `references/client-boundary.md`                     |
| 3D scene with spatial audio (three.js)                                                     | `references/threejs.md` + `architecture.md`         |
| 3D scene with spatial audio (PlayCanvas)                                                   | `references/playcanvas.md` + `architecture.md`      |
| PixiJS (2D) audio visualizer or interactive canvas                                         | `references/pixijs.md`                              |
| Sharing state between React and an imperative view (three.js, Canvas2D, WebGPU)            | `references/architecture.md`                        |
| Adding effects, building an FX rack, replacing Tone.js effects, offline export             | `references/effects.md`                             |
| Understanding rationale ("why does this exist?")                                           | `references/overview.md`                            |

## The one rule that always applies

**Audio graphs and playback live as methods on audio-layer objects** — `AudioProcessor`
subclasses and blocks. UI components call those methods and read state; they never
orchestrate audio logic themselves.

- **Audio layer owns:** graph construction, envelope shaping, parameter
  automation, transport logic, anything touching `AudioContext.currentTime`.
- **UI layer does:** read state (`useValue(processor.params.foo)`,
  `useValue(player.cells.isPlaying)`), set params (`processor.params.foo.value = x`),
  call audio methods (`synth.filterSweep()`).
- **Read-only cells change through methods.** State an owner has to validate is a
  read-only entry in `owner.cells`: read it there, change it with the owner's method
  (`player.setSelection(range)`), never by assignment.
- **Views borrow.** Destroying a widget leaves a caller-supplied player or model alive
  and playing; the caller destroys what it created.

Keep UI callbacks thin, such as `() => synth.filterSweep()`. Read
`references/architecture.md` for scheduling examples, Cell vs Param choices and
sharing state with imperative views.

## Audio runtime is client-only

Pure entries (`core/peaks`, `core/automation` curves, `blocks/midi`) import no audio
runtime and work in Node. Everything that touches an `AudioContext` is client-only.

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

### Errors by area

Every other thrown message is listed, with cause and fix, in the reference for its area:

| Message starts with or mentions                                                                                                                                                                                                                   | Read                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `Waveform…`, `Zoom…`, `Playhead…`, `Plugin…`, `Selection plugin…`                                                                                                                                                                                 | `references/widgets.md` → Common errors     |
| `No track is loaded.`, `No audio is loaded.`, `Audio is still loading.`, `The audio context is closed.`                                                                                                                                           | `references/widgets.md` → Common errors     |
| `Range player…`, `Audio request…`, `Audio download…`, `Audio file…`, `Enter an audio URL.`, `Load progress…`, `Position…`, `Start time…`, `Selection must satisfy…`, `Source automation…`, `Instrument…`, `Unknown instrument…`, `AudioRecorder…` | `references/blocks.md` → Common errors      |
| `Clock owned event time…`                                                                                                                                                                                                                         | `references/clock.md` → Common errors       |
| `Stretch…`, `No audio source…`, `WavePlayer needs…`, `Time must be finite…`                                                                                                                                                                       | `references/blocks.md` → Committed versions |
| `Piano roll…`, `MIDI…`, `MidiSequence…`, `Invalid MIDI file.`, `Only MIDI format…`, `SMPTE…`                                                                                                                                                      | `references/midi.md` → Common errors        |
| `summarizePeaks:…`, `peakFrameRange:…`                                                                                                                                                                                                            | `references/core.md` → PCM peak summaries   |
| `TimeStretch…`, `Rubber Band…`                                                                                                                                                                                                                    | `references/effects.md` → TimeStretch       |
| `AutomationCurve…`, `AutomationBinding…`                                                                                                                                                                                                          | `references/automation.md` → Common errors  |

## References

- [Installation](references/installation.md) · [Blocks](references/blocks.md) · [Widgets](references/widgets.md) · [MIDI/Piano Roll](references/midi.md) · [Core](references/core.md) · [Automation](references/automation.md) · [Architecture](references/architecture.md) · [Designing Audio Apps](references/designing-audio-apps.md) · [Choosing Playback](references/choosing-playback.md) · [Clock](references/clock.md) · [Effects](references/effects.md) · [React](references/react.md) · [three.js](references/threejs.md) · [PlayCanvas](references/playcanvas.md) · [PixiJS](references/pixijs.md) · [Server-rendered frameworks](references/client-boundary.md) · [Overview](references/overview.md) · [Changelog](references/changelog.md)
