---
title: Clip Launcher
---

Tracks of clips launched on musical boundaries, from `@audiorective/launcher`. Signatures, option lists, defaults and units are in the package's type declarations (JSDoc on every member); this page holds what the types do not say. Modes, follow actions, tempo, pattern clips and the host hook are in [advanced](./launcher-advanced.md).

`ClipLauncher` owns playback. A track plays one clip at a time; launching replaces it on the next boundary, with no gap and no overlap. It borrows its time from a clock (`clock.attach(launcher)`) and imports only `@audiorective/core`.

## Layer 1: tracks of buffers

```ts
import { Clock } from "@audiorective/clock";
import { ClipLauncher } from "@audiorective/launcher";

const launcher = new ClipLauncher(
  { drums: [drumsA, drumsB], bass: [bassA, null, bassC] }, // one array per track; null leaves a slot empty
  { context, quantize: "1m" },
);
const clock = new Clock({ context, bpm: 120 });
clock.attach(launcher); // or workspace.transport.attach(launcher)
clock.start();

launcher.tracks.drums.clips[0].launch(); // clips[0] is the first slot; starts on the next bar
launcher.launchScene(1); // clips[1] of every track on one shared boundary
launcher.tracks.bass.stop(); // silence one track on the next boundary
launcher.stopAll();
```

A buffer plays once and the clip is then stopped; `loop: true` repeats it. Each track has an `output` (a `GainNode` joined to the destination until `track.connect(node)`), so gain, mute and effects are the app's. Boundaries are `"none"` (at once), `"4n"` (a beat), `"8n"`, `"1m"` (a bar of `clock.meter`) or `"2m"`; `launcher.quantize` is a cell, so a UI can change it at any time.

## Layer 2: per-clip options

```ts
const launcher = new ClipLauncher(
  {
    bass: [
      { buffer: loop, loop: true, quantize: "4n", gainDb: -3 },
      { buffer: loop, offsetBeats: 2, loop: { startBeat: 4, endBeat: 12 }, mode: "gate" },
      { sound: (ctx) => new OscillatorNode(ctx, { frequency: 110 }), length: "2m" }, // a voice made per start
    ],
  },
  { context },
);
const clip = launcher.tracks.bass.clips[0];
clip.gainDb.value = -6; // live
clip.pitch.value = 3; // semitones, live for a buffer
clip.configure({ quantize: "1m", loop: false }); // every other option
```

- **A clip is a buffer, a `sound` factory or a `scheduler`.** The factory returns an unconnected `AudioScheduledSourceNode` (or `{ source, output }`); the launcher starts, stops and connects it to the track. A `scheduler` is a `StepSequencer` or any clock scheduler (see [advanced](./launcher-advanced.md#pattern-clips)).
- **Material is in beats from its first beat.** A buffer's seconds become beats at its `bpm`, which defaults to the clock tempo when the clip is created. `offsetBeats` sets where the first pass starts; `loop` is `true` or a region `{ startBeat, endBeat }`; `length` is where a one-shot ends. One rule: the material is `[0, length)`, `loop` picks the part that repeats, `offsetBeats` only sets the start, `bpm` only converts seconds to beats.
- **Buffer clips follow the song tempo.** `warp` defaults to `"repitch"`: the playback rate is clock tempo / `bpm`, so a tempo change or a scene tempo speeds the clip up with the song and moves its pitch. Pass `warp: false` for a clip that must keep its own speed.
- **`quantize` per clip** overrides `launcher.quantize` for that clip's launch, stop and release. `launch({ quantize, legato })` overrides it for one call.
- **`track.stop()` quantize:** the explicit option, else the playing clip's `quantize`, else `launcher.quantize`.
- **`pitch` moves a buffer's playback rate live.** A `sound` factory reads it once, at the start; a `scheduler` clip ignores it.
- **`configure(patch)`** edits any option after construction; the JSDoc says when each takes effect (`loop` at the playing clip's next wrap, `mode`, `length`, `offsetBeats`, `bpm` and `warp` at its next start). It throws `RangeError` for `chance` outside 0..1, `repeatBeats` of 0 or less, or an empty loop.

## Layer 3: scenes, cancel and the wait

```ts
const launcher = new ClipLauncher(tracks, { context, scenes: [{ name: "Intro" }, { name: "Drop", tempo: 140 }] });
launcher.launchScene(1); // the clips in slot 1, and the tempo changes to 140 at that boundary
launcher.tracks.drums.cancelQueued(); // withdraw one track's waiting launch; what plays keeps playing
launcher.cancelQueued(); // withdraw every waiting launch, stop and scene tempo
```

- **One waiting launch per track.** Launching a track again replaces only that track's waiting launch; the playing clip is untouched until a boundary lands. A cancelled or replaced launch never sounds.
- **A scene lands every track on one boundary, sample-aligned**, and ignores each clip's own `quantize`. Empty slots are left alone. `launchScene([clipA, clipB])` starts exactly those clips.
- **Stopped transport:** launches made while the clock is stopped wait, survive `clock.start(when, offsetBeats)` and start exactly at `when`. Pause freezes everything and `resume()` continues; stop, seek and detach clear it all.
- **A one-shot ends at its exact end** (`ended` fires then, and the track is free).

## Layer 4: state and events

State is in read-only cells, so an effect or a framework hook tracks it like any other cell:

```ts
effect(() => render(launcher.queued.value, launcher.playing.value)); // every waiting launch (soonest first) and every playing clip
effect(() => (cellEl.dataset.state = clip.queued.value ? "queued" : clip.playing.value ? "playing" : "idle"));
// per clip: playing, queued, startsAt, startedAt, options; per track: playing, queued; position: read it each frame, it is not tracked
launcher.addEventListener("started", (event) => log(event.track.name, event.clip?.name, event.when, event.offsetBeats));
```

Events are `queued`, `started`, `ended`, `cancelled` and `skipped` (a `ClipEvent` with `track`, `clip`, `when`, `offsetBeats`); `started` and `ended` carry the exact audio time, delivered on the first clock tick at or after it. Commands (`launch`, `stop`, `launchScene`, `configure`, ...) never subscribe a calling effect.

## Standalone vs the DAW

`Workspace.session` is a launcher over a Project's audio tracks: its clips play through each track's devices and mixer strip. See [the DAW Session](./daw.md#clip-launcher). A grid view over a launcher is `mountClipGrid` in [widgets](./widgets.md).

## When not to use it

For lanes of steps use `StepSequencer`; for a one-off sound, a player. A launcher fits looping and one-shot material switched in time with a transport. For arrangement-style timelines use the DAW `Project`.

## Common errors

<!-- prettier-ignore -->
| Clip Launcher message | Cause and fix |
| --- | --- |
| `Clip Launcher requires a note value such as "4n" or "1m", got "…".` | A `quantize`, `length` or `follow.after` string is not a note value. Use `"none"`, `"4n"`, `"8n"`, `"1m"`, `"2m"` (`"1m"` is a bar of `clock.meter`). |
| `Clip Launcher requires chance in 0..1, got ….` | `chance` is a probability. Pass a number from 0 to 1. |
| `Clip Launcher requires repeatBeats above 0, got ….` | `repeatBeats` is the retrigger interval in beats of a `mode: "repeat"` clip. Pass a number above 0. |
| `Clip Launcher requires a loop with endBeat after startBeat.` | A loop region needs `endBeat > startBeat`, in material beats. |
