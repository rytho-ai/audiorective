import { mountEqEditor, mountLevelMeter, mountParameter, mountSpectrum, type EqBand, type ParameterOptions } from "@audiorective/widgets";
import { rackMacroRange } from "@audiorective/blocks/effect-rack";
import type { RackEffect, RackMacroMapping, RackMacroParameter, RackMacroSettings, Workspace } from "@audiorective/workspace";

const effectName = { filter: "Filter", delay: "Delay", eq: "EQ" } as const;
const macroParameterNames: Record<RackMacroParameter, string> = {
  wet: "Mix",
  frequency: "頻率",
  q: "Q",
  delayTime: "時間",
  feedback: "回授",
};
const macroParameters = Object.keys(macroParameterNames) as RackMacroParameter[];

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
  const macroControls = document.createElement("div");
  macroControls.className = "rack-macro-controls";
  panel.append(header, macroControls, slots);
  root.append(panel);

  const effects = () => workspace.project.tracks.find((track) => track.id === trackId)?.effects ?? [];
  const macros = () => workspace.project.tracks.find((track) => track.id === trackId)?.effectMacros ?? [];
  const owner = (slotId: string, parameter: RackMacroParameter) =>
    macros().find((macro) => macro.targets.some((target) => target.slotId === slotId && target.parameter === parameter));
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
  const editMacros = async (next: readonly RackMacroSettings[]) => {
    try {
      workspace.project.setTrackRackPreset(trackId, { effects: effects(), macros: next });
      await workspace.flush();
      if (panel.isConnected) render();
    } catch (error) {
      report(error);
    }
  };
  const add = (type: RackEffect["type"]) => {
    const base = { id: crypto.randomUUID(), enabled: true, wet: type === "delay" ? 0.35 : 1 };
    let effect: RackEffect;
    if (type === "filter") effect = { ...base, type, mode: "lowpass", frequency: 1200, q: 0.7 };
    else if (type === "delay") effect = { ...base, type, delayTime: 0.25, feedback: 0.25 };
    else
      effect = {
        ...base,
        type,
        bands: [
          { frequency: 250, gain: 0, q: 0.7 },
          { frequency: 1000, gain: 0, q: 1 },
          { frequency: 4000, gain: 0, q: 0.8 },
        ],
      };
    edit([...effects(), effect]);
    render();
  };
  header.append(
    button("＋ Filter", () => add("filter"), "加入 Filter"),
    button("＋ Delay", () => add("delay"), "加入 Delay"),
    button("＋ EQ", () => add("eq"), "加入 EQ"),
    button(
      "＋ 巨集",
      () => {
        let index = macros().length + 1;
        while (macros().some((macro) => macro.label === `巨集 ${index}`)) index++;
        void editMacros([...macros(), { id: crypto.randomUUID(), label: `巨集 ${index}`, value: 0.5, targets: [] }]);
      },
      "加入巨集",
    ),
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

  const frequencyView = document.createElement("div");
  frequencyView.className = "rack-spectrum";
  if (analyser) {
    const label = document.createElement("span");
    label.className = "rack-spectrum-label";
    label.textContent = "輸出頻譜";
    frequencyView.append(label);
    header.after(frequencyView);
  }
  const spectrum =
    analyser &&
    mountSpectrum(frequencyView, {
      label: "效果鏈輸出頻譜",
      sampleRate: workspace.context.sampleRate,
      fftSize: analyser.fftSize,
      read: (bins) => analyser.getFloatFrequencyData(bins),
    });

  function renderMacros(): void {
    macroControls.replaceChildren();
    const chain = effects();
    const targetLabel = ({ slotId, parameter }: Pick<RackMacroMapping, "slotId" | "parameter">): string => {
      const i = chain.findIndex((slot) => slot.id === slotId);
      return i < 0 ? macroParameterNames[parameter] : `${i + 1}. ${effectName[chain[i].type]} ${macroParameterNames[parameter]}`;
    };
    for (const macro of macros()) {
      const label = macro.label ?? macro.id;
      const row = document.createElement("section");
      row.className = "rack-macro";
      row.setAttribute("aria-label", label);
      const control = mountParameter(row, {
        label,
        min: 0,
        max: 1,
        step: 0.01,
        orientation: "rotary",
        format: (value) => Math.round(value * 100) + "%",
        param: {
          get value() {
            return workspace.trackMacroValue(trackId, macro.id)?.value ?? macro.value;
          },
          set value(value: number) {
            try {
              workspace.setTrackMacroValue(trackId, macro.id, value);
            } catch (error) {
              report(error);
            }
          },
        },
      });
      controls.push(() => control.destroy());
      const changeTargets = (targets: readonly RackMacroMapping[]) =>
        editMacros(macros().map((item) => (item.id === macro.id ? { ...item, targets } : item)));
      for (const target of macro.targets)
        row.append(
          button(
            targetLabel(target) + " ×",
            () => {
              const current = macros().find(({ id }) => id === macro.id);
              if (current) void changeTargets(current.targets.filter((item) => item !== target));
            },
            "解除 " + label + " 的 " + targetLabel(target),
          ),
        );
      const candidates = chain.flatMap((slot) =>
        macroParameters.flatMap((parameter) => {
          const range = rackMacroRange(slot, parameter);
          if (!range || owner(slot.id, parameter)) return [];
          return [
            {
              slotId: slot.id,
              parameter,
              min: range[0],
              max: range[1],
              scale: parameter === "frequency" ? ("exponential" as const) : ("linear" as const),
            },
          ];
        }),
      );
      const choose = document.createElement("select");
      choose.setAttribute("aria-label", label + " 的目標");
      choose.add(new Option("指定參數", ""));
      for (const [i, target] of candidates.entries()) choose.add(new Option(targetLabel(target), String(i)));
      choose.disabled = !candidates.length;
      choose.addEventListener("change", () => {
        const target = choose.value === "" ? undefined : candidates[Number(choose.value)];
        const current = macros().find(({ id }) => id === macro.id);
        if (target && current) void changeTargets([...current.targets, target]);
      });
      row.append(
        choose,
        button("移除", () => void editMacros(macros().filter(({ id }) => id !== macro.id)), "移除 " + label),
      );
      macroControls.append(row);
    }
  }

  function render() {
    clearControls();
    renderMacros();
    slots.replaceChildren();
    const chain = effects();
    if (!chain.length) {
      const empty = document.createElement("span");
      empty.className = "effect-rack-empty";
      empty.textContent = "加入 Filter、Delay 或 EQ";
      slots.append(empty);
    }
    for (const [index, slot] of chain.entries()) {
      const name = effectName[slot.type];
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
      const numericPort = (read: (effect: RackEffect) => number, write: (effect: RackEffect, value: number) => RackEffect) => ({
        get value() {
          workspace.project.cells.revision.$();
          return read(current());
        },
        set value(value: number) {
          update(slot.id, (item) => write(item, value));
        },
      });
      const parameter = (
        key: RackMacroParameter,
        opts: Omit<ParameterOptions, "param">,
        read: (effect: RackEffect) => number,
        write: (effect: RackEffect, value: number) => RackEffect,
      ) => {
        if (owner(slot.id, key)) return;
        const control = mountParameter(values, { ...opts, param: numericPort(read, write) });
        controls.push(() => control.destroy());
      };
      const response = (bands: readonly EqBand[], label: string, minDb: number) => {
        const plot = document.createElement("div");
        plot.className = "rack-filter-response";
        if (slot.type === "eq") plot.classList.add("rack-eq-response");
        card.append(plot);
        let phases = new Float32Array(0);
        const editor = mountEqEditor(plot, {
          label,
          maxHz: Math.min(20_000, workspace.context.sampleRate / 2),
          minDb,
          maxDb: 24,
          readResponse(frequencies, magnitudes) {
            workspace.project.cells.revision.$();
            if (phases.length !== frequencies.length) phases = new Float32Array(frequencies.length);
            return workspace.trackFilterResponse(trackId, slot.id, frequencies, magnitudes, phases);
          },
          bands,
        });
        controls.push(() => editor.destroy());
      };
      parameter(
        "wet",
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
        response(
          owner(slot.id, "frequency")
            ? []
            : [
                {
                  id: slot.id,
                  label: "截止頻率",
                  frequency: numericPort(
                    (effect) => (effect.type === "filter" ? effect.frequency : slot.frequency),
                    (effect, frequency) => (effect.type === "filter" ? { ...effect, frequency } : effect),
                  ),
                  q: owner(slot.id, "q")
                    ? undefined
                    : numericPort(
                        (effect) => (effect.type === "filter" ? effect.q : slot.q),
                        (effect, q) => (effect.type === "filter" ? { ...effect, q } : effect),
                      ),
                },
              ],
          "Filter 頻率響應",
          -36,
        );
        parameter(
          "frequency",
          { label: "Filter 頻率", min: 20, max: 20_000, step: 1, orientation: "rotary", scale: "log", format: (v) => Math.round(v) + " Hz" },
          (effect) => (effect.type === "filter" ? effect.frequency : slot.frequency),
          (effect, frequency) => (effect.type === "filter" ? { ...effect, frequency } : effect),
        );
        parameter(
          "q",
          { label: "Filter Q", min: 0.1, max: 20, step: 0.1 },
          (effect) => (effect.type === "filter" ? effect.q : slot.q),
          (effect, q) => (effect.type === "filter" ? { ...effect, q } : effect),
        );
      } else if (slot.type === "delay") {
        parameter(
          "delayTime",
          { label: "Delay 時間", min: 0.01, max: 1, step: 0.01, format: (v) => Math.round(v * 1000) + " ms" },
          (effect) => (effect.type === "delay" ? effect.delayTime : slot.delayTime),
          (effect, delayTime) => (effect.type === "delay" ? { ...effect, delayTime } : effect),
        );
        parameter(
          "feedback",
          { label: "Delay 回授", min: 0, max: 0.95, step: 0.01, orientation: "rotary", format: (v) => Math.round(v * 100) + "%" },
          (effect) => (effect.type === "delay" ? effect.feedback : slot.feedback),
          (effect, feedback) => (effect.type === "delay" ? { ...effect, feedback } : effect),
        );
      } else {
        const bands = slot.bands.map((band, index) => {
          const label = slot.bands.length === 3 ? ["低頻", "中頻", "高頻"][index] : `頻段 ${index + 1}`;
          const access = (key: "frequency" | "gain" | "q") =>
            numericPort(
              (item) => (item.type === "eq" ? (item.bands[index]?.[key] ?? band[key]) : band[key]),
              (item, value) =>
                item.type === "eq" ? { ...item, bands: item.bands.map((entry, i) => (i === index ? { ...entry, [key]: value } : entry)) } : item,
            );
          const gain = access("gain");
          const control = mountParameter(values, {
            label: `EQ ${label}增益`,
            min: -24,
            max: 24,
            step: 0.1,
            param: gain,
            format: (value) => `${value.toFixed(1)} dB`,
          });
          controls.push(() => control.destroy());
          return { id: `${slot.id}-${index}`, label, frequency: access("frequency"), gain, q: access("q") };
        });
        response(bands, "EQ 頻率響應", -24);
      }
    }
  }
  render();
  return () => {
    clearControls();
    spectrum?.destroy();
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
