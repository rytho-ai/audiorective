# @audiorective/midi

MIDI event and note-data tools for Audiorective. The root entry is pure JavaScript: `parseMidi`, `midiGrid`, `tickToSeconds`, `visibleMidiNotes`, `MidiSequence` and `compileMidiPlaybackEvents` work without DOM or Web Audio globals. `MidiSequence` owns immutable note and selection snapshots; the compiler combines edited notes with captured control messages in stable order.

Import `MidiRecorder` from `@audiorective/midi/web` for a browser take. It borrows a caller-selected `MIDIInput` and running `AudioContext`, preserves raw messages and returns take-relative notes with absolute audio-clock placement. The app owns permission, device selection, live instrument routing and clip placement. The recorder does not synthesize sound or extend notes for sustain pedal; the instrument interprets controls during playback.

See [MIDI and Piano Roll](../../docs/midi.md) for recording, editing, playback projection and the piano-roll widget.
