---
title: Effects
---

DSP effects for audiorective — the Tone.js replacement set. Ten `Effect` classes (nine effects plus `Ducker`), a `Channel` strip, a `SendBus`, an [`EffectChain`](#effectchain) that orders any of them, and dB conversion helpers are built on `@audiorective/core`. [`TimeStretch`](#timestretch) provides separate offline processing of `AudioBuffer`s.

## Install

```bash
pnpm add @audiorective/effects
```

## The contract

Every live effect in this package is an `AudioProcessor` with a stable `input: GainNode` and `output: GainNode`, so it drops into `defineGraph` like any other processor. Continuous controls are `SchedulableParam`s (rampable, sample-accurate); controls that must rebuild a node (a WaveShaper curve, a filter type) are plain `Param`s. Every effect has `params.wet: SchedulableParam` (default `1`) — a linear crossfade between the dry input and the processed signal, computed from one automation signal so both arms land in step on a ramp. Writes to a continuous effect param (`wet`, gain, frequency, delay time, …) ramp over 10 ms (`smoothing`), so a dragged slider never clicks; scheduled ramps are exact. Every effect also has `params.bypass: Param<boolean>` (option `bypass`, default `false`): it fades the effect out of the sound in about 15 ms, keeps its settings and stays connected, so there is no connect/disconnect toggling. While an effect is loading or has failed, its wet arm is muted and the dry share stays at `1 − wet`: a fully wet send return is silent, so it cannot duplicate the original dry track. Bypass always passes the full dry signal, including while loading or after failure. Each effect declares `latency` (samples) or lets it derive from its internal `defineGraph` — unless documented otherwise below, an effect's latency is its wet arm's latency, since the dry arm is delay-compensated to match. Live processors accept a `BaseAudioContext`, so the same code runs live or through `renderOffline` (from `@audiorective/core`). Every effect has `cells.status: ReadonlyCell<"loading" | "ready" | "error">` (`"ready"` at once for an effect that loads nothing), `cells.error: ReadonlyCell<Error | null>`, and `ready: Promise<void>`, which resolves when the status is `"ready"` and rejects with the cause when loading fails. The separate `TimeStretch` class has no audio nodes, context, `wet`, or `Effect` inheritance.

## Writing your own effect

A custom effect extends `Effect`, passes its wet arm's `input`/`output` pair to `super()`, and either declares `latency` (a fixed number or a `Param<number>`) or leaves it to derive from its own internal `defineGraph`. A declared latency also delays the dry path by whatever the wet arm does not already account for (the declared value minus the arm processor's own `latency`, nothing for a declared `0`), so bypass and a partial `wet` stay aligned with the wet arm even when it is plain Web Audio nodes. An arm that loads asynchronously sets `loading: true` and calls `this.track(promise)` once; the wet arm stays muted until the promise resolves (the dry share remains `1 − wet`), and `cells.status`, `cells.error` and `ready` follow it. Set `static type` to the name `EffectChain.toJSON()` should write. `Effect`, `EffectStatus`, `WetArm`, `EffectOptions`, and `WorkletUnavailableError` are exported from `@audiorective/effects` for this purpose.

`AnyEffect` is the exported common type for heterogeneous insert lists and shared controls over `params.wet`, `params.bypass`, `cells.status` and `ready`. Effect-specific params remain typed on each concrete effect.

## Effects

