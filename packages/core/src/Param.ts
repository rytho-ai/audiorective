import { signal, effect as alienEffect, getActiveSub, setActiveSub } from "alien-signals";
import { subscribeTo } from "./subscribe";
import type { ParamOptions, SignalAccessor } from "./types";

export class Param<T> {
  readonly $: SignalAccessor<T>;
  readonly label?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly display?: (value: T) => string;
  private _stopEffect?: () => void;

  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  readonly subscribe = (listener: (value: T) => void, options?: { immediate?: boolean }): (() => void) =>
    subscribeTo(() => this.$(), listener, options);

  constructor(options: ParamOptions<T>) {
    // `bind.get` seeds the value from the external state; `default` covers a getter that yields undefined.
    const initial = options.bind?.get?.();
    this.$ = signal(initial === undefined ? options.default : initial);
    this.label = options.label;
    this.min = options.min;
    this.max = options.max;
    this.step = options.step;
    this.display = options.display;
    if (options.bind?.set) {
      const setter = options.bind.set;
      // Detach from any running effect: a Param built inside a caller's effect must not
      // become its child, or the caller's next run would dispose this bind effect.
      const prev = getActiveSub();
      setActiveSub(undefined);
      try {
        this._stopEffect = alienEffect(() => {
          setter(this.value);
        });
      } finally {
        setActiveSub(prev);
      }
    }
  }

  get value(): T {
    return this.$();
  }

  set value(newValue: T) {
    this.$(newValue);
  }

  /** Stops the bind effect, if any. Safe to call twice. */
  dispose(): void {
    this._stopEffect?.();
    this._stopEffect = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
