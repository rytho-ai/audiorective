import { effect } from "@audiorective/core";
import { StepSequencer } from "@audiorective/sequencer";
import { mountStepGrid, type StepGridPluginContext, type StepGridStep } from "../src";
import type { StepGridCellContext } from "../src/step-grid-types";

/** Public structural owners and scoped cell helpers, checked without executing this file. */
export function stepGridCellContracts(root: HTMLElement): void {
  const sequencer = new StepSequencer({ kick: { pattern: "X...", params: { cutoff: { min: 20, max: 20000, default: 1000 } } } });
  // @ts-expect-error The former constructor option is removed.
  new StepSequencer({ kick: { pattern: "X...", mute: true } });
  new StepSequencer({ kick: { pattern: "X...", muted: true } });
  const grid = mountStepGrid(root, { sequencer, formatStep: (label, index) => `${label} ${index + 1}` });
  const attachment = grid.attach({
    attach(context: StepGridPluginContext) {
      const stop: () => void = context.onCell((cell: StepGridCellContext) => {
        const ownerStep: StepGridStep = cell.step;
        const index: number = cell.stepIndex;
        const lane: string = cell.laneId;
        cell.root.dataset.address = `${lane}:${index}`;
        const stopReading: () => void = cell.onCleanup(effect(() => (cell.root.textContent = String(ownerStep.repeat))));
        cell.listen(cell.root, "click", () => {
          ownerStep.repeat = 2;
          ownerStep.values.cutoff = 400;
        });
        // @ts-expect-error The owner reference is readonly, although its fields are writable.
        cell.step = ownerStep;
        // @ts-expect-error Scope metadata cannot be reassigned.
        cell.stepIndex = 1;
        // @ts-expect-error This is an actual step, not a serialized value snapshot or a Step cell.
        void cell.step.value;
        // @ts-expect-error The cell scope does not own or dispose its caller's step.
        cell.step.dispose();
        // @ts-expect-error Registered cleanup must be callable.
        cell.onCleanup({ dispose() {} });
        return stopReading;
      });
      stop();
      // @ts-expect-error onCell accepts setup, not a standalone element.
      context.onCell(root);
      // @ts-expect-error Cell setup returns a cleanup function, not a widget handle.
      context.onCell(() => ({ dispose() {} }));
    },
  });
  attachment.dispose();
  grid.dispose();
  sequencer.dispose();
}