| Class              | Constructor options (defaults)                                                                                                | Params                                                                            | Cells                                                 | Latency                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Filter`           | `frequency` (350), `type` (`"lowpass"`), `Q` (1), `gain` (0), `rolloff` (`-12`, one of `-12\|-24\|-48`)                       | `frequency`, `Q`, `gain`: `SchedulableParam`; `type`: `Param<BiquadFilterType>`   | —                                                     | 0                                                                                                                       |
| `Distortion`       | `distortion` (0.4, 0..1), `oversample` (`"none"`)                                                                             | `distortion`: `Param<number>`                                                     | —                                                     | 0                                                                                                                       |
| `Phaser`           | `frequency` (0.5 Hz), `octaves` (3), `baseFrequency` (350), `Q` (10), `stages` (10)                                           | `frequency`, `Q`: `SchedulableParam`; `octaves`, `baseFrequency`: `Param<number>` | —                                                     | 0                                                                                                                       |
| `FrequencyShifter` | `frequency` (0 Hz)                                                                                                            | `frequency`: `SchedulableParam`                                                   | —                                                     | 0                                                                                                                       |
| `PingPongDelay`    | `delayTime` (0.25 s), `feedback` (0.2), `maxDelay` (1 s)                                                                      | `delayTime`, `feedback`: `SchedulableParam`                                       | —                                                     | 0                                                                                                                       |
| `Convolver`        | `buffer`, `url`, `normalize` (true)                                                                                           | —                                                                                 | `buffer: ReadonlyCell<AudioBuffer \| null>`           | 0                                                                                                                       |
| `PitchShift`       | `pitch` (0 semitones), `engine` (`"granular"`), `windowSize` (0.1 s, granular only), `stretch` (stretch-engine options)       | `pitch`: `Param<number>`                                                          | —                                                     | granular: `windowSize / 2 * sampleRate` samples, fixed; stretch: reported by the engine, updated as the node reports it |
| `Compressor`       | `threshold` (-24 dB), `ratio` (4), `knee` (6 dB), `attack` (0.003 s), `release` (0.25 s), `makeup` (0 dB), `lookAhead` (0 s)  | `threshold`, `ratio`, `knee`, `attack`, `release`, `makeup`: `SchedulableParam`   | `reduction: ReadonlyCell<number>` (dB, ≤ 0)           | `lookahead * sampleRate` samples, fixed at construction                                                                 |
| `Limiter`          | `threshold` (-1 dB), `release` (0.05 s), `lookAhead` (0.005 s)                                                                | `threshold`, `release`: `SchedulableParam`                                        | `reduction: ReadonlyCell<number>` (dB, ≤ 0)           | `lookahead * sampleRate` samples, fixed at construction                                                                 |
| `Ducker`           | `depth` (8 dB), `attack` (0.01 s), `release` (0.3 s), `threshold` (-30 dBFS)                                                  | `depth`, `attack`, `release`, `threshold`: `SchedulableParam`                     | `reduction: ReadonlyCell<number>` (dB, ≤ 0)           | 0                                                                                                                       |
| `Channel`          | `gain` (1, linear), `pan` (0), `muted` (false), `outputEnabled` (true), `channelCount` (2), `channelCountMode` (`"explicit"`) | `gain`, `pan`: `SchedulableParam`; `muted`, `outputEnabled`: `Param<boolean>`     | `level: ReadonlyCell<number>` (post-fader peak, dBFS) | not an `Effect` subclass — no `wet`, no declared latency                                                                |

Every effect except `Channel` also exposes `params.wet: SchedulableParam` (default 1), `params.bypass: Param<boolean>` and the `status`/`error` cells. `Channel` is a strip (gain → pan → mute → output gate) with a post-mute `tap` for sends and per-send `enabled` flags (see [Channel and SendBus](#channel-and-sendbus)), not a wet/dry effect, and sits outside the `Effect` base class.

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

- **Distortion.** The waveshaper curve is Tone's shape normalized to unity peak, so `distortion = 0` is exactly unity gain (no coloration). A `distortion` change crossfades prebuilt shaper arms over 10 ms; a curve is replaced only on a silent arm, so rapid drive edits stay continuous. These native handovers do not reserve or resume caller-owned offline suspend points. `oversample` defaults to `"none"` because `"2x"`/`"4x"` add browser-defined latency the effect has no way to declare.
- **Phaser.** The wet arm sums the dry input with the phased signal at equal gain — that sum is what produces the notches, and `wet` blends between the plain dry input and that summed signal. With an even `stages` count, no notch sits exactly at `baseFrequency`.
- **PingPongDelay.** Input is summed to mono and enters on the left delay line, then bounces through the cross-feedback path to the right and back. Echoes that have crossed that feedback path arrive one render quantum (128 samples) later than `delayTime`, since a cycle in a Web Audio graph always delays one of its nodes by a quantum.
- **Compressor / Limiter / Ducker.** See [Compressor and Limiter](#compressor-and-limiter) and [Ducker](#ducker) below.
- **PitchShift.** See [PitchShift engines](#pitchshift-engines) below.
- **Convolver.load().** The latest call to `load(url)` wins — an in-flight load that's superseded by a newer one is discarded silently. While no impulse response is in place (`cells.status` is `"loading"`, or `"error"` after a failed `load()`) only its `1 − wet` dry share passes; `wet: 1` stays silent. `load(url)` returns `ready`, which rejects with the fetch or decode error that `cells.error` also holds, and each `load()` or `buffer` assignment re-arms it. `cells.buffer` is the read-only cell behind the `buffer` accessor. A `load()` that settles after `dispose()` is ignored. The `buffer` accessor is a tracked read: an effect that reads `convolver.buffer` re-runs when the buffer changes (assignment or `load`).

## PitchShift engines

`PitchShift` has one param surface — `pitch` in semitones (-24..24) — over two interchangeable engines, chosen with `engine`. `pitch` is a JS-rate `Param<number>`, not a `SchedulableParam`: the stretch engine applies it through an asynchronous worklet message, and the granular engine switches its delay-sweep direction and range at 0 semitones, so neither can follow a sample-accurate ramp. Set `pitch.value` from the main thread; do not expect `setValueAtTime` or ramps on it. This is a deliberate exception to the schedulable-by-default rule for audio-rate params.

- **`"granular"` (default).** Two delay lines swept by out-of-phase sawtooth LFOs and crossfaded — native nodes, no worklet, works everywhere including `OfflineAudioContext` with no setup. Latency is half of `windowSize` (default 0.1 s, so 50 ms) converted to samples, fixed for the processor's lifetime: the grains sweep the whole window with the crossfade centred on it. A short window (`windowSize` at or below ~0.02 s) keeps latency low for pad chains that must stay tight against a beat, at the cost of an audible warble; the default 0.1 s window is smoother but smears pitch by roughly ±15 Hz. `cells.status` is `"ready"` immediately and `ready` resolves right away — there's nothing to load.
- **`"stretch"`.** Backed by [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch), a polyphonic WASM AudioWorklet with real formant handling. Construct with `engine: "stretch"`; it needs the optional peer dependency `signalsmith-stretch` (`npm i signalsmith-stretch`), loaded lazily when the engine is created, so the root entry, the other effects and the granular engine never touch it. The node is silent until its worklet module loads and starts — only the `1 − wet` dry share passes until `cells.status` is `"ready"` (`wet: 1` is silent; await `ready` to know when). `stretch.blockMs` trades latency for quality: a smaller block lowers latency and stresses quality more, a larger one (the useful range runs roughly 40–120 ms) gets closer to offline-quality pitch shifting. `latency` is read back from the node in samples once it starts and is exposed as a `Param<number>` that updates live, so the graph re-solves compensation when it changes. Every stretch-node method (`configure`, `schedule`, `start`, `latency`) is an async round-trip to the worklet thread; `PitchShift` awaits each of them internally before resolving `ready`. If `signalsmith-stretch` cannot be loaded, `ready` rejects with the install error below and `cells.status` becomes `"error"`.

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

`TimeStretch` renders pitch-preserving duration and timing changes: an `AudioBuffer` in, an `AudioBuffer` out. Import `@audiorective/effects/time-stretch` to avoid evaluating the live effects/audio-runtime implementations. Importing it creates no nodes or DOM. Processing requires browser Web Workers and WASM support. Pass a loaded `TimeStretch` as the `stretch` option of `openWorkspace` (see [DAW](./daw.md#stretched-audio-from-another-daw)) to keep the pitch of audio a `.dawproject` from another DAW stretches by its warp markers.

`await TimeStretch.load({ wasmUrl })` fetches and compiles the Rubber Band WebAssembly build (the `rubberband-wasm3.3` C ABI) once per URL and returns a stretcher over the cached module. The package includes its adapter, but **no Rubber Band WASM binary or third-party GPL wrapper**: you host the file and pass its URL (a `blob:` or object URL works for a file the user picks). There is no built-in module URL or download.

```typescript
import { TimeStretch } from "@audiorective/effects/time-stretch";

