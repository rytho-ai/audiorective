---
title: Blocks
---

`@audiorective/blocks` provides headless audio capture, range playback, sample hits, a step sequencer, a clip launcher and a sample library. A block owns behavior and state; widgets read that state and call its methods. Playback blocks need Web Audio, but no document, elements, renderer, or UI framework. MIDI recording and note data live in [MIDI and Piano Roll](./midi.md).

The package has no root entry. Each capability is a subpath that imports only `@audiorective/core`, so importing one never loads another:

| Subpath                          | Exports         | Kind                                                                                                                |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@audiorective/blocks/player`    | `WavePlayer`    | Standalone: give it an `AudioContext`                                                                               |
| `@audiorective/blocks/recorder`  | `AudioRecorder` | Standalone                                                                                                          |
| `@audiorective/blocks/samples`   | `SampleLibrary` | Standalone; previews through core `BufferPlayer`                                                                    |
| `@audiorective/blocks/pads`      | `PadBank`       | Standalone: bring your own `AudioBuffer`s                                                                           |
| `@audiorective/blocks/sequencer` | `StepSequencer` | Borrowing: needs a `BeatTiming` (`beatToTime`, `timeToBeat`) and a `trigger(hit)` that returns a `CancellableEvent` |
| `@audiorective/blocks/launcher`  | `ClipLauncher`  | Borrowing: needs a transport (`BeatTiming` plus `now`, `schedule`, `reset`)                                         |

`BeatTiming` and `CancellableEvent` are core contracts ([Core](./core.md#shared-contracts)); `Timeline`, `Clock` and `PadBank` satisfy them structurally, so a drum machine needs only `clock`, `blocks/sequencer`, `blocks/pads` and `core`. See [Architecture](./architecture.md).

## WavePlayer

`WavePlayer` loads audio, selects a range in the committed output timeline, and auditions it. Pass an optional borrowed offline stretch processor to render another duration while preserving pitch. It extends `AudioProcessor`, reuses core's `BufferPlayer`, and exposes `params.volume` with the standard `.value`, `$`, and scheduling methods. The caller supplies an `AudioContext`, routes its output, and destroys it when finished.

```typescript
import { WavePlayer } from "@audiorective/blocks/player";

const context = new AudioContext(); // or your existing context
const player = new WavePlayer(context);
player.output.connect(context.destination); // or your effects chain

try {
  await player.load("/audio/loop.wav");
  if (player.duration >= 2) player.setSelection({ start: 1, end: 2 });
} catch (error) {
  console.error(player.getState().error, error);
}

