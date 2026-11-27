import type { ParamSpec } from "./range";

export interface ParamBind<T> {
  /** Optional property reader; omitted when writes alone synchronize the binding. */
  get?: () => T;
  /** Optional property writer invoked on reactive changes; receives the unformatted value. */
  set?: (value: T) => void;
}

export interface ParamOptions<T> extends Partial<Pick<ParamSpec, "label" | "min" | "max" | "step">> {
  /** Initial unformatted value; numeric values use the parameter's native units. */
  default: T;
  /** Optional property binding; omission keeps the parameter as pure reactive state. */
  bind?: ParamBind<T>;
  /** Optional value formatter for presentation; does not change the stored value. */
  display?: (value: T) => string;
}

/**
 * alien-signals 3.x signal accessor — callable to read, callable with arg to write.
 */
export type SignalAccessor<T> = {
  (): T;
  (value: T): void;
};

/**
 * alien-signals 3.x computed — callable to read.
 */
export type ComputedAccessor<T> = () => T;

/**
 * Shared interface for any reactive container that can be read and tracked.
 * Param<T>, Cell<T> and ReadonlyCell<T> satisfy this.
 */
export interface Readable<T> {
  // NoInfer: T comes from `value`. A writable `$` is overloaded, and inferring from it would pick its setter signature.
  /** Tracked accessor for framework integration; reads the same value as `.value`. */
  readonly $: ComputedAccessor<NoInfer<T>>;
  /** Current tracked state; read-only through this interface. */
  readonly value: T;
  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  subscribe(
    listener: (value: T) => void,
    options?: {
      /** Notify once during subscription; defaults to false. */
      immediate?: boolean;
    },
  ): () => void;
}
