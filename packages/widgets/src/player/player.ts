/** Plain player UI over a borrowed PlayerLike. Owns interaction state (scrub hold, notice); never owns playback. */
import { untracked } from "@audiorective/core";
import { effect } from "../detached-effect";
import { defaultRenderer } from "./renderer";
import type { PlayerActions, PlayerFrame, PlayerHandle, PlayerOptions, PlayerRendererInstance } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function describe(reason: unknown): string {
  const name = reason instanceof Error || reason instanceof DOMException ? reason.name : "";
  if (name === "NotAllowedError") return "The browser blocked playback. Press play again.";
  const message = reason instanceof Error || reason instanceof DOMException ? reason.message : String(reason);
  return message ? `Playback could not start: ${message}` : "Playback could not start.";
}

/** Mounts play/pause, optional volume and a timeline for a borrowed player into `root`; returns a handle whose `dispose` removes it. */
export function mountPlayer(root: HTMLElement, options: PlayerOptions): PlayerHandle {
  const { player } = options;
  const timeline = player.timeline;
  const container = document.createElement("div");
  container.className = "ar-widget ar-player";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", options.label ?? "Player");
  root.append(container);

  let renderer: PlayerRendererInstance | undefined;
  let disposed = false;
  // Interaction state. Not reactive: every change to it calls draw() itself.
  let held: number | null = null; // shown position while the user scrubs
  let target: number | null = null; // where to seek on commit; null until the control actually moved
  let notice: string | null = null;
  let attempt = 0;
  let frameRequest = 0;

  /** Reads the player. Inside the effect these reads are the subscriptions. */
  function read(): PlayerFrame {
    const isPlaying = player.isPlaying.value;
    if (isPlaying) notice = null; // it started (here or elsewhere): the reason no longer applies
    const rawDuration = timeline ? timeline.duration.value : NaN;
    const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null;
    const canSeek = !!timeline?.seek && duration !== null;
    if (!canSeek) held = target = null; // the track changed under the gesture
    let position: number | null = null;
    if (timeline) {
      // Always read the player, even while a held value is shown: skipping the read would drop the
      // effect's subscription and the widget would stop following after the gesture.
      const live = timeline.position();
      const raw = held ?? live;
      position = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      if (duration !== null) position = Math.min(position, duration);
    }
    const rawVolume = player.volume ? player.volume.value : NaN;
    return {
      isPlaying,
      resumes: player.resumes ?? true,
      position,
      duration,
      canSeek,
      scrubbing: held !== null,
      volume: player.volume ? (Number.isFinite(rawVolume) ? clamp(rawVolume, 0, 1) : 0) : null,
      notice,
    };
  }
  /** Redraw outside the effect (interaction state or an untracked player change). Subscribes nothing. */
  function draw(): void {
    if (disposed || !renderer) return;
    const instance = renderer;
    untracked(() => instance.render(read()));
  }
  function tick(): void {
    frameRequest = 0;
    if (disposed) return;
    draw();
    if (untracked(() => player.isPlaying.value)) frameRequest = requestAnimationFrame(tick);
  }
  function fail(id: number, reason: unknown): void {
    if (disposed || id !== attempt) return;
    if ((reason instanceof Error || reason instanceof DOMException) && reason.name === "AbortError") return;
    // Another view may have started playback before this attempt settled.
    if (untracked(() => player.isPlaying.value)) return;
    notice = describe(reason);
    draw();
  }

  const actions: PlayerActions = {
    toggle() {
      if (disposed) return;
      const id = ++attempt;
      if (untracked(() => player.isPlaying.value)) {
        player.pause();
        return;
      }
      notice = null;
      draw();
      try {
        const result = player.play();
        if (result) result.catch((reason: unknown) => fail(id, reason));
      } catch (reason) {
        fail(id, reason);
      }
    },
    hold() {
      if (disposed || held !== null) return;
      const frame = untracked(read);
      if (!frame.canSeek) return;
      held = frame.position;
      target = null;
      draw();
    },
    scrub(seconds) {
      if (disposed || !Number.isFinite(seconds)) return;
      const frame = untracked(read);
      if (!frame.canSeek || frame.duration === null) return;
      held = target = clamp(seconds, 0, frame.duration);
      draw();
    },
    commit() {
      if (disposed || held === null) return;
      const to = target;
      const frame = untracked(read); // also drops the gesture if seeking stopped being possible
      held = target = null;
      if (to !== null && frame.canSeek && frame.duration !== null) timeline!.seek!(clamp(to, 0, frame.duration));
      draw();
    },
    cancel() {
      if (disposed || held === null) return;
      held = target = null;
      draw();
    },
    setVolume(value) {
      if (disposed || !player.volume || !Number.isFinite(value)) return;
      player.volume.value = clamp(value, 0, 1);
    },
  };

  let stopEffect: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  const handle: PlayerHandle = {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopEffect?.();
      unsubscribe?.();
      if (frameRequest) cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      try {
        renderer?.dispose?.();
      } catch (error) {
        console.error("Player renderer cleanup failed:", error);
      }
      renderer = undefined;
      container.remove();
    },
  };
  try {
    renderer = (options.renderer ?? defaultRenderer)(container, actions);
    const instance = renderer;
    let initializing = true;
    let initialError: { reason: unknown } | undefined;
    stopEffect = effect(() => {
      try {
        const frame = read();
        untracked(() => instance.render(frame));
        if (timeline?.clock && frame.isPlaying && !frameRequest) frameRequest = requestAnimationFrame(tick);
      } catch (reason) {
        // The first effect run precedes its disposer. Defer the error until the disposer exists.
        if (!initializing) throw reason;
        initialError = { reason };
      }
    });
    initializing = false;
    if (initialError) throw initialError.reason;
    unsubscribe = player.subscribe?.(draw);
  } catch (error) {
    handle.dispose();
    throw error;
  }
  return handle;
}
