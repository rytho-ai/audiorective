import type { Readable } from "@audiorective/core";

/** A tracked value that can also be written. `Param` and `Cell` satisfy it. */
export interface WritableValue<T> {
  readonly $: () => T;
  value: T;
}

/** What a player can say about time. Omit the whole object when the player has no position. */
export interface PlayerTimeline {
  /**
   * Current position in seconds. Called inside an effect, so tracked reads in here re-render the widget.
   * It is also re-read after every `subscribe` notification.
   */
  position(): number;
  /**
   * True when the position advances with a clock and no tracked value changes while it does.
   * The widget then reads `position()` once per animation frame, only while `isPlaying` is true.
   */
  readonly clock?: boolean;
  /** Length in seconds. Any non-finite or non-positive value means "not known". */
  readonly duration: Readable<number>;
  /** Omit when the player cannot seek. Called with finite seconds within `0..duration`. */
  seek?(seconds: number): void;
}

/** The smallest surface a plain player UI needs. The widget borrows it and never ends its life. */
export interface PlayerLike {
  readonly isPlaying: Readable<boolean>;
  /**
   * Start or resume. Reject (or throw) when playback could not start; the widget shows the reason.
   * A rejection named `AbortError` means the attempt was superseded and is ignored.
   */
  play(): void | Promise<void>;
  /** Halt sound. */
  pause(): void;
  /** False when `play()` after `pause()` starts over instead of continuing. The control then reads "Stop". Default true. */
  readonly resumes?: boolean;
  /** Linear gain 0..1. Omit for no volume control. */
  readonly volume?: WritableValue<number>;
  readonly timeline?: PlayerTimeline;
  /** Notifications for changes no tracked value reports (e.g. a seek while paused on a clock-derived position). */
  subscribe?(listener: () => void): () => void;
}

/** One coherent state to draw. All numbers are finite. */
export interface PlayerFrame {
  readonly isPlaying: boolean;
  /** False: the halt control stops rather than pauses. */
  readonly resumes: boolean;
  /** Seconds to show, clamped to the known duration; the held value while the user scrubs. Null: the player has no position. */
  readonly position: number | null;
  /** Seconds, or null while the length is not known (before metadata, live stream, nothing loaded). */
  readonly duration: number | null;
  /** True only when the player can seek and the duration is known. */
  readonly canSeek: boolean;
  /** True between `hold()`/`scrub()` and `commit()`/`cancel()`. */
  readonly scrubbing: boolean;
  /** 0..1, or null when the player has no volume. */
  readonly volume: number | null;
  /** Why the last play request from this widget did not start, or null. */
  readonly notice: string | null;
}

/** The interaction logic. A renderer forwards user input here and draws the frames it gets back. */
export interface PlayerActions {
  /** Pause when playing, otherwise play. A failed play becomes `frame.notice`. */
  toggle(): void;
  /** Pointer went down on the seek control: freeze the shown position until commit/cancel. */
  hold(): void;
  /** The user moved the seek control to `seconds`: show it, do not seek yet. */
  scrub(seconds: number): void;
  /** The user released: seek to the last `scrub` value (if any) and follow the player again. */
  commit(): void;
  /** Abandon the gesture without seeking. */
  cancel(): void;
  setVolume(value: number): void;
}

export interface PlayerRendererInstance {
  /** Called once after mounting and again whenever the frame changes. */
  render(frame: PlayerFrame): void;
  destroy?(): void;
}

/** Mounts markup into `container` once, wires its input to `actions`, and returns how to draw a frame. */
export type PlayerRenderer = (container: HTMLElement, actions: PlayerActions) => PlayerRendererInstance;

export interface PlayerOptions {
  player: PlayerLike;
  renderer?: PlayerRenderer;
  /** Accessible name of the group. Default "Player". */
  label?: string;
}

export interface PlayerHandle {
  /** Idempotent. Removes DOM, effects, subscriptions and animation frames. Never touches playback. */
  destroy(): void;
}
