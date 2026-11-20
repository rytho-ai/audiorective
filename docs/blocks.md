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

## Reference pages

- [WavePlayer](./player.md): range playback, selection, loading, offline stretch and shared views.
- [Audio Recorder](./recorder.md): PCM take capture.
- [Pad Bank](./pads.md): sample hits with choke groups.
- [Step Sequencer](./sequencer.md): step patterns, lanes, transforms and the standalone drum machine.
- [Step Sequencer: advanced](./sequencer-advanced.md): the explicit form, `refreshOnEdit`, transform sockets, custom per-step params and the standalone drum machine.
- [Sample Library](./samples.md): imported sample storage and previews.
- [Clip Launcher](./launcher.md): quantized clip launching.

Each page ends with its own Common errors table.
