// Compile-time only: `pnpm typecheck` fails if a `StepSequencer` stops satisfying the widget's contract.
import type { StepSequencer } from "@audiorective/blocks/sequencer";
import type { StepGridSequencer } from "../src";

export type StepSequencerFitsStepGrid = StepSequencer extends StepGridSequencer ? true : never;
export const stepSequencerFitsStepGrid: StepSequencerFitsStepGrid = true;
