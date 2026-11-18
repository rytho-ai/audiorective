import { effect, type Readable } from "@audiorective/core";

type StepPattern = Readonly<{
  steps: number;
  lanes: readonly Readonly<{ id: string; label: string; velocities: readonly number[] }>[];
}>;

export type StepGridOptions = {
  sequencer: {
    pattern: Readable<StepPattern>;
    currentStep: Readable<number | null>;
    setVelocity(laneId: string, step: number, velocity: number): void;
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
  const { steps, lanes } = sequencer.pattern.value;
  function heading(row: HTMLTableRowElement, text: string, scope: "col" | "row"): void {
    const cell = doc.createElement("th");
    cell.scope = scope;
    cell.textContent = text;
    row.append(cell);
  }
  heading(head, "", "col");
  for (let step = 0; step < steps; step++) heading(head, String(step + 1), "col");
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
    velocity.value = String(lane.velocities[selected.step]);
    velocity.setAttribute("aria-label", `${velocityLabel} · ${formatStep(lane.label, selected.step)}`);
    velocity.disabled = false;
  }
  velocity.addEventListener("input", () => {
    if (selected) sequencer.setVelocity(selected.id, selected.step, velocity.valueAsNumber);
  });
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
        const current = sequencer.pattern.value.lanes.find(({ id }) => id === lane.id)!.velocities[step];
        sequencer.setVelocity(lane.id, step, current > 0 ? 0 : 0.8);
      });
      row.insertCell().append(button);
      group.push(button);
    }
    buttons.set(lane.id, group);
  }
  view.append(table, label);
  root.append(view);
  const stopPattern = effect(() => {
    for (const lane of sequencer.pattern.value.lanes) {
      const cells = buttons.get(lane.id)!;
      lane.velocities.forEach((value, index) => {
        cells[index].setAttribute("aria-pressed", String(value > 0));
        cells[index].textContent = value > 0 ? String(Math.round(value * 100)) : "·";
      });
    }
    refreshVelocity();
  });
  const stopPlayhead = effect(() => {
    const index = sequencer.currentStep.value;
    for (const cells of buttons.values())
      cells.forEach((button, step) => {
        button.dataset.current = String(step === index);
      });
  });
  return {
    destroy() {
      stopPattern();
      stopPlayhead();
      view.remove();
    },
  };
}
