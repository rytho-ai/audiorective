---
title: Audio Recorder
---

PCM take capture from `@audiorective/recorder`.

## Record an audio take

`AudioRecorder` captures PCM from an input at sample-frame positions on the caller's `AudioContext`. It is a headless class with an `input` node and **no audible output**: connect a source to it (`mic.connect(recorder)`), route monitoring separately, and place the returned take yourself. It owns no microphone and no track.

```typescript
import { AudioRecorder, MicrophoneInput } from "@audiorective/recorder";

const context = new AudioContext();
// From the Record click: asks for permission now, not at page load.
const mic = await MicrophoneInput.open(context); // rejects with getUserMedia's own DOMException
const recorder = new AudioRecorder(context, { channels: 1 });
mic.connect(recorder);
await context.resume();

const recording = recorder.record(); // starts now; settles when the take ends
// Later, from the stop control:
try {
  const take = await recorder.stop(); // the same take `recording` resolves with
  // take.channels, sampleRate and raw frame/time positions are ready for the clip owner.
} catch (error) {
  // A quick Stop before capture begins is normal cancellation of both promises.
  if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
}

mic.dispose(); // stops every track and releases the device; `using mic = ...` does the same
recorder.dispose();
```

Without `onChunk`, `record(options?)` returns `Promise<RecordedAudio>`. `when` is absolute AudioContext seconds (default now; a time already past starts at the first available frame). `length` is seconds, or a note value such as `"4m"` (see below); without it the take runs until `stop({ when? })`. `signal` discards the take with `AbortError`, like `cancel()`. `stop()` ends the take early and resolves `record()` with what was captured; `cancel()` discards it and rejects `record()` with `AbortError`, so an app's Stop button calls `stop()`. All `stop()` failures reject its Promise, so callers can use `.catch()`. On a take with `length`, Stop can only shorten it. `await recorder.ready` preloads AudioWorklet registration before a precise start; it does not mean capture has begun. On a live context, `cells.startedAt` becomes non-null after the worklet starts capturing. A workflow that starts playback only after capture begins can observe that cell; the DAW audio-fallback helper handles this internally. An `OfflineAudioContext` renders only what is armed: wait for `cells.startsAt` to be non-null before `startRendering()`. Whatever is wired to `recorder.input` is processed from the start, armed or not (a silent path pulls it), so a source or automation that reaches only the recorder runs on the audio clock and a take holds what played at that audio time. In an offline render, take delivery is asynchronous: return the take's promise from a [`renderTimeline` action](./clock.md#rendering-offline--rendertimeline) so the render waits for it.

Stop uses **audio time**, not whether the main thread has received the capture-begin notification. It samples `now` once and computes `effective = Math.max(when ?? now, now)`, rounding up to the closing sample frame. Past Stop times therefore mean now, even if they precede the take's start time.

| Effective closing frame              | Requested time                                   | Result                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| After the first capture frame        | Any valid time, including omitted or past `when` | Stop normally and return the captured audio, even if `cells.state` still reads `"armed"` because the main thread was busy.                  |
| At or before the first capture frame | Omitted, past or present `when`                  | Discard the pending take; both Stop and record reject with `AbortError`, without writing `cells.error`. Handle this as normal cancellation. |
| At or before the first capture frame | A future `when`                                  | Reject only that Stop request with `RangeError`; preserve the take and leave `cells.error` unchanged.                                       |

Times must be finite, non-negative seconds. During graph preparation, the first frame is the start requested when `record()` was called (its `when` or the next quantized boundary). A future Stop not after it rejects with `RangeError` and preserves the take, however long preparation takes. If preparation finishes late and moves the start past a Stop that was after the requested start, the take cancels with `AbortError` rather than leave a new recording running. A valid future Stop schedules that later end. The `"armed"` state or a null `cells.startedAt` alone does not prove that no audio has been captured: worklet messages can be queued while native capture continues.

The result reports **actual** inclusive `startFrame` and exclusive `endFrame`; divide by `sampleRate` for `startTime` and `endTime` (AudioContext seconds); `startBeat` is in beats from the clock's beat 0. Each channel's `Float32Array` has exactly `endFrame - startFrame` samples, and the caller may edit or transfer them. A take with no captured frames rejects rather than masquerading as aligned silence. `toAudioBuffer(take, context)` copies a take into an `AudioBuffer` for `BufferPlayer`, a clip launcher or `WavePlayer.load`.

### Start on a bar for N bars

`AudioRecorder` is a clock scheduler like `StepSequencer` and `ClipLauncher`: attach it, and `record` takes the same `quantize` values.

```typescript
import { Clock } from "@audiorective/clock";

const clock = new Clock({ audioContext: context, bpm: 120 });
clock.start();
const detach = clock.attach(recorder);

// From the Record click: starts on the next bar line and ends exactly four bars later.
const take = await recorder.record({ quantize: "1m", length: "4m" });
take.startBeat; // beat of the actual first captured frame, for track placement
take.startTime; // the same instant on the audio clock
detach();
```

`quantize` is `"none"` (default), `"1m"` (the next bar of `clock.meter`), `"2m"`, or a note value such as `"4n"` (the next beat); a call exactly on a boundary starts there, like the launcher, otherwise the boundary is the first one at least 50 ms ahead, so the capture graph exists before it. `length: "4m"` is measured from the start at the clock's tempo, and the capture worklet counts it from its own first captured frame, so a take is exactly `length` frames (`Math.round(seconds * sampleRate)` for seconds) even when the boundary has already passed or the render thread runs late. An on-time `startFrame` is the ceiling of the requested boundary time in frames. If native capture begins late, `startFrame` and `startTime` report the first frame actually captured, and `startBeat` reports that frame’s clock beat rather than the earlier requested bar line. Even an on-time boundary can fall between samples, so the reported beat need not be an exact integer. Use the returned placement without snapping it back to the planned boundary. Both note values need the attached clock; `quantize` also needs it playing. During a count-in (negative beats, `clock.start(when, -4)`) a quantized start can land inside the count-in; to start at bar 1 pass `when: clock.timeline.beatToTime(0)` instead of `quantize`. `take.startBeat` is the clock beat at `startTime` whenever the recorder is attached to a playing clock, else `null`. While attached, leaving the transport (stop, pause, seek, detach) cancels a take whose first frame is still ahead on the audio clock, whether its start is `quantize` or a future `when`, and rejects `record()` with `AbortError`; a take past that frame continues until `stop()` or its `length`, even if `cells.state` still reads `"armed"` because the begin notification is queued, and its `startBeat` is the first frame's beat on the timeline from before the transport moved, including on a tempo ramp or a `clock.start()` jump. `cells.startsAt` and `cells.startedAt` read like the launcher's.

### Placing a take in a loop

A take resolves after its end, so a loop made from it starts late. Launch it with `clip.launch({ at: beat })` ([launcher](./launcher.md#launch-as-if-it-started-earlier)) so it plays in phase. Two pure helpers return a new `AudioBuffer` (the target, often a playing clip's `clip.buffer.value`, is not modified) for `clip.configure({ buffer })`, which swaps the playing loop gaplessly:

```typescript
import { overdub, punch } from "@audiorective/recorder";

const layered = overdub(clip.buffer.value!, take, { loopStartBeat, bpm }); // sums the take at take.startBeat, wrapping across the loop end
clip.configure({ buffer: layered });
// Keep the planned transport range used to schedule this punch take.
const punched = punch(layered, take, { loopStartBeat, fromBeat: punchStartBeat, toBeat: punchEndBeat, bpm, fadeSeconds: 0.005 });
clip.configure({ buffer: punched });
```

`fromBeat` and `toBeat` are **absolute transport beats for this capture occurrence**, not offsets inside the loop. For a four-bar loop launched at beat 12, bars 3–4 of its second cycle are beats 36–44: use `punchStartBeat = 36` and `punchEndBeat = 44`, not 8 and 16. Advancing to a later cycle advances the planned range as well as the recording start. Keep that planned range if capture begins late; the helper leaves frames not covered by the take unchanged. For an existing four-bar loop at fixed 120 BPM in 4/4, choose a future bars-3–4 occurrence directly from the shared timeline, without attaching a temporary scheduler:

```typescript
const firstPunchBeat = loopStartBeat + 8;
const earliestBeat = clock.timeline.timeToBeat(context.currentTime + 0.05);
const cycle = Math.max(0, Math.ceil((earliestBeat - firstPunchBeat) / 16));
const fromBeat = firstPunchBeat + cycle * 16;
const toBeat = fromBeat + 8;
const take = await recorder.record({
  when: clock.timeline.beatToTime(fromBeat),
  length: "2m",
});
clip.configure({ buffer: punch(clip.buffer.value!, take, { loopStartBeat, fromBeat, toBeat, bpm: 120 }) });
```

This example assumes the tempo stays fixed until capture ends. Concrete bar rulers also accept an attached scheduler's window and its `BeatTiming`: `ruler.read(window, timing).grid(4)` needs only the beat span and beat/time conversion. Concrete time rulers additionally need the pause-aware timeline `position`. The custom `Ruler` interface retains the full tick window for extensions that read transport metadata.

`loopStartBeat` is the transport beat the loop's first frame sounds at. Pass `bpm` for a constant tempo or `timeline` (`clock.timeline`) to follow a tempo curve; `atBeat` overrides `take.startBeat` and is required for a take that has none. `overdub` takes an optional `gain`. A mono take is added to every channel; sample rates must match.

### Observing a take

`cells.state` is a read-only `"idle" | "armed" | "recording" | "stopping" | "disposed"`; `cells.error` is the last failed take's message and clears on a new `record`; `cells.startsAt` is the AudioContext time an armed take starts at, and `cells.startedAt` the time the capture began (each `null` otherwise). Only one take may be active at a time. Closing a live AudioContext during capture fails the take. `dispose()` ends an active take, detaches from the clock and leaves borrowed sources, streams and the context running; `options.signal` calls it on abort, and `[Symbol.dispose]()` is the same call. The private worklet reaches the destination through a zero-gain sink so it processes input without adding to caller monitoring.

## Microphone input

`MicrophoneInput.open(context, { audio?, signal? })` wraps `getUserMedia({ audio })` (`audio` defaults to `true`; pass `MediaTrackConstraints` such as `{ deviceId, echoCancellation: false }`) and resolves with an `AudioProcessor` whose `output` is the stream's source node. Connect it like any node or processor: `mic.connect(recorder)`.

- **Permission and device errors** reject with the `DOMException` `getUserMedia` raised, unchanged: `NotAllowedError` (the user denied it), `NotFoundError` (no microphone), `NotReadableError` (the device is busy), `OverconstrainedError`, `SecurityError`. Branch on `error.name`.
- **Monitoring** is a writable cell: `mic.cells.monitoring.value = true` routes the input to `context.destination` (default off). The recorder's input stays unaffected, so the monitor is never in the take. Use headphones, or `echoCancellation` stays on by default and cuts speaker feedback.
- **`mic.cells.state`** is `"live"` until every track ends (for example the device is unplugged) or the input is disposed, then `"ended"`.
- **Release:** `mic.dispose()` (or `[Symbol.dispose]()`) stops every track. An `AbortSignal` rejects `open` with its reason, stops a stream that arrives late, and after open calls `dispose()`.

## Long takes

Normal `record()` accumulates PCM in memory and suits short takes. For long captures, pass `onChunk` to the same `record()` entry. The returned `Promise<RecordedAudioSpan>` observes natural completion, writer failure and cancellation from the start; it returns frame/timing metadata without full-take PCM. `quantize`, `length`, `when` and `signal` have the same meaning in both modes.

```typescript
const recording = recorder.record({
  quantize: "1m", // clock.attach(recorder), with that clock playing
  length: "4m",
  onChunk: (chunk) => writer.writeChunk(chunk),
});
// Observe completion immediately, even if the writer fails before Stop is pressed.
void recording.catch(showError);
// Natural completion needs no Stop. An early-stop control uses:
const span = await recorder.stop({ result: "span" }); // same span as `recording`
// Or await `recording` directly for a fixed-length take.
const media = await writer.finish(span);
```

`onChunk` receives ordered `{ startFrame, channels }` chunks, each up to 4096 frames. The recorder waits for each callback before calling the next; buffers are borrowed until that callback settles. Up to 64 chunks may remain pending, including an in-flight callback. A slower writer fails the take instead of growing the queue without bound. On failure or cancellation the recorder stops capture, skips queued callbacks and waits for the in-flight callback before rejecting; the caller can then safely abort/close its storage. It preserves the writer's original error; cancellation rejects with `AbortError`. Do not close the external file before completion settles.

`stop({ result: "span", when? })` ends a streaming take early and resolves after accepted writes finish. Buffered `stop({ when? })` returns PCM. The selector must match the active mode (`InvalidStateError` otherwise); neither stop call is necessary for a take with a fixed `length`. Both modes accept valid future timed stops during graph preparation. `cancel()` discards either mode. With a dynamically optional writer or result selector, the return type is `RecordedAudio | RecordedAudioSpan`; use a literal writer/selector when the mode is known.

When the browser skips a short render interval, optional `span.dropouts` holds absolute frame ranges and skipped samples become silence; a gap longer than two seconds rejects. A healthy take omits this field. Check `span.dropouts?.length` or iterate `span.dropouts ?? []` before treating a take as lossless; an unguarded `span.dropouts.length` throws on a healthy take. The span reports `{ channelCount, sampleRate, startFrame, endFrame, startTime, endTime }`. The callback owns external file/database storage. `@audiorective/daw/project` provides `AudioMediaWriter` and `Project.addAudioMediaClip` for file-backed editable clips; see [DAW project and runtime](./daw.md#long-audio-takes-and-media-ownership). AudioWorklet registration uses a Blob URL and needs compatible Content Security Policy settings.

The result preserves the audio clock's raw sample positions. A Track/Clip owner places takes against transport time and applies any measured input/monitor latency adjustment; the recorder does not guess a round-trip offset. `MediaRecorder` can still be suitable for a simple voice memo, but its chunk intervals are not the alignment contract used here.

## Common errors

| Message                                                                                                                                                                                                 | Cause                                                                                                                                             | Fix                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `SecurityError` from `MicrophoneInput.open`                                                                             | `getUserMedia` refused: permission denied, no device, device busy                                                                                 | Branch on `error.name` and tell the user; ask again from a click.                                                                                                         |
| `MicrophoneInput needs navigator.mediaDevices.getUserMedia (a secure context).` (`NotSupportedError`)                                                                                                   | Insecure page or an environment without `mediaDevices`                                                                                            | Serve over https or localhost.                                                                                                                                            |
| `MicrophoneInput is disposed.`                                                                                                                                                                          | `connect` after `dispose`                                                                                                                         | Open a new input.                                                                                                                                                         |
| `AudioRecorder channels must be an integer from 1 to 32.`                                                                                                                                               | Invalid channel option                                                                                                                            | Choose an integer channel count from 1 to 32.                                                                                                                             |
| `AudioRecorder placement requires a positive bpm or a timeline.` / `AudioRecorder placement needs equal sample rates, got … and ….` / `AudioRecorder placement needs a mono take or … channels, got ….` | `overdub` or `punch` was given no tempo, a take at another sample rate, or a channel count the loop cannot take                                   | Pass `bpm` or `timeline`, record at the loop's rate (the context's), and use a mono take or one with the loop's channels.                                                 |
| `AudioRecorder overdub needs `atBeat` or a take with a startBeat.`                                                                                                                                      | The take was not recorded on an attached playing clock and no `atBeat` was given                                                                  | Pass `atBeat`, or attach the recorder to the clock before recording.                                                                                                      |
| `AudioRecorder punch needs fromBeat before toBeat, within one loop.`                                                                                                                                    | The region is empty, reversed or as long as the loop                                                                                              | Pass `fromBeat` < `toBeat`, shorter than the loop.                                                                                                                        |
| `AudioRecorder requires AudioWorklet support.` / `AudioRecorder worklet failed.`                                                                                                                        | Missing worklet support or processor failure                                                                                                      | Use a browser with AudioWorklet and inspect its audio processor error.                                                                                                    |
| `AudioRecorder AudioContext closed during recording.`                                                                                                                                                   | Caller closed the borrowed context mid-take                                                                                                       | Await `stop` or cancel the take before closing the context.                                                                                                               |
| `AudioRecorder time must be finite, non-negative seconds.` / `AudioRecorder stop must follow its start time.`                                                                                           | Invalid time, sub-frame length, or future Stop at/before the first frame                                                                          | Use finite non-negative seconds and at least one frame of capture. Past Stop times clamp to now; an invalid future Stop rejects only that request and preserves the take. |
| `AudioRecorder length must be positive seconds or a note value.` / `AudioRecorder requires a note value such as "4n" or "1m", got "…".`                                                                 | Invalid `length` or `quantize`                                                                                                                    | Use positive seconds, or `"<n>m"` / `"<n>n"` such as `"4m"`.                                                                                                              |
| `AudioRecorder record() takes `when`or`quantize`, not both.`                                                                                                                                            | Both an absolute time and a boundary were given                                                                                                   | Pass one.                                                                                                                                                                 |
| `AudioRecorder quantize needs clock.attach(recorder).` / `AudioRecorder length needs clock.attach(recorder).` (`InvalidStateError`)                                                                     | A bar or beat was asked of a recorder with no clock                                                                                               | `clock.attach(recorder)` first, or pass seconds.                                                                                                                          |
| `AudioRecorder quantize needs a playing clock.` / `AudioRecorder length needs a playing clock.` (`InvalidStateError`)                                                                                   | The attached clock is stopped or paused                                                                                                           | `clock.start()` first, or use `quantize: "none"` with a length in seconds.                                                                                                |
| `AudioRecorder already has an active take.` / `AudioRecorder has no started take to stop.`                                                                                                              | Record/stop lifecycle mismatch                                                                                                                    | `stop` or `cancel` the active take before recording another.                                                                                                              |
| `AudioRecorder stream needs a chunk writer.` (`TypeError`)                                                                                                                                              | `onChunk` is not a function.                                                                                                                      | Pass a chunk writer function, or omit `onChunk` for a buffered take.                                                                                                      |
| `AudioRecorder stop result does not match active take.` (`InvalidStateError`)                                                                                                                           | The Stop selector differs from the active recording mode.                                                                                         | Use `stop({ result: "span" })` for `record({ onChunk })`; use `stop()` for buffered `record()`.                                                                           |
| `AudioRecorder stream writer fell behind.`                                                                                                                                                              | More than 64 chunk writes remain pending                                                                                                          | Use a faster external writer or stop and retry with shorter takes.                                                                                                        |
| `AudioRecorder captured no frames.` / `AudioRecorder lost captured frames.` / `AudioRecorder lost captured frames: expected …`                                                                          | Missed interval or incomplete worklet transfer                                                                                                    | Preload `ready`, use future times, then retry the take.                                                                                                                   |
| `AudioRecorder render clock skipped more than two seconds.`                                                                                                                                             | Browser audio graph stopped running mid-take                                                                                                      | Retry while the AudioContext remains active; check device and browser load.                                                                                               |
| `AudioRecorder recording was cancelled.` (`AbortError`) / `AudioRecorder is disposed.`                                                                                                                  | Take cancelled (`cancel`, `signal`, a Stop at or before the first frame whose requested time is not future, a transport change) or owner disposed | Treat `AbortError` as cancellation, not an error UI; start a fresh take on a live recorder, or construct another owner.                                                   |
