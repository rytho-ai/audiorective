/** An inclusive numeric interval. Pure data: no DOM, no `AudioContext`. */
export type ValueRange = Readonly<{ min: number; max: number }>;

/** A numeric parameter's range with its starting value and an optional editing granularity. */
export type ParamRange = ValueRange &
  Readonly<{
    default: number;
    /** Editing granularity hint for views; not enforced. */
    step?: number;
  }>;

/** A named numeric parameter: a `ParamRange` with an `id` and an optional display `label`. */
export type ParamSpec = ParamRange & Readonly<{ id: string; label?: string }>;
