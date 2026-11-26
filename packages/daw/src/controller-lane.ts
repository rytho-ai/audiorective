/**
 * A track's MIDI controller movement as data: one lane per (expression, channel, controller), points in project beats, and the one rule that turns a lane
 * into the MIDI messages that play it. Pure: the Project model, the DAWproject codec, playback, the MIDI file export and the MCP view all use it.
 */

/** The MIDI messages a lane can carry. */
export type ControllerExpression = "channelController" | "pitchBend" | "channelPressure" | "polyPressure" | "programChange";

/**
 * One point of a controller lane. `time` is in project beats (0 or more). `value` is the controller's own integer range: 0 to 127 for a controller number,
 * channel pressure, poly pressure and program number, and 0 to 16383 for pitch bend (14 bits, centre 8192). `shape` is how the value goes on to the next
 * point: `"linear"` moves toward it, `"hold"` keeps this value until it (a step). The last point has nothing to go on to, so it is always `"hold"`. A
 * program-change lane always steps. Points at the same time are a step too: every one is sent, in order.
 */
export type ControllerPoint = Readonly<{ time: number; value: number; shape: "linear" | "hold" }>;

/** The movement of one controller on one channel. `controller` is the controller number (`channelController`) or the key (`polyPressure`), else 0. */
export type ControllerLane = Readonly<{
  expression: ControllerExpression;
  /** MIDI channel 0 to 15. */
  channel: number;
  controller: number;
  points: readonly ControllerPoint[];
}>;

/** What a lane sends at one beat. */
export type ControllerEvent = Readonly<{ beat: number; value: number }>;

/** Every `ControllerExpression` a lane can use, in the order the tool schema lists them. */
export const controllerExpressions: readonly ControllerExpression[] = [
  "channelController",
  "pitchBend",
  "channelPressure",
  "polyPressure",
  "programChange",
];

/** Beats between the sample times of a linear segment: 1/32 of a beat (15.6 ms at 120 BPM), a control rate finer than a person hears. */
export const controllerSampleBeats = 1 / 32;

/** The largest value of an expression: 16383 for pitch bend, else 127. */
export const controllerMax = (expression: ControllerExpression): number => (expression === "pitchBend" ? 16383 : 127);

/** A value as the 0 to 1 number a DAWproject `Points unit="normalized"` carries: `value / max`, written to 9 decimals. */
export const controllerToNormalized = (expression: ControllerExpression, value: number): number =>
  Number((value / controllerMax(expression)).toFixed(9));

/** The exact inverse of `controllerToNormalized` for every integer value: `round(normalized * max)`, halves up, limited to the range. */
export const controllerFromNormalized = (expression: ControllerExpression, normalized: number): number =>
  Math.min(controllerMax(expression), Math.max(0, Math.round(normalized * controllerMax(expression))));

/** The key lanes of one track are told apart by. */
export const controllerLaneKey = ({ expression, channel, controller }: Pick<ControllerLane, "expression" | "channel" | "controller">): string =>
  `${expression}:${channel}:${controller}`;

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** The first thing wrong with a lane, or undefined. A controller number from 120 up is a channel-mode message, not movement. */
export function controllerLaneProblem(lane: ControllerLane, allowEmpty = false): string | undefined {
  if (!lane || typeof lane !== "object") return "a lane is an object";
  if (!controllerExpressions.includes(lane.expression)) return `expression must be one of ${controllerExpressions.join(", ")}`;
  if (!isInt(lane.channel, 0, 15)) return "channel must be an integer from 0 to 15";
  const numbered = lane.expression === "channelController" ? 119 : lane.expression === "polyPressure" ? 127 : 0;
  if (!isInt(lane.controller, 0, numbered))
    return lane.expression === "channelController"
      ? "controller must be an integer from 0 to 119"
      : lane.expression === "polyPressure"
        ? "controller (the key) must be an integer from 0 to 127"
        : "controller must be 0 for this expression";
  if (!Array.isArray(lane.points) || (!allowEmpty && lane.points.length === 0)) return "points must be a non-empty list";
  const max = controllerMax(lane.expression);
  for (const [i, point] of lane.points.entries()) {
    if (!point || typeof point !== "object") return `points[${i}] must be an object`;
    if (typeof point.time !== "number" || !Number.isFinite(point.time) || point.time < 0)
      return `points[${i}] time must be a finite number of beats, 0 or more`;
    if (!isInt(point.value, 0, max)) return `points[${i}] value must be an integer from 0 to ${max}`;
    if (point.shape !== "linear" && point.shape !== "hold") return `points[${i}] shape must be "linear" or "hold"`;
  }
  return undefined;
}

/** A lane with its points sorted by time (equal times keep their order) and its last point's shape set to `"hold"`, frozen. Throws `RangeError` for a lane `controllerLaneProblem` rejects. */
export function normalizeControllerLane(lane: ControllerLane, allowEmpty = false): ControllerLane {
  const problem = controllerLaneProblem(lane, allowEmpty);
  if (problem) throw new RangeError(`Project controller lane: ${problem}.`);
  // Nothing follows the last point: its shape is "hold", so the same lane has one form.
  const points = lane.points.map((point, i) =>
    Object.freeze({ time: point.time, value: point.value, shape: i === lane.points.length - 1 ? ("hold" as const) : point.shape }),
  );
  const sorted = points.map((point, index) => ({ point, index })).sort((a, b) => a.point.time - b.point.time || a.index - b.index);
  return Object.freeze({
    expression: lane.expression,
    channel: lane.channel,
    controller: lane.controller,
    points: Object.freeze(sorted.map(({ point }) => point)),
  });
}

