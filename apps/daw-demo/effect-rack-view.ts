import { mountLevelMeter, mountParameter, type ParameterOptions } from "@audiorective/widgets";
import type { RackEffect, Workspace } from "@audiorective/workspace";

export function mountEffectRackView(root: HTMLElement, workspace: Workspace, trackId: string, report: (error: unknown) => void) {
  const panel = document.createElement("section");
  panel.className = "effect-rack";
  panel.setAttribute("aria-label", "效果鏈");
  const header = document.createElement("div");
  header.className = "effect-rack-actions";
  const heading = document.createElement("strong");
  heading.textContent = "效果鏈";
  header.append(heading);
  const slots = document.createElement("div");
  slots.className = "effect-rack-slots";
  panel.append(header, slots);
  root.append(panel);

  const effects = () => workspace.project.tracks.find((track) => track.id === trackId)?.effects ?? [];
  const controls: Array<() => void> = [];
  const clearControls = () => {
    for (const destroy of controls.splice(0)) destroy();
  };
  const edit = (next: readonly RackEffect[]) => {
    try {
      workspace.setTrackEffects(trackId, next);
    } catch (error) {
      report(error);
    }
  };
  const update = (id: string, change: (slot: RackEffect) => RackEffect) => {
    edit(effects().map((slot) => (slot.id === id ? change(slot) : slot)));
  };
  function button(label: string, action: () => void, accessibleLabel = label): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", accessibleLabel);
    button.addEventListener("click", action);
    return button;
  }
  const add = (type: RackEffect["type"]) => {
    const base = { id: crypto.randomUUID(), enabled: true, wet: type === "delay" ? 0.35 : 1 };
    const effect: RackEffect =
      type === "filter" ? { ...base, type, mode: "lowpass", frequency: 1200, q: 0.7 } : { ...base, type, delayTime: 0.25, feedback: 0.25 };
    edit([...effects(), effect]);
    render();
  };
  header.append(
    button("＋ Filter", () => add("filter"), "加入 Filter"),
    button("＋ Delay", () => add("delay"), "加入 Delay"),
  );

  const tap = workspace.trackEffectOutput(trackId);
  const analyser = tap && workspace.context.createAnalyser();
  if (tap && analyser) {
    tap.connect(analyser);
  }
  const meter =
    analyser &&
    mountLevelMeter(header, {
      label: "效果鏈輸出峰值",
      sampleCount: analyser.fftSize,
      read: (samples) => analyser.getFloatTimeDomainData(samples),
    });

  function render() {
    clearControls();
    slots.replaceChildren();
    const chain = effects();
    if (!chain.length) {
      const empty = document.createElement("span");
      empty.className = "effect-rack-empty";
      empty.textContent = "加入 Filter 或 Delay";
      slots.append(empty);
    }
    for (const [index, slot] of chain.entries()) {
      const name = slot.type === "filter" ? "Filter" : "Delay";
      const card = document.createElement("article");
      card.className = "effect-slot";
      card.dataset.effectType = slot.type;
      const title = document.createElement("strong");
      title.textContent = name;
      const actions = document.createElement("div");
      actions.className = "effect-slot-actions";
      const bypass = button(
        "旁通",
        () => {
          update(slot.id, (effect) => ({ ...effect, enabled: !effect.enabled }));
          bypass.setAttribute("aria-pressed", String(!current().enabled));
        },
        name + " 旁通",
      );
      bypass.setAttribute("aria-pressed", String(!slot.enabled));
      const move = (delta: number) => {
        const next = [...effects()];
        const index = next.findIndex((entry) => entry.id === slot.id);
        const to = index + delta;
        if (index < 0 || to < 0 || to >= next.length) return;
        [next[index], next[to]] = [next[to], next[index]];
        edit(next);
        render();
      };
      const up = button("←", () => move(-1), name + " 往前");
      const down = button("→", () => move(1), name + " 往後");
      up.disabled = index === 0;
      down.disabled = index === chain.length - 1;
      actions.append(
        bypass,
        up,
        down,
        button(
          "移除",
          () => {
            edit(effects().filter((effect) => effect.id !== slot.id));
            render();
          },
          "移除 " + name,
        ),
      );
      const values = document.createElement("div");
      values.className = "effect-slot-values";
      card.append(title, actions, values);
      slots.append(card);
      const current = () => effects().find((effect) => effect.id === slot.id) ?? slot;
      const parameter = (
        opts: Omit<ParameterOptions, "param">,
        read: (effect: RackEffect) => number,
        write: (effect: RackEffect, value: number) => RackEffect,
      ) => {
        const control = mountParameter(values, {
          ...opts,
          param: {
            get value() {
              workspace.project.cells.revision.value;
              return read(current());
            },
            set value(value) {
              update(slot.id, (effect) => write(effect, value));
            },
          },
        });
        controls.push(() => control.destroy());
      };
      parameter(
        { label: name + " Mix", min: 0, max: 1, step: 0.01, orientation: "vertical", format: (v) => Math.round(v * 100) + "%" },
        (effect) => effect.wet,
        (effect, wet) => ({ ...effect, wet }),
      );
      if (slot.type === "filter") {
        const mode = document.createElement("select");
        mode.setAttribute("aria-label", "Filter 模式");
        mode.add(new Option("低通", "lowpass"));
        mode.add(new Option("高通", "highpass"));
        mode.value = slot.mode;
        mode.addEventListener("change", () => {
          const value = mode.value === "highpass" ? "highpass" : "lowpass";
          update(slot.id, (effect) => (effect.type === "filter" ? { ...effect, mode: value } : effect));
        });
        values.append(mode);
        parameter(
          { label: "Filter 頻率", min: 20, max: 20_000, step: 1, orientation: "rotary", scale: "log", format: (v) => Math.round(v) + " Hz" },
          (effect) => (effect.type === "filter" ? effect.frequency : slot.frequency),
          (effect, frequency) => (effect.type === "filter" ? { ...effect, frequency } : effect),
        );
        parameter(
          { label: "Filter Q", min: 0.1, max: 20, step: 0.1 },
          (effect) => (effect.type === "filter" ? effect.q : slot.q),
          (effect, q) => (effect.type === "filter" ? { ...effect, q } : effect),
        );
      } else {
        parameter(
          { label: "Delay 時間", min: 0.01, max: 1, step: 0.01, format: (v) => Math.round(v * 1000) + " ms" },
          (effect) => (effect.type === "delay" ? effect.delayTime : slot.delayTime),
          (effect, delayTime) => (effect.type === "delay" ? { ...effect, delayTime } : effect),
        );
        parameter(
          { label: "Delay 回授", min: 0, max: 0.95, step: 0.01, orientation: "rotary", format: (v) => Math.round(v * 100) + "%" },
          (effect) => (effect.type === "delay" ? effect.feedback : slot.feedback),
          (effect, feedback) => (effect.type === "delay" ? { ...effect, feedback } : effect),
        );
      }
    }
  }
  render();
  return () => {
    clearControls();
    meter?.destroy();
    if (tap && analyser) {
      try {
        tap.disconnect(analyser);
      } catch {
        /* Track may already have been removed. */
      }
    }
    panel.remove();
  };
}
