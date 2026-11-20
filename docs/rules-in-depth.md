---
title: Rules in depth
---

Detail behind the always-on rules and routing tables of the `audiorective` skill. The skill's `SKILL.md` keeps one or two lines per rule and points here for the rest.

## Audio and UI separation

**Audio graphs and playback live as methods on audio-layer objects** — `AudioProcessor` subclasses and blocks. UI components call those methods and read state; they never orchestrate audio logic themselves.

- **Audio layer owns:** graph construction, envelope shaping, parameter automation, transport logic, anything touching `AudioContext.currentTime`.
- **UI layer does:** read state (`useValue(processor.params.foo)`, `useValue(player.cells.isPlaying)`), set params (`processor.params.foo.value = x`), call audio methods (`synth.filterSweep()`).
- **Read-only cells change through methods.** State an owner has to validate is a read-only entry in `owner.cells`: read it there, change it with the owner's method (`player.setSelection(range)`), never by assignment.
- **Views borrow.** Destroying a widget leaves a caller-supplied player or model alive and playing; the caller destroys what it created.

Keep UI callbacks thin, such as `() => synth.filterSweep()`. See [Architecture](./architecture.md) for scheduling examples, Cell vs Param choices and sharing state with imperative views.

## Client-only runtime

Pure entries (`core/peaks`, `core/automation` curves, `@audiorective/midi`, `effects/rack-preset`, `daw/project`, `daw/dawproject`) import no audio runtime and work in Node. Everything that touches an `AudioContext` is client-only.

`createEngine` builds a real `AudioContext`; there is none on a server, and there is no SSR mode to enable. In Next.js, Remix, or Astro, mount the audio subtree behind a client-only boundary — `next/dynamic(..., { ssr: false })` or `client:only` — and keep `createEngine` at module scope _inside_ that subtree. `'use client'` is not a boundary: the server still evaluates the module.

`EngineEnvironmentError` means an audio module leaked across the boundary. Don't patch it with a lazy accessor, a nullable engine, or a `typeof window` guard — find the import path that reaches the engine module and move it inside the island. See [Server-rendered frameworks](./client-boundary.md).

## Autoplay

The `AudioContext` starts suspended by browser autoplay policy. Resume it from a user gesture — `engine.core.start()` in a click handler, or `engine.core.autoStart(document)` to do that on the first click/key/touch.

## React quick start

The provider auto-starts the engine on the first gesture; `useValue` subscribes a component to a param and the component writes back directly:

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

Install: `npm install @audiorective/core @audiorective/react`. A processor owns nodes, exposes them as params, and puts audio behaviour in methods; nodes are built as locals _before_ `super()` so the build callback can close over them.

## Version mismatches

The skill and the npm packages install through different channels, so a project may have an older package than the APIs documented here. On an API surprise — `X is not a function`, an `undefined` import, a missing export, or a type error on a documented API:

1. Read `references/changelog.md` (the changelog) to find the version that introduced or changed the API.
2. Check the installed version: `node -p "require('@audiorective/core/package.json').version"`.
3. If the API postdates the installed version, tell the user to upgrade (`npm i @audiorective/core@latest`, all `@audiorective/*` together) rather than hand-rolling the missing API. APIs under **Unreleased** require a repository build or packed artifact; `@latest` cannot supply an unreleased API.

## Choosing a capability: full notes

Blocks and widgets cover specific workflows. When a request does not match one, build on core with your own `AudioProcessor`; that is the intended path, not a fallback. Import the narrowest subpath: capability modules import only core, `blocks/sequencer` and `blocks/launcher` borrow a transport you supply, and `widgets` and `daw` never import each other (the app wires them).

Full text of the table cells that the skill abbreviates:

