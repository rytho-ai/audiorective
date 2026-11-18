/** Headless audio workflows; views are supplied separately. */
export { WavePlayer } from "./WavePlayer";
export { InstrumentEvents } from "./InstrumentEvents";
export type { EventPad, InstrumentEvent } from "./InstrumentEvents";
export { AudioRecorder } from "./AudioRecorder";
export type { AudioRecorderOptions, AudioRecorderState, RecordedAudio, RecordedAudioSpan, RecordedAudioChunk } from "./AudioRecorder";
export type { WaveLoadProgress, WaveSourceLoader } from "./source";
export type {
  AudioRange,
  WavePlayerSource,
  WavePlayerState,
  WavePlayerCells,
  WavePlayerOptions,
  WavePlayOptions,
  WaveStretchProcessor,
  PlaybackVersion,
} from "./WavePlayer";
export { ClipLauncher } from "./ClipLauncher";
export type { ClipLaunch, QueuedClipLaunch, ClipLauncherState, ClipLaunchTransition, ClipLaunchTransport } from "./ClipLauncher";
export { SampleLibrary } from "./SampleLibrary";
export type { SampleLibraryOptions, SampleLibraryState, SampleLease, SampleRow } from "./SampleLibrary";
export { StepSequencer } from "./StepSequencer";
export type { StepHit, StepLane, StepPattern, StepTiming, StepWindow } from "./StepSequencer";
export { clipGainAt, normalizeClipEnvelope, scheduleClipEnvelope, unityClipEnvelope } from "./clip-envelope";
export type { ClipEnvelope } from "./clip-envelope";
