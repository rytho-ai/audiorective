/** The Project model and its pure helpers. Loads without a DOM or AudioContext. */
export { Project, MidiClip, audioClipSourceDuration, audioClipTimeMap } from "./model";
export type {
  ProjectMidiData,
  ProjectOptions,
  ProjectContent,
  ProjectTrack,
  ProjectClip,
  ProjectAudio,
  ProjectMidiEvent,
  AudioClip,
  AudioClipSource,
  AudioClipStretch,
  AudioClipGainAutomation,
  PcmAudioSource,
  MediaAudioSource,
  PcmAudioClip,
  MediaAudioClip,
  TrackKind,
  BusRole,
  TrackRouting,
  ProjectSend,
  ProjectDevice,
  WebClapDevice,
} from "./model";
export type { ClipTimeMap, ClipStretchAnchor } from "./clip-time-map";
export { clipGainAt, normalizeClipEnvelope, unityClipEnvelope } from "./clip-envelope";
export type { ClipEnvelope } from "./clip-envelope";
export type { RackEffect, RackFilter, RackDelay, RackEq, RackMacroMapping, RackMacroParameter, RackMacroSettings, RackPreset } from "./rack-preset";
export { rackMacroRange } from "./rack-preset";
export { TempoMap } from "./tempo-map";
export type { TempoChange } from "./tempo-map";
export { AudioMedia, AudioMediaWriter } from "./media";
export type { AudioMediaStorage, AudioMediaChunk, AudioMediaSpan } from "./media";
