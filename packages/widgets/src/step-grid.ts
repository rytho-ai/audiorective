import { effect, untracked, type Readable } from "@audiorective/core";

type StepPattern = Readonly<{
  size: number;
  lanes: readonly Readonly<{ id: string; label: string; cells: readonly Readonly<{ velocity: number }>[] }>[];
}>;

export type StepGridOptions = {
  sequencer: {
    pattern: Readable<StepPattern>;
    playheads: Readable<Readonly<Record<string, number | null>>>;
    setCell(laneId: string, step: number, patch: { velocity: number }): void;
  };
  formatStep?(label: string, step: number): string;
  velocityLabel?: string;
};

/** Edit and inspect a borrowed pattern, with precise velocity for the selected step. */
export function mountStepGrid(
  root: HTMLElement,
  { sequencer, formatStep = (label, step) => `${label} step ${step + 1}`, velocityLabel = "Velocity" }: StepGridOptions,
) {
  const doc = root.ownerDocument;
  const view = doc.createElement("div");
  view.className = "ar-step-grid";
  const table = doc.createElement("table");
  const head = table.createTHead().insertRow();
  function heading(row: HTMLTableRowElement, text: string, scope: "col" | "row"): void {
    const cell = doc.createElement("th");
    cell.scope = scope;
    cell.textContent = text;
    row.append(cell);
  }
  const body = table.createTBody();
  const velocity = doc.createElement("input");
  velocity.type = "range";
  velocity.min = "0";
  velocity.max = "1";
  velocity.step = "0.01";
  velocity.setAttribute("aria-label", velocityLabel);
  velocity.disabled = true;
  const label = doc.createElement("label");
  label.textContent = velocityLabel;
  label.append(velocity);
  let selected: { id: string; step: number } | undefined;
  const buttons = new Map<string, HTMLButtonElement[]>();
  function refreshVelocity(): void {
    if (!selected) return;
    const lane = sequencer.pattern.value.lanes.find(({ id }) => id === selected!.id)!;
    velocity.value = String(lane.cells[selected.step].velocity);
    velocity.setAttribute("aria-label", `${velocityLabel} · ${formatStep(lane.label, selected.step)}`);
    velocity.disabled = false;
  }
  velocity.addEventListener("input", () => {
    if (selected) sequencer.setCell(selected.id, selected.step, { velocity: velocity.valueAsNumber });
  });
  /** Rebuild the table for a pattern with a new step count or lane list. */
  function build({ size: steps, lanes }: StepPattern): void {
    head.replaceChildren();
    body.replaceChildren();
    buttons.clear();
    heading(head, "", "col");
    for (let step = 0; step < steps; step++) heading(head, String(step + 1), "col");
    for (const lane of lanes) {
      const row = body.insertRow();
      heading(row, lane.label, "row");
      const group = [];
      for (let step = 0; step < steps; step++) {
        const button = doc.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", formatStep(lane.label, step));
        button.textContent = "·";
        button.addEventListener("focus", () => {
          selected = { id: lane.id, step };
          refreshVelocity();
        });
        button.addEventListener("click", () => {
          selected = { id: lane.id, step };
          const current = sequencer.pattern.value.lanes.find(({ id }) => id === lane.id)!.cells[step].velocity;
          sequencer.setCell(lane.id, step, { velocity: current > 0 ? 0 : 0.8 });
        });
        row.insertCell().append(button);
        group.push(button);
      }
      buttons.set(lane.id, group);
    }
    if (selected && (selected.step >= steps || !buttons.has(selected.id))) {
      selected = undefined;
      velocity.disabled = true;
    }
    markCurrent(untracked(() => sequencer.playheads.value));
  }
  function markCurrent(heads: Readonly<Record<string, number | null>>): void {
    for (const [id, cells] of buttons)
      cells.forEach((button, step) => {
        button.dataset.current = String(step === heads[id]);
      });
  }
  view.append(table, label);
  root.append(view);
  let shape = "";
  const stopPattern = effect(() => {
    const current = sequencer.pattern.value;
    const next = JSON.stringify([current.size, current.lanes.map(({ id, label }) => [id, label])]);
    if (next !== shape) {
      shape = next;
      untracked(() => build(current));
    }
    for (const lane of current.lanes) {
      const cells = buttons.get(lane.id)!;
      lane.cells.forEach(({ velocity: value }, index) => {
        cells[index].setAttribute("aria-pressed", String(value > 0));
        cells[index].textContent = value > 0 ? String(Math.round(value * 100)) : "·";
      });
    }
    refreshVelocity();
  });
  const stopPlayhead = effect(() => markCurrent(sequencer.playheads.value));
  return {
    destroy() {
      stopPattern();
      stopPlayhead();
      view.remove();
    },
  };
}