const stretch = await TimeStretch.load({ wasmUrl: "/wasm/rubberband.wasm" });
try {
  // a 92 BPM loop at project tempo 120: ratio = fromBpm / toBpm
  const stretched = await stretch.process(loop, { ratio: 92 / 120, loop: true, signal });
  source.buffer = stretched;
  source.loop = true;
} finally {
  stretch.dispose();
}
```

`process(input, { ratio, anchors?, loop?, signal? }): Promise<AudioBuffer>` uses an offline two-pass study/process render. `ratio` is output length divided by input length, so a tempo change from `fromBpm` to `toBpm` is `ratio = fromBpm / toBpm` (92 BPM to 120 BPM gives 0.767: the result is shorter). The result has exactly `Math.round(input.length * ratio)` frames, the input's sample rate and channel count. Each job produces a complete render with variable processing time.

`loop: true` treats the input as one loop cycle: the stretcher sees the cycle wrapped with its own ends on both sides, and the result is cut back to exactly one cycle, so it wraps back to its start without a seam. Set the `AudioBufferSourceNode`'s `loop` to play it.

Pass interior `{ sourceFrame, outputFrame }` pairs to move transients locally. Both frame columns must be strictly increasing integers. The first and last frames of the whole interval are implicit at `(0, 0)` and `(inputFrames, outputFrames)`. For example, on a two-second 48 kHz input, use `{ ratio: 1, anchors: [{ sourceFrame: 48000, outputFrame: 62400 }] }` to move a transient from 1.0 to 1.3 seconds and keep the output two seconds long. The supplied module must export `rb_set_key_frame_map` for jobs with anchors.

The input needs finite samples, and the ratio must be finite and positive and yield a positive safe-integer frame count. Private source copies are transferred to each job; the caller's buffer stays attached and unchanged.

Each call owns a Worker, so concurrent calls remain independent. **Every cancellation rejects with an `AbortError`** (`error.name === "AbortError"`): an already-aborted or later-aborted `signal` on `load` or `process`, and `dispose()` for jobs still running. Anything else that rejects is a real failure, so `if (error.name === "AbortError") return;` is the whole cancellation check. `dispose()` is idempotent and prevents further processing; it owns no audio context. Failure or cancellation of one job does not prevent another valid call on a live stretcher. A [`WavePlayer`](./player.md) accepts a `TimeStretch` as its `stretch` processor.

| Error                                                                                     | Cause and fix                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `TimeStretch.load: <url> responded <status>.`                                             | The WASM URL did not return 200; host the file at that URL.                                                                               |
| `TimeStretch ratio must be positive and produce at least one frame.`                      | Supply a finite positive ratio whose rounded output frame count is a positive safe integer.                                               |
| `TimeStretch needs finite samples.`                                                       | Check the input buffer for NaN or infinite samples.                                                                                       |
| `TimeStretch requires Web Workers.`                                                       | Run processing in a browser environment with Worker support.                                                                              |
| `TimeStretch: unsupported Rubber Band WASM ABI.`                                          | Supply the compatible C-ABI module, including memory, allocation and `rb_*` exports.                                                      |
| `TimeStretch anchors need strictly increasing interior source and output frames.`         | Supply integer interior frame pairs in increasing order on both axes.                                                                     |
| `TimeStretch: Rubber Band WASM does not support warp anchors.`                            | Supply a compatible module that exports `rb_set_key_frame_map`.                                                                           |
| `TimeStretch processing was aborted.` / `TimeStretch.load was aborted.` (`AbortError`)    | The caller cancelled the job; create a fresh signal to retry.                                                                             |
| `TimeStretch is disposed.`                                                                | Calling `process` after `dispose()` throws this; a job running at `dispose()` rejects with it as an `AbortError`. Load another stretcher. |
| `TimeStretch produced an unexpected frame count.` / `TimeStretch produced nonfinite PCM.` | The supplied module did not produce the required finite output; check module compatibility and input.                                     |
| `TimeStretch allocation failed.` / `TimeStretch could not create a Rubber Band state.`    | The supplied module could not allocate its processing resources.                                                                          |
| `TimeStretch worker failed.` / `Rubber Band exited: <code>`                               | Worker execution or the supplied module failed; inspect the browser's worker error and module compatibility.                              |

For DAW clip edits, pass the loaded processor to `workspace.prepareAudioClipStretch(clipId, ratio, processor, { anchors, signal })`, call the prepared edit's `apply()`, then await `workspace.flush()`; see [pitch-preserving clip stretch](./daw.md#pitch-preserving-clip-stretch) for ownership and undo. The rendered WAV provides standard DAWproject playback. The original window, ratio and anchors are Audiorective-private entries that other DAWs may drop. Use streaming `saveWorkspaceTo(workspace, writableStream)` when playback or a retained original source is file-backed.

See [WavePlayer composition](./player.md#compose-offline-stretch-and-a-selector) for module loading, audio routing, selection mapping, and cleanup with a waveform selector.

## Compressor and Limiter

Both share one internal gain-computer/detector core (`DynamicsCore`, not exported — construct `Compressor` or `Limiter` directly): threshold, ratio, knee, attack, and release feed a feedforward gain reduction curve, and a windowed peak detector looks `lookahead` seconds ahead to catch transients before they clip. The core runs in an `AudioWorkletNode` rather than the browser's built-in `DynamicsCompressorNode` so behavior — knee shape, lookahead, detector — is identical across browsers and in offline renders, where a promise made about export bytes can't depend on Chrome, Firefox, and Safari agreeing.

`Limiter` is the same core preset to a brickwall: ratio `Infinity`, knee `0`, attack `1 ms`, and only `threshold`, `release`, and `lookAhead` are exposed as constructor options (`threshold` and `release` as params) — ratio, knee, and attack are fixed. The windowed peak detector over `lookahead` is what actually holds the ceiling at `threshold`.

Both expose `cells.reduction: ReadonlyCell<number>` — the current gain reduction in dB (≤ 0) — for a meter, and, like every effect, `cells.status` and `ready`: `ready` resolves once the worklet has loaded and the node is wired in, and until then only the `1 − wet` dry share passes (`wet: 1` is silent). Both cells are written only by the effect. If the context has no `audioWorklet`, `ready` rejects with the `registerWorklet` error and `cells.status` becomes `"error"`; the rejection is handled internally, so only callers that await `ready` see it. `lookahead` is fixed at construction for both classes; it sets the worklet's internal buffer size and cannot be changed live. Because the detector runs sample-by-sample rather than block-by-block, `Compressor`'s output gain on a steady sine settles to within about half a dB of the value a static gain-computer formula would predict — the sample-level detector ripples slightly around it.

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

## Ducker

`Ducker` lowers its audio by `depth` dB while a second signal, the sidechain, is above `threshold`: a music bed under a voice, a pad under a kick. Connect the trigger into `ducker.sidechain`; it only triggers and never reaches the output, so the voice goes to the speakers by its own path.

```typescript
import { Ducker } from "@audiorective/effects";

