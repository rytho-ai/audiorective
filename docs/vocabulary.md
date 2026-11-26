---
title: Vocabulary
---

One name and one unit per concept across `core`, `clock`, `effects`, `launcher`, `midi`, `host`, `player`, `recorder`, `widgets`, `daw` and `mcp`. When a name below fits your concept, use it; when you guess a name from this table it is the one the types use. `pnpm check:vocabulary` scans the shipped declarations for the forms in the last column.

## Time

| Concept                                      | Canonical name                                                                             | Unit and base                                                                                                                       | Not allowed                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| When a sound starts or an event takes effect | `when`, `atSeconds`; native-shaped `time`, `startTime`, `endTime`                          | Absolute `AudioContext` seconds. `when` is the first choice on anything that schedules; the `…Time` forms mirror a Web Audio method | `at`, `timestamp`, `startAt`, `stopAt`, `endAt`     |
| Position on the beat axis                    | `beat`, `startBeat`, `endBeat`, `atBeat`                                                   | Quarter-note beats, 0 is the origin (negative during a count-in). Meter changes do not change the unit                              | `beatNumber`, `beatPos`, `beatTime`                 |
| Position in seconds off the audio clock      | `seconds`, `startSeconds`, `endSeconds`                                                    | Seconds on the project, source or view axis the owner names (pause-aware transport seconds, project seconds, source seconds)        | `Sec`, `Secs`, `InSeconds` suffixes                 |
| Extent of an event, clip or note             | `duration`; `durationBeats` or `durationSeconds` when one type holds both                  | Beats for MIDI notes and clips, seconds for audio; the owner's JSDoc says which                                                     | `lengthSeconds`, `lengthMs`, `len`                  |
| Looped or requested material extent          | `length`, `lengthBeats`, `loopBeats`                                                       | Beats (or a `"2m"`/`"4n"` note value where the type says so); frames only in `frameCount`                                           | `lengthSeconds`, `lengthMs`                         |
| Offset into material                         | `offset`, `offsetBeats`, `sourceOffset`                                                    | Beats for clips and launcher material, seconds for audio sources; JSDoc states it                                                   | `offsetMs`, `startOffset`                           |
| Silence appended after the last event        | `tailSeconds`                                                                              | Seconds                                                                                                                             | `tail`, `tailMs`, `tailTime`, `tailBeats`           |
| Material rendered before a range             | `prerollSeconds`                                                                           | Seconds                                                                                                                             | `preroll`, `prerollMs`, `prerollBeats`              |
| Scheduling look-ahead                        | `lookAhead`                                                                                | Seconds. A clock's tick window and a dynamics effect's detector window share the name                                               | `lookahead`, `lookaheadMs`                          |
| Wall-clock timers                            | `intervalMs`, `timeoutMs`, `waitMs`, `reconnectMs`                                         | Milliseconds, only for timers and network waits. Audio quantities are never milliseconds                                            | `…Ms` on anything audible, `Millis`, `Msec`         |
| Ranges                                       | `start`/`end`, `startBeat`/`endBeat`, `startFrame`/`endFrame`, `BeatRange`, `SecondsRange` | Half-open `[start, end)`: the start is inside, the end is not                                                                       | `begin`, `stopBeat`, `stopTime`; closed ranges      |
| Tempo                                        | `bpm`                                                                                      | Quarter-note beats per minute                                                                                                       | `tempoBpm`, `beatsPerMinute`, `BPM`                 |
| Bars and steps                               | `bar`, `beatInBar`, `index`, `step`                                                        | Zero-based: bar 0 and beat 0 come first; a step `index` counts from 0                                                               | `barNumber`, `beatNumber`, `stepNumber` (one-based) |

A parameter or property named `time`, `offset`, `duration`, `position` or `length` that holds a number states its unit in its own JSDoc or in its owner's (`pnpm check:vocabulary` fails on a bare one). Do not add a unit to the name when the owner has a single unit; add it (`durationBeats`) when one type carries two.

## Level, pitch, signal

| Concept             | Canonical name                         | Unit and range                                                                                     | Not allowed                                    |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Linear amplitude    | `gain`                                 | Linear factor, 1 is unity                                                                          | `vol`, `amp`, `amplitude`, `gainLinear`        |
| Decibels            | `gainDb`, `peakDbFS`, `minDb`, `maxDb` | dB; `Db` suffix, `dbToGain` and `gainToDb` convert                                                 | `gainDB`, `volumeDb`, `dB…`, `Decibels` suffix |
| User volume control | `volume`                               | 0..1 linear                                                                                        | `volumePercent`, `level` for a control         |
| Pan                 | `pan`                                  | -1 (left) to 1 (right)                                                                             | `panning`, `panValue`, `balance`               |
| Velocity            | `velocity`                             | 0..1 everywhere; 0..127 exists only on MIDI wire and file data, converted at that boundary         | `vel`, `velocity127`, JSDoc that says 0-127    |
| Pitch               | `pitch`, `note`                        | MIDI note number, 60 is middle C; a `note` argument may also be a name such as `"C4"`              | `midiNote`, `midiPitch`, `pitchNumber`         |
| Sample rate         | `sampleRate`                           | Hertz                                                                                              | `samplerate`, `sr`, `fs`, `sampleRateHz`       |
| Frames              | `frameCount`, `startFrame`, `endFrame` | Sample frames per channel, half-open                                                               | `numFrames`, `nFrames`, `framesCount`          |
| Channels            | `channelCount`                         | Integer count                                                                                      | `numChannels`, `nChannels`, `numberOfChannels` |
| Latency             | `latency`                              | Samples (a `Param<number>` on every processor); `inputLatencySeconds` is the measured seconds form | `latencyMs`, `delayMs`                         |

## Lifecycle and state

| Concept                   | Canonical name                                               | Meaning                                                                                           | Not allowed                                                  |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Teardown                  | `dispose()`, `[Symbol.dispose]()`                            | Releases everything the object owns; safe to call twice                                           | `destroy`, `teardown`, `unmount`, `free`, `cleanup`          |
| Cleanup of a registration | the `() => void` that `subscribe`, `attach` and `on…` return | Call it to stop listening; there is no separate remove method                                     | `unsubscribe()`, `off()`                                     |
| Observable state          | `cells` (`ReadonlyCell`), `params` (`Param`)                 | The only store; read `.value`, subscribe with `subscribe`; write only through the owner's methods | mirrored private fields, `getState()` as the source of truth |

## Where the vocabulary bends

- `Decibels` in `AnalyserOptions.minDecibels` and `maxDecibels` mirrors the native `AnalyserNode`; `StretchOptions.blockMs` mirrors the Signalsmith Stretch configuration. Both are listed in `scripts/check-vocabulary.exceptions.json` with that reason.
- Native-shaped methods keep Web Audio's argument names (`setValueAtTime(value, time)`, `cancelScheduledValues(cancelTime)`); their JSDoc says the unit.
