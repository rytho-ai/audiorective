import { effect, untracked } from "@audiorective/core";
import type { WavePlayer } from "../src/WavePlayer";

/** A plain snapshot of everything a WavePlayer exposes through its cells, for `toMatchObject` assertions. */
export function view(player: WavePlayer) {
  const { cells } = player;
  const version = cells.version.value;
  return {
    duration: player.duration,
    selection: cells.selection.value,
    position: player.position,
    isPlaying: cells.isPlaying.value,
    isLooping: cells.isLooping.value,
    loading: cells.loading.value,
    loadProgress: cells.loadProgress.value,
    error: cells.error.value,
    processing: cells.processing.value,
    stretchRatio: version?.ratio ?? 1,
    sourceDuration: player.sourceBuffer?.duration ?? 0,
    revision: version?.revision ?? 0,
  };
}

/** Runs `listener` after any cell of the player changes (not for clock-only playhead movement); returns the stop function. */
export function onChange(player: WavePlayer, listener: () => void): () => void {
  let first = true;
  return untracked(() =>
    effect(() => {
      for (const source of Object.values(player.cells)) void source.value;
      if (first) {
        first = false;
        return;
      }
      untracked(listener);
    }),
  );
}
