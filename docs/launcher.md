---
title: Clip Launcher
---

Quantized clip launching from `@audiorective/launcher`.

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
import { ClipLauncher, type ClipLaunch, type ClipLaunchTransition } from "@audiorective/launcher";
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

| Clip Launcher message                                   | Fix                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Clip Launcher requires a non-negative launch quantum.` | Use a finite number of beats, or 0 to launch at the current audio time.                                      |
| `Clip Launcher requires one launch per affected track.` | Supply a non-empty group with unique track IDs.                                                              |
| `Clip Launcher requires a future audio time.`           | Use a running transport whose beat-to-time mapping advances past the current audio time (a quantum above 0). |
