import { untracked, type Readable } from "@audiorective/core";
import { effect } from "./detached-effect";
import { mountLevelMeter, type LevelMeterSource } from "./level-meter";

export type MixerStripSettings = Readonly<{
  /** User volume as a linear factor, 0..1; 1 is unity. */
  volume: number;
  /** Stereo position, -1 left to 1 right; 0 is centered. */
  pan: number;
  /** Omit when mute is unsupported. */
  muted?: boolean;
  /** Omit when solo is unsupported; the caller implements solo routing. */
  solo?: boolean;
}>;
export type MixerStrip = MixerStripSettings &
  Readonly<{
    /** Stable strip identifier passed to edit and selection callbacks. */
    id: string;
    /** Visible strip caption; independent of its stable identifier. */
    name: string;
  }>;
export type MixerState = Readonly<{
  /** Track strips in display order; an empty list leaves only the master strip. */
  tracks: readonly MixerStrip[];
  /** Omit when a master fader is unsupported. */
  masterVolume?: number;
}>;
/**
 * Borrowed dBFS or PCM for one strip/master. Optional cleanup releases caller resources when its meter is removed.
 */
export type MixerMeter = Readonly<{
  /** Borrowed dBFS peak reader or PCM source; the mixer samples it through a meter view. */
  source: LevelMeterSource;
  /** Releases resources owned by this attachment or view; safe to call twice. */
  dispose?(): void;
}>;
export type MixerOptions = {
  /** Expose tracked owner getters through readonlyCell(() => ...). */
  state: Readable<MixerState>;
  /** Commits a partial strip edit by identifier; values retain linear volume and -1..1 pan. */
  editTrack(id: string, patch: Partial<MixerStripSettings>): void;
  /** Shown only with masterVolume; the caller owns the audio routing. */
  editMaster?(gain: number): void;
  /** Called once per strip, and once for the master with `null`. Return undefined to show no meter. */
  meter?(id: string | null): MixerMeter | undefined;
  /** Optional callback when a strip is selected; receives its stable identifier. */
  onSelect?(id: string): void;
  /** Optional selection predicate by strip identifier; omitted means no selected highlight. */
  selected?(id: string): boolean;
  /** Return strip cleanup; also run it when independently removing your appended controls. */
  appendControls?(id: string, root: HTMLElement): void | (() => void);
  /** Optional control-caption overrides; missing entries use built-in English text. */
  labels?: Partial<{
    /** Stereo-position caption; defaults to "Pan". */
    pan: string;
    /** Linear-volume caption; defaults to "Volume". */
    volume: string;
    /** Master-strip caption; defaults to "Master". */
    master: string;
    /** Mute-button caption; defaults to "Mute". */
    mute: string;
    /** Solo-button caption; defaults to "Solo". */
    solo: string;
  }>;
};

