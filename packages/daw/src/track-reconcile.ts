import { retainRackMacroTargets } from "./rack-preset";
import type { AudioClipGainAutomation, ProjectTrack } from "./model";
import type { TrackRuntime } from "./track-runtime";

/** Whether `after` differs from `before` only in gain automation; fills `edits` with those changes. */
export function collectGainAutomationEdits(
  before: ProjectTrack["clips"],
  after: ProjectTrack["clips"],
  edits: Map<string, AudioClipGainAutomation | undefined>,
): boolean {
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index++) {
    const old = before[index];
    const clip = after[index];
    if (old === clip) continue;
    if (
      old.kind !== "audio" ||
      clip.kind !== "audio" ||
      old.id !== clip.id ||
      old.time !== clip.time ||
      old.duration !== clip.duration ||
      old.sampleRate !== clip.sampleRate ||
      old.envelope !== clip.envelope ||
      old.stretch !== clip.stretch ||
      old.channels !== clip.channels ||
      old.media !== clip.media ||
      (old.media && clip.media && old.startFrame !== clip.startFrame)
    )
      return false;
    edits.set(clip.id, clip.gainAutomation);
  }
  return true;
}
export const deviceKeys = (track: ProjectTrack): readonly string[] =>
  track.devices.map((device) => `${device.id}\u0000${device.pluginId}\u0000${device.bundleUrl}`);

/** Bring a live track's effect rack in line with its Project track without rebuilding it. */
export function updateRack(runtime: TrackRuntime, track: ProjectTrack): void {
  const effectsChanged = runtime.effectSettings !== track.effects;
  if (runtime.macroSettings !== track.effectMacros) {
    const retained = effectsChanged ? retainRackMacroTargets(track.effects, runtime.macroSettings) : runtime.macroSettings;
    const valuesOnly =
      retained.length === track.effectMacros.length &&
      retained.every((old, i) => {
        const macro = track.effectMacros[i];
        return (
          old.id === macro.id &&
          old.label === macro.label &&
          old.targets.length === macro.targets.length &&
          old.targets.every((target, j) => target === macro.targets[j])
        );
      });
    if (!valuesOnly) {
      runtime.rack.setPreset({ effects: track.effects, macros: track.effectMacros });
    } else {
      if (effectsChanged) runtime.rack.setEffects(track.effects);
      for (const [i, macro] of track.effectMacros.entries()) {
        if (macro.value !== retained[i].value) runtime.rack.macro(macro.id)!.param.value = macro.value;
      }
    }
  } else if (effectsChanged) runtime.rack.setEffects(track.effects);
  runtime.effectSettings = track.effects;
  runtime.macroSettings = track.effectMacros;
}
