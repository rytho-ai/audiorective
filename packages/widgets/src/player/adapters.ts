/** Maps each Audiorective player onto PlayerLike. Adapters hold no state and need no disposal. */
import { readonlyCell, untracked, type BufferPlayer, type FilePlayer } from "@audiorective/core";
import { effect } from "../detached-effect";
import type { WavePlayer } from "@audiorective/player";
import type { PlayerLike } from "./types";

/** Everything a plain player needs. A blocked or failed play rejects as `FilePlayer.play()` does. */
export function fromFilePlayer(player: FilePlayer): PlayerLike {
  return {
    isPlaying: player.cells.isPlaying,
    play: () => player.play(),
    pause: () => player.pause(),
    volume: player.params.volume,
    timeline: {
      position: () => player.cells.currentTime.value,
      duration: player.cells.duration,
      seek: (seconds) => player.seek(seconds),
    },
  };
}

/** Position comes from the audio clock (read per frame while playing); paused seeks arrive through `cells.playhead`. */
export function fromWavePlayer(player: WavePlayer): PlayerLike {
  return {
    isPlaying: player.cells.isPlaying,
    async play() {
      if (!player.buffer) {
        throw new Error(player.cells.error.value ?? (player.cells.loading.value ? "Audio is still loading." : "No audio is loaded."));
      }
      await player.play();
    },
    pause: () => player.pause(),
    volume: player.params.volume,
    timeline: {
      position: () => player.position,
      clock: true,
      duration: readonlyCell(() => player.cells.version.value?.buffer.duration ?? NaN),
      seek: (seconds) => player.seek(seconds),
    },
    subscribe: (listener) => {
      let following = false;
      return untracked(() =>
        effect(() => {
          void player.cells.playhead.value;
          void player.cells.version.value;
          if (!following) return void (following = true);
          untracked(listener);
        }),
      );
    },
  };
}

/**
 * Start/stop and volume only. A BufferPlayer exposes no position, no reactive duration and no pause,
 * so there is no timeline, and `resumes` is false: the control reads "Stop" and play starts over.
 */
export function fromBufferPlayer(player: BufferPlayer): PlayerLike {
  return {
    isPlaying: player.cells.isPlaying,
    async play() {
      if (!player.buffer) throw new Error("No audio is loaded.");
      const context = player.context;
      if (context.state === "closed") throw new Error("The audio context is closed.");
      // Same policy as WavePlayer.play(): a user-initiated play resumes the supplied context.
      if (context.state === "suspended" && "resume" in context) await (context as AudioContext).resume();
      player.start();
    },
    pause: () => player.stop(),
    resumes: false,
    volume: player.params.volume,
  };
}
