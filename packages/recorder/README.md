# @audiorective/recorder

Headless PCM take capture for Audiorective. `AudioRecorder` captures short takes from a caller-connected input through an AudioWorklet and returns the actual AudioContext start/end sample frames; the caller owns microphone permission, monitor routing, latency calibration and take placement. Depends only on `@audiorective/core`. See [Record an audio take](../../docs/recorder.md#record-an-audio-take).
