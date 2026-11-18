import { effect } from "@audiorective/core";
import { InstrumentEvents, StepSequencer, type SampleLease, type SampleLibrary } from "@audiorective/blocks";
import { mountPadGrid, mountStepGrid } from "@audiorective/widgets";
import type { Workspace } from "@audiorective/daw";

const lanes = [
  { id: "kick", label: "Kick", key: "a", hits: [0, 8] },
  { id: "open", label: "Open hat", key: "s", hits: [4, 12], group: "hat" },
  { id: "closed", label: "Closed hat", key: "d", hits: [2, 6, 10, 14], group: "hat" },
] as const;

export function mountRhythmView(
  host: HTMLElement,
  workspace: Workspace,
  library: SampleLibrary,
  defaults: readonly AudioBuffer[],
  onError: (error: unknown) => void,
) {
  const context = workspace.context;
  const bank = new InstrumentEvents(
    context,
    lanes.map((lane, index) => ({
      id: lane.id,
      buffer: defaults[index],
      group: "group" in lane ? lane.group : undefined,
    })),
  );
  bank.output.connect(workspace.output);
  const sequence = new StepSequencer(
    {
      steps: 16,
      beatsPerStep: 0.25,
      lanes: lanes.map(({ id, label, hits }) => ({
        id,
        label,
        velocities: Array.from({ length: 16 }, (_, index) => ((hits as readonly number[]).includes(index) ? 0.8 : 0)),
      })),
    },
    ({ laneId, velocity, when }) => bank.trigger(laneId, velocity, when),
  );

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
  let destroyed = false;
  play.addEventListener("click", () => {
    if (detach) {
      detach();
      detach = undefined;
      play.textContent = "啟用鼓機";
      play.setAttribute("aria-pressed", "false");
      return;
    }
    detach = workspace.attachStepSequencer(sequence);
    play.textContent = "停止鼓機";
    play.setAttribute("aria-pressed", "true");
    void workspace.play().catch((error) => {
      if (!destroyed) onError(error);
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
          if (!destroyed) bank.trigger(id);
        })
        .catch(onError);
    },
  });
  const grid = mountStepGrid(element, { sequencer: sequence, formatStep: (label, step) => `${label} 第 ${step + 1} 格`, velocityLabel: "力度" });
  element.append(assignments);
  host.append(element);

  return {
    get enabled() {
      return detach !== undefined;
    },
    destroy() {
      destroyed = true;
      detach?.();
      stopChoices();
      grid.destroy();
      pads.destroy();
      bank.destroy();
      for (const { lease } of leases.values()) lease.release();
      element.remove();
    },
  };
}
