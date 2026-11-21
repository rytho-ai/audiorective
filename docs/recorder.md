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
const take = await recorder.stop(); // the same take `recording` resolves with
// take.channels, sampleRate, startFrame/endFrame, startTime/endTime and startBeat are ready for the clip owner.

mic.dispose(); // stops every track and releases the device; `using mic = ...` does the same
recorder.dispose();
```

`record(options?)` returns `Promise<RecordedAudio>`. `when` is absolute AudioContext seconds (default now; a time already past starts at the first available frame). `length` is seconds, or a note value such as `"4m"` (see below); without it the take runs until `stop({ when? })`. `signal` discards the take with `AbortError`, like `cancel()`. `stop()` ends the take early and resolves `record()` with what was captured; `cancel()` discards it and rejects `record()` with `AbortError`, so an app's Stop button calls `stop()`. `stop` while the capture graph is still being built ends the take as soon as it starts, and on a take with `length` it can only shorten it. `await recorder.ready` preloads the AudioWorklet before a precise start. An `OfflineAudioContext` renders only what is armed: wait for `cells.startsAt` to be non-null before `startRendering()`.

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
take.startBeat; // the bar line's beat (a multiple of 4 in 4/4), to place the take on a track
take.startTime; // the same instant on the audio clock
detach();
```

`quantize` is `"none"` (default), `"1m"` (the next bar of `clock.meter`), `"2m"`, or a note value such as `"4n"` (the next beat); a call exactly on a boundary starts there, like the launcher, otherwise the boundary is the first one at least 50 ms ahead, so the capture graph exists before it. `length: "4m"` is measured from the start at the clock's tempo. Start and end land on the frames of those instants (`startFrame` is the ceiling of the boundary time in frames). Both note values need the attached clock; `quantize` also needs it playing. During a count-in (negative beats, `clock.start(when, -4)`) a quantized start can land inside the count-in; to start at bar 1 pass `when: clock.timeline.beatToTime(0)` instead of `quantize`. `take.startBeat` is the clock beat at `startTime` whenever the recorder is attached to a playing clock, else `null`. Leaving the transport (stop, pause, seek, detach) before a quantized start arrives cancels that take with `AbortError`; a take already recording continues. `cells.startsAt` and `cells.startedAt` read like the launcher's.

### Observing a take

`cells.state` is a read-only `"idle" | "armed" | "recording" | "stopping" | "disposed"`; `cells.error` is the last failed take's message and clears on a new `record`; `cells.startsAt` is the AudioContext time an armed take starts at, and `cells.startedAt` the time the capture began (each `null` otherwise). Only one take may be active at a time. Closing a live AudioContext during capture fails the take. `dispose()` ends an active take, detaches from the clock and leaves borrowed sources, streams and the context running; `options.signal` calls it on abort, and `[Symbol.dispose]()` is the same call. The private worklet reaches the destination through a zero-gain sink so it processes input without adding to caller monitoring.

## Microphone input

`MicrophoneInput.open(context, { audio?, signal? })` wraps `getUserMedia({ audio })` (`audio` defaults to `true`; pass `MediaTrackConstraints` such as `{ deviceId, echoCancellation: false }`) and resolves with an `AudioProcessor` whose `output` is the stream's source node. Connect it like any node or processor: `mic.connect(recorder)`.

- **Permission and device errors** reject with the `DOMException` `getUserMedia` raised, unchanged: `NotAllowedError` (the user denied it), `NotFoundError` (no microphone), `NotReadableError` (the device is busy), `OverconstrainedError`, `SecurityError`. Branch on `error.name`.
- **Monitoring** is a writable cell: `mic.cells.monitoring.value = true` routes the input to `context.destination` (default off). The recorder's input stays unaffected, so the monitor is never in the take. Use headphones, or `echoCancellation` stays on by default and cuts speaker feedback.
- **`mic.cells.state`** is `"live"` until every track ends (for example the device is unplugged) or the input is disposed, then `"ended"`.
- **Release:** `mic.dispose()` (or `[Symbol.dispose]()`) stops every track. An `AbortSignal` rejects `open` with its reason, stops a stream that arrives late, and after open calls `dispose()`.

## Long takes

