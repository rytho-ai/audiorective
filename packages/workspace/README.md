# @audiorective/workspace

Project ownership, browser playback and a narrow DAWproject 1.0 save/open workflow for audio, MIDI and WebCLAP devices. The `Project` model and codec work without browser audio; `Workspace` borrows an `AudioContext` for playback. See [Workspace and DAWproject](../../docs/workspace.md) for the API, file contents and supported scope.

`Project.tempoMap` converts project beats and seconds; step changes persist as DAWproject `TempoAutomation`. Audio and legacy MIDI clips stay anchored in seconds. Add MIDI with `{ timeUnit: "beats" }` to stretch its notes and controllers with tempo; `Project.clipTimeSeconds()` maps either kind to the arrangement's second axis.