/** The MIDI message that sets `value` on a lane's controller. */
export function controllerMessage(lane: Pick<ControllerLane, "expression" | "channel" | "controller">, value: number): Uint8Array {
  const { expression, channel, controller } = lane;
  switch (expression) {
    case "pitchBend":
      return Uint8Array.of(0xe0 | channel, value & 127, value >> 7);
    case "channelPressure":
      return Uint8Array.of(0xd0 | channel, value);
    case "programChange":
      return Uint8Array.of(0xc0 | channel, value);
    case "polyPressure":
      return Uint8Array.of(0xa0 | channel, controller, value);
    default:
      return Uint8Array.of(0xb0 | channel, controller, value);
  }
}

/**
 * What a lane sends, in beat order: a message at every point, and along a linear segment one at each 1/32 beat where the rounded value differs from the one
 * sent before it. A hold segment sends nothing between its points. Pure in the lane, so a window of the result is the same however playback is cut into windows.
 */
export function controllerEvents(expression: ControllerExpression, points: readonly ControllerPoint[]): ControllerEvent[] {
  const out: ControllerEvent[] = [];
  for (const [i, point] of points.entries()) {
    out.push({ beat: point.time, value: point.value });
    const next = points[i + 1];
    if (!next || point.shape !== "linear" || expression === "programChange" || next.time <= point.time) continue;
    let last = point.value;
    for (let step = Math.floor(point.time / controllerSampleBeats) + 1; step * controllerSampleBeats < next.time; step++) {
      const beat = step * controllerSampleBeats;
      const value = Math.round(point.value + ((next.value - point.value) * (beat - point.time)) / (next.time - point.time));
      if (value === last) continue;
      out.push({ beat, value });
      last = value;
    }
  }
  return out;
}

const compiled = new WeakMap<ControllerLane, readonly ControllerEvent[]>();

/** `controllerEvents` of a lane, kept per lane object. */
export function compileControllerLane(lane: ControllerLane): readonly ControllerEvent[] {
  let events = compiled.get(lane);
  if (!events) {
    events = controllerEvents(lane.expression, lane.points);
    compiled.set(lane, events);
  }
  return events;
}

const EPS = 1e-9;

/**
 * The lane's messages a playback segment sends, as `{ beat, data }`. `[from, to)` is the segment in project beats. A segment that `begins` a run (a start,
 * a seek, a loop wrap) first sends the value in force at `from` (the last event at or before it), then the events after `from`; any other segment sends the
 * events in `[from, to)`.
 */
export function controllerMessagesIn(lane: ControllerLane, from: number, to: number, begins: boolean): Array<{ beat: number; data: Uint8Array }> {
  const events = compileControllerLane(lane);
  const out: Array<{ beat: number; data: Uint8Array }> = [];
  let state: ControllerEvent | undefined;
  for (const event of events) {
    if (event.beat > from + EPS) break;
    state = event;
  }
  if (begins && state) out.push({ beat: from, data: controllerMessage(lane, state.value) });
  for (const event of events) {
    const after = begins ? event.beat > from + EPS : event.beat >= from - EPS;
    if (!after || event.beat >= to - EPS) continue;
    out.push({ beat: event.beat, data: controllerMessage(lane, event.value) });
  }
  return out;
}

/** The value a lane's points give at `beat` (rounded; a linear segment moves toward the next point), or undefined before the first point. */
export function controllerValueAt(expression: ControllerExpression, points: readonly ControllerPoint[], beat: number): number | undefined {
  const at = points.findLastIndex((point) => point.time <= beat + EPS);
  if (at < 0) return undefined;
  const point = points[at];
  const next = points[at + 1];
  if (!next || point.shape !== "linear" || expression === "programChange" || next.time <= point.time) return point.value;
  return Math.round(point.value + ((next.value - point.value) * (beat - point.time)) / (next.time - point.time));
}

/** The points left when the beats `[start, end)` are deleted and later beats close up: points inside go, later ones move earlier, and the value in force at `end` is held from `start`. */
export function controllerPointsAfterDelete(
  expression: ControllerExpression,
  points: readonly ControllerPoint[],
  start: number,
  end: number,
): ControllerPoint[] {
  const length = end - start;
  const out = points.filter((point) => point.time < start - EPS);
  const kept = points.filter((point) => point.time >= end - EPS).map((point) => ({ ...point, time: point.time - length }));
  const state = controllerValueAt(expression, points, end);
  if (state !== undefined && !(kept[0] && Math.abs(kept[0].time - start) < EPS)) out.push({ time: start, value: state, shape: "hold" });
  return [...out, ...kept];
}

/**
 * The points after the beats `[start, end)` are copied and inserted at `at` (outside the range), pushing later beats `end - start` later: the copy plays the
 * range's own movement from its start value, and the lane's value from before the insert resumes after it.
 */
export function controllerPointsAfterInsert(
  expression: ControllerExpression,
  points: readonly ControllerPoint[],
  start: number,
  end: number,
  at: number,
): ControllerPoint[] {
  const length = end - start;
  const out = points.filter((point) => point.time < at - EPS);
  const copied = points.filter((point) => point.time >= start - EPS && point.time < end - EPS);
  const startState = controllerValueAt(expression, points, start);
  if (startState !== undefined && !(copied[0] && Math.abs(copied[0].time - start) < EPS)) out.push({ time: at, value: startState, shape: "hold" });
  for (const point of copied) out.push({ ...point, time: point.time - start + at });
  const resume = controllerValueAt(expression, points, at);
  const later = points.filter((point) => point.time >= at - EPS);
  if (resume !== undefined && !(later[0] && Math.abs(later[0].time - at) < EPS)) out.push({ time: at + length, value: resume, shape: "hold" });
  for (const point of later) out.push({ ...point, time: point.time + length });
  return out;
}
