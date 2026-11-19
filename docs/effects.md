---
title: Effects
---

DSP effects for audiorective — the Tone.js replacement set. Ten `AudioProcessor` classes (nine effects plus `Channel`), a `SendBus`, and dB conversion helpers are built on `@audiorective/core`. [`TimeStretch`](#timestretch) provides separate data-only offline processing.

## Install

```bash
pnpm add @audiorective/effects
```

## The contract

Every live effect in this package is an `AudioProcessor` with a stable `input: GainNode` and `output: GainNode`, so it drops into `defineGraph` like any other processor. Continuous controls are `SchedulableParam`s (rampable, sample-accurate); controls that must rebuild a node (a WaveShaper curve, a filter type) are plain `Param`s. Every effect has `params.wet: SchedulableParam` (default `1`) — a linear crossfade between the dry input and the processed signal, computed from one automation signal so both arms land in step on a ramp. Bypass is `wet = 0`; effects stay connected at `wet = 0`, there is no connect/disconnect toggling. Each effect declares `latency` (samples) or lets it derive from its internal `defineGraph` — unless documented otherwise below, an effect's latency is its wet arm's latency, since the dry arm is delay-compensated to match. Live processors accept a `BaseAudioContext`, so the same code runs live or through `renderOffline` (from `@audiorective/core`). The separate `TimeStretch` class accepts a compiled WASM module and has no audio nodes, context, `wet`, or `Effect` inheritance.

## Writing your own effect

A custom effect extends `Effect`, passes its wet arm's `input`/`output` pair to `super()`, and either declares `latency` (a fixed number or a `Param<number>`) or leaves it to derive from its own internal `defineGraph`. `Effect`, `WetArm`, `EffectOptions`, and `WorkletUnavailableError` are exported from `@audiorective/effects` for this purpose.

## Effects

| Class              | Constructor options (defaults)                                                                                               | Params                                                                            | Cells                                                                         | Latency                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Filter`           | `frequency` (350), `type` (`"lowpass"`), `Q` (1), `gain` (0), `rolloff` (`-12`, one of `-12\|-24\|-48`)                      | `frequency`, `Q`, `gain`: `SchedulableParam`; `type`: `Param<BiquadFilterType>`   | —                                                                             | 0                                                                                                                       |
| `Distortion`       | `distortion` (0.4, 0..1), `oversample` (`"none"`)                                                                            | `distortion`: `Param<number>`                                                     | —                                                                             | 0                                                                                                                       |
| `Phaser`           | `frequency` (0.5 Hz), `octaves` (3), `baseFrequency` (350), `Q` (10), `stages` (10)                                          | `frequency`, `Q`: `SchedulableParam`; `octaves`, `baseFrequency`: `Param<number>` | —                                                                             | 0                                                                                                                       |
| `FrequencyShifter` | `frequency` (0 Hz)                                                                                                           | `frequency`: `SchedulableParam`                                                   | —                                                                             | 0                                                                                                                       |
| `PingPongDelay`    | `delayTime` (0.25 s), `feedback` (0.2), `maxDelay` (1 s)                                                                     | `delayTime`, `feedback`: `SchedulableParam`                                       | —                                                                             | 0                                                                                                                       |
| `Convolver`        | `buffer`, `url`, `normalize` (true)                                                                                          | —                                                                                 | `isReady: ReadonlyCell<boolean>`                                              | 0                                                                                                                       |
| `PitchShift`       | `pitch` (0 semitones), `engine` (`"granular"`), `windowSize` (0.1 s, granular only), `stretch` (stretch-engine options)      | `pitch`: `Param<number>`                                                          | `isReady: ReadonlyCell<boolean>`                                              | granular: `windowSize / 2 * sampleRate` samples, fixed; stretch: reported by the engine, updated as the node reports it |
| `Compressor`       | `threshold` (-24 dB), `ratio` (4), `knee` (6 dB), `attack` (0.003 s), `release` (0.25 s), `makeup` (0 dB), `lookahead` (0 s) | `threshold`, `ratio`, `knee`, `attack`, `release`, `makeup`: `SchedulableParam`   | `reduction: ReadonlyCell<number>` (dB, ≤ 0), `isReady: ReadonlyCell<boolean>` | `lookahead * sampleRate` samples, fixed at construction                                                                 |
| `Limiter`          | `threshold` (-1 dB), `release` (0.05 s), `lookahead` (0.005 s)                                                               | `threshold`, `release`: `SchedulableParam`                                        | `reduction: ReadonlyCell<number>` (dB, ≤ 0), `isReady: ReadonlyCell<boolean>` | `lookahead * sampleRate` samples, fixed at construction                                                                 |
| `Channel`          | `gain` (1, linear), `pan` (0), `mute` (false), `channelCount` (2), `channelCountMode` (`"explicit"`)                         | `gain`, `pan`: `SchedulableParam`; `mute`: `Param<boolean>`                       | —                                                                             | not an `Effect` subclass — no `wet`, no declared latency                                                                |

Every effect except `Channel` also exposes `params.wet: SchedulableParam` (default 1). `Channel` is a strip (gain → pan → mute), not a wet/dry effect, and sits outside the `Effect` base class.

```typescript
import { Filter, Distortion } from "@audiorective/effects";

const filter = new Filter(ctx, { frequency: 800, type: "highpass", rolloff: -24 });
const drive = new Distortion(ctx, { distortion: 0.6 });
source.connect(filter.input);
filter.output.connect(drive.input);
drive.output.connect(ctx.destination);

drive.params.wet.linearRampToValueAtTime(0, ctx.currentTime + 1); // fade to bypass over 1s
```

### Filter frequency response

`filter.getFrequencyResponse(frequencies, magnitudes, phases)` fills equal-length `Float32Array` results. Use Hz for frequency, linear amplitude for magnitude and radians for phase. The snapshot includes all stages selected by `rolloff` and the phase-sensitive wet/dry sum. It reads the same current parameter values exposed to other observers. Use it with a standalone [EQ editor](./widgets.md#spectrum-and-eq-editor) or through an effect rack.

### Parametric equalizer

`Equalizer(context, { bands, wet? })` chains peaking Filter bands. Give each band a center `frequency` in 20–20,000 Hz, `gain` from −24 to +24 dB and `q` from 0.1 to 20. The band controls on `equalizer.bands` are schedulable Params; the same Params are registered in `equalizer.params` as `band<i>Frequency`, `band<i>Gain` and `band<i>Q` (zero-based `i`). Call `setBands()` with the same number of bands to update an existing bank. `params.wet` controls one wet/dry mix around the entire chain.

```ts
import { Equalizer } from "@audiorective/effects";

const eq = new Equalizer(context, {
  bands: [
    { frequency: 250, gain: -3, q: 0.7 },
    { frequency: 1000, gain: 6, q: 1 },
    { frequency: 4000, gain: 0, q: 0.8 },
  ],
});
source.connect(eq.input);
eq.output.connect(context.destination);
```

`getFrequencyResponse(frequencies, magnitudes, phases)` uses the same equal-length arrays as Filter and includes the phase-sensitive global wet/dry mix. Use these bands and magnitudes with [mountEqEditor](./widgets.md#spectrum-and-eq-editor). The equalizer owns its filters and borrows the context.

If you see `Equalizer frequency response arrays must have the same length.`, allocate one magnitude and one phase entry for each frequency. If `setBands()` rejects a change in band count, create a new equalizer for the new topology.

### Notes on individual effects

- **Distortion.** The waveshaper curve is Tone's shape normalized to unity peak, so `distortion = 0` is exactly unity gain (no coloration). `oversample` defaults to `"none"` because `"2x"`/`"4x"` add browser-defined latency the effect has no way to declare.
- **Phaser.** The wet arm sums the dry input with the phased signal at equal gain — that sum is what produces the notches, and `wet` blends between the plain dry input and that summed signal. With an even `stages` count, no notch sits exactly at `baseFrequency`.
- **PingPongDelay.** Input is summed to mono and enters on the left delay line, then bounces through the cross-feedback path to the right and back. Echoes that have crossed that feedback path arrive one render quantum (128 samples) later than `delayTime`, since a cycle in a Web Audio graph always delays one of its nodes by a quantum.
- **Compressor / Limiter.** See [Compressor and Limiter](#compressor-and-limiter) below.
- **PitchShift.** See [PitchShift engines](#pitchshift-engines) below.
- **Convolver.load().** The latest call to `load(url)` wins — an in-flight load that's superseded by a newer one is discarded silently. `ready` resolves once the constructor's initial `url` option (if given) has loaded; it is not re-armed by a later `load()` call. The `buffer` accessor is a tracked read: an effect that reads `convolver.buffer` re-runs when the buffer changes (assignment or `load`).

## PitchShift engines

`PitchShift` has one param surface — `pitch` in semitones (-24..24) — over two interchangeable engines, chosen with `engine`. `pitch` is a JS-rate `Param<number>`, not a `SchedulableParam`: the stretch engine applies it through an asynchronous worklet message, and the granular engine switches its delay-sweep direction and range at 0 semitones, so neither can follow a sample-accurate ramp. Set `pitch.value` from the main thread; do not expect `setValueAtTime` or ramps on it. This is a deliberate exception to the schedulable-by-default rule for audio-rate params.

- **`"granular"` (default).** Two delay lines swept by out-of-phase sawtooth LFOs and crossfaded — native nodes, no worklet, works everywhere including `OfflineAudioContext` with no setup. Latency is half of `windowSize` (default 0.1 s, so 50 ms) converted to samples, fixed for the processor's lifetime: the grains sweep the whole window with the crossfade centred on it. A short window (`windowSize` at or below ~0.02 s) keeps latency low for pad chains that must stay tight against a beat, at the cost of an audible warble; the default 0.1 s window is smoother but smears pitch by roughly ±15 Hz. `isReady` is `true` immediately and `ready` resolves right away — there's nothing to load.
- **`"stretch"`.** Backed by [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch), a polyphonic WASM AudioWorklet with real formant handling. Construct with `engine: "stretch"`; the node is silent until its worklet module loads and starts — await `ready` (or watch `cells.isReady`) before expecting output. `stretch.blockMs` trades latency for quality: a smaller block lowers latency and stresses quality more, a larger one (the useful range runs roughly 40–120 ms) gets closer to offline-quality pitch shifting. `latency` is read back from the node in samples once it starts and is exposed as a `Param<number>` that updates live, so the graph re-solves compensation when it changes. Every stretch-node method (`configure`, `schedule`, `start`, `latency`) is an async round-trip to the worklet thread; `PitchShift` awaits each of them internally before resolving `ready`.

```typescript
import { PitchShift } from "@audiorective/effects";

// low-latency, for a tight pad chain
const pad = new PitchShift(ctx, { engine: "granular", pitch: 7, windowSize: 0.02 });

// quality, for a one-shot export
const stretch = new PitchShift(ctx, { engine: "stretch", pitch: -5, stretch: { blockMs: 80 } });
await stretch.ready;
console.log(stretch.latency.value); // samples, known only after `ready`
```

## TimeStretch

`TimeStretch` renders pitch-preserving duration and timing changes from planar [`PCMData`](./core.md#pcm-peak-summaries). Import `@audiorective/effects/time-stretch` to avoid evaluating the live effects/audio-runtime implementations. Importing it creates no nodes or DOM. Processing requires browser Web Workers and WASM support.

The constructor **requires a caller-supplied compiled `WebAssembly.Module`** implementing the `rubberband-wasm3.3` C ABI. The package includes its adapter, but no Rubber Band WASM binary or third-party GPL wrapper. Obtaining, hosting, loading, and compiling a compatible module belongs to the application; there is no built-in module URL or download.

The pure entry exports `TimeStretch` and the types `TimeStretchOptions`, `TimeStretchResult`, and `TimeStretchAnchor`.

```typescript
import { TimeStretch } from "@audiorective/effects/time-stretch";
import type { PCMData } from "@audiorective/core/peaks";

async function stretchPCM(pcm: PCMData, compiledModule: WebAssembly.Module) {
  const processor = new TimeStretch(compiledModule);
  try {
    return await processor.process(pcm, { ratio: 1.5 });
  } finally {
    processor.destroy();
  }
}
```

`process(input, { ratio, anchors?, signal? }): Promise<TimeStretchResult>` uses an offline two-pass study/process render. `ratio` is output duration divided by input duration. Output channels have exactly `Math.round(inputFrames * ratio)` frames. Each job produces a complete render with variable processing time.

Pass interior `{ sourceFrame, outputFrame }` pairs to move transients locally. Both frame columns must be strictly increasing integers. The first and last frames of the whole interval are implicit at `(0, 0)` and `(inputFrames, outputFrames)`. For example, on a two-second 48 kHz input, use `{ ratio: 1, anchors: [{ sourceFrame: 48000, outputFrame: 62400 }] }` to move a transient from 1.0 to 1.3 seconds and keep the output two seconds long. The supplied module must export `rb_set_key_frame_map` for jobs with anchors.

Input requires at least one nonempty `Float32Array` channel, equal channel lengths, finite samples, and an integer sample rate from 8000 through 192000. The ratio must be finite and positive and yield a positive safe-integer frame count. Private source copies are transferred to each job; caller buffers stay attached and unchanged. Output includes `channels`, unchanged `sampleRate`, `inputFrames`, `outputFrames`, and the requested `ratio`.

Each call owns a Worker, so concurrent calls remain independent. An already-aborted or subsequently aborted `AbortSignal` rejects that job with `AbortError`. `destroy()` idempotently cancels all pending jobs and prevents further processing; it owns no application audio context. Failure or cancellation of one job does not prevent another valid call on a live processor.

| Error                                                                                               | Cause and fix                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TimeStretch requires a compiled WebAssembly.Module.`                                               | Compile compatible caller-owned WASM bytes before construction.                                              |
| `TimeStretch ratio must be positive and produce at least one frame.`                                | Supply a finite positive ratio whose rounded output frame count is a positive safe integer.                  |
| `TimeStretch needs finite equal-length PCM channels and an integer sampleRate from 8000 to 192000.` | Check channel type, lengths, samples and sample rate.                                                        |
| `TimeStretch requires Web Workers.`                                                                 | Run processing in a browser environment with Worker support.                                                 |
| `TimeStretch: unsupported Rubber Band WASM ABI.`                                                    | Supply the compatible C-ABI module, including memory, allocation and `rb_*` exports.                         |
| `TimeStretch anchors need strictly increasing interior source and output frames.`                   | Supply integer interior frame pairs in increasing order on both axes.                                        |
| `TimeStretch: Rubber Band WASM does not support warp anchors.`                                      | Supply a compatible module that exports `rb_set_key_frame_map`.                                              |
| `TimeStretch processing was aborted.` (`AbortError`)                                                | The caller cancelled the job; create a fresh signal to retry.                                                |
| `TimeStretch is destroyed.`                                                                         | Construct another processor for further jobs.                                                                |
| `TimeStretch produced an unexpected frame count.` / `TimeStretch produced nonfinite PCM.`           | The supplied module did not produce the required finite output; check module compatibility and input.        |
| `TimeStretch allocation failed.` / `TimeStretch could not create a Rubber Band state.`              | The supplied module could not allocate its processing resources.                                             |
| `TimeStretch worker failed.` / `Rubber Band exited: <code>`                                         | Worker execution or the supplied module failed; inspect the browser's worker error and module compatibility. |

See [WavePlayer composition](./blocks.md#compose-offline-stretch-and-a-selector) for module loading, audio routing, selection mapping, and cleanup with a waveform selector.

## Compressor and Limiter

Both share one internal gain-computer/detector core (`DynamicsCore`, not exported — construct `Compressor` or `Limiter` directly): threshold, ratio, knee, attack, and release feed a feedforward gain reduction curve, and a windowed peak detector looks `lookahead` seconds ahead to catch transients before they clip. The core runs in an `AudioWorkletNode` rather than the browser's built-in `DynamicsCompressorNode` so behavior — knee shape, lookahead, detector — is identical across browsers and in offline renders, where a promise made about export bytes can't depend on Chrome, Firefox, and Safari agreeing.

`Limiter` is the same core preset to a brickwall: ratio `Infinity`, knee `0`, attack `1 ms`, and only `threshold`, `release`, and `lookahead` are exposed as constructor options (`threshold` and `release` as params) — ratio, knee, and attack are fixed. The windowed peak detector over `lookahead` is what actually holds the ceiling at `threshold`.

Both expose `cells.reduction: ReadonlyCell<number>` — the current gain reduction in dB (≤ 0) — for a meter, and `cells.isReady: ReadonlyCell<boolean>` alongside a `ready: Promise<void>` that resolves once the worklet has loaded and the node is wired in. Both cells are written only by the effect. If the context has no `audioWorklet`, `ready` rejects with the `registerWorklet` error and `isReady` stays `false`; the rejection is handled internally, so only callers that await `ready` see it. `lookahead` is fixed at construction for both classes; it sets the worklet's internal buffer size and cannot be changed live. Because the detector runs sample-by-sample rather than block-by-block, `Compressor`'s output gain on a steady sine settles to within about half a dB of the value a static gain-computer formula would predict — the sample-level detector ripples slightly around it.

Params are bound to placeholders until `ready` resolves; automation scheduled before that is not carried over, so await `ready` before calling `setValueAtTime`/ramps on these params (plain `.value` writes are carried over).

```typescript
import { Compressor, Limiter } from "@audiorective/effects";

const comp = new Compressor(ctx, { threshold: -24, ratio: 4, attack: 0.003, release: 0.25 });
const limiter = new Limiter(ctx, { threshold: -1 });
await Promise.all([comp.ready, limiter.ready]);

source.connect(comp.input);
comp.output.connect(limiter.input);
limiter.output.connect(ctx.destination);

meterEl.textContent = `${limiter.cells.reduction.value.toFixed(1)} dB`;
```

## Channel and SendBus

`Channel` is a gain → pan → mute → output-gate strip: `gain` and `pan` are `SchedulableParam`s (`gain` is linear, not dB — convert with `dbToGain`/`gainToDb` from this package), `mute` is a boolean `Param`. `channel.send(bus, name, gain?)` taps the channel's post-mute `tap` node into a named receive point on a `SendBus` and returns a `Send` (`{ gain: SchedulableParam, enabled: Param<boolean>, dispose() }`); `send.gain` is also linear, and `send.enabled` (default `true`) gates that one send without touching its gain. A `SendBus` is instance-scoped — define receive points with `bus.define(name)`, read them back with `bus.receive(name)` (throws if undefined) — not a global registry. `SendBus.destroy()` disconnects every receive node; it cannot see the sends still feeding them, so call it only after every dependent `Send` has been disposed. `channel.params.outputEnabled` (default `true`) gates only the main `output`; sends tap `channel.tap` ahead of that gate, so each edge is controllable on its own. The input is `channelCount` channels in `"explicit"` mode, so a mono source is upmixed before the panner. Pass `channelCountMode: "max"` to follow the connected sources: a mono source reaches the panner as mono and gets its equal-power law (about -3 dB per side at centre), while a stereo source is unchanged. `bus.undefine(name)` disconnects and forgets one receive point.

An FX rack — five inserts in series, two sends to shared buses, a master limiter — fits inside one `defineGraph` in an `AudioProcessor`:

```typescript
import { AudioProcessor } from "@audiorective/core";
import { Channel, SendBus, Filter, Compressor, Distortion, Phaser, PingPongDelay, Limiter, dbToGain } from "@audiorective/effects";

class FxRack extends AudioProcessor<{}, {}> {
  private readonly _output: GainNode;
  readonly channel: Channel;
  readonly bus: SendBus;

  constructor(ctx: BaseAudioContext) {
    const output = new GainNode(ctx);
    const bus = new SendBus(ctx);
    bus.define("delay");
    bus.define("hall");

    const channel = new Channel(ctx, { gain: dbToGain(-6) });
    const filter = new Filter(ctx, { frequency: 400, type: "highpass" });
    const comp = new Compressor(ctx, { threshold: -18, ratio: 3 });
    const drive = new Distortion(ctx, { distortion: 0.2 });
    const phaser = new Phaser(ctx, { frequency: 0.3 });
    const master = new Limiter(ctx, { threshold: -1 });
    const delayFx = new PingPongDelay(ctx, { delayTime: 0.3, feedback: 0.35 });
    const hallFx = new Filter(ctx, { frequency: 3000, type: "lowpass" }); // stand-in for a reverb IR chain

    super(ctx, () => ({ params: {}, cells: {} }));
    this._output = output;
    this.channel = channel;
    this.bus = bus;

    channel.send(bus, "delay", 0.25);
    channel.send(bus, "hall", 0.15);
    bus.receive("delay").connect(delayFx.input);
    bus.receive("hall").connect(hallFx.input);

    this.defineGraph(() => [
      [channel, filter],
      [filter, comp],
      [comp, drive],
      [drive, phaser],
      [phaser, master],
      [master, output],
      [delayFx, master],
      [hallFx, master],
    ]);
  }

  get output(): GainNode {
    return this._output;
  }

  get input(): GainNode {
    return this.channel.input;
  }
}
```

## EffectRack inserts

Import `EffectRack` from `@audiorective/effects/rack`; its pure settings, validation and macro-range helpers live in `@audiorective/effects/rack-preset`, which loads without an `AudioContext`. It owns an ordered chain of built-in Filter, PingPongDelay and Equalizer inserts behind stable `input` and `output` nodes, and borrows the caller's audio context.

```typescript
import { EffectRack } from "@audiorective/effects/rack";

const rack = new EffectRack(context, [
  { id: "filter", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1200, q: 0.7 },
  { id: "delay", type: "delay", enabled: true, wet: 0.35, delayTime: 0.25, feedback: 0.25 },
]);
source.connect(rack.input);
rack.output.connect(context.destination);
rack.setEffects(rack.effects.map((slot) => (slot.id === "delay" ? { ...slot, enabled: false } : slot)));
// On teardown, disconnect your source from rack.input and call rack.destroy().
```

`setEffects()` takes a complete ordered snapshot, validates it, and preserves processors with the same slot ID and type. An empty chain passes audio through. Bypass sets the effective mix to dry while preserving the configured mix. Filter accepts lowpass or highpass, 20–20,000 Hz and Q 0.1–20. Delay accepts 0.01–1 second and feedback 0–0.95. Both accept a mix from 0–1. `rack.effects` and `rack.cells.effects` are the tracked, frozen settings snapshot; an effect or `useValue` that reads either re-runs after `setEffects()`, the only writer. [the DAW runtime](./daw.md#effect-rack) connects these settings to a project and playback.

Observe the read-only `rack.cells.effects.value` or `rack.effects` for the current order and settings. Use `setEffects()` to edit that snapshot.

Add `{ id, type: "eq", enabled, wet, bands }` for one Equalizer insert. Each band uses `{ frequency, gain, q }` and follows the [Equalizer ranges](#parametric-equalizer). Edits retain a slot's Equalizer when its band count stays the same.

`rack.readFilterResponse(slotId, frequencies, magnitudes, phases)` reads the current response for a Filter or Equalizer by slot ID. It yields `false` for an absent slot or a Delay. In the DAW runtime the same operation is available as `workspace.trackFilterResponse(trackId, slotId, frequencies, magnitudes, phases)`.

### Rack macros and presets

Each macro owns one normalized control and one or more built-in parameter targets. Set its mappings in the third constructor argument or in a complete preset.

```typescript
rack.setPreset({
  effects: rack.effects,
  macros: [
    {
      id: "tone",
      label: "Tone",
      value: 0.5,
      targets: [
        { slotId: "filter", parameter: "frequency", min: 200, max: 8000, scale: "exponential" },
        { slotId: "delay", parameter: "feedback", min: 0.05, max: 0.65 },
      ],
    },
  ],
});
const tone = rack.macro("tone")!;
tone.param.value = 0.7;
const preset = rack.capturePreset();
rack.setPreset(preset);
```

`rack.cells.macros.value` lists the live controls. Bind an ordinary knob to a macro's `param`. For audio-clock automation, pass `macro.automation` to [AutomationBinding](./automation.md). Linear or hold segments in the normalized curve produce native ramps or steps on the mapped parameters. Exponential targets require positive endpoints. Stop a running binding before taking manual control so subsequent curve edits do not reprogram the target.

Only one macro can own a given slot parameter. Use `rackMacroRange(slot, parameter)` for ranges. Supported targets are mix (`wet`) on every insert, Filter `frequency` and `q`, and Delay `delayTime` and `feedback`. Removing a slot drops its mappings. Bypassing a slot keeps its macro phase and makes that insert dry.

`capturePreset()` returns version 1, the ordered slots, mappings and current macro positions. Authored curves belong to their caller. `setPreset()` validates the entire rack and prepares missing nodes before touching existing controls. A successful recall resets the recalled positions and cancels their old schedules. Existing controls retain identity when their IDs and labels match.

## Offline export

`renderOffline` (from `@audiorective/core`) builds an `OfflineAudioContext`, runs an async `setup` callback, and returns the rendered `AudioBuffer`. Await `ready` on every worklet-backed effect (`Compressor`, `Limiter`, `PitchShift` with `engine: "stretch"`) inside `setup` before rendering starts:

```typescript
import { renderOffline } from "@audiorective/core";
import { Limiter, Compressor } from "@audiorective/effects";

const wav = await renderOffline({ seconds: 8, channels: 2, sampleRate: 44100 }, async (ctx) => {
  const comp = new Compressor(ctx, { threshold: -18, ratio: 3 });
  const limiter = new Limiter(ctx, { threshold: -1 });
  await Promise.all([comp.ready, limiter.ready]);

  source.connect(comp.input);
  comp.output.connect(limiter.input);
  limiter.output.connect(ctx.destination);
});
```

## Coming from Tone.js

| Tone usage                                          | Replacement                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `Tone.PitchShift({ pitch, windowSize })`            | `PitchShift({ engine, pitch, windowSize })`                        |
| `Tone.Filter(f, type, -24)`                         | `Filter({ frequency: f, type, rolloff: -24 })`                     |
| `Tone.FrequencyShifter()`                           | `FrequencyShifter()`                                               |
| `Tone.Distortion(0.5)`                              | `Distortion({ distortion: 0.5 })`                                  |
| `Tone.Phaser({ frequency, baseFrequency, wet: 0 })` | `Phaser({ frequency, baseFrequency })`, `wet.value = 0`            |
| `Tone.PingPongDelay('4n', 0.2)`                     | `PingPongDelay({ delayTime: 0.5, feedback: 0.2 })`                 |
| `Tone.Convolver(url)`                               | `Convolver({ url })`                                               |
| `Tone.Limiter(-1)`                                  | `Limiter({ threshold: -1 })`                                       |
| `Tone.Channel` + `send`/`receive(key)`              | `Channel` + `SendBus.define(key)` / `channel.send(bus, key)`       |
| `channel.set({ volume: dB })` ramp                  | `send.gain.linearRampToValueAtTime(dbToGain(dB), t)`               |
| `effect.set({ wet })` / disconnect on min           | `effect.params.wet.linearRampToValueAtTime(v, t)`                  |
| `Tone.Offline(cb, s, 2, rate)`                      | `renderOffline({ seconds: s, channels: 2, sampleRate: rate }, cb)` |

## Advanced: pre-warming worklets

`registerWorklet(ctx, name, source)` lives in `@audiorective/core` (so blocks can use it) and `@audiorective/effects` re-exports it. It is exported for apps that want to load a worklet module ahead of first use (e.g. during a loading screen) rather than on first construction of `Compressor`, `Limiter`, or a stretch-engine `PitchShift`. `Compressor` and `Limiter` call it with the same `(ctx, name)` pair internally, so a pre-warm call and the effect's own call share one `addModule` load.

## Common errors

| Rack message                                                                         | Fix                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `EffectRack needs unique slot IDs and valid Filter, Delay or EQ settings.`           | Use distinct nonempty slot IDs and settings inside the ranges above.                  |
| `Equalizer needs valid bands with frequency 20–20000 Hz, gain ±24 dB, and Q 0.1–20.` | Supply one or more bands with values in the supported ranges.                         |
| `EffectRack is destroyed.`                                                           | Construct a new rack before applying settings.                                        |
| `EffectRack preset version must be 1.`                                               | Pass a version 1 snapshot or omit the version when authoring a preset.                |
| `EffectRack macros need unique IDs, normalized values, and distinct valid targets.`  | Use positions from 0 to 1 and assign a supported slot parameter to at most one macro. |
| `EffectRack macro target is unavailable.`                                            | Rebuild the preset against the current rack slots and supported ranges.               |
| `EffectRack macro value needs a number from 0 to 1.`                                 | Pass a finite normalized position.                                                    |
| `EffectRack macro automation needs a time and a normalized curve starting at zero.`  | Use absolute audio seconds for the start and a relative curve beginning at zero.      |
| `EffectRack macro is disposed.`                                                      | Look up the replacement control on the live rack.                                     |
