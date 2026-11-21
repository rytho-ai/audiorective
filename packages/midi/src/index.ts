/** Pure MIDI note data, the playable `MidiClip`, file parsing and playback-event projection. No DOM, no AudioContext. */
export type { MidiNote, NoteInit, DraftNote, MidiRange, MidiData, ParsedMidi, Instrument, MidiTake, MidiTakeEvent } from "./midi-data";
export { visibleMidiNotes, noteBeats } from "./midi-data";
export { parseMidi } from "./midi-file";
export { midiGrid } from "./midi-grid";
export { compileMidiPlaybackEvents } from "./midi-playback";
export type { MidiPlaybackSource, MidiPlaybackSourceEvent, MidiPlaybackEvent } from "./midi-playback";
export { MidiClip } from "./MidiClip";
export type { MidiClipOptions, ClipLength, ClipResetReason, ClipWindow, ClipTransport, ClipTransportChange } from "./MidiClip";
