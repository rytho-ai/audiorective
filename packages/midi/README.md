# @audiorective/midi

MIDI notes that play in time with a clock. The root entry is pure JavaScript and works without DOM or Web Audio globals: `MidiClip`, `parseMidi`, `midiGrid`, `visibleMidiNotes` and `compileMidiPlaybackEvents`.

A note is `{ id, pitch, velocity, start, duration, channel }` with velocity 0..1 and times in beats. `MidiClip` is the note model and a clock scheduler: `clock.attach(clip)` plays it into an instrument (a core `Sampler`, a `WebClapHost`, or any object with `noteOn(note, { velocity, when, channel })` and `noteOff(note, when)`), and `clip.edit(draft => ...)` changes it in one commit while it plays.

```typescript
import { MidiClip } from "@audiorective/midi";

const clip = new MidiClip([{ pitch: 60, velocity: 0.8, start: 0, duration: 1 }], { instrument: sampler, loop: true, length: "1m" });
clock.attach(clip);
```

Import `MidiRecorder` and `MidiKeyboard` from `@audiorective/midi/web`. `MidiRecorder` mirrors `AudioRecorder`: `clock.attach(recorder)`, then `await recorder.record({ quantize: "1m", length: "4m" })` resolves a `MidiTake` whose `notes` feed `new MidiClip(take.notes)`. `MidiKeyboard.open(context, { instrument })` plays every Web MIDI input live, with sustain pedal and hot-plug. The app owns permission, the instrument and the `AudioContext`.

See [MIDI and Piano Roll](../../docs/midi.md) for recording, live play, files, playback projection and the piano-roll widget.
