/** Pure MIDI note data, the playable `MidiClip`, file parsing and playback-event projection. No DOM, no AudioContext. */
export type {
  MidiNote,
  NoteInit,
  DraftNote,
  NoteDraft,
  MidiRange,
  MidiData,
  ParsedMidi,
  ParsedMidiTrack,
  MidiFileEvent,
  Instrument,
  MidiTake,
  MidiTakeEvent,
} from "./midi-data";
export { visibleMidiNotes, noteBeats } from "./midi-data";
export { parseMidi } from "./midi-file";
export { writeMidi } from "./midi-writer";
export type { WriteMidiInput, MidiWriteTrack } from "./midi-writer";
export { midiGrid } from "./midi-grid";
export { controllerRestValue, restOf as controllerRestOf, controllerStateKey, chaseMessages } from "./midi-rest";
export type { RestExpression } from "./midi-rest";
export { compileMidiPlaybackEvents } from "./midi-playback";
export type { MidiPlaybackSource, MidiPlaybackSourceEvent, MidiPlaybackEvent } from "./midi-playback";
export { MidiClip, claimController } from "./MidiClip";
export type {
  MidiClipOptions,
  ClipMessage,
  NoteHit,
  NoteTransform,
  ClipLength,
  ClipResetReason,
  ClipWindow,
  ClipTransport,
  ClipTransportChange,
} from "./MidiClip";