const ducker = new Ducker(ctx, { depth: 8, attack: 0.01, release: 0.3, threshold: -30 });
music.connect(ducker.input);
ducker.output.connect(ctx.destination);
mic.connect(ducker.sidechain); // keys the ducking
mic.connect(ctx.destination); // the voice itself, unchanged

const stopMeter = ducker.cells.reduction.subscribe(
  (db) => {
    duckingEl.textContent = `${db.toFixed(1)} dB`;
  },
  { immediate: true },
);
ducker.params.bypass.value = true; // auto-duck off: audio and meter recover together
// On teardown: stopMeter(); ducker.dispose();
```

`cells.reduction` is the actual output attenuation in dB (≤ 0), including the wet/dry mix and the complete bypass fade. Read it each frame or subscribe directly; do not substitute `0` when the bypass checkbox changes. The worklet refreshes the meter every 512 audio frames (about 12 ms at 44.1 kHz), even when the detector envelope is steady. While loading or after failure, an animation-frame poll reports the remaining dry path: `wet: 1` is silent (`-Infinity` dB), `wet: 0.5` is about −6.02 dB, and full bypass is `0` dB. Disposal stops the poll and worklet reports.

`attack` and `release` are the seconds a full-depth change takes (linear in dB), so `release: 0.3` recovers 8 dB over 300 ms. `threshold` is the sidechain's peak level in dBFS; a 50 ms peak follower keeps speech from chattering the gate. `depth`, `attack`, `release` and `threshold` are `SchedulableParam`s. The core runs in an `AudioWorkletNode`, so, like `Compressor`, only the `1 − wet` dry share passes until `cells.status` is `"ready"` (`wet: 1` is silent).

## Channel and SendBus

`Channel` is a gain → pan → mute → output-gate strip: `gain` and `pan` are `SchedulableParam`s that ramp over 10 ms (`gain` is linear, not dB — convert with `dbToGain`/`gainToDb` from this package), `muted` is a boolean `Param`. `channel.cells.level` is the post-fader peak in dBFS over the last ~45 ms (`-Infinity` when silent), refreshed every animation frame while the channel lives: bind a meter to it, no analyser needed. `channel.send(bus, name, gain?)` taps the channel's post-mute `tap` node into a named receive point on a `SendBus` and returns a `Send`, an `AudioProcessor` with `params.gain: SchedulableParam` (linear) and `params.enabled: Param<boolean>` (default `true`, gates that one send without touching its gain); `send.dispose()` removes it. A `SendBus` is instance-scoped — define receive points with `bus.define(name)`, read them back with `bus.receive(name)` (throws if undefined) — not a global registry. A receive point is a processor too, so `bus.receive(name).connect(reverb)` works like any `connect`. Sends and receive points join the context's latency graph, so a limiter's lookahead on one strip is compensated on the sends and the dry paths alike. `SendBus.dispose()` disconnects every receive node; it cannot see the sends still feeding them, so call it only after every dependent `Send` has been disposed. `channel.params.outputEnabled` (default `true`) gates only the main `output`; sends tap `channel.tap` ahead of that gate, so each edge is controllable on its own. The input is `channelCount` channels in `"explicit"` mode, so a mono source is upmixed before the panner. Pass `channelCountMode: "max"` to follow the connected sources: a mono source reaches the panner as mono and gets its equal-power law (about -3 dB per side at centre), while a stereo source is unchanged. `bus.undefine(name)` disconnects and forgets one receive point.

Use processor `connect()` throughout a mixer that uses `Channel.send()`, including the upstream inserts and return routes. These edges share one context-wide latency solve. A separate `defineGraph()` solves only its own edges and cannot see a send's upstream arrival, so mixing the two across a send boundary can misalign tracks. Keep `defineGraph()` for a self-contained processor's internal graph.

An FX rack — five inserts in series, two sends to shared buses, a master limiter — composes with processor connections:

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
    bus.receive("delay").connect(delayFx);
    bus.receive("hall").connect(hallFx);

    channel.connect(filter).connect(comp).connect(drive).connect(phaser).connect(master);
    delayFx.connect(master);
    hallFx.connect(master);
    master.connect(output);
  }

  get output(): GainNode {
    return this._output;
  }

  get input(): GainNode {
    return this.channel.input;
  }
}
```

