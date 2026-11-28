import type { PlayerRenderer } from "./types";

/** `m:ss`, floored; minutes are not wrapped into hours. Non-finite input reads `--:--`. */
export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const styles = `
.ar-player{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font:var(--player-font,14px system-ui,sans-serif);color:var(--player-foreground,inherit)}
.ar-player-seek{flex:1 1 120px;accent-color:var(--player-accent,#4f8cff)}
.ar-player-volume{width:80px;accent-color:var(--player-accent,#4f8cff)}
.ar-player-time{font-variant-numeric:tabular-nums}
.ar-player-notice{flex-basis:100%;margin:0;color:var(--player-error,#c62828)}
.ar-player [hidden]{display:none}
`;

/** Default drawing: a button, two native range inputs, a time readout and an alert line. */
export const defaultRenderer: PlayerRenderer = (container, actions) => {
  container.innerHTML = `<style>${styles}</style><button class="ar-player-toggle" data-testid="play-toggle" type="button"></button><input class="ar-player-seek" data-testid="seek" type="range" min="0" max="1" step="0.01" value="0" aria-label="Seek"><span class="ar-player-time" data-testid="time"></span><input class="ar-player-volume" data-testid="volume" type="range" min="0" max="1" step="0.01" aria-label="Volume"><p class="ar-player-notice" data-testid="notice" role="alert" hidden></p>`;
  const query = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;
  const toggle = query<HTMLButtonElement>(".ar-player-toggle");
  const seek = query<HTMLInputElement>(".ar-player-seek");
  const time = query<HTMLElement>(".ar-player-time");
  const volume = query<HTMLInputElement>(".ar-player-volume");
  const notice = query<HTMLElement>(".ar-player-notice");

  // Listeners live on elements this renderer owns; removing the elements in dispose() releases them.
  toggle.addEventListener("click", () => actions.toggle());
  seek.addEventListener("pointerdown", () => actions.hold());
  seek.addEventListener("input", () => actions.scrub(seek.valueAsNumber));
  seek.addEventListener("change", () => actions.commit());
  seek.addEventListener("pointerup", () => actions.commit());
  seek.addEventListener("pointercancel", () => actions.cancel());
  volume.addEventListener("input", () => actions.setVolume(volume.valueAsNumber));

  return {
    render(frame) {
      const label = frame.isPlaying ? (frame.resumes ? "Pause" : "Stop") : "Play";
      toggle.textContent = label;
      toggle.setAttribute("aria-label", label);

      const timed = frame.position !== null;
      seek.hidden = !timed;
      time.hidden = !timed;
      seek.disabled = !frame.canSeek;
      // max before value: a value above the current max would be clamped by the browser.
      seek.max = String(frame.duration ?? 1);
      seek.value = String(frame.duration === null ? 0 : (frame.position ?? 0));
      time.textContent = timed ? `${formatTime(frame.position)} / ${formatTime(frame.duration)}` : "";

      volume.hidden = frame.volume === null;
      if (frame.volume !== null) volume.value = String(frame.volume);

      notice.hidden = frame.notice === null;
      notice.textContent = frame.notice ?? "";
    },
    dispose() {
      container.replaceChildren();
    },
  };
};
