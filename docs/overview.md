---
title: Overview
---

Audiorective is a modular toolkit for Web Audio applications. Use it to build instruments, sequencers, spatial scenes, visualizers, and audio tools.

The audio engine owns its state. Your interfaces observe parameters, change values, and call methods. React components and canvas or 3D views can control the same engine without separate copies of that state.

## Choose your packages

| Package                        | What it provides                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [Core](/docs/core)             | Reactive parameters and cells, processors, playback, analysis, spatial audio, and graph routing          |
| [Clock](/docs/clock)           | Transport, tempo automation, scheduling windows, and beat/bar/time rulers                                |
| [Effects](/docs/effects)       | Filters, delay, reverb, distortion, modulation, pitch shifting, dynamics, channel strips, and send buses |
| [Widgets](/docs/widgets)       | Browser waveform/piano-roll display, shared selection, audition and custom drawing                       |
| [Blocks](/docs/blocks)         | Headless audio recording, WavePlayer, cancellable grouped sample hits, and pure MidiSequence note data   |
| [React](/docs/react)           | Hooks and an engine context for reactive interfaces                                                      |
| [Three.js](/docs/threejs)      | A shared audio context and spatial sound that follows scene objects                                      |
| [PlayCanvas](/docs/playcanvas) | Engine integration and entity-to-panner bindings                                                         |
| [Devtools](/docs/devtools)     | Processor latency measurement and assertions                                                             |

[PixiJS](/docs/pixijs) uses core directly; it does not need a dedicated binding package. Other imperative interfaces can also observe and change the engine's state.

## Playback and sound

Choose a source for the job:

- **Sampler** plays polyphonic one-shots, with per-voice fades, reverse playback, and mute controls.
- **BufferPlayer** plays in-memory loops and stems with sample-accurate scheduling and a schedulable playback rate.
- **FilePlayer** streams longer tracks with play, pause, and seek.
- **AudioProcessor** is the base for your own instruments and effects.

Route sources through effects, add a `Spatial` processor for positional sound, and use `Analyser` for waveform or frequency data. See [Choosing Playback](/docs/choosing-playback).

## Waveform tools

Mount a complete waveform selector into a DOM element to load a URL or File, select a range, and audition it through your own audio context and routing. For a visual-only view, provide peaks and an external playhead, then attach optional selection or marker plugins. See [Widgets](/docs/widgets) and the [waveform showroom](/showroom/waveform).

## Timing and automation

Use the clock for transport and look-ahead scheduling. Rulers express positions as bars, beats, cycles, or seconds. Tempo supports scheduled changes and ramps.

Audio parameters use the Web Audio `.value` and scheduling conventions. Native-backed parameters delegate automation to the audio thread and update reactive values for the interface. See [Clock](/docs/clock) and [Core](/docs/core).

## Routing, latency, and offline rendering

`defineGraph` connects processors from a reactive list of edges. When the graph changes, it updates the connections and compensates unequal processing latency where paths join.

Use `renderOffline` for a graph or `renderTimeline` for clock-driven audio. Both let you render audio without real-time playback. Devtools checks whether a processor's measured latency matches its declared latency.

## Start building

Follow [Get Started](/docs/get-started) for a runnable sound, or [Installation](/docs/installation) to choose packages. The [showroom](/showroom) contains working examples and source links.

Audiorective's audio engine runs in the browser. For Astro, Next.js, or other server-rendered frameworks, keep audio code behind a [client-only boundary](/docs/client-boundary).

### MIDI notes and piano roll

Use the pure `blocks/midi` entry to parse SMF note data, preserve source-tempo coordinates, edit notes and share a selection. Mount independent piano-roll views through `widgets/piano-roll`; the caller chooses instruments and playback. See [MIDI and Piano Roll](/docs/midi) and the [showroom](/showroom/piano-roll).