## EffectChain

`EffectChain` is an ordered chain of any effect instances behind stable `input` and `output` nodes. It is an `AudioProcessor`, so `source.connect(chain.input)` and `chain.connect(destination)` work, it declares the sum of its effects' latency, and it borrows the caller's audio context. The chain owns its effects: `remove()` and `dispose()` dispose them.

```typescript
import { EffectChain, Filter, PingPongDelay, Distortion } from "@audiorective/effects";

const chain = new EffectChain(ctx, [new Filter(ctx, { frequency: 2000 }), new PingPongDelay(ctx, { delayTime: 0.35, feedback: 0.4, wet: 0.3 })]);
guitar.connect(chain.input);
chain.output.connect(ctx.destination);

chain.add(new Distortion(ctx), 0); // insert at an index (default: the end)
const [filter] = chain.cells.effects.value;
chain.move(filter!, 2); // reorder; the same instance and its settings
chain.remove(filter!); // disposes it once its tail has faded
filter.params.bypass.value = true; // or just bypass it, keeping its place
```

`cells.effects: ReadonlyCell<readonly Effect[]>` is the current order; an effect or `useValue` that reads it re-runs after every edit. Every edit is a crossfade of about 15 ms between per-edge gains, never a hard reconnect: adding, removing or moving an effect does not click or drop out, and the other effects keep their state, so a delay's echoes keep ringing while a neighbour moves. A move runs as a removal followed by an insertion (about 70 ms in all), which is what keeps the graph free of feedback loops at every instant; edits made during a hand-over queue behind it. Effects inside a chain take stereo input (a mono source is upmixed). `new EffectChain(ctx, effects, { signal })` disposes the chain and its effects when `signal` aborts.