Normal `record()` accumulates PCM in memory and suits short takes. For long captures, call `startStream(writeChunk, { when? })` and `stopStream({ when? })` instead. The callback receives ordered `{ startFrame, channels }` chunks, each with up to 4096 frames, and writes them to caller-owned storage. `stopStream()` waits for accepted writes and returns `{ channelCount, sampleRate, startFrame, endFrame, startTime, endTime }` without returning the full PCM. When the browser skips a short render interval, the result includes `dropouts` with absolute frame ranges and the skipped samples become silence; a gap longer than two seconds rejects. Check `dropouts` before treating a take as lossless. At most 64 pending writes are allowed; a slower writer fails the take instead of growing the recorder's queue without bound. The callback owns any external file or database and must preserve chunk order when writes complete asynchronously. `@audiorective/daw/project` provides `AudioMediaWriter` and `Project.addAudioMediaClip` to turn these chunks into file-backed, editable project clips; see [DAW project and runtime](./daw.md#long-audio-takes-and-media-ownership). AudioWorklet registration uses a Blob URL and needs compatible Content Security Policy settings.

The result preserves the audio clock's raw sample positions. A Track/Clip owner places takes against transport time and applies any measured input/monitor latency adjustment; the recorder does not guess a round-trip offset. `MediaRecorder` can still be suitable for a simple voice memo, but its chunk intervals are not the alignment contract used here.

## Common errors

| Message                                                                                                                                            | Cause                                                                     | Fix                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `SecurityError` from `MicrophoneInput.open`                        | `getUserMedia` refused: permission denied, no device, device busy         | Branch on `error.name` and tell the user; ask again from a click.           |
| `MicrophoneInput needs navigator.mediaDevices.getUserMedia (a secure context).` (`NotSupportedError`)                                              | Insecure page or an environment without `mediaDevices`                    | Serve over https or localhost.                                              |
| `MicrophoneInput is disposed.`                                                                                                                     | `connect` after `dispose`                                                 | Open a new input.                                                           |
| `AudioRecorder channels must be an integer from 1 to 32.`                                                                                          | Invalid channel option                                                    | Choose an integer channel count from 1 to 32.                               |
| `AudioRecorder requires AudioWorklet support.` / `AudioRecorder worklet failed.`                                                                   | Missing worklet support or processor failure                              | Use a browser with AudioWorklet and inspect its audio processor error.      |
| `AudioRecorder AudioContext closed during recording.`                                                                                              | Caller closed the borrowed context mid-take                               | Await `stop` or cancel the take before closing the context.                 |
| `AudioRecorder time must be finite, non-negative seconds.` / `AudioRecorder stop must follow its start time.`                                      | Invalid scheduled capture interval                                        | Pass ordered absolute AudioContext seconds.                                 |
| `AudioRecorder length must be positive seconds or a note value.` / `AudioRecorder requires a note value such as "4n" or "1m", got "…".`            | Invalid `length` or `quantize`                                            | Use positive seconds, or `"<n>m"` / `"<n>n"` such as `"4m"`.                |
| `AudioRecorder record() takes `when`or`quantize`, not both.`                                                                                       | Both an absolute time and a boundary were given                           | Pass one.                                                                   |
| `AudioRecorder quantize needs clock.attach(recorder).` / `AudioRecorder length needs clock.attach(recorder).` (`InvalidStateError`)                | A bar or beat was asked of a recorder with no clock                       | `clock.attach(recorder)` first, or pass seconds.                            |
| `AudioRecorder quantize needs a playing clock.` / `AudioRecorder length needs a playing clock.` (`InvalidStateError`)                              | The attached clock is stopped or paused                                   | `clock.start()` first, or use `quantize: "none"` with a length in seconds.  |
| `AudioRecorder already has an active take.` / `AudioRecorder has no started take to stop.`                                                         | Record/stop lifecycle mismatch                                            | `stop` or `cancel` the active take before recording another.                |
| `AudioRecorder stream needs a chunk writer.` / `AudioRecorder streaming take needs stopStream().` / `AudioRecorder has no started stream to stop.` | Streaming call mismatch                                                   | Pass a writer to `startStream`, then finish that take with `stopStream`.    |
| `AudioRecorder stream writer fell behind.`                                                                                                         | More than 64 chunk writes remain pending                                  | Use a faster external writer or stop and retry with shorter takes.          |
| `AudioRecorder captured no frames.` / `AudioRecorder lost captured frames.` / `AudioRecorder lost captured frames: expected …`                     | Missed interval or incomplete worklet transfer                            | Preload `ready`, use future times, then retry the take.                     |
| `AudioRecorder render clock skipped more than two seconds.`                                                                                        | Browser audio graph stopped running mid-take                              | Retry while the AudioContext remains active; check device and browser load. |
| `AudioRecorder recording was cancelled.` (`AbortError`) / `AudioRecorder is disposed.`                                                             | Take cancelled (`cancel`, `signal`, a transport change) or owner disposed | Start a fresh take on a live recorder, or construct another owner.          |
