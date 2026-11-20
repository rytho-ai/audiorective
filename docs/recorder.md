---
title: Audio Recorder
---

PCM take capture from `@audiorective/blocks/recorder`. Part of [Blocks](./blocks.md).

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

## Common errors

| Message                                                                                                                                            | Cause                                          | Fix                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| `AudioRecorder channels must be an integer from 1 to 32.`                                                                                          | Invalid channel option                         | Choose an integer channel count from 1 to 32.                               |
| `AudioRecorder requires AudioWorklet support.` / `AudioRecorder worklet failed.`                                                                   | Missing worklet support or processor failure   | Use a browser with AudioWorklet and inspect its audio processor error.      |
| `AudioRecorder AudioContext closed during recording.`                                                                                              | Caller closed the borrowed context mid-take    | Await `stop` or cancel the take before closing the context.                 |
| `AudioRecorder time must be finite, non-negative seconds.` / `AudioRecorder stop must follow its start time.`                                      | Invalid scheduled capture interval             | Pass ordered absolute AudioContext seconds.                                 |
| `AudioRecorder already has an active take.` / `AudioRecorder has no started take to stop.`                                                         | Start/stop lifecycle mismatch                  | Await `start`, then `stop` or `cancel` before starting another take.        |
| `AudioRecorder stream needs a chunk writer.` / `AudioRecorder streaming take needs stopStream().` / `AudioRecorder has no started stream to stop.` | Streaming call mismatch                        | Pass a writer to `startStream`, then finish that take with `stopStream`.    |
| `AudioRecorder stream writer fell behind.`                                                                                                         | More than 64 chunk writes remain pending       | Use a faster external writer or stop and retry with shorter takes.          |
| `AudioRecorder captured no frames.` / `AudioRecorder lost captured frames.` / `AudioRecorder lost captured frames: expected …`                     | Missed interval or incomplete worklet transfer | Preload `ready`, use future times, then retry the take.                     |
| `AudioRecorder render clock skipped more than two seconds.`                                                                                        | Browser audio graph stopped running mid-take   | Retry while the AudioContext remains active; check device and browser load. |
| `AudioRecorder recording was cancelled.` (`AbortError`) / `AudioRecorder is destroyed.`                                                            | Take cancelled or owner destroyed              | Start a fresh take on a live recorder, or construct another owner.          |