`chain.toJSON()` returns `{ version: 1, effects: [{ type, params }] }`: each effect's type name (its class's `static type`) and every primitive parameter, including `bypass` and `wet`. `AnyEffect` is the common type for a heterogeneous list and its shared controls.

For a preset Load button, use `await chain.restore(json, { types, signal? })` on the existing chain. `types` maps saved names to effect classes or factories that create new instances (for example, an `Equalizer` factory can supply its required `bands`). Restore validates the complete JSON shape, types, parameter names, values and ranges, then awaits every candidate effect's `ready`. Any issue disposes the candidates and leaves the live order, settings and wiring unchanged. Saved values initialize detached effects immediately; later knob writes keep normal smoothing.

A successful restore publishes the complete target order once and queues its existing remove/insert crossfades as one batch behind earlier edits. The chain keeps the same `input` and `output`, so the caller does not reconnect audio, run timers, or write a second fade engine. The promise resolves when that target is committed and queued; the audio handovers can still be running. Edits made by subscribers or after the restore queue behind the whole replacement.

```typescript
const types = { Filter, PingPongDelay, Distortion, Equalizer: (c: BaseAudioContext) => new Equalizer(c, { bands }) };
localStorage.setItem("board", JSON.stringify(chain));
try {
  const issues = await chain.restore(JSON.parse(localStorage.getItem("board")!), {
    types,
    signal: loadController.signal,
  });
  if (issues.length) showMessage(issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
} catch (error) {
  if (!(error instanceof DOMException && error.name === "AbortError")) showMessage(String(error));
}
```

