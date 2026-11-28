---
title: "Clip Launcher: advanced"
---

Deep topics for `ClipLauncher` from `@audiorective/launcher`: launch modes, follow actions, legato and probability, a rewrite hook, tempo and warp, pattern clips, the host hook and transport edge cases. Start with [Clip Launcher](./launcher.md) (layers 1-4 and the errors table).

## Launch modes

`mode` is how a clip reacts to the press that launches it:

- **`"trigger"`** (default) starts it. **`"toggle"`**: launching a playing or waiting clip stops it (a waiting launch is withdrawn). **`"gate"`**: plays while held; `clip.release()` ends it at the next boundary of the clip's `quantize`, and a gate released before it starts cancels its launch. **`"repeat"`**: restarts every `repeatBeats` (default 1) while held, until `release()`.
- **Without a press.** A scene (`launchScene`) or a follow has nothing to release. A gate clip started that way plays like a trigger clip (its loop, or its one-shot to the end); a repeat clip started that way retriggers every `repeatBeats` until the track is stopped or another clip replaces it. A scene launch never toggles a clip off.
- A grid cell does `pointerdown -> clip.launch()` and `pointerup -> clip.release()`.

## Follow actions, legato, chance

```ts
const options: ClipOptions = {
  buffer: loop,
  loop: true,
  follow: {
    after: "2m",
    next: [
      { clip: "next", weight: 70 },
      { clip: 0, weight: 20 },
      { clip: "stay", weight: 10 },
    ],
  },
};
```

- **`follow`:** `after` the clip's start one of `next` is picked by weight (relative, so weights summing to 100 read as percentages) and launched on the clip's track at that clip's `quantize`, replacing it. Targets are a slot index, `"next"`, `"previous"` (the track's filled slots, wrapping), `"random"` (another clip) or `"stay"`: nothing is launched. A looping clip re-arms its follow after a stay (it draws again one `after` later); a one-shot does not. A pending follow is cancelled when the clip is stopped, replaced by any launch on the track, or the clock stops or seeks; pause freezes it. After a legato start, `after` counts from the new clip's start beat.
- **`legato`** (clip option or `launch({ legato })`): the new clip starts where the playing one has reached at the boundary (its phase inside its loop), not at its `offsetBeats`.
- **`chance`** (0..1): a launch of this clip happens with that probability; a failed draw leaves what plays untouched and dispatches `skipped`. Every draw (`chance`, `follow`, `transform`) is a pure function of `options.seed`, the clip and the launch count, so a seed makes a run repeatable. A scene tempo is not subject to `chance`.

## Rewriting launches: `transform`

```ts
const launcher = new ClipLauncher(tracks, {
  context,
  transform: (launch, random) => (leadSolo.value && launch.track.name === "lead" && launch.clip ? { ...launch, quantize: "2m" } : launch),
});
```

It runs on every launch and stop before it is queued (`launch.source` says why: `"launch"`, `"scene"`, `"follow"`, `"release"`, `"repeat"` or `"stop"`). Return the request, change `quantize` for another boundary or `beat` for an exact one, or return `null` to drop it (`skipped`). While the clock is stopped `beat` and `when` are null.

## Tempo, scenes and warp

- A scene's `tempo` (a cell on `launcher.scenes[i].tempo`) becomes the clock tempo at the scene's boundary. Buffer clips follow it because `warp` defaults to `"repitch"` (rate = clock tempo / the clip's `bpm`, pitch moves with it); `clock.bpm` ramps are followed too. `bpm` defaults to the clock tempo when the clip is created, or when the launcher is attached for clips made before `clock.attach`. `warp: false` plays at the buffer's own speed; `bpm` then only describes its beat grid. There is no real-time stretch: `@audiorective/effects` `TimeStretch` is an offline `PCM -> PCM` processor, so a pre-stretched buffer is the app's job.
- A waiting boundary is fixed in beats: when the tempo changes, `when` moves with it and the `queued` cells show the new time. A `scene` boundary is one beat for every track.
- Material beats of a buffer are its seconds x `bpm` / 60 in `offsetBeats`, `loop`, `length`, `position` and `lengthBeats`; a `sound` factory or scheduler clip's beats are transport beats. `clip.duration` is one pass in seconds at the current tempo.

## Pattern clips

A `scheduler` clip plays a `StepSequencer` (or any clock scheduler) as a clip: `{ scheduler: new StepSequencer({ kick: "X..." }, { context }), loop: true, length: "1m" }`.

- The launcher routes the sound into the track for you: a sequencer's lanes connect to the clip's gain on the track (the caller does not call `lanes.x.connect`), another scheduler's `connect(node)` is called once. `gainDb` works; `pitch` is not applied.
- The scheduler sees windows whose beat 0 is the clip's start, so a loop is the sequencer's own loop or a `length` period. Do not also `clock.attach` it.
- Switching, stopping and replacing land on the boundary beat with no doubled or missing hit. Several pattern clips playing at once share the launcher's one scheduler on the clock; a switch inside the look-ahead retracts the launcher's events from the boundary (`handle.cancelFrom`) and feeds every playing pattern clip again. Another sequencer attached to the same clock is untouched. When a scheduler clip stops, is replaced or reaches the end of its material, the launcher cancels that clip's own events that reach the boundary or later, passing the boundary time to `event.cancel(time)`, so a `MidiClip` cuts a sounding note exactly there; other clips' events are not touched.
- Edits to a playing pattern re-queue the look-ahead through the sequencer's own `attached` handle.

## Sharing a transport

A launcher attached to a clock is one scheduler among others: a separate `StepSequencer` on the same clock keeps playing in sync. `launcher.dispose()` (also on `AbortSignal` abort) detaches only the launcher, silences its clips and removes its listeners; the clock keeps running.

## Host hook: `onSchedule`

```ts
const launcher = new ClipLauncher(tracks, {
  context,
  onSchedule: ({ track, clip, when, endsAt }) => ({
    cancel: () => undoWhatIDid(), // withdrawn, replaced or the tempo changed before `when`; onSchedule runs again after a tempo change
    commit: () => {}, // `when` has arrived
    reset: () => {}, // the track was silenced after it began: stop, seek, dispose, or the clip was removed by setClip
  }),
});
```

It is called once per launch or stop when the change is handed to the audio graph (a launch made while stopped is reported when it starts), so a host can switch other audio at the same boundary: `clip` is null for a stop and `endsAt` is the exact end of a one-shot. A tempo change while a change waits calls the old handle's `cancel()` and then `onSchedule` again with the new `when`; there is no separate reschedule call.

## Transport edge cases

- **Pause** freezes the launcher: clips go silent, waiting launches and pending follows keep their beats, `resume()` continues playing clips from the paused material position. No event is dispatched for a pause.
- **Stop, seek and detach** silence every clip (`ended` fires), cancel the waiting launches (`cancelled`) and clear pending follows. `clock.start()` while playing silences clips but keeps waiting launches.
- A launch exactly on a boundary starts at once, not on the next one.
- `track.setClip(index, spec)` replaces a slot; a playing or waiting clip that is replaced is stopped or withdrawn at once.
