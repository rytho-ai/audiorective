import { effect, untracked, type Readable } from "@audiorective/core";
import { mountLevelMeter, type LevelMeterOptions } from "./level-meter";

type StripSettings = Readonly<{ volume: number; pan: number; muted: boolean; solo: boolean }>;
export type MixerStrip = StripSettings & Readonly<{ id: string; name: string }>;
export type MixerState = Readonly<{ tracks: readonly MixerStrip[]; masterVolume: number }>;
/**
 * A caller-owned level reader for one strip or the master (`null`). The caller creates and wires its analysis node;
 * the view only reads samples and calls `dispose` when the strip goes away so the caller can disconnect.
 */
export type MixerMeter = Readonly<{ sampleCount?: number; read: LevelMeterOptions["read"]; dispose?(): void }>;
export type MixerOptions = {
  state: Readable<MixerState>;
  editTrack(id: string, patch: Partial<StripSettings>): void;
  editMaster(gain: number): void;
  /** Called once per strip, and once for the master with `null`. Return undefined to show no meter. */
  meter?(id: string | null): MixerMeter | undefined;
  onSelect?(id: string): void;
  selected?(id: string): boolean;
  appendControls?(id: string, root: HTMLElement): void | (() => void);
  labels?: Partial<{ pan: string; volume: string; master: string; mute: string; solo: string }>;
};

/** Mixer controls and caller-supplied level readers. The caller owns all mix settings and routing. */
export function mountMixer(root: HTMLElement, options: MixerOptions) {
  const doc = root.ownerDocument;
  const labels = { pan: "Pan", volume: "Volume", master: "Master", mute: "Mute", solo: "Solo", ...options.labels };
  const mixer = doc.createElement("div");
  mixer.className = "mixer";
  root.append(mixer);

  function control(label: string, min: number, max: number, onInput: (value: number) => void) {
    const field = doc.createElement("label");
    field.textContent = label;
    const input = doc.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "0.01";
    input.addEventListener("input", () => onInput(input.valueAsNumber));
    field.append(input);
    return { field, input };
  }

  function meter(root: HTMLElement, id: string | null, label: string) {
    const reader = options.meter?.(id);
    if (!reader) return;
    const view = mountLevelMeter(root, { sampleCount: reader.sampleCount, label, read: reader.read });
    return () => {
      view.dispose();
      reader.dispose?.();
    };
  }

  const master = doc.createElement("div");
  master.className = "mixer-strip master";
  const masterLabel = doc.createElement("span");
  masterLabel.className = "strip-name";
  masterLabel.textContent = labels.master;
  const masterVolume = control(labels.volume, 0, 1.5, options.editMaster);
  masterVolume.input.setAttribute("aria-label", `${labels.master} ${labels.volume}`);
  master.append(masterLabel, masterVolume.field);
  const detachMaster = meter(master, null, `${labels.master} peak`);
  mixer.append(master);

  function add(track: MixerStrip) {
    let current = track;
    const element = doc.createElement("div");
    element.className = "mixer-strip";
    element.dataset.trackId = track.id;
    const select = doc.createElement(options.onSelect ? "button" : "span");
    if (options.onSelect) select.setAttribute("type", "button");
    select.className = "strip-name";
    select.addEventListener("click", () => options.onSelect?.(track.id));
    const pan = control(labels.pan, -1, 1, (value) => options.editTrack(track.id, { pan: value }));
    const volume = control(labels.volume, 0, 1.5, (value) => options.editTrack(track.id, { volume: value }));
    const actions = doc.createElement("div");
    actions.className = "strip-actions";
    function toggle(key: "muted" | "solo", label: string, cssClass: string) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = cssClass;
      button.textContent = label;
      button.addEventListener("click", () => options.editTrack(track.id, { [key]: !current[key] }));
      return button;
    }
    const mute = toggle("muted", "M", "mute");
    const solo = toggle("solo", "S", "solo");
    actions.append(mute, solo);
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
        for (const [button, active, label] of [
          [mute, strip.muted, labels.mute],
          [solo, strip.solo, labels.solo],
        ] as const) {
          button.classList.toggle("on", active);
          button.setAttribute("aria-pressed", String(active));
          button.setAttribute("aria-label", `${strip.name} ${label}`);
        }
      },
      dispose() {
        detachControls?.();
        detachMeter?.();
        element.remove();
      },
    };
  }
  const strips = new Map<string, ReturnType<typeof add>>();
  const stop = effect(() => {
    const { tracks, masterVolume: gain } = options.state.value;
    masterVolume.input.value = String(gain);
    const ids = new Set(tracks.map(({ id }) => id));
    for (const [id, strip] of strips)
      if (!ids.has(id)) {
        untracked(() => strip.dispose());
        strips.delete(id);
      }
    let next = mixer.firstElementChild;
    for (const track of tracks) {
      let strip = strips.get(track.id);
      if (!strip) {
        // Detached from this effect: widgets mounted by `appendControls` own effects that must outlive its re-runs.
        strip = untracked(() => add(track));
        strips.set(track.id, strip);
      }
      strip.update(track);
      if (strip.element !== next) mixer.insertBefore(strip.element, next);
      next = strip.element.nextElementSibling;
    }
  });
  return {
    dispose() {
      stop();
      for (const strip of strips.values()) strip.dispose();
      strips.clear();
      detachMaster?.();
      mixer.remove();
    },
  };
}