Only the latest pending restore may commit. A newer request, the job's `signal`, or chain disposal cancels pending preparation, disposes its candidates and rejects with `AbortError`. A restore job's signal does **not** dispose the chain or cancel an already committed queue batch. In contrast, `new EffectChain(ctx, effects, { signal })` uses its signal for ownership of the chain itself.

For a separate chain—for example, a preview or caller-composed two-chain morph—use `EffectChain.fromJSON(context, json, { types, signal? })`. This tolerant factory returns `{ chain, issues }`, keeps valid entries and settings, and reports unknown types, malformed entries or rejected params by `path`. It does not replace a running chain or await effect readiness. Its signal owns the newly constructed chain, as with the constructor. `EffectChainFromJSONOptions` describes factory ownership; `EffectChainRestoreOptions` describes one live load job.

The DAW's built-in track inserts are a [separate, data-driven rack](./daw.md#effect-rack) built on `EffectChain`.

## Offline export

`renderOffline` (from `@audiorective/core`) builds an `OfflineAudioContext`, runs an async `setup` callback, and returns the rendered `AudioBuffer`. Await `ready` on every worklet-backed effect (`Compressor`, `Limiter`, `Ducker`, `PitchShift` with `engine: "stretch"`) inside `setup` before rendering starts:

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
| `channel.set({ volume: dB })` ramp                  | `send.params.gain.linearRampToValueAtTime(dbToGain(dB), t)`        |
| `effect.set({ wet })` / disconnect on min           | `effect.params.wet.linearRampToValueAtTime(v, t)`                  |
| `Tone.Offline(cb, s, 2, rate)`                      | `renderOffline({ seconds: s, channels: 2, sampleRate: rate }, cb)` |

## Advanced: pre-warming worklets

