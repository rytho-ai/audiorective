import { effect } from "@audiorective/core";
import { PadBank } from "@audiorective/pads";
import type { SampleLease, SampleLibrary } from "@audiorective/samples";
import { StepSequencer } from "@audiorective/sequencer";
import { mountPadGrid, mountStepGrid } from "@audiorective/widgets";
import type { Workspace } from "@audiorective/daw";

const lanes = [
  { id: "kick", label: "Kick", key: "a", pattern: "x.......x.......", group: undefined },
  { id: "open", label: "Open hat", key: "s", pattern: "....x.......x...", group: "hat" },
  { id: "closed", label: "Closed hat", key: "d", pattern: "..x...x...x...x.", group: "hat" },
] as const;

export function mountRhythmView(
  host: HTMLElement,
  workspace: Workspace,
  library: SampleLibrary,
  defaults: readonly AudioBuffer[],
  onError: (error: unknown) => void,
) {
  const context = workspace.context;
  const bank = new PadBank(
    context,
    lanes.map((lane, index) => ({
      id: lane.id,
      buffer: defaults[index],
      group: lane.group,
    })),
  );
  bank.output.connect(workspace.output);
  const sequence = new StepSequencer(Object.fromEntries(lanes.map(({ id, pattern }) => [id, pattern])), {
    context,
    onHit: ({ lane, velocity, when, pitch, duration }) => {
      const played = bank.trigger(lane, velocity, when, { pitch, duration });
      return played ? () => played.cancel() : undefined;
    },
  });

  const element = document.createElement("div");
  element.className = "rhythm-view";
  const toolbar = document.createElement("div");
  toolbar.className = "rhythm-tools";
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "啟用鼓機";
  play.setAttribute("aria-pressed", "false");
  const assignments = document.createElement("div");
  assignments.className = "rhythm-assignments";
  const leases = new Map<string, { id: string; name: string; lease: SampleLease }>();
  const choices = lanes.map((lane, index) => {
    const label = document.createElement("label");
    label.textContent = lane.label;
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${lane.label} 素材`);
    select.addEventListener("change", () => {
      const previous = leases.get(lane.id);
      try {
        if (select.value) {
          const row = library.state.value.rows.find(({ id }) => id === select.value)!;
          const lease = library.acquire(row.id);
          try {
            bank.assign(lane.id, lease.buffer);
          } catch (error) {
            lease.release();
            throw error;
          }
          leases.set(lane.id, { id: row.id, name: row.name, lease });
        } else {
          bank.assign(lane.id, defaults[index]);
          leases.delete(lane.id);
        }
        previous?.lease.release();
        workspace.clock.refresh();
      } catch (error) {
        select.value = previous?.id ?? "";
        onError(error);
      }
    });
    label.append(select);
    assignments.append(label);
    return select;
  });
  const stopChoices = effect(() => {
    const ready = library.state.value.rows.filter(({ status }) => status === "ready");
    choices.forEach((select, index) => {
      const chosen = leases.get(lanes[index].id);
      select.replaceChildren(new Option("內建", ""), ...ready.map(({ name, id }) => new Option(name, id)));
      if (chosen && !ready.some(({ id }) => id === chosen.id)) select.append(new Option(chosen.name, chosen.id));
      select.value = chosen?.id ?? "";
    });
  });

  let detach: (() => void) | undefined;
  let disposed = false;
  play.addEventListener("click", () => {
    if (detach) {
      detach();
      detach = undefined;
      play.textContent = "啟用鼓機";
      play.setAttribute("aria-pressed", "false");
      return;
    }
    detach = workspace.transport.attach(sequence);
    play.textContent = "停止鼓機";
    play.setAttribute("aria-pressed", "true");
    void workspace.play().catch((error) => {
      if (!disposed) onError(error);
    });
  });
  toolbar.append(play);
  element.append(toolbar);
  const pads = mountPadGrid(toolbar, {
    pads: lanes,
    press: (id) => {
      void context
        .resume()
        .then(() => {
          if (!disposed) bank.trigger(id);
        })
        .catch(onError);
    },
  });
  const grid = mountStepGrid(element, {
    sequencer: sequence,
    laneLabel: (name) => lanes.find(({ id }) => id === name)?.label ?? name,
    formatStep: (label, step) => `${label} 第 ${step + 1} 格`,
    labels: {
      velocity: "力度",
      offset: "偏移",
      length: "長度",
      repeat: "重複",
      pitch: "音高",
      chance: "機率",
      fold: "收合",
      mute: "靜音",
      solo: "獨奏",
      steps: "步數",
      rate: "速率",
      direction: "方向",
      swing: "搖擺",
    },
  });
  element.append(assignments);
  host.append(element);

  return {
    get enabled() {
      return detach !== undefined;
    },
    dispose() {
      disposed = true;
      detach?.();
      sequence.dispose();
      stopChoices();
      grid.dispose();
      pads.dispose();
      bank.dispose();
      for (const { lease } of leases.values()) lease.release();
      element.remove();
    },
  };
}
