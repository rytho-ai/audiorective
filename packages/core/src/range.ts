/** An inclusive numeric interval. Pure data: no DOM, no `AudioContext`. */
export type ValueRange = Readonly<{
  /** Inclusive lower bound in the value's native units. */
  min: number;
  /** Inclusive upper bound in the value's native units. */
  max: number;
}>;

/** A numeric parameter's range with its starting value and an optional editing granularity. */
export type ParamRange = ValueRange &
  Readonly<{
    /** Initial amount in the parameter's native units, within its declared bounds. */
    default: number;
    /** Editing granularity hint for views; not enforced. */
    step?: number;
  }>;

/** A named numeric parameter: a `ParamRange` with an `id` and an optional display `label`. */
export type ParamSpec = ParamRange &
  Readonly<{
    /** Stable string identifier used to address the parameter. */
    id: string;
    /** Optional human-readable control caption; omitted when no caption is supplied. */
    label?: string;
  }>;