/** Find focus in the strip's own tree, including caller controls in nested open shadows. */
function focusedDescendant(element: HTMLElement): HTMLElement | null {
  const root = element.getRootNode();
  if (!("activeElement" in root)) return null;
  let active = (root as Document | ShadowRoot).activeElement;
  if (!active || !element.contains(active)) return null;
  while (active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active as HTMLElement;
}

/** Keyed controls over borrowed state. Omit unsupported master/mute/solo controls; the caller owns routing. */
export function mountMixer(root: HTMLElement, options: MixerOptions) {
  const doc = root.ownerDocument;
  const labels = { pan: "Pan", volume: "Volume", master: "Master", mute: "Mute", solo: "Solo", ...options.labels };
  const mixer = doc.createElement("div");
  mixer.className = "mixer";
  root.append(mixer);

  function control(label: string, min: number, max: number, onInput: (value: number) => void, signal: AbortSignal) {
    const field = doc.createElement("label");
    field.textContent = label;
    const input = doc.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "0.01";
    input.addEventListener("input", () => onInput(input.valueAsNumber), { signal });
    field.append(input);
    return { field, input };
  }

  function meter(root: HTMLElement, id: string | null, label: string) {
    const reader = options.meter?.(id);
    if (!reader) return;
    const view = mountLevelMeter(root, { source: reader.source, label });
    return () => {
      view.dispose();
      reader.dispose?.();
    };
  }

  function addMaster(edit: (gain: number) => void) {
    const element = doc.createElement("div");
    element.className = "mixer-strip master";
    const caption = doc.createElement("span");
    caption.className = "strip-name";
    caption.textContent = labels.master;
    const abort = new AbortController();
    const volume = control(labels.volume, 0, 1.5, edit, abort.signal);
    volume.input.setAttribute("aria-label", `${labels.master} ${labels.volume}`);
    element.append(caption, volume.field);
    const detachMeter = meter(element, null, `${labels.master} peak`);
    mixer.prepend(element);
    return {
      element,
      input: volume.input,
      dispose() {
        abort.abort();
        detachMeter?.();
        element.remove();
      },
    };
  }
  let master: ReturnType<typeof addMaster> | undefined;

  function add(track: MixerStrip) {
    let current = track;
    const abort = new AbortController();
    const element = doc.createElement("div");
    element.className = "mixer-strip";
    element.dataset.trackId = track.id;
    const select = doc.createElement(options.onSelect ? "button" : "span");
    if (options.onSelect) select.setAttribute("type", "button");
    select.className = "strip-name";
    select.addEventListener("click", () => options.onSelect?.(track.id), { signal: abort.signal });
    const pan = control(labels.pan, -1, 1, (value) => options.editTrack(track.id, { pan: value }), abort.signal);
    const volume = control(labels.volume, 0, 1.5, (value) => options.editTrack(track.id, { volume: value }), abort.signal);
    const actions = doc.createElement("div");
    actions.className = "strip-actions";
    function toggle(key: "muted" | "solo", label: string, cssClass: string) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = cssClass;
      button.textContent = label;
      button.addEventListener("click", () => options.editTrack(track.id, { [key]: !current[key] }), { signal: abort.signal });
      return button;
    }
    const toggles = new Map<"muted" | "solo", HTMLButtonElement>();
    element.append(select, pan.field, volume.field, actions);
    const detachMeter = meter(element, track.id, `${track.name} peak`);
    const detachControls = options.appendControls?.(track.id, element);
    return {
      element,
      update(strip: MixerStrip) {
        current = strip;
        select.textContent = strip.name;
        element.classList.toggle("selected", options.selected?.(strip.id) ?? false);
        pan.input.value = String(strip.pan);
        pan.input.setAttribute("aria-label", `${strip.name} pan`);
        volume.input.value = String(strip.volume);
        volume.input.setAttribute("aria-label", `${strip.name} mixer ${labels.volume}`);
        for (const [key, cssClass, caption, label] of [
          ["muted", "mute", "M", labels.mute],
          ["solo", "solo", "S", labels.solo],
        ] as const) {
          const active = strip[key];
          let button = toggles.get(key);
          if (active === undefined) {
            button?.remove();
            toggles.delete(key);
            continue;
          }
          if (!button) {
            button = toggle(key, caption, cssClass);
            toggles.set(key, button);
            actions.append(button);
          }
          button.classList.toggle("on", active);
          button.setAttribute("aria-pressed", String(active));
          button.setAttribute("aria-label", `${strip.name} ${label}`);
        }
        actions.hidden = toggles.size === 0;
      },
      dispose() {
        abort.abort();
        detachControls?.();
        detachMeter?.();
        element.remove();
      },
    };
  }
  const strips = new Map<string, ReturnType<typeof add>>();
  const stop = untracked(() =>
    effect(() => {
      const { tracks, masterVolume: gain } = options.state.value;
      if (gain !== undefined && options.editMaster) {
        master ??= untracked(() => addMaster(options.editMaster!));
        master.input.value = String(gain);
      } else if (master) {
        untracked(() => master!.dispose());
        master = undefined;
      }
      const ids = new Set(tracks.map(({ id }) => id));
      for (const [id, strip] of strips)
        if (!ids.has(id)) {
          untracked(() => strip.dispose());
          strips.delete(id);
        }
      let next = master ? master.element.nextElementSibling : mixer.firstElementChild;
      for (const track of tracks) {
        let strip = strips.get(track.id);
        if (!strip) {
          // Detached from this effect: widgets mounted by `appendControls` own effects that must outlive its re-runs.
          strip = untracked(() => add(track));
          strips.set(track.id, strip);
        }
        strip.update(track);
        if (strip.element !== next) {
          const focused = focusedDescendant(strip.element);
          const input = focused as HTMLInputElement | HTMLTextAreaElement | null;
          const selection =
            input && typeof input.selectionStart === "number"
              ? ([input.selectionStart, input.selectionEnd!, input.selectionDirection ?? "none"] as const)
              : null;
          if (strip.element.isConnected && "moveBefore" in mixer && typeof mixer.moveBefore === "function") {
            // State-preserving DOM moves keep native focus and in-progress extension input intact.
            mixer.moveBefore(strip.element, next);
          } else {
            mixer.insertBefore(strip.element, next);
          }
          if (focused && focusedDescendant(strip.element) !== focused) focused.focus({ preventScroll: true });
          if (selection) input!.setSelectionRange(...selection);
        }
        next = strip.element.nextElementSibling;
      }
    }),
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      for (const strip of strips.values()) strip.dispose();
      strips.clear();
      master?.dispose();
      mixer.remove();
    },
  };
}
