// Compile-time only: `pnpm typecheck` fails if the built `StepSequencer` (or one of its lanes) stops satisfying the widget's contract.
import type { Lane, StepSequencer } from "@audiorective/blocks/sequencer";
import type { StepGridLane, StepGridSequencer } from "../src";

export type StepSequencerFitsStepGrid = StepSequencer extends StepGridSequencer ? true : never;
export const stepSequencerFitsStepGrid: StepSequencerFitsStepGrid = true;
export type LaneFitsStepGrid = Lane extends StepGridLane ? true : never;
export const laneFitsStepGrid: LaneFitsStepGrid = true;
