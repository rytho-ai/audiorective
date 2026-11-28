# @audiorective/daw

Project ownership, browser playback and a narrow DAWproject 1.0 save/open workflow for audio, MIDI and WebCLAP devices. Import `@audiorective/daw/project` (model) and `@audiorective/daw/dawproject` (codec) in Node.js or the browser without audio; `@audiorective/daw/runtime` exposes `Workspace`, which borrows an `AudioContext` for playback; the root entry re-exports all three and adds `openWorkspace` and `saveWorkspace`. See [DAW project, runtime and DAWproject](../../docs/daw.md) for the API, file contents and supported scope.

`Project.tempoMap` converts project beats and seconds; step changes persist as DAWproject `TempoAutomation`. Audio clips stay anchored in seconds; MIDI clips are in beats, so their notes and controllers stretch with tempo. `Project.clipTimeSeconds()` maps either kind to the arrangement's second axis.