// From a user gesture:
// await player.audition(); // loop the selection
// player.pause();
// player.destroy(); // leaves context open
```

| Member                                                       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load(source: string \| File \| AudioBuffer): Promise<void>` | Stops playback, clears range/loop/position and replaces the source. URL and File are decoded with the supplied context. An AudioBuffer is borrowed without decoding or copying. Loading cancels any pending stretch and restores ratio 1. Only the latest load may update state; superseded loads settle without updating it. A current failure rejects and sets `error`.                                      |
| `buffer: AudioBuffer \| null`, `duration: number`            | Current committed playback buffer and output duration in seconds. Read them together through `version` when audio and peaks must agree.                                                                                                                                                                                                                                                                        |
| `setSelection(range: AudioRange \| null)`                    | Sets a defensive copy. Finite endpoints must satisfy `0 <= start < end <= duration`. Invalid edits leave state unchanged. Clearing disables looping. A stopped player stays stopped; a playing session follows the new bounds.                                                                                                                                                                                 |
| `getSelection(): AudioRange \| null`                         | Returns a copy of the authoritative selection.                                                                                                                                                                                                                                                                                                                                                                 |
| `play(options?: { when?: number }): Promise<number \| null>` | Resumes the supplied context, then starts or resumes within the current range (whole source without a range). At the end, the next play starts at the range start. `when` schedules the first sound; see [Scheduled start](#scheduled-start). Resolves with the effective start time, or `null` when the call started nothing. Context resume errors reject.                                                   |
| `attachSourceAutomation(binding): () => void`                | Borrows a core `AutomationBinding` in source seconds for non-looping playback. Starts, re-anchors and stops it with the player; the returned function detaches and stops it without destroying the binding or player. See [Source-time automation](#source-time-automation-on-a-selection).                                                                                                                    |
| `audition(): Promise<void>`                                  | Enables looping, seeks to the selected start and plays. No selection means no action.                                                                                                                                                                                                                                                                                                                          |
| `pause()` / `stop()`                                         | Pause holds position; stop resets to the selection start, or zero. Both cancel pending play requests.                                                                                                                                                                                                                                                                                                          |
| `seek(seconds)`                                              | Clamps finite seconds to the committed output duration. A playing session restarts within its bounds; a stopped session remains stopped.                                                                                                                                                                                                                                                                       |
| `setLooping(boolean)`                                        | Loops the selection, or the whole source. Changing this during playback cancels an obsolete scheduled stop.                                                                                                                                                                                                                                                                                                    |
| `position`, `isPlaying`, `isLooping`                         | Current output seconds and playback flags. `isPlaying` is the transport flag and always equals `cells.isPlaying`. Position follows the audio clock at the committed buffer's native playback speed.                                                                                                                                                                                                            |
| `cancelLoad(): void`                                         | Cancels the active load, clears progress without an error, and ignores late results. Idle calls preserve the committed version.                                                                                                                                                                                                                                                                                |
| `getState()`                                                 | Snapshot containing `duration`, copied `selection`, `position`, `isPlaying`, `isLooping`, `loading`, `loadProgress`, `error: string \| null`, `processing`, `stretchRatio`, `sourceDuration`, and `revision`.                                                                                                                                                                                                  |
| `subscribe(listener: () => void): () => void`                | Change notifications for source, selection, loading and playback, one per committed change; an effect over the cells, so it is also a thin wrapper over them. Returns unsubscribe. Does not call immediately or tick for clock-only position movement. Render once, subscribe for changes, and read `position` per animation frame when needed. A failing listener is logged without preventing other updates. |
| `destroy()`                                                  | Idempotently cancels loads, edits and play requests, stops/disconnects owned audio and releases buffers/listeners. It never destroys the borrowed stretch processor. Leaves the caller context open. Mutating a destroyed player throws `WavePlayer is destroyed.`                                                                                                                                             |

`AudioRange` is `{ start: number; end: number }`. `WavePlayerSource`, `WavePlayerState`, `WavePlayerOptions`, `WavePlayOptions`, `WaveStretchProcessor`, and `PlaybackVersion` are exported. Playback, selection, seek, and position use **committed output seconds**. Original source seconds remain available through `sourceDuration` and the mapping helpers below. With ratio 1 the timelines coincide.

### Scheduled start

`play({ when })` starts the sound at an absolute `AudioContext` time. For a source-time envelope, attach an [`AutomationBinding`](./automation.md#domain-adapters-and-waveform-composition) before playing so the player shares the effective start and handles edits:

```typescript
const detach = player.attachSourceAutomation(binding);
const when = context.currentTime + 0.1; // lookahead: leaves room for the context to resume
const started = await player.play({ when });
// started is the actual start time or null; the attachment schedules no envelope on null.
```

| Situation                                                 | Rule                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `when` omitted or already past when the start is issued   | Clamps to the current audio time, the same rule as `AutomationBinding`. `play()` awaits `context.resume()` first, so a near `when` can pass while it waits.                                                                                   |
| Resolved value                                            | The effective start time: `when` itself, or the clamped time. Anchor other schedules to this value, never to the requested one. A start at the requested future `when` is sample-accurate; a clamped start begins on the next render quantum. |
| Resolved `null`                                           | This call started nothing: no source, already playing or queued, or superseded before it resolved by any call that cancels or re-issues the start. Schedule nothing against it.                                                               |
| Before `when`                                             | The start is queued. `isPlaying`, `cells.isPlaying` and `getState().isPlaying` are already true, the output is silent, and `position` holds the start offset. It advances from `when`.                                                        |
| `play()` while queued                                     | No-op that resolves `null`. Pause or stop first to schedule a different time.                                                                                                                                                                 |
| `pause`, `stop`, `load`, a `setStretch` commit, `destroy` | Cancel the queued start; nothing sounds. Pause holds the start offset.                                                                                                                                                                        |
| `seek`, `setSelection`, `setLooping` while queued         | Keep the session and the same `when`. The start is re-issued from the new position and bounds, and a one-shot's end is measured from `when`. Only the re-issued start sounds.                                                                 |
| `when` is not a finite, non-negative number               | Rejects with `Start time must be finite, non-negative seconds.`                                                                                                                                                                               |

### Source-time automation on a selection

For a non-looping waveform selection with an `AutomationBinding` in original source seconds, attach the borrowed binding to the player. The player starts both on the same effective audio time and maps its output selection and committed stretch ratio into the binding's source-time range. No app operation token or copied selection state is needed.

```typescript
import { AutomationBinding, AutomationCurve, audioParamTarget } from "@audiorective/core/automation";

const envelope = new GainNode(context);
// Route the output through this envelope once; remove any direct destination connection.
player.output.connect(envelope);
envelope.connect(context.destination);
const curve = new AutomationCurve([
  { time: 0, value: 1, shape: "linear" },
  { time: player.sourceBuffer!.duration, value: 0, shape: "hold" },
]);
const binding = new AutomationBinding(context, curve, audioParamTarget(envelope.gain));
const detach = player.attachSourceAutomation(binding);

player.setSelection({ start: 1, end: 2 }); // output seconds
await player.play({ when: context.currentTime + 0.1 });
// curve.value = updatedPoints; // reprograms the remaining native automation
// Manual takeover: detach(); envelope.gain.value = 0.5;
// Cleanup: detach(); binding.destroy(); player.destroy(); envelope.disconnect();
```

The binding must use the player's exact `AudioContext`; the player borrows and stops it but never destroys it. Detaching stops automation and leaves playback running. Attach before playback or during a non-looping run; `setLooping(true)` and `audition()` are unavailable while a source binding is attached because a finite binding does not repeat over loops. Detach before manual target writes or changing the target. Curve edits remain live through `AutomationBinding` itself.

If selection changes while `play()` is still awaiting `context.resume()`, that play resolves `null` and starts neither sound nor automation. A selection edit after a future start has been queued reissues both at the same `when` with the new range. Starting a stretch edit cancels a queued start; an already-sounding run continues on its committed version until the stretch commits, then stops with its binding. Unattached WavePlayer playback keeps its normal behavior. See [Automation](./automation.md#domain-adapters-and-waveform-composition) for target adapters and manual control.

## Observing state reactively

`player.cells` holds the observable state, like every core processor: `selection`, `isLooping`, `isPlaying`, `loading`, `loadProgress`, `error`, `processing` and `version`. Each is a `ReadonlyCell<T>`. They are the only store; `getState()` and `subscribe()` are thin wrappers over them. Read `.value` (or call `$()`) inside an `effect`, a `computed`, or `useValue` from `@audiorective/react`, and the reader re-runs when the value changes. No subscription or manual teardown is involved beyond the effect's own.

```typescript
import { effect } from "@audiorective/core";

const stop = effect(() => {
  const { selection, loading, error } = player.cells;
  console.log(loading.value, selection.value, error.value);
});
// React: const loading = useValue(player.cells.loading);
```

The cells are read-only from outside: assigning `.value` is a type error and throws, and `$` takes no argument. Change state through the owner's methods (`setSelection`, `setLooping`, `load`, `cancelLoad`, `setStretch`, `play`, `pause`). An operation that changes several fields commits them as one batch, so an effect sees one coherent state, never a half-applied one: a finished load updates `version`, `selection`, `looping`, `loading`, `loadProgress` and `error` together, and a finished stretch updates `version`, the scaled `selection` and `processing` together. Calling owner methods inside an effect does not subscribe that effect to the state those methods read.

The reading methods are tracked too: `getState()`, `getSelection()`, `isLooping`, `isPlaying` and `version` re-run an effect that calls them. `buffer`, `duration` and `sourceBuffer` are tracked too and change together with `version`. The time-mapping helpers `sourceToOutput` and `outputToSource` are plain calculations that never subscribe an effect; an effect that only uses them reads `cells.version.value` first so it follows source replacement and stretch.

`cells.isPlaying` follows the transport: it turns true when a start is issued, including one queued for a future `when`, and false when playback stops. `position` is derived from the audio clock and stays a plain getter; read it per animation frame instead of observing it. `volume` is `params.volume`, a standard `SchedulableParam`.

## Loading state, progress and cancellation

`getState().loading` covers the whole source load. `loadProgress` is an immutable snapshot:

```typescript
type WaveLoadProgress = { phase: "download" | "read"; loadedBytes: number; totalBytes: number | null } | { phase: "decode" } | { phase: "peaks" };
```

URL streams report `download`; File streams report `read`. `totalBytes: null` means the size is unknown, including encoded HTTP bodies whose Content-Length describes compressed bytes. Show the bytes received and an indeterminate indicator. A trustworthy positive total supports a download fraction; decode and peaks have no percentage. Peaks reduction is synchronous: subscribers observe its phase, but the browser need not paint it before completion. An AudioBuffer skips I/O and decode.

Progress is `null` when idle and briefly before a custom adapter reports its first phase. Successful load, failure, `cancelLoad()` and destruction clear it. `processing` remains the separate stretch-render state. `subscribe` includes phase and byte changes; it does not emit an initial snapshot:

```typescript
const render = () => {
  const { loading, loadProgress, error } = player.getState();
  console.log({ loading, loadProgress, error });
};
render();
const unsubscribe = player.subscribe(render);
// In the cancel button handler: player.cancelLoad();
// On observer cleanup: unsubscribe();
```

Cancellation or replacement prevents stale progress/results from updating the block. A superseded/cancelled `load` settles without publishing an error; inspect the current state rather than treating every resolution as a successful commit. Web Audio decoding already in progress cannot be interrupted; its result is ignored. Cancellation cannot interrupt synchronous peaks work once it has started. Current failures reject and populate `error`; retry with `load`.

### Reusing an existing URL/decode cache

`WavePlayerOptions.loadSource?: WaveSourceLoader` replaces **URL** loading; File inputs use the built-in loader. The adapter receives `(url, { context, signal, onProgress })` and returns `Promise<AudioBuffer>`. It reports actual `download`/`read` or `decode` phases through `onProgress`; the block owns the `peaks` phase, loading/error state, version commit and stale-result guards. A decoded cache hit can return its buffer without reporting artificial I/O phases. The buffer is borrowed and must be treated as immutable.

Detach this waiter's progress observers when `signal` aborts or the adapter settles. Shared cache work may continue for other readers; cancellation does not require aborting their request. Byte reports require non-negative safe integers, `totalBytes: null` or a total at least as large as `loadedBytes`. Invalid progress rejects the current load. `WaveLoadProgress` and `WaveSourceLoader` are exported from `@audiorective/blocks/player`.

Built-in HTTP loading rejects unsuccessful responses, text/SPA fallback content, and known-length transfers whose actual bytes do not match Content-Length. These failures clear loading/progress and permit retry; decoding errors retain the browser's message.

## Committed versions and offline stretch

Construct `new WavePlayer(context, { stretch })` with any structural `WaveStretchProcessor` exposing `process(input: PCMData, options: { ratio: number; signal?: AbortSignal }): Promise<PCMData>`. The player borrows that processor; the application owns its lifetime. A custom processor must leave the borrowed source PCM unchanged. [`TimeStretch`](./effects.md#timestretch) implements this interface and takes private copies before processing.

`sourceBuffer: AudioBuffer | null` keeps the original loaded buffer. Treat its channel data as immutable while loaded. `version: PlaybackVersion | null` publishes one committed revision:

```typescript
interface PlaybackVersion {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly buffer: AudioBuffer;
  readonly peaks: import("@audiorective/core/peaks").PeakSummary;
  readonly ratio: number;
}
```

The metadata object is frozen. Its borrowed buffer and peak arrays are read-only by contract, rather than deeply frozen. `revision` increases on every committed load or edit; `sourceRevision` identifies the source across its edits. `ratio` is the requested duration ratio; actual output duration uses a whole-frame `Math.round(sourceBuffer.length * ratio)` target. Read `version.buffer` and `version.peaks` together for matching audio and display data.

`await player.setStretch(ratio)` always processes the original source, so successive ratios do not compound. While it runs, `processing` is true and the old version remains playable and visible. A current failure rejects, sets `error`, and preserves the version, selection, position and playback. A newer edit cancels the older signal; stale results or failures settle without publication. Loading another source or destroying the player also cancels pending edits.

A successful edit commits audio and peaks together, stops playback, and scales selection and held position by the new duration divided by the previous duration. Loop mode is retained. Call `play()` or `audition()` from a user gesture to start the committed version. `setStretch(1)` restores the original buffer without invoking a processor. Ratios must be finite and positive; edits require a loaded source, and ratios other than 1 require a processor.

`sourceToOutput(seconds)` and `outputToSource(seconds)` map uniformly between the original and committed timelines using their actual durations. They clamp finite input to the relevant duration, return zero without a source, and reject nonfinite time. This is uniform offline editing, with no seamless live warp or arbitrary warp-marker map.

| Error                                          | Fix                                                                                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Stretch ratio must be finite and positive.`   | Supply a finite ratio greater than zero.                                                                                                                                                        |
| `No audio source is loaded.`                   | Await a successful load before editing.                                                                                                                                                         |
| `WavePlayer needs a stretch processor.`        | Supply `{ stretch }` at construction for a ratio other than 1.                                                                                                                                  |
| `Stretch processor returned incompatible PCM.` | Return the original sample rate and channel count, with exactly the rounded target frames in every channel. Samples must also satisfy the [PCM summary contract](./core.md#pcm-peak-summaries). |
| `Time must be finite seconds.`                 | Pass finite time to the mapping helpers.                                                                                                                                                        |

## Compose offline stretch and a selector

This browser example uses a WASM URL hosted by the application. The file must implement the compatible C ABI; Audiorective does not supply it. Call playback methods from a user gesture.

```typescript
import { TimeStretch } from "@audiorective/effects/time-stretch";
import { WavePlayer } from "@audiorective/blocks/player";
import { mountWaveformSelector } from "@audiorective/widgets";

async function createEditor(context: AudioContext, root: HTMLElement, wasmURL: string) {
  const response = await fetch(wasmURL);
  if (!response.ok) throw new Error(`WASM request failed: HTTP ${response.status}`);
  const module = await WebAssembly.compile(await response.arrayBuffer());
  const stretch = new TimeStretch(module);
  const player = new WavePlayer(context, { stretch });
  const gain = new GainNode(context, { gain: 0.8 });
  player.output.connect(gain);
  gain.connect(context.destination);
  let selector: ReturnType<typeof mountWaveformSelector>;
  try {
    selector = mountWaveformSelector(root, { player });
  } catch (error) {
    player.destroy();
    stretch.destroy();
    gain.disconnect();
    throw error;
  }

  return {
    player,
    async load(source: string | File) {
      try {
        await player.load(source);
      } catch (error) {
        console.error(player.getState().error, error);
        throw error;
      }
    },
    async setStretch(ratio: number) {
      await player.setStretch(ratio); // returns after the coherent commit
    },
    destroy() {
      selector.destroy(); // detach every view before its shared owner
      player.destroy();
      stretch.destroy(); // player does not destroy this borrowed processor
      gain.disconnect();
      // context remains open for the application
    },
  };
}

const context = new AudioContext(); // or the application's existing context
let editor: Awaited<ReturnType<typeof createEditor>> | undefined;
try {
  editor = await createEditor(context, document.querySelector<HTMLElement>("#waveform")!, "/assets/rubberband.wasm");
  await editor.load("/audio/loop.wav"); // a File can be passed here too
  await editor.setStretch(1.5);
} catch (error) {
  console.error("Module loading, audio loading or rendering failed", error);
}
// From a file-input handler: await editor?.load(input.files![0]);
// From a play-button handler: await editor?.player.play();
// On unmount: editor?.destroy();
```

URL loading follows browser CORS rules; URL fetch and File decode failures reject and appear in player/selector error state. Catch module-fetch and compilation errors when calling `createEditor`; module hosting is separate from loading the audio source.

## Share a block between widgets

```typescript
import { WavePlayer } from "@audiorective/blocks/player";
import { mountWaveformSelector } from "@audiorective/widgets";

const context = new AudioContext();
const player = new WavePlayer(context);
player.output.connect(context.destination); // route once, even with two views
await player.load("/audio/loop.wav");

const first = mountWaveformSelector(document.querySelector<HTMLElement>("#first")!, { player });
const second = mountWaveformSelector(document.querySelector<HTMLElement>("#second")!, { player });
if (player.duration >= 1) player.setSelection({ start: 0.1, end: 1 });

first.destroy(); // player and second view remain usable
// Later: second.destroy(); player.destroy();
```

Loading through either view replaces the shared source. Each view keeps its own zoom, scroll, renderer, snap policy and plugin resources; audio and selection have one owner. Shared outputs are identical: route `player.output` once to avoid doubling the signal.

The [pure waveform selection plugin](./widgets.md#selection-plugin-api) can use `model: player` without importing audio into the pure view entry. An application can supply any structural model implementing `getSelection()`, `setSelection()` and `subscribe()`. Detaching a view does not clear an external model.

See [Core](./core.md#pcm-peak-summaries) for pure PCM summaries, [TimeStretch](./effects.md#timestretch) for offline DSP, and [Widgets](./widgets.md) for visual plugins, custom drawing and snapping.

## Record an audio take

`AudioRecorder` captures PCM from a borrowed Web Audio input at sample-frame positions on the caller's `AudioContext`. It is a headless block with an `input` node and **no audible output**. The caller obtains permission, creates and connects the source, routes monitoring separately, and owns the source and context lifetime. The recorder does not create a `MediaStream` or decide where a take belongs in a track.

```typescript
import { AudioRecorder } from "@audiorective/blocks/recorder";

const context = new AudioContext();
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const microphone = context.createMediaStreamSource(stream);
const recorder = new AudioRecorder(context, { channels: 1 });
microphone.connect(recorder.input);
await context.resume();
await recorder.ready; // preload before a precise transport start
await recorder.start({ when: context.currentTime + 0.1 });
// Later, from the stop control:
const take = await recorder.stop();
// take.channels, sampleRate, startFrame/endFrame and startTime/endTime are ready for the clip owner.
microphone.disconnect(recorder.input);
recorder.destroy();
stream.getTracks().forEach((track) => track.stop());
await context.close();
```

`start({ when? })` and `stop({ when? })` use absolute AudioContext seconds. `start` awaits AudioWorklet registration; if the requested start is already past when the worklet receives it, capture begins at the first available frame. `stop` requires a time after the requested start and resolves after the worklet sends the final PCM chunk. The result reports **actual** inclusive `startFrame` and exclusive `endFrame`; divide by `sampleRate` for `startTime` and `endTime`. Each channel's `Float32Array` has exactly `endFrame - startFrame` samples. The caller may edit or transfer the returned sample arrays. A take with no captured frames rejects rather than masquerading as aligned silence.

`cells.state` is a read-only reactive `"idle" | "armed" | "recording" | "stopping" | "destroyed"` value; `cells.error` reports the last failed take and clears on a new start. Only one take may be active at a time; after `stop` settles or `cancel()` discards a take, another `start` can reuse the recorder. Cancelling a pending `stop` rejects it with `AbortError`. Closing a live AudioContext during capture fails the take. `destroy()` ends an active take, disconnects only recorder-owned graph edges and leaves borrowed sources, streams and context running. The private worklet reaches the destination through a zero-gain sink so it processes input without adding to caller monitoring.

The result preserves the audio clock's raw sample positions. A Track/Clip owner places takes against transport time and applies any measured input/monitor latency adjustment; the recorder does not guess a round-trip offset. Normal `start()`/`stop()` accumulates PCM in memory and suits short takes. For long captures, call `startStream(writeChunk, { when? })` and `stopStream({ when? })` instead. The callback receives ordered `{ startFrame, channels }` chunks, each with up to 4096 frames, and writes them to caller-owned storage. `stopStream()` waits for accepted writes and returns `{ channelCount, sampleRate, startFrame, endFrame, startTime, endTime }` without returning the full PCM. When the browser skips a short render interval, the result includes `dropouts` with absolute frame ranges and the skipped samples become silence; a gap longer than two seconds rejects. Check `dropouts` before treating a take as lossless. At most 64 pending writes are allowed; a slower writer fails the take instead of growing the recorder's queue without bound. The callback owns any external file or database and must preserve chunk order when writes complete asynchronously. `@audiorective/daw/project` provides `AudioMediaWriter` and `Project.addAudioMediaClip` to turn these chunks into file-backed, editable project clips; see [DAW project and runtime](./daw.md#long-audio-takes-and-media-ownership). AudioWorklet registration uses a Blob URL and needs compatible Content Security Policy settings. `MediaRecorder` can still be suitable for a simple voice memo, but its chunk intervals are not the alignment contract used here.

## Pad Bank

`PadBank` plays sample hits and owns reversible same-group choke policy. Use it when a sequencer can edit or cancel a hit after the Clock has scheduled it, or when a future closed-hat hit must choke an open-hat hit only if that closed hit still exists. Ordinary one-shot pads without choke can keep using core `Sampler` and `Voice`.

```typescript
import { PadBank } from "@audiorective/blocks/pads";

const instruments = new PadBank(context, [
  { id: "open-hat", buffer: openHat, group: "hat", gate: true },
  { id: "closed-hat", buffer: closedHat, group: "hat" },
]);
instruments.output.connect(context.destination);
instruments.routePad("open-hat", hatFilter); // optional: this pad feeds `hatFilter` instead of the bank output; hatFilter is a node you own
const manual = instruments.trigger("open-hat"); // caller owns this event
const queued = instruments.trigger("closed-hat", 1, context.currentTime + 0.2);
queued?.cancel(); // removes both the hit and its future choke; manual keeps sounding
// Later: manual?.cancel(); instruments.destroy(); context.close();
```

```typescript
type PadSpec = Readonly<{ id: string; buffer: AudioBuffer; group?: string; gate?: boolean }>;
class PadBank {
  constructor(context: BaseAudioContext, pads: readonly PadSpec[]); // an OfflineAudioContext works
}
```

Pad IDs must be nonempty and unique. `group` names the choke group; `gate` is described below.

`trigger(id, velocity = 1, when = context.currentTime, options?: { pitch?: number; duration?: number })` returns an `PadHit` with idempotent `cancel()` / `stop()` and `onEnded(listener)`, or `null` for an unknown pad ID. Velocity clamps to 0..1; a past `when` plays now. `options.pitch` is in semitones and sets the playback rate to `2 ** (pitch / 12)`. `options.duration` (seconds) applies only to `gate: true` pads: the gate closes at `when + duration`, retractably like choke, so cancelling the hit before then keeps the earlier close from applying; one-shot pads ignore it and play to the end of their buffer. Later hits with a **different ID** in the same `group` choke earlier hits at their native audio start time, even if the later hit was scheduled first. Hits of the same ID may overlap.

**`gate` and choke.** Choke does not need `gate`: a later hit of another pad in the same `group` cuts an earlier hit whether the earlier pad is a one-shot (`gate` omitted or `false`) or a gate pad, so a one-shot open hat is choked by a later closed hat. `gate` changes what the hit does when nothing chokes it. A one-shot plays its buffer once and ends at the buffer's end; `options.duration` is ignored. A `gate: true` pad loops its buffer for as long as the gate stays open, until the hit is cancelled, choked, or closed by `options.duration`; pass a `duration` from the sequencer, or the hit never ends by itself. Use `gate: true` for sustained sounds (an open hat held until the next hit, a pad that must stop at the step length) and leave it off for drum one-shots.

Choke is carried by a per-event gain gate, so cancelling an unstarted hit retracts its future choke. A choke that already reached its deadline stays committed and cannot resurrect an earlier sound. The cleanup timer retires silent nodes; it does not time the audible cutoff.

**Per-pad routing.** Each pad owns a gain node that feeds the bank `output`. `routePad(id, destination: AudioNode | null)` sends that pad to a node you own instead (a filter, a send), and `routePad(id, null)` sends it back to `output`. Choke acts before the routing, so two pads in one `group` can feed different effects and still cut each other. A routed pad bypasses `params.volume`, which scales only the bank `output`. The bank owns its pad nodes and edges; you own every destination. `destroy()` disconnects only the bank's own nodes and leaves a destination connected to the rest of your graph. An unknown pad ID throws `Unknown pad.`

`assign(id, buffer)` replaces that pad's buffer, cancels its current and future hits, and retracts their future choke. `stopAll()` cancels every hit. `cells.activeEvents` is a read-only reactive count and `cells.pads` is the read-only list of current pad specs, which changes on `assign`; `params.volume` follows the normal schedulable `.value` / `$` contract. The block owns its nodes and event handles, while the caller owns output routing and the `AudioContext`. It has no polyphony cap or voice-stealing policy. For Clock-owned sequenced hits, pass the handle to `window.own(hit, when)` and call `clock.refresh()` after pattern edits (or let `refreshOnEdit` do it, see [Step Sequencer](#step-sequencer)); manual hits remain unregistered. See [Clock](./clock.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).

## Step Sequencer

`StepSequencer` owns an editable looping pattern: per-lane length, rate, direction and swing, per-step velocity, offset, length, repeat, pitch and chance, and any numbers you declare per step. It borrows a beat transport and an instrument trigger and imports only `@audiorective/core`.

```ts
type StepRate = "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "1/64" | "1/2T" | "1/4T" | "1/8T" | "1/16T" | "1/32T" | "1/64T";
type StepDirection = "forward" | "backward" | "bounce";
type StepCell = { velocity; offset; length; repeat; pitch; chance; custom: Readonly<Record<string, number>> };
type StepLane = { id; label; steps; rate; direction; swing; mute; solo; cells: readonly StepCell[] };
type StepPattern = { size: number; lanes: readonly StepLane[] };
new StepSequencer(pattern: StepPatternInput, trigger: (hit: StepHit) => CancellableEvent | null, options?: { random?: () => number; params?: readonly StepParamSpec[]; transforms?: readonly StepTransform[] });
```

`size` is the loop length in 1/16 steps (integer 1..128, so the loop lasts `size / 4` beats). Input is partial and filled with defaults: a lane gets `label = id`, `steps = size`, `rate = "1/16"`, `direction = "forward"`, `swing = 0`, `mute`/`solo` false and every cell off; a cell gets `velocity 0`, `offset 0`, `length 1`, `repeat 1`, `pitch 0`, `chance 1` and `custom` set to each declared param's default (`{}` without `params`). Every lane always holds `size` cells; cells beyond its `steps` are kept but not played.

| Cell field | Range           | Meaning                                            |
| ---------- | --------------- | -------------------------------------------------- |
| `velocity` | 0..1            | 0 turns the step off                               |
| `offset`   | -0.5..0.5       | shift of the hit, as a fraction of one lane step   |
| `length`   | 1/16..4         | hit duration in lane steps (divided among repeats) |
| `repeat`   | integer 1..8    | hits evenly spaced inside the step                 |
| `pitch`    | integer -24..24 | semitones, passed to the trigger                   |
| `chance`   | 0..1            | probability that the step plays                    |

The ranges are data, in one place. `sequencer.cellParams` (also exported as `stepCellParams`) lists these six fields as `readonly StepParamSpec[]` in the order above, as core `ParamSpec`s, the same `{ id, label, min, max, default, step }` shape as a custom param (`step` is the editing hint; `repeat` and `pitch` are enforced as integers). `sequencer.rates` (also `stepRates`) lists the twelve `StepRate`s in display order, straight 1/2 to 1/64 then the triplets. Validation and views read the same constants, so a view needs no copy of them.

Lane fields: `steps` (integer 1..`size`, the lane's own length, so lanes of different lengths drift against each other), `rate` (a `StepRate`; straight 1/2 = 2 beats down to 1/64 = 1/16 beat, and a `T` rate is two thirds of the straight one), `direction`, `swing` (0..1; the `stepSwing` transform delays every odd lane step by `swing * 0.5` lane steps, a fixed beat offset at any tempo), `mute` and `solo`.

**Timing.** Every lane restarts at each loop boundary, measured from beat 0 of the timing; a lane whose rate does not divide the loop is cut off at the loop end. With `k` the lane step counter in the loop, the played cell is `k mod steps` going forward, `steps - 1 - (k mod steps)` backward, and a ping-pong without repeating the end cells for `bounce` (`0 1 2 1 0 1 ...` for 3 steps; a 1-step lane stays on cell 0). A hit starts at beat `loopStart + k * rate`, plus `offset * rate`, then the transforms run in beats (by default `stepSwing` adds swing); the result is converted to seconds through the timing and a start already in the past plays at the window's current time. A step with `repeat = r` plays `r` hits at `i * rate / r` and each lasts `length * rate / r` beats. A lane plays when it is not muted and either no lane is soloed or it is soloed. A step plays when `velocity > 0` and `random() < chance`; the draw happens once per step, so all repeats of a step play or none do. Pass `options.random` for deterministic tests.

The trigger receives a `StepHit` and returns a `CancellableEvent` (`cancel()` and `onEnded()`) or `null`; a `PadHit` is one.

```ts
type StepEvent = TimedBeatEvent & {
  // beat, durationBeats, velocity (core): where the hit sounds and how long, in beats, after offset and repeat
  laneId: string;
  step: number; // cell index
  count: number; // the lane's step counter k within the loop
  stepBeat: number; // beat of the lane step boundary (before offset and repeat)
  rateBeats: number;
  swing: number; // the lane's swing value
  pitch: number;
  custom: Readonly<Record<string, number>>;
  loop: number; // floor(stepBeat / loopBeats): loops since timing beat 0
  repeatIndex: number;
  repeatCount: number;
};
type StepHit = SecondsOf<StepEvent>; // the same fields with beat -> when and durationBeats -> duration
```

`StepEvent` is what transforms read and return. `StepHit` is what the trigger receives: final, after the transforms and the clamp to the window's current time.
On a `StepHit`, `when` is absolute audio-context seconds and `duration` is seconds. `loop` supports conditional triggers such as "every 2nd loop" (`hit.loop % 2 === 0`) without the block knowing about them.

The trigger can delegate to `PadBank.trigger(id, velocity, when, { pitch, duration })`. The sequencer tracks and cancels only events returned by that callback. Use a separate call to the instrument for manual hits.

`schedule(window, timing)` reads the caller's transport window and registers its hits via `window.own(event, when)`. `timing` is any `BeatTiming`; pass the same `Timeline` the window came from.

`schedule` takes a `StepWindow`, a structural subset of the clock's tick window, so you can pass the real window or a hand-built one:

```typescript
type StepWindow = Readonly<{
  beat: { start: number; end: number }; // beats this call may schedule
  time: { current: number }; // audio time hits are clamped to
  own(event: CancellableEvent, when: number): void; // registers each hit for cancel
}>;
```

**Edits and the look-ahead.** The clock has already scheduled the next window when you edit, so an edit applies to later windows unless the look-ahead is rebuilt. `refreshOnEdit(sequencer, transport)` does that: it calls `transport.refresh()` once per committed change of `pattern` or `transforms` (a `batch` counts once) and returns a disposer. `Clock.refresh()` cancels owned hits at once but refills in a microtask, and repeated calls in one task share that refill, so any number of edits in the same task rebuild the look-ahead once.

```ts
import { refreshOnEdit } from "@audiorective/blocks/sequencer";

const stopRefresh = refreshOnEdit(sequencer, clock); // `transport` is anything with refresh(), such as a Clock
sequencer.setCell("closed", 4, { velocity: 0 }); // the queued look-ahead is rebuilt without a manual refresh()
stopRefresh(); // before the clock is destroyed
```

Each `setCell`, `toggle`, `setLane` or `setTransforms` call outside a `batch` is its own commit, so effects watching the pattern run once per call. The look-ahead refill is coalesced either way. To change many cells at once, such as filling a Euclidean pattern, wrap them in core's `batch` so observers (a grid, a counter) see one coherent change:

```ts
import { batch } from "@audiorective/core";

batch(() => {
  for (let step = 0; step < 16; step++) sequencer.setCell("kick", step, { velocity: hits[step] ? 1 : 0 });
});
```

It does not refresh on attach, and calling it inside an effect does not subscribe that effect. [The DAW runtime](./daw.md#step-sequencer) already uses it for an attached pattern.

### A pattern as a switchable clip

To start and stop a pattern on a launch boundary, make one `StepSequencer` per launch and give it a window and timing shifted so its beat 0 is the launch beat. Clip the window to the clip's beat range so it never schedules outside it.

```ts
// In the Clock's onTick; startBeat is the launch boundary, endBeat the stop boundary (or Infinity).
const start = Math.max(window.beat.start, startBeat);
const end = Math.min(window.beat.end, endBeat);
if (start < end) {
  sequencer.schedule(
    {
      beat: { start: start - startBeat, end: end - startBeat }, // pattern-local beats
      time: window.time,
      own: (event, when) => window.own(event, when),
    },
    {
      beatToTime: (local) => timeline.beatToTime(local + startBeat),
      timeToBeat: (time) => timeline.timeToBeat(time) - startBeat,
    },
  );
}
```

The pattern plays from step 0 at `startBeat` whatever the transport position was. To stop it, call `sequencer.reset()` to cancel its pending hits and stop calling `schedule`. Drive `startBeat` and `endBeat` from a [Clip Launcher](#clip-launcher) transition, or from your own state.

**A re-queue calls the trigger again.** `refresh()`, `reset()`, stop and seek cancel every owned hit that has not ended and the next window builds the hits again, so the trigger runs again for every still-pending hit, not only the edited one. Keep the trigger free of state that a cancel cannot undo: do not count hits in it, and do not leave behind scheduling on a node you own (a filter cutoff, a send level). Derive counts from the pattern, not from trigger calls. To retract extra scheduling, wrap the event with core's `withCancel(event, undo)`: its `cancel()` cancels the event and runs `undo` once.

```ts
import { withCancel } from "@audiorective/core";

const sequencer = new StepSequencer(
  pattern,
  ({ laneId, velocity, when, duration, custom }) => {
    const hit = bank.trigger(laneId, velocity, when, { duration });
    filter.frequency.setValueAtTime(200 * 2 ** (custom.cutoff * 6), when); // extra scheduling, so retractable
    return withCancel(hit, () => filter.frequency.cancelScheduledValues(when));
  },
  { params: [{ id: "cutoff", min: 0, max: 1, default: 0.5 }] },
);
```

`cancelScheduledValues(when)` drops that value and every later one on the param, which is right because the look-ahead is rebuilt together. `undo` runs once, and not for an event that already ended on its own. When the trigger returns `null` for an unknown pad, `withCancel(null, undo)` still gives the sequencer a handle to cancel.

**State and commands.** `pattern` is a read-only reactive cell of the `StepPattern`; `transforms` is a read-only cell of the transform list; `playheads` is a read-only cell of `Record<laneId, cellIndex | null>` (the cell each lane is on at the window's current time) and `loopProgress` is a read-only cell of the 0..1 loop position or `null`. Only the sequencer writes them. Commands:

- `setCell(laneId, step, patch)` changes any subset of one cell's fields in one write.
- `toggle(laneId, step)` turns an off cell on at velocity 1 and an on cell off; its other fields are kept.
- `setLane(laneId, patch)` changes any of `label`, `steps`, `rate`, `direction`, `swing`, `mute`, `solo`.
- `setSize(size)` truncates or pads every lane's cells with off cells and clamps each lane's `steps` to the new size.
- `setTransforms(list)` replaces the transform list in one write (see below).
- `reset()` cancels pending events and sets every playhead and `loopProgress` to `null`.

### Custom per-step parameters

The six built-in cell values affect timing, so the sequencer understands them. Anything else is caller data: declare it once and the sequencer stores, validates and passes it to the trigger.

```ts
const sequencer = new StepSequencer(pattern, ({ custom, when, laneId }) => /* set a filter from custom.cutoff at `when` */ null, {
  params: [{ id: "cutoff", label: "Cutoff", min: 0, max: 1, default: 0.5, step: 0.01 }], // StepParamSpec, an alias of core ParamSpec
});
sequencer.params; // the declared specs, read-only and fixed at construction
sequencer.setCell("kick", 0, { custom: { cutoff: 0.4 } }); // partial merge; other custom ids keep their values
```

Ids must be unique, nonempty, differ from the built-in cell keys and from `custom`, with `min < max` and `default` inside the range. Every cell carries `custom` with exactly the declared ids. `setCell` and the constructor reject undeclared ids and values outside `min..max`; `step` is a hint for views and is not enforced.

### Transform sockets

New expressive behaviour plugs in as a `StepTransform` (an `EventTransform<StepEvent>`, a core contract, see [Core](./core.md#shared-contracts)) instead of growing the block. After the sequencer has computed a window's hits it runs the `transforms` in array order over them, converts the result to seconds, then triggers every hit.

A transform works in beats by default: it reads and returns `StepEvent`s with `beat` and `durationBeats`, so moves are tempo-independent beat arithmetic. A transform that sets `unit: "second"` reads and returns the same hits as seconds (`when`, `duration`); the sequencer converts through the timing before it and back to beats after it.

```ts
import { defaultStepTransforms, stepSwing, StepSequencer, type StepTransform } from "@audiorective/blocks/sequencer";

// Beat transform: push odd lane steps late by a sixteenth of a beat, whatever the tempo.
const lazy: StepTransform = {
  id: "lazy",
  apply: (hits) => hits.map((hit) => (hit.count % 2 ? { ...hit, beat: hit.beat + 0.0625 } : hit)),
};

// Seconds transform: humanize each hit by up to 5 ms either way.
const humanize: StepTransform = {
  id: "humanize",
  unit: "second",
  apply: (hits, { random }) => hits.map((hit) => ({ ...hit, when: hit.when + (random() - 0.5) * 0.01 })),
};
sequencer.setTransforms([...defaultStepTransforms, lazy, humanize]); // keep swing, add mine
```

`defaultStepTransforms` is `[stepSwing()]`, and it is the default for the `transforms` option. `stepSwing()` (`id: "step-swing"`) delays hits whose `count` is odd by `swing * 0.5 * rateBeats` beats, so swing stays a fixed beat offset when the tempo changes. Passing `transforms: []` or a list without it makes every lane's `swing` inert and gives straight timing.

Rules the sequencer enforces and never leaves to the transform:

- Transforms run in array order on each window's hits, before anything is triggered. The hits are converted between beats and seconds only where consecutive transforms differ in `unit`.
- `context.now` is the window's current time in the transform's unit (beats for a beat transform, seconds for a seconds transform).
- After the last transform the hits are converted to seconds through the timing, and a hit earlier than the window's current time plays at that time. The trigger never sees a `when` before it.
- A returned hit with a non-finite `beat` (`when` in a seconds transform), a `durationBeats` (`duration`) that is not above 0, or a `velocity` outside 0..1 throws an error that names the transform `id`; so does a `unit` other than `"beat"` or `"second"`. `velocity` 0 drops the hit.
- A transform never triggers or cancels audio. The sequencer triggers every returned hit and owns it with `window.own`, so `reset()`, stop and seek still retract added hits.
- A transform keeps no hidden state across windows: what it needs (beat, loop, lane data) is on the hit. Randomness comes only from `context.random`, the sequencer's injectable `random` option.

Chance, repeat, offset, mute/solo, direction and polymeter stay built in. `setTransforms` is a command like the others: it changes the `transforms` cell once and never subscribes a calling effect. Call the clock's `refresh()` afterwards to rebuild the unplayed look-ahead.

A `StepSequencer` holds no nodes, timers or effects, so `reset()` releases everything it owns and there is no `destroy()`. The commands, `schedule` and `reset` never subscribe an effect that calls them. [The DAW runtime](./daw.md#step-sequencer) wires the scheduling and refresh for an attached pattern.

### Standalone drum machine

A vanilla drum machine with no DAW: your decoded buffers, a `Clock` driving the sequencer, and the step grid for editing. Closed and open hat share a choke `group`, so each pad ID doubles as its lane ID. To give the two hat lanes separate effects, call `bank.routePad("open", openFilter)` and `bank.routePad("closed", closedFilter)`: choke still crosses them.

```ts
import { Clock, Timeline } from "@audiorective/clock";
import { PadBank } from "@audiorective/blocks/pads";
import { refreshOnEdit, StepSequencer, type StepPatternInput } from "@audiorective/blocks/sequencer";
import { mountStepGrid } from "@audiorective/widgets";

const context = new AudioContext(); // you own it; resume() it from a user gesture
// kick, snare, closedHat, openHat: AudioBuffers you decoded yourself
const bank = new PadBank(context, [
  { id: "kick", buffer: kick },
  { id: "snare", buffer: snare },
  { id: "closed", buffer: closedHat, group: "hat" },
  { id: "open", buffer: openHat, group: "hat" }, // a one-shot (no gate) is still choked by a later closed hit
]);
bank.output.connect(context.destination);

const steps = (...on: number[]) => Array.from({ length: 16 }, (_, step) => ({ velocity: on.includes(step) ? 1 : 0 }));
const pattern: StepPatternInput = {
  size: 16, // sixteenth notes; lanes default to 1/16 and 16 steps
  lanes: [
    { id: "kick", label: "Kick", cells: steps(0, 4, 8, 12) },
    { id: "snare", label: "Snare", cells: steps(4, 12) },
    { id: "closed", label: "Closed hat", cells: steps(0, 4, 8, 12) },
    { id: "open", label: "Open hat", cells: steps(2, 10) },
  ],
};
const sequencer = new StepSequencer(pattern, ({ laneId, velocity, when, pitch, duration }) =>
  bank.trigger(laneId, velocity, when, { pitch, duration }),
);
const timeline = new Timeline({ audioContext: context, bpm: 120 });
const clock = new Clock({ timeline, onTick: (window) => sequencer.schedule(window, timeline) });
const stopRefresh = refreshOnEdit(sequencer, clock); // every edit re-queues the look-ahead
const grid = mountStepGrid(document.querySelector("#grid")!, { sequencer }); // click toggles; drag a cell or use the arrow keys to edit the active parameter

await context.resume();
clock.start(); // clock.stop() ends playback and cancels queued hits
timeline.bpm.value = 140; // takes effect on the next look-ahead window

// Edits in the grid or code re-queue the look-ahead at once.
// A deleted closed-hat step that has not played yet no longer chokes the open hat.
sequencer.setCell("closed", 4, { velocity: 0 });

// Teardown: the caller keeps the AudioContext.
grid.destroy();
stopRefresh();
clock.destroy();
bank.destroy();
```

`TickWindow` already has the `beat`, `time` and `own` shape `schedule()` reads, and `Timeline` is the `BeatTiming`. The same wiring runs in `packages/blocks/tests/drum-machine-doc.browser.test.ts`.

## Sample Library

`SampleLibrary` owns queued File decoding, byte accounting and an audition voice built on core `BufferPlayer`. Create it with the caller's `AudioContext`, connect `library.output` to an audition route and pass Files to `importFiles(files)`. The result contains row IDs in input order. A removed pending import resolves to `null`. Inspect `library.state.value.rows` for per-file readiness and decoding errors. `state` is the only store of rows, `decodedBytes`, `previewId` and `previewPlaying`; each change commits in one write. `preview(id)` is safe to call from inside an effect.

In a secure browser context, identical file bytes share a row based on a content hash even when the names differ. Import is sequential. The default file limit is 64 MiB and the default retained PCM limit is 256 MiB. Pass `maxFileBytes` and `maxDecodedBytes` to change those limits. The PCM limit counts the library's decoded buffers, including removed samples with outstanding leases.

Use `library.preview(id)` to audition a ready sample independently of the transport and `stopPreview()` to stop. Use `acquire(id)` to borrow its decoded `AudioBuffer` and `release()` when finished. Treat borrowed PCM as read-only. Removing a row stops its audition and leaves the leased samples available. Destroying the library clears rows and stops preview. Outstanding leases remain valid until released. Projects can copy leased samples into their own clips with `Project.addAudioClip()`.

## Clip Launcher

`ClipLauncher` is the launch state machine of a session view: quantized per-track overrides over a borrowed audio clock. It owns what is queued and active and when each switch is due; your driver owns the sound. It holds no nodes, timers or effects, so there is no `destroy()`.

```ts
new ClipLauncher(transport: ClipLaunchTransport)

type ClipLaunch = { trackId: string; clipId: string | null; mode?: "loop" | "one-shot" };
type QueuedClipLaunch = ClipLaunch & { beat: number; when: number }; // the boundary, in beats and absolute audio seconds
type ClipLauncherState = { active: readonly ClipLaunch[]; queued: readonly QueuedClipLaunch[] }; // at most one entry per track

type ClipLaunchTransport = BeatTiming & {
  now(): number; // audio-context time
  schedule(change: ClipLaunch, when: number): ClipLaunchTransition; // one track's change at `when`
  reset(): void; // stop all playback
};
type ClipLaunchTransition = { cancel(): void; commit(): void; endsAt?: number };
```

`BeatTiming` (`timeToBeat()` and `beatToTime()`) and `now()` come from the same source, usually the `Timeline` of the `Clock` that is running. `state` is a read-only cell; `launcher.state.value` and effects read it like any other cell.

### Launching and cancelling

- `queue(changes, quantumBeats = 1)` queues one launch per listed track (unique track IDs) and returns the `QueuedClipLaunch` list, in call order. Each launch switches at the next multiple of `quantumBeats`.
- **Pending launches are per track.** Queueing track A replaces only A's pending launch; every other track's pending launch stays. Independent clicks need no merging in your app.
- **A scene is one `queue` call.** All its tracks share one boundary and the same `when`, so they start on the same sample. A later call that names only one of those tracks replaces just that track.
- **Quanta are per call.** A track queued with a different quantum than another pending track keeps its own boundary: a track queued on 4 beats and another on 1 beat switch at different times.
- **Quantum `0` launches now.** There is no boundary: `when` is the current audio time and `beat` the current beat. The switch is still published by the next `advance()`.
- `clipId: null` is the driver's "no clip" for that track. Your driver decides what it means (silence in a standalone driver; the DAW returns the track to Arrangement). It is committed like any other launch and removes the track from `active`.
- `cancel(trackId?)` withdraws that track's pending launch, or every pending launch with no argument, and returns whether anything was withdrawn. A launch whose time has arrived cannot be withdrawn; its switch is published instead.
- `advance()` publishes the switches whose audio time has arrived, plus any one-shot that has ended. Call it from the `Clock`'s `onTick`. `reset()` cancels every pending launch, clears `active`, and calls `transport.reset()`; use it before a discontinuous transport change such as a seek or stop.

Commands never subscribe a calling effect.

### The driver contract

`schedule(change, when)` is called once per changed track, with the same `when` for every track of one `queue` call. It must prepare the sound **reversibly** and return a transition:

| Member   | When it runs                                                                                                                                            | Who calls it | What it must do                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel` | The launch is withdrawn with `cancel()`, replaced by a later launch of the same track, `reset()` runs, or a later track of the same `queue` call throws | The launcher | Retract the incoming playback and leave the previous playback exactly as before. Safe before `when` only.                                                                   |
| `commit` | An `advance()` finds `when` has arrived                                                                                                                 | The launcher | Release the outgoing playback; the switch has happened. The driver has no other reason to track `when`.                                                                     |
| `endsAt` | Read once, when the launch commits                                                                                                                      | The launcher | For `mode: "one-shot"`, the absolute audio time the clip ends. The override leaves `active` at that time; the driver schedules its own audio change there. Omit for a loop. |

The launcher never calls `cancel()` after `commit()`. Replacing or withdrawing a track therefore always calls the replaced launch's `cancel()` for you; the driver does not track pending launches itself.

The hard part is the outgoing stop. `AudioBufferSourceNode.stop(when)` cannot be retracted, so a launch that stops the outgoing clip with it cannot be cancelled. Put each launch behind its own `GainNode` gate instead: schedule `setValueAtTime(0, when)` on the outgoing gate, and undo it with `cancelScheduledValues(when)`. The sources are stopped for real only in `commit()`.

```ts
import { ClipLauncher, type ClipLaunch, type ClipLaunchTransition } from "@audiorective/blocks/launcher";
import { Clock, Timeline } from "@audiorective/clock";

const context = new AudioContext(); // you own it; resume() it from a user gesture
const buffers = new Map<string, AudioBuffer>(); // clipId -> decoded loop
const strips = new Map<string, AudioNode>(); // trackId -> the track's input (a Channel input, or a GainNode)
type Voice = { source: AudioBufferSourceNode; gate: GainNode };
const playing = new Map<string, Voice>(); // trackId -> the voice that is sounding at the boundary

const timeline = new Timeline({ audioContext: context, bpm: 120 });
const launcher = new ClipLauncher({
  now: () => context.currentTime,
  timeToBeat: (time) => timeline.timeToBeat(time),
  beatToTime: (beat) => timeline.beatToTime(beat),
  schedule({ trackId, clipId, mode }: ClipLaunch, when: number): ClipLaunchTransition {
    const outgoing = playing.get(trackId);
    let incoming: Voice | undefined;
    if (clipId !== null) {
      const source = new AudioBufferSourceNode(context, { buffer: buffers.get(clipId)!, loop: mode !== "one-shot" });
      const gate = new GainNode(context, { gain: 0 });
      gate.gain.setValueAtTime(1, when); // audible from the boundary
      source.connect(gate).connect(strips.get(trackId)!);
      source.start(when);
      incoming = { source, gate };
    }
    outgoing?.gate.gain.setValueAtTime(0, when); // silent from the boundary; the source keeps running until commit
    if (incoming) playing.set(trackId, incoming);
    else playing.delete(trackId);
    const dispose = ({ source, gate }: Voice) => {
      source.stop();
      source.disconnect();
      gate.disconnect();
    };
    return {
      endsAt: incoming && mode === "one-shot" ? when + incoming.source.buffer!.duration : undefined,
      cancel() {
        outgoing?.gate.gain.cancelScheduledValues(when); // the outgoing keeps sounding
        if (incoming) dispose(incoming);
        if (outgoing) playing.set(trackId, outgoing);
        else playing.delete(trackId);
      },
      commit() {
        if (outgoing) dispose(outgoing);
      },
    };
  },
  reset() {
    for (const voice of playing.values()) {
      voice.gate.gain.cancelScheduledValues(0);
      voice.source.stop();
      voice.source.disconnect();
      voice.gate.disconnect();
    }
    playing.clear();
  },
});

const clock = new Clock({ timeline, onTick: () => launcher.advance() });
await context.resume();
clock.start({ atBeat: -0.5 }); // beat 0 is then the first boundary half a beat from now

launcher.queue([{ trackId: "drums", clipId: "drums-a" }], 4); // drums start on the next 4-beat boundary
launcher.queue([{ trackId: "bass", clipId: "bass-a" }], 1); // independent: bass starts on the next beat; drums stay queued
launcher.queue(
  [
    { trackId: "drums", clipId: "drums-b" },
    { trackId: "bass", clipId: "bass-b" },
  ],
  4,
); // a scene on one boundary; replaces both pending launches
launcher.queue([{ trackId: "bass", clipId: "bass-c" }], 0); // now, without touching drums
launcher.queue([{ trackId: "drums", clipId: null }], 1); // quantized stop: silence for that track
launcher.cancel("drums"); // withdraw just that stop; launcher.cancel() withdraws everything
```

Nothing sounds early: the outgoing voice is only silenced by its gate at `when` and disposed in `commit()`. A one-shot needs no extra call at its end: the driver's source ends there and the launcher drops the override from `active` at `endsAt`.

For engine playback with a Project, and for mounting a view over `state`, see [the DAW Clip Launcher](./daw.md#clip-launcher).

## Common errors

| Step Sequencer message                                                                                                                                                              | Fix                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Step Sequencer needs an integer size from 1 to 128.`                                                                                                                               | Pass a whole `size` in 1/16 steps from 1 to 128 to the constructor or `setSize`.                                                                                                                                                                         |
| `Step Sequencer needs lanes with unique, nonempty IDs.`                                                                                                                             | Give every lane a different, nonempty string `id`.                                                                                                                                                                                                       |
| `Step Sequencer lane needs steps from 1 to the pattern size, a known rate and direction, ...`                                                                                       | Keep `steps` within `size`, use a listed `StepRate`, `forward`/`backward`/`bounce`, swing 0..1, boolean `mute`/`solo` and no more than `size` cells.                                                                                                     |
| `Step Sequencer cell needs velocity and chance from 0 to 1, offset from -0.5 to 0.5, length from 1/16 to 4, ...`                                                                    | Keep cell values in range; `repeat` is an integer 1..8 and `pitch` an integer -24..24.                                                                                                                                                                   |
| `Step Sequencer params need unique nonempty ids that differ from the built-in cell keys ...`                                                                                        | Fix the `params` option: unique ids that are not `velocity`, `offset`, `length`, `repeat`, `pitch`, `chance` or `custom`, `min < max`, `default` in range.                                                                                               |
| `Step Sequencer custom values need declared param ids and finite numbers from each param's min to max.`                                                                             | Declare the id in `params` at construction, and keep each `custom` value within that param's range.                                                                                                                                                      |
| `Step Sequencer transforms need an array of objects that each have a nonempty string id and an apply function.`                                                                     | Pass `transforms` / `setTransforms` a list of `{ id, apply }` objects.                                                                                                                                                                                   |
| `Event transform "<id>" returned an event without a finite "beat".` (also `"when"`, `"durationBeats"`, `"duration"`, `"velocity"`, `must return an array`, `has a unit other than`) | The named transform returned a hit with a non-finite `beat` (`when` if it sets `unit: "second"`), a `durationBeats` (`duration`) not above 0, a `velocity` outside 0..1, a non-array, or a `unit` other than `"beat"` or `"second"`. Fix that transform. |
| `Step Sequencer needs an existing lane and step.`                                                                                                                                   | `setCell`/`toggle` need a current lane ID and a zero-based step below `size`.                                                                                                                                                                            |
| `Step Sequencer needs an existing lane.`                                                                                                                                            | `setLane` needs a current lane ID.                                                                                                                                                                                                                       |

| Sample Library message                                       | Fix                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `Sample Library byte limits must be non-negative.`           | Supply non-negative byte limits.                                              |
| `File byte limit exceeded.`                                  | Import a smaller file or configure a larger file limit.                       |
| `Decoded PCM budget exceeded.`                               | Remove unused files, release leases or raise the decoded byte limit.          |
| `Sample Library needs a ready sample.`                       | Wait for the import and use a ready row ID.                                   |
| `Sample lease is released.` / `Sample Library is destroyed.` | Keep the lease until use finishes, or create a new library for a new session. |

| Clip Launcher message                                   | Fix                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Clip Launcher requires a non-negative launch quantum.` | Use a finite number of beats, or 0 to launch at the current audio time.                                      |
| `Clip Launcher requires one launch per affected track.` | Supply a non-empty group with unique track IDs.                                                              |
| `Clip Launcher requires a future audio time.`           | Use a running transport whose beat-to-time mapping advances past the current audio time (a quantum above 0). |

Loading, selection and playback messages from `WavePlayer`. Stretch and time-mapping messages are listed with [stretch](#committed-versions-and-offline-stretch); waveform view and plugin messages are in [Widgets](./widgets.md#common-errors).

| Message                                                                                                                                            | Cause                                                     | Fix                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `WavePlayer is destroyed.`                                                                                                                         | Mutating or subscribing after block cleanup               | Create a new WavePlayer; shared views must not destroy their caller's player.   |
| `Position must be finite seconds.` / `Start time must be finite, non-negative seconds.`                                                            | Invalid `seek` position or `play({ when })` time          | Pass finite seconds; `when` is an absolute `AudioContext` time, clamped to now. |
| `Enter an audio URL.`                                                                                                                              | Empty URL passed to `load`                                | Supply a URL or File.                                                           |
| `Audio request failed: HTTP 404.` (status varies)                                                                                                  | URL response is unsuccessful                              | Check the URL, access, and server response; call `load` again to recover.       |
| `Audio request returned text instead of audio.`                                                                                                    | URL served HTML/text                                      | Fix routing/proxy to return audio, then retry load.                             |
| `Audio download size does not match Content-Length.`                                                                                               | Truncated or incorrect byte length                        | Fix the transfer/length, then retry load.                                       |
| `Load progress needs non-negative byte counts and a null or matching total.` / `Unknown audio loading phase.`                                      | Invalid cache adapter reports                             | Use download/read with safe byte counts or decode; total may be null.           |
| `Audio file has no playable duration.`                                                                                                             | Decoded audio has zero duration                           | Supply audio with a positive duration.                                          |
| `Selection must satisfy 0 <= start < end <= duration (finite seconds).`                                                                            | Invalid programmatic range                                | Await loading, then pass ordered finite endpoints within duration, or `null`.   |
| `Source automation must use the player's AudioContext.`                                                                                            | Binding uses another audio clock                          | Construct it with the same `AudioContext` as the player.                        |
| `Source automation requires non-looping playback.`                                                                                                 | Loop requested with finite source automation              | Detach the binding before looping, or play the selection once.                  |
| `Pad Bank pad IDs must be nonempty and unique.`                                                                                                    | Empty or repeated pad ID                                  | Give each pad a stable unique ID.                                               |
| `Pad hit time must be finite, non-negative seconds.` / `Pad hit velocity must be finite.`                                                          | Invalid hit time or velocity                              | Use absolute audio seconds and a finite velocity.                               |
| `Pad hit pitch must be finite semitones.` / `Pad hit duration must be finite, positive seconds.`                                                   | Invalid `options.pitch` or `options.duration`             | Pass finite semitones and a duration above zero.                                |
| `Unknown pad.`                                                                                                                                     | `assign()` or `routePad()` received an ID not in the bank | Use a declared pad ID.                                                          |
| `PadBank is destroyed.`                                                                                                                            | Trigger, assign or routePad after cleanup                 | Create a new block; `destroy()` is final.                                       |
| `AudioRecorder channels must be an integer from 1 to 32.`                                                                                          | Invalid channel option                                    | Choose an integer channel count from 1 to 32.                                   |
| `AudioRecorder requires AudioWorklet support.` / `AudioRecorder worklet failed.`                                                                   | Missing worklet support or processor failure              | Use a browser with AudioWorklet and inspect its audio processor error.          |
| `AudioRecorder AudioContext closed during recording.`                                                                                              | Caller closed the borrowed context mid-take               | Await `stop` or cancel the take before closing the context.                     |
| `AudioRecorder time must be finite, non-negative seconds.` / `AudioRecorder stop must follow its start time.`                                      | Invalid scheduled capture interval                        | Pass ordered absolute AudioContext seconds.                                     |
| `AudioRecorder already has an active take.` / `AudioRecorder has no started take to stop.`                                                         | Start/stop lifecycle mismatch                             | Await `start`, then `stop` or `cancel` before starting another take.            |
| `AudioRecorder stream needs a chunk writer.` / `AudioRecorder streaming take needs stopStream().` / `AudioRecorder has no started stream to stop.` | Streaming call mismatch                                   | Pass a writer to `startStream`, then finish that take with `stopStream`.        |
| `AudioRecorder stream writer fell behind.`                                                                                                         | More than 64 chunk writes remain pending                  | Use a faster external writer or stop and retry with shorter takes.              |
| `AudioRecorder captured no frames.` / `AudioRecorder lost captured frames.` / `AudioRecorder lost captured frames: expected …`                     | Missed interval or incomplete worklet transfer            | Preload `ready`, use future times, then retry the take.                         |
| `AudioRecorder render clock skipped more than two seconds.`                                                                                        | Browser audio graph stopped running mid-take              | Retry while the AudioContext remains active; check device and browser load.     |
| `AudioRecorder recording was cancelled.` (`AbortError`) / `AudioRecorder is destroyed.`                                                            | Take cancelled or owner destroyed                         | Start a fresh take on a live recorder, or construct another owner.              |