- **Editable sequenced hits with future choke groups:** `blocks/pads` `PadBank` + clock window `own(hit, when)`; `routePad(id, node)` gives a pad its own effect. Not an irreversible future `Voice.stop(when)`.
- **Audition an audio clip or shared range already placed in a Project:** `workspace.auditionAudioClip(clipId)` or `workspace.auditionRange(range, { trackIds })`; see [DAW](./daw.md). Not seeking and starting the arrangement.
- **Automate a non-looping waveform selection in source seconds:** `WavePlayer.attachSourceAutomation(binding)` with core automation. Not an app-owned play token and duplicated time mapping.
- **Play, edit and save a DAWproject with WebCLAP devices:** `@audiorective/daw` + `@audiorective/host/webclap`; pass `workspace.player` to `mountPlayer`. Not separate project or player state.
- **Read, edit or write `.dawproject` files in Node (no audio):** `@audiorective/daw/project` + `@audiorective/daw/dawproject` only (`portabilityReport(project)` lives there). Not the `@audiorective/daw` root or `daw/runtime`.
- **Step patterns, a drum machine, humanize, ratchets, per-step values:** `clock` + `blocks/sequencer` (+ `blocks/pads` for choke groups); `new StepSequencer({ kick: "X...", hat: { pattern, rate, swing, sound } }, { context, onHit, transform })` then `clock.attach(seq)` (or `workspace.transport.attach(seq)`), add `widgets` `mountStepGrid`; [Sequencer](./sequencer.md) (includes the runnable drum machine), and [Sequencer advanced](./sequencer-advanced.md) only for a custom `transform`, per-step field semantics or shared transports. No `daw`. If the pattern is not a lane/step grid, skip `StepSequencer`: schedule `window.rulers.<r>.grid(n)` points in `onTick` with `window.own`, [Clock](./clock.md#typing-the-window). Not a private scheduling loop, forking the block, or pulling in a Project.
- **Session view, clip launcher, scene launching:** standalone `blocks/launcher` `ClipLauncher` with your own audio driver: [Launcher](./launcher.md#clip-launcher). The DAW Session launches only in-memory PCM clips on Project tracks; pattern clips go standalone. Not the `daw` Session for step-pattern clips.
- **An editable curve driving a parameter, rack macro, or clip gain:** `core/automation` for parameters or `macro.automation`. For clips use `Project.setAudioClipGainAutomation` and `createAutomationOverlay`. Not hand-scheduled ramps.

For a short audio take, the app owns microphone permission and monitoring: connect its source to `new AudioRecorder(context).input`, await `recorder.ready`, start with absolute AudioContext seconds, then await `recorder.stop()`; the clip owner keeps the PCM. See [Recorder](./recorder.md).

For a MIDI take, the app obtains `MIDIInput` and resumes its AudioContext. Use `new MidiRecorder(context, input)` from `@audiorective/midi/web`, `recorder.start({ when })`, then `recorder.stop()` for `events`, `notes` and `duration`. For edited playback use `compileMidiPlaybackEvents`. See [MIDI](./midi.md) → Record a MIDI take. The recorder does not play notes.

## Which core section to read

[Core](./core.md) is the core API reference. Read the section you need rather than the whole file:

| Task                                                            | Section of `core.md`                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Param vs SchedulableParam vs Cell, `bind` rules, `.value` / `$` | Core Concepts; API Reference → Param, SchedulableParam, Cell |
| Automation ramps that don't behave                              | API Reference → Automation Gotchas                           |
| Wiring processors together, bypass, latency compensation        | API Reference → Graph helpers (`defineGraph`), Latency (PDC) |
| Playing samples, loops, or a streamed track                     | Sound Playback                                               |
| Engine lifecycle, autoplay, `createEngine`                      | AudioEngine                                                  |
| Spatial audio, spectrum/waveform analysis                       | API Reference → Spatial, Analyser                            |
| PCM min/max summaries and source-frame/time metadata            | PCM peak summaries / Common errors                           |

## Which reference to read

| If you're doing…                                                                                                          | Also read                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Designing a whole audio app (multiple sources, multiple UIs, spatial)                                                     | `references/designing-audio-apps.md`                        |
| Choosing a playback primitive (Sampler vs BufferPlayer vs FilePlayer)                                                     | `references/choosing-playback.md`                           |
| Sequencing, transport, tempo, a step sequencer or drum machine, re-queueing hits after an edit                            | `references/clock.md` + `references/sequencer.md`           |
| Deciding what goes in the audio layer vs the UI; Cell vs Param; which layer or package owns a feature                     | `references/architecture.md`                                |
| Writing or modifying an `AudioProcessor` subclass                                                                         | the `audio-processor-authoring` skill                       |
| Waveform, visual plugins, spectrum, EQ and audio controls                                                                 | `references/widgets.md`                                     |
| Plain Play/Pause, time, seek and volume controls without a waveform                                                       | `references/widgets.md` → Plain player controls             |
| Curves, native automation binding, range/time scaling, macro target adapters                                              | `references/automation.md`                                  |
| Source-time automation on a stretched WavePlayer selection                                                                | `references/player.md` + `references/automation.md`         |
| Stretching PCM, moving an interior transient, cancelling a pitch-preserving render                                        | `references/effects.md` → TimeStretch                       |
| MIDI files, piano-roll layout/drawing/plugins, note drag/resize and caller-owned audition                                 | `references/midi.md`                                        |
| Capturing Web MIDI messages and projecting a note take against the audio clock                                            | `references/midi.md` → Record a MIDI take                   |
| Takes, tempo, beat MIDI, clip editing/stretch/warp, Session launch, step sequencing, bus routing and DAWproject save/open | `references/daw.md`                                         |
| Edit a running Project, wait with `flush()`, or rebuild with `sync()`                                                     | `references/daw.md` → Apply Project edits to the live graph |
| Host a WebCLAP device, choose a CLAP ID from a bundle, bind a Param or save a patch                                       | `references/host.md` + `references/daw.md`                  |
| Observing block state (`cells`), loading phases, cancel, cached sources, audition                                         | `references/player.md` + `references/widgets.md`            |
| React UI bound to an engine                                                                                               | `references/react.md`                                       |
| Next.js / Remix / Astro / any app that renders on a server                                                                | `references/client-boundary.md`                             |
| 3D scene with spatial audio (three.js)                                                                                    | `references/threejs.md` + `architecture.md`                 |
| 3D scene with spatial audio (PlayCanvas)                                                                                  | `references/playcanvas.md` + `architecture.md`              |
| PixiJS (2D) audio visualizer or interactive canvas                                                                        | `references/pixijs.md`                                      |
| Sharing state between React and an imperative view (three.js, Canvas2D, WebGPU)                                           | `references/architecture.md`                                |
| Adding effects, building an FX rack, replacing Tone.js effects, offline export                                            | `references/effects.md`                                     |
| Understanding rationale ("why does this exist?")                                                                          | `references/overview.md`                                    |

## Errors by area: full prefix list

Every thrown message is listed, with cause and fix, in the reference for its area.

| Message starts with or mentions                                                                                                                                                                                                                                                           | Read                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Waveform…`, `Step grid…`, `Zoom…`, `Timeline zoom needs a positive increasing scale range.`, `Playhead…`, `Plugin…`, `Selection plugin…`, `Parameter control…`, `Level meter…`, `Frequency plot…`, `Spectrum…`, `EQ editor…`, `Automation overlay…`, `Automation lane…`, `Warp markers…` | `references/widgets.md` → Common errors                                                     |
| `No track is loaded.`, `No audio is loaded.`, `Audio is still loading.`, `The audio context is closed.`                                                                                                                                                                                   | `references/widgets.md` → Common errors                                                     |
| `WavePlayer…`, `Audio request…`, `Audio download…`, `Audio file…`, `Enter an audio URL.`, `Load progress…`, `Position…`, `Start time…`, `Selection must satisfy…`, `Source automation…`, `Stretch…`, `No audio source…`, `WavePlayer needs…`, `Time must be finite…`                      | `references/player.md` → Common errors                                                      |
| `AudioRecorder…`                                                                                                                                                                                                                                                                          | `references/recorder.md` → Common errors                                                    |
| `Pad Bank…`, `Pad hit…`, `Unknown pad.`                                                                                                                                                                                                                                                   | `references/pads.md` → Common errors                                                        |
| `Step Sequencer…`                                                                                                                                                                                                                                                                         | `references/sequencer.md` → Common errors                                                   |
| `Sample Library…`, `Sample lease…`                                                                                                                                                                                                                                                        | `references/samples.md` → Common errors                                                     |
| `Clock owned event time…`, `bpm must…`, `TempoParam…`, `renderTimeline…`, `… must be a finite number…`                                                                                                                                                                                    | `references/clock.md` → Common errors                                                       |
| `EffectRack…`, `Equalizer…`, `Effect: …`, `SendBus…`                                                                                                                                                                                                                                      | `references/effects.md` → Common errors                                                     |
| `Piano roll…`, `MIDI…`, `MidiSequence…`, `MidiRecorder…`, `Invalid MIDI file.`, `Only MIDI format…`, `SMPTE…`                                                                                                                                                                             | `references/midi.md` → Common errors                                                        |
| `Project…`, `AudioMedia…`, `Clip gain…`, `Workspace clip stretch…`, `Workspace audition…`, `Workspace range audition…`, `Start Workspace playback before launching clips.`, `Clip Launcher…`, `Audio clip gain automation…`, `Flush the project before setting a live track macro.`       | `references/daw.md`, `references/launcher.md` → Common errors                               |
| `WebCLAP…`                                                                                                                                                                                                                                                                                | `references/host.md` → Common errors                                                        |
| `summarizePeaks:…`, `peakFrameRange:…`, `AudioEngine destroyed…`, `createEngine:…`, `Event transform…`, `loadAudioBuffer:…`, `registerWorklet:…`                                                                                                                                          | `references/core.md` → PCM peak summaries / Common errors                                   |
| `measureLatency:…`, `useEngine…`, `attach:…`                                                                                                                                                                                                                                              | `references/devtools.md`, `references/react.md`, `references/playcanvas.md` → Common errors |
| `TimeStretch…`, `Rubber Band…`                                                                                                                                                                                                                                                            | `references/effects.md` → TimeStretch                                                       |
| `AutomationCurve…`, `AutomationBinding…`                                                                                                                                                                                                                                                  | `references/automation.md` → Common errors                                                  |