`registerWorklet(ctx, name, source)` lives in `@audiorective/core` only (the capability packages use it too); import it from there. It is exported for apps that want to load a worklet module ahead of first use (e.g. during a loading screen) rather than on first construction of `Compressor`, `Limiter`, `Ducker`, or a stretch-engine `PitchShift`. `Compressor`, `Limiter` and `Ducker` call it with the same `(ctx, name)` pair internally, so a pre-warm call and the effect's own call share one `addModule` load.

## Common errors

| Message                                                                                                                       | Cause                                                                                                                                                                           | Fix                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PitchShift stretch engine needs the optional peer dependency "signalsmith-stretch": install it (npm i signalsmith-stretch).` | `engine: "stretch"` was requested and `signalsmith-stretch` could not be loaded; `ready` rejects                                                                                | Install `signalsmith-stretch`, or use the default `"granular"` engine                                                                            |
| `Effect: wet arm's input processor has no input node`                                                                         | An `Effect` wet arm was given an `AudioProcessor` that exposes no `input`.                                                                                                      | Use a processor with an input node (an effect, not an instrument or player) as the arm input.                                                    |
| `Effect: invalid filter type "<type>".`                                                                                       | A filter type from JavaScript or saved data is outside `BiquadFilterType`.                                                                                                      | Use `lowpass`, `highpass`, `bandpass`, `lowshelf`, `highshelf`, `peaking`, `notch` or `allpass`; restore reports invalid saved values as issues. |
| `Phaser needs a baseFrequency that gives a finite sweep, got ….` / `Phaser needs octaves that give a finite sweep, got ….`    | A NaN or infinite `baseFrequency` or `octaves` (or one so large that `baseFrequency * 2 ** octaves` overflows) was written. The write is refused and the param keeps its value. | Pass finite numbers; the UI range is `baseFrequency` 20–10000 Hz and `octaves` 0–10.                                                             |
| `PitchShift needs a finite pitch in semitones, got ….`                                                                        | `pitch` was written as NaN or infinity. The write is refused and the param keeps its value.                                                                                     | Pass semitones; the UI range is -24..24.                                                                                                         |
| `Equalizer band count must match the constructed bank.`                                                                       | `setBands()` received a different number of bands than the Equalizer was constructed with.                                                                                      | Pass exactly one band per constructed filter; construct a new Equalizer to change the count.                                                     |
| `Equalizer frequency response arrays must have the same length.`                                                              | `getFrequencyResponse()` received `magnitudes` or `phases` whose length differs from `frequencies`.                                                                             | Allocate all three `Float32Array`s with the same length.                                                                                         |
| `SendBus: no receive named "<name>" — call define("<name>") first`                                                            | `receive(name)` or a send referenced a bus name that was never defined.                                                                                                         | Call `define(name)` on the `SendBus` before sending to or receiving from it.                                                                     |
| `Effect failed to load.`                                                                                                      | An effect's `ready` promise rejected with a value that is not an `Error`; `cells.error` holds this wrapper with the original as `cause`.                                        | Read `error.cause`; fix the load (URL, decode, worklet support) and call `load()` again where the effect has one.                                |
| `EffectChain: effect is already in the chain.`                                                                                | `add()` (or the constructor's list) received an effect instance the chain already holds.                                                                                        | Add each instance once; `move()` it instead, or construct a second effect.                                                                       |
| `EffectChain: effect is not in this chain.`                                                                                   | `remove()` or `move()` received an effect the chain does not hold.                                                                                                              | Pass an instance from `chain.cells.effects.value`.                                                                                               |
| `EffectChain restore was cancelled.` (`AbortError`)                                                                           | A newer restore, its job signal, or chain disposal cancelled pending preparation.                                                                                               | Ignore this cancelled load; the job signal leaves the chain alive. A newer request may still commit.                                             |
| `EffectChain is disposed.`                                                                                                    | `add`, `remove`, `move` or `restore` ran after `dispose()` or an aborted `signal`.                                                                                              | Build a new chain.                                                                                                                               |
| `Equalizer needs valid bands with frequency 20–20000 Hz, gain ±24 dB, and Q 0.1–20.`                                          | A band is outside the supported ranges.                                                                                                                                         | Supply one or more bands with values in the supported ranges.                                                                                    |
