export interface ParamBind<T> {
  get?: () => T;
  set?: (value: T) => void;
}

export interface ParamOptions<T> {
  default: T;
  bind?: ParamBind<T>;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
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
  readonly $: ComputedAccessor<NoInfer<T>>;
  readonly value: T;
}

export type EngineState = "idle" | "running" | "suspended" | "destroyed";
