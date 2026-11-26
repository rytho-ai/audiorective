// Compile-time only: `pnpm typecheck` fails if the built `StepSequencer` (or one of its lanes) stops satisfying the widget's contract.
import "./selector.contracts.typecheck";
import "./step-grid.contracts.typecheck";
import "./meter-mixer.contracts.typecheck";
import "./automation-editors.contracts.typecheck";
import "./arrangement.contracts.typecheck";
import "./removed-forms.typecheck";
import type { Lane, StepSequencer } from "@audiorective/sequencer";
import type { StepGridLane, StepGridPlugin, StepGridSequencer } from "../src";

export type StepSequencerFitsStepGrid = StepSequencer extends StepGridSequencer ? true : never;
export const stepSequencerFitsStepGrid: StepSequencerFitsStepGrid = true;
export type LaneFitsStepGrid = Lane extends StepGridLane ? true : never;
export const laneFitsStepGrid: LaneFitsStepGrid = true;

// A plugin writes every writable lane member through its context without casting to the concrete sequencer.
export const lanesWritableInPlugin: StepGridPlugin = {
  attach(context) {
    const lane = context.sequencer.lanes.kick!;
    lane.pattern = "X...X...";
    lane.pattern = [1, 0, 0.5, 0];
    lane.length = 8;
    lane.rate = "1/8";
    lane.swing = 0.3;
    lane.direction = "bounce";
    lane.muted = false;
    lane.solo = false;
    lane.steps[0]!.velocity = 1;
  },
};

// Boolean silence controls use the same spelling on real and structural owners.
export function mutedLaneContract(sequencer: StepSequencer, structural: StepGridSequencer): void {
  const lane = sequencer.lanes.kick!;
  const viewLane = structural.lanes.kick!;
  lane.muted = viewLane.muted;
  viewLane.muted = lane.muted;
  // @ts-expect-error A concrete lane has no former Boolean alias.
  void lane.mute;
  // @ts-expect-error A structural widget owner has no former Boolean alias.
  void viewLane.mute;
}
