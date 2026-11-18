---
title: Blocks
---

`@audiorective/blocks` provides headless audio capture, range playback and cancellable instrument events. A block owns behavior and state; widgets read that state and call its methods. Playback blocks need Web Audio, but no document, elements, renderer, or UI framework. MIDI recording and note data live in [MIDI and Piano Roll](./midi.md).

## WavePlayer

`WavePlayer` loads audio, selects a range in the committed output timeline, and auditions it. Pass an optional borrowed offline stretch processor to render another duration while preserving pitch. It extends `AudioProcessor`, reuses core's `BufferPlayer`, and exposes `params.volume` with the standard `.value`, `$`, and scheduling methods. The caller supplies an `AudioContext`, routes its output, and destroys it when finished.

```typescript
import { WavePlayer } from "@audiorective/blocks";

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

| Member                                                       | Behavior                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load(source: string \| File \| AudioBuffer): Promise<void>` | Stops playback, clears range/loop/position and replaces the source. URL and File are decoded with the supplied context. An AudioBuffer is borrowed without decoding or copying. Loading cancels any pending stretch and restores ratio 1. Only the latest load may update state; superseded loads settle without updating it. A current failure rejects and sets `error`. |
| `buffer: AudioBuffer \| null`, `duration: number`            | Current committed playback buffer and output duration in seconds. Read them together through `version` when audio and peaks must agree.                                                                                                                                                                                                                                   |
| `setSelection(range: AudioRange \| null)`                    | Sets a defensive copy. Finite endpoints must satisfy `0 <= start < end <= duration`. Invalid edits leave state unchanged. Clearing disables looping. A stopped player stays stopped; a playing session follows the new bounds.                                                                                                                                            |
| `getSelection(): AudioRange \| null`                         | Returns a copy of the authoritative selection.                                                                                                                                                                                                                                                                                                                            |
| `play(options?: { when?: number }): Promise<number \| null>` | Resumes the supplied context, then starts or resumes within the current range (whole source without a range). At the end, the next play starts at the range start. `when` schedules the first sound; see [Scheduled start](#scheduled-start). Resolves with the effective start time, or `null` when the call started nothing. Context resume errors reject.              |
| `attachSourceAutomation(binding): () => void`                | Borrows a core `AutomationBinding` in source seconds for non-looping playback. Starts, re-anchors and stops it with the player; the returned function detaches and stops it without destroying the binding or player. See [Source-time automation](#source-time-automation-on-a-selection).                                                                               |
| `audition(): Promise<void>`                                  | Enables looping, seeks to the selected start and plays. No selection means no action.                                                                                                                                                                                                                                                                                     |
| `pause()` / `stop()`                                         | Pause holds position; stop resets to the selection start, or zero. Both cancel pending play requests.                                                                                                                                                                                                                                                                     |
| `seek(seconds)`                                              | Clamps finite seconds to the committed output duration. A playing session restarts within its bounds; a stopped session remains stopped.                                                                                                                                                                                                                                  |
| `setLooping(boolean)`                                        | Loops the selection, or the whole source. Changing this during playback cancels an obsolete scheduled stop.                                                                                                                                                                                                                                                               |
| `position`, `isPlaying`, `isLooping`                         | Current output seconds and playback flags. Position follows the audio clock at the committed buffer's native playback speed.                                                                                                                                                                                                                                              |
| `cancelLoad(): void`                                         | Cancels the active load, clears progress without an error, and ignores late results. Idle calls preserve the committed version.                                                                                                                                                                                                                                           |
| `getState()`                                                 | Snapshot containing `duration`, copied `selection`, `position`, `isPlaying`, `isLooping`, `loading`, `loadProgress`, `error: string \| null`, `processing`, `stretchRatio`, `sourceDuration`, and `revision`.                                                                                                                                                             |
| `subscribe(listener: () => void): () => void`                | Change notifications for source, selection, loading and playback; returns unsubscribe. Does not call immediately or tick for clock-only position movement. Render once, subscribe for changes, and read `position` per animation frame when needed. A failing listener is logged without preventing other updates.                                                        |
| `destroy()`                                                  | Idempotently cancels loads, edits and play requests, stops/disconnects owned audio and releases buffers/listeners. It never destroys the borrowed stretch processor. Leaves the caller context open. Mutating a destroyed player throws `Range player is destroyed.`                                                                                                      |

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

The reading methods are tracked too: `getState()`, `getSelection()`, `isLooping`, `isPlaying` and `version` re-run an effect that calls them. `buffer`, `duration`, `sourceBuffer` and the time-mapping helpers are plain reads that change together with `version`; observe `cells.version` (or `getState()`) to follow them.

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

Detach this waiter's progress observers when `signal` aborts or the adapter settles. Shared cache work may continue for other readers; cancellation does not require aborting their request. Byte reports require non-negative safe integers, `totalBytes: null` or a total at least as large as `loadedBytes`. Invalid progress rejects the current load. `WaveLoadProgress` and `WaveSourceLoader` are exported from `@audiorective/blocks`.

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
import { WavePlayer } from "@audiorective/blocks";
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
import { WavePlayer } from "@audiorective/blocks";
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
import { AudioRecorder } from "@audiorective/blocks";

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

The result preserves the audio clock's raw sample positions. A Track/Clip owner places takes against transport time and applies any measured input/monitor latency adjustment; the recorder does not guess a round-trip offset. Normal `start()`/`stop()` accumulates PCM in memory and suits short takes. For long captures, call `startStream(writeChunk, { when? })` and `stopStream({ when? })` instead. The callback receives ordered `{ startFrame, channels }` chunks, each with up to 4096 frames, and writes them to caller-owned storage. `stopStream()` waits for accepted writes and returns `{ channelCount, sampleRate, startFrame, endFrame, startTime, endTime }` without returning the full PCM. When the browser skips a short render interval, the result includes `dropouts` with absolute frame ranges and the skipped samples become silence; a gap longer than two seconds rejects. Check `dropouts` before treating a take as lossless. At most 64 pending writes are allowed; a slower writer fails the take instead of growing the recorder's queue without bound. The callback owns any external file or database and must preserve chunk order when writes complete asynchronously. `@audiorective/workspace` provides `AudioMediaWriter` and `Project.addAudioMediaClip` to turn these chunks into file-backed, editable project clips; see [Workspace and DAWproject](./workspace.md#long-audio-takes-and-media-ownership). AudioWorklet registration uses a Blob URL and needs compatible Content Security Policy settings. `MediaRecorder` can still be suitable for a simple voice memo, but its chunk intervals are not the alignment contract used here.

## Cancellable instrument events

`InstrumentEvents` plays sample hits and owns reversible same-group choke policy. Use it when a sequencer can edit or cancel a hit after the Clock has scheduled it, or when a future closed-hat hit must choke an open-hat hit only if that closed hit still exists. Ordinary one-shot pads without choke can keep using core `Sampler` and `Voice`.

```typescript
import { InstrumentEvents } from "@audiorective/blocks";

const instruments = new InstrumentEvents(context, [
  { id: "open-hat", buffer: openHat, group: "hat", gate: true },
  { id: "closed-hat", buffer: closedHat, group: "hat" },
]);
instruments.output.connect(context.destination);
const manual = instruments.trigger("open-hat"); // caller owns this event
const queued = instruments.trigger("closed-hat", 1, context.currentTime + 0.2);
queued?.cancel(); // removes both the hit and its future choke; manual keeps sounding
// Later: manual?.cancel(); instruments.destroy(); context.close();
```

`trigger(id, velocity = 1, when = context.currentTime)` returns an `InstrumentEvent` with idempotent `cancel()` / `stop()` and `onEnded(listener)`, or `null` for an unknown pad ID. Velocity clamps to 0..1; a past `when` plays now. `gate: true` loops a sample until its event is cancelled or choked; otherwise it plays once. Later hits with a **different ID** in the same `group` choke earlier hits at their native audio start time, even if the later hit was scheduled first. Hits of the same ID may overlap. Choke is carried by a per-event gain gate, so cancelling an unstarted hit retracts its future choke. A choke that already reached its deadline stays committed and cannot resurrect an earlier sound. The cleanup timer retires silent nodes; it does not time the audible cutoff.

`assign(id, buffer)` replaces that pad's buffer, cancels its current and future hits, and retracts their future choke. `stopAll()` cancels every hit. `cells.activeEvents` is a read-only reactive count; `params.volume` follows the normal schedulable `.value` / `$` contract. The block owns its nodes and event handles, while the caller owns output routing and the `AudioContext`. It has no polyphony cap or voice-stealing policy. For Clock-owned sequenced hits, pass the handle to `window.own(hit, when)` and call `clock.refresh()` after pattern edits; manual hits remain unregistered. See [Clock](./clock.md#own-cancellable-events-when-transport-edits-must-cut-queued-sound).

## EffectRack inserts

Import `EffectRack` from `@audiorective/blocks/effect-rack`. It owns an ordered chain of built-in Filter and PingPongDelay inserts behind stable `input` and `output` nodes, and borrows the caller's audio context.

```typescript
import { EffectRack } from "@audiorective/blocks/effect-rack";

const rack = new EffectRack(context, [
  { id: "filter", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1200, q: 0.7 },
  { id: "delay", type: "delay", enabled: true, wet: 0.35, delayTime: 0.25, feedback: 0.25 },
]);
source.connect(rack.input);
rack.output.connect(context.destination);
rack.setEffects(rack.effects.map(slot => slot.id === "delay" ? { ...slot, enabled: false } : slot));
// On teardown, disconnect your source from rack.input and call rack.destroy().
```

`setEffects()` takes a complete ordered snapshot, validates it, and preserves processors with the same slot ID and type. An empty chain passes audio through. Bypass sets the effective mix to dry while preserving the configured mix. Filter accepts lowpass or highpass, 20–20,000 Hz and Q 0.1–20. Delay accepts 0.01–1 second and feedback 0–0.95. Both accept a mix from 0–1. [Workspace](./workspace.md#effect-rack) connects these settings to a project and playback.

## Common errors

| Message | Fix |
| --- | --- |
| `EffectRack needs unique slot IDs and valid Filter or Delay settings.` | Use distinct nonempty slot IDs and settings inside the ranges above. |
| `EffectRack is destroyed.` | Construct a new rack before applying settings. |

Loading, selection and playback messages from `WavePlayer`. Stretch and time-mapping messages are listed with [stretch](#committed-versions-and-offline-stretch); waveform view and plugin messages are in [Widgets](./widgets.md#common-errors).

| Message                                                                                                                                            | Cause                                            | Fix                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `Range player is destroyed.`                                                                                                                       | Mutating or subscribing after block cleanup      | Create a new WavePlayer; shared views must not destroy their caller's player.   |
| `Position must be finite seconds.` / `Start time must be finite, non-negative seconds.`                                                            | Invalid `seek` position or `play({ when })` time | Pass finite seconds; `when` is an absolute `AudioContext` time, clamped to now. |
| `Enter an audio URL.`                                                                                                                              | Empty URL passed to `load`                       | Supply a URL or File.                                                           |
| `Audio request failed: HTTP 404.` (status varies)                                                                                                  | URL response is unsuccessful                     | Check the URL, access, and server response; call `load` again to recover.       |
| `Audio request returned text instead of audio.`                                                                                                    | URL served HTML/text                             | Fix routing/proxy to return audio, then retry load.                             |
| `Audio download size does not match Content-Length.`                                                                                               | Truncated or incorrect byte length               | Fix the transfer/length, then retry load.                                       |
| `Load progress needs non-negative byte counts and a null or matching total.` / `Unknown audio loading phase.`                                      | Invalid cache adapter reports                    | Use download/read with safe byte counts or decode; total may be null.           |
| `Audio file has no playable duration.`                                                                                                             | Decoded audio has zero duration                  | Supply audio with a positive duration.                                          |
| `Selection must satisfy 0 <= start < end <= duration (finite seconds).`                                                                            | Invalid programmatic range                       | Await loading, then pass ordered finite endpoints within duration, or `null`.   |
| `Source automation must use the player's AudioContext.`                                                                                            | Binding uses another audio clock                 | Construct it with the same `AudioContext` as the player.                        |
| `Source automation requires non-looping playback.`                                                                                                 | Loop requested with finite source automation     | Detach the binding before looping, or play the selection once.                  |
| `Instrument pad IDs must be nonempty and unique.`                                                                                                  | Empty or repeated pad ID                         | Give each pad a stable unique ID.                                               |
| `Instrument event time must be finite, non-negative seconds.` / `Instrument velocity must be finite.`                                              | Invalid hit time or velocity                     | Use absolute audio seconds and a finite velocity.                               |
| `Unknown instrument pad.`                                                                                                                          | `assign()` received an ID not in the bank        | Assign to a declared pad ID.                                                    |
| `InstrumentEvents is destroyed.`                                                                                                                   | Trigger or assign after cleanup                  | Create a new block; `destroy()` is final.                                       |
| `AudioRecorder channels must be an integer from 1 to 32.`                                                                                          | Invalid channel option                           | Choose an integer channel count from 1 to 32.                                   |
| `AudioRecorder requires AudioWorklet support.` / `AudioRecorder worklet failed.`                                                                   | Missing worklet support or processor failure     | Use a browser with AudioWorklet and inspect its audio processor error.          |
| `AudioRecorder AudioContext closed during recording.`                                                                                              | Caller closed the borrowed context mid-take      | Await `stop` or cancel the take before closing the context.                     |
| `AudioRecorder time must be finite, non-negative seconds.` / `AudioRecorder stop must follow its start time.`                                      | Invalid scheduled capture interval               | Pass ordered absolute AudioContext seconds.                                     |
| `AudioRecorder already has an active take.` / `AudioRecorder has no started take to stop.`                                                         | Start/stop lifecycle mismatch                    | Await `start`, then `stop` or `cancel` before starting another take.            |
| `AudioRecorder stream needs a chunk writer.` / `AudioRecorder streaming take needs stopStream().` / `AudioRecorder has no started stream to stop.` | Streaming call mismatch                          | Pass a writer to `startStream`, then finish that take with `stopStream`.        |
| `AudioRecorder stream writer fell behind.`                                                                                                         | More than 64 chunk writes remain pending         | Use a faster external writer or stop and retry with shorter takes.              |
| `AudioRecorder captured no frames.` / `AudioRecorder lost captured frames: expected …`                                                             | Missed interval or incomplete worklet transfer   | Preload `ready`, use future times, then retry the take.                         |
| `AudioRecorder render clock skipped more than two seconds.`                                                                                        | Browser audio graph stopped running mid-take     | Retry while the AudioContext remains active; check device and browser load.     |
| `AudioRecorder recording was cancelled.` (`AbortError`) / `AudioRecorder is destroyed.`                                                            | Take cancelled or owner destroyed                | Start a fresh take on a live recorder, or construct another owner.              |
