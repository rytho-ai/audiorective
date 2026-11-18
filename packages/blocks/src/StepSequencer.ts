import { cell, readonlyCell, type BeatTiming, type CancellableEvent } from "@audiorective/core";

export type StepLane = Readonly<{ id: string; label: string; velocities: readonly number[] }>;
export type StepPattern = Readonly<{ steps: number; beatsPerStep: number; lanes: readonly StepLane[] }>;
export type StepHit = Readonly<{ laneId: string; step: number; velocity: number; when: number }>;
export type StepWindow = Readonly<{
  beat: { start: number; end: number };
  time: { current: number };
  own(event: CancellableEvent, when: number): void;
}>;

/** An editable looping pattern over a borrowed beat transport and instrument trigger. */
export class StepSequencer {
  private readonly data;
  private readonly step = cell<number | null>(null);
  private readonly events = new Set<CancellableEvent>();
  readonly pattern;
  readonly currentStep = readonlyCell(this.step);

  constructor(
    pattern: StepPattern,
    private readonly trigger: (hit: StepHit) => CancellableEvent | null,
  ) {
    if (
      !Number.isSafeInteger(pattern.steps) ||
      pattern.steps <= 0 ||
      !Number.isFinite(pattern.beatsPerStep) ||
      pattern.beatsPerStep <= 0 ||
      !pattern.lanes.length ||
      new Set(pattern.lanes.map(({ id }) => id)).size !== pattern.lanes.length ||
      pattern.lanes.some(
        ({ id, velocities }) => !id || velocities.length !== pattern.steps || Array.from(velocities).some((velocity) => !validVelocity(velocity)),
      )
    )
      throw new Error("Step Sequencer needs a positive grid and unique lanes with valid velocities.");
    this.data = cell<StepPattern>(
      Object.freeze({
        steps: pattern.steps,
        beatsPerStep: pattern.beatsPerStep,
        lanes: Object.freeze(pattern.lanes.map((lane) => Object.freeze({ ...lane, velocities: Object.freeze([...lane.velocities]) }))),
      }),
    );
    this.pattern = readonlyCell(this.data);
  }

  setVelocity(laneId: string, step: number, velocity: number): void {
    const pattern = this.data.value;
    const lane = pattern.lanes.find(({ id }) => id === laneId);
    if (!lane || !Number.isSafeInteger(step) || step < 0 || step >= pattern.steps || !validVelocity(velocity))
      throw new Error("Step Sequencer needs an existing step and a velocity from zero to one.");
    if (lane.velocities[step] === velocity) return;
    const velocities = [...lane.velocities];
    velocities[step] = velocity;
    const changed = Object.freeze({ ...lane, velocities: Object.freeze(velocities) });
    this.data.value = Object.freeze({ ...pattern, lanes: Object.freeze(pattern.lanes.map((item) => (item === lane ? changed : item))) });
  }

  schedule(window: StepWindow, timing: BeatTiming): void {
    const { steps, beatsPerStep, lanes } = this.data.value;
    const absoluteStep = Math.floor(timing.timeToBeat(window.time.current) / beatsPerStep + 1e-9);
    this.step.value = ((absoluteStep % steps) + steps) % steps;
    const first = Math.max(0, Math.ceil(window.beat.start / beatsPerStep - 1e-9));
    const end = Math.ceil(window.beat.end / beatsPerStep - 1e-9);
    for (let index = first; index < end; index++) {
      const step = index % steps;
      const when = timing.beatToTime(index * beatsPerStep);
      for (const lane of lanes) {
        const velocity = lane.velocities[step];
        if (!velocity) continue;
        const event = this.trigger({ laneId: lane.id, step, velocity, when });
        if (!event) continue;
        this.events.add(event);
        event.onEnded(() => this.events.delete(event));
        window.own(event, when);
      }
    }
  }

  /** Cancel only this pattern's events and clear its displayed playhead. */
  reset(): void {
    for (const event of this.events) event.cancel();
    this.events.clear();
    this.step.value = null;
  }
}

function validVelocity(velocity: number): boolean {
  return Number.isFinite(velocity) && velocity >= 0 && velocity <= 1;
}
