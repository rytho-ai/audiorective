import { readonlyCell, type Readable } from "@audiorective/core";
import {
  mountLevelMeter,
  mountMixer,
  type LevelMeterHandle,
  type LevelMeterPCMSource,
  type LevelMeterSource,
  type LevelSnapshot,
  type MixerMeter,
  type MixerOptions,
  type MixerState,
  type MixerStrip,
  type MixerStripSettings,
} from "../src";

export function meterSourcesArePublic(root: HTMLElement, peak: Readable<number>, analyser: AnalyserNode): LevelMeterHandle[] {
  const callback: LevelMeterSource = () => peak.value;
  const pcm: LevelMeterPCMSource = {
    sampleCount: analyser.fftSize,
    read: (samples) => analyser.getFloatTimeDomainData(samples),
  };
  const meter = mountLevelMeter(root, { source: callback });
  const snapshot: LevelSnapshot = meter.getLevel();
  const knownOrUnknown: number | null = snapshot.rms;
  // @ts-expect-error A scalar peak does not provide measured RMS.
  const inventedRms: number = snapshot.rms;
  // @ts-expect-error Snapshots are read-only.
  snapshot.peak = 0;
  void [knownOrUnknown, inventedRms];
  // @ts-expect-error PCM options belong inside source; the superseded flat form is not accepted.
  mountLevelMeter(root, { sampleCount: 64, read: (samples: Float32Array<ArrayBuffer>) => samples.fill(0) });
  // @ts-expect-error dBFS callbacks return numbers, not PCM snapshots.
  mountLevelMeter(root, { source: () => ({ peak: 1, rms: 1 }) });
  return [meter, mountLevelMeter(root, { source: pcm })];
}

export function mixerUsesOwnerProjection(
  root: HTMLElement,
  owner: Readable<readonly MixerStrip[]>,
  apply: (id: string, patch: Partial<MixerStripSettings>) => void,
  peak: Readable<number>,
): void {
  const state = readonlyCell<MixerState>(() => ({ tracks: owner.value }));
  const borrowed: MixerMeter = { source: () => peak.value };
  const options: MixerOptions = { state, editTrack: apply, meter: () => borrowed };
  mountMixer(root, options);
  const supported: MixerStripSettings = { volume: 1, pan: 0 };
  const withMute: MixerStripSettings = { ...supported, muted: false };
  options.editTrack("track", { solo: true });
  // @ts-expect-error Track identity cannot be changed through a settings patch.
  options.editTrack("track", { id: "replacement" });
  // @ts-expect-error Meter readers use the shared source contract.
  const oldMeter: MixerMeter = { sampleCount: 64, read: () => {} };
  void [withMute, oldMeter];
}
