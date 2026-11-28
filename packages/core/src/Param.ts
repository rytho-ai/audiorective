import { signal, effect as alienEffect, getActiveSub, setActiveSub } from "alien-signals";
import { guarded } from "./guarded";
import { subscribeTo } from "./subscribe";
import type { ParamOptions, SignalAccessor } from "./types";

/** A reactive value with the same `.value` shape as a native `AudioParam`; `min`, `max`, `step`, `label` and `display` are metadata for UIs. */
export class Param<T> {
  /** Raw alien-signals accessor: `$()` reads (tracked), `$(next)` writes. */
  readonly $: SignalAccessor<T>;
  /** Display name for a UI control; undefined when not given. */
  readonly label?: string;
  /** Lower bound for a UI control, in the param's own unit. Not enforced: a write below it is stored as is. */
  readonly min?: number;
  /** Upper bound for a UI control, in the param's own unit. Not enforced: a write above it is stored as is. */
  readonly max?: number;
  /** Increment for a UI control, in the param's own unit; undefined means continuous. */
  readonly step?: number;
  /** Formats a value for display (for example `v => `${v} dB``); undefined means show the raw value. */
  readonly display?: (value: T) => string;
  private _stopEffect?: () => void;

  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  readonly subscribe = (listener: (value: T) => void, options?: { immediate?: boolean }): (() => void) =>
    subscribeTo(() => this.$(), listener, options);

  constructor(options: ParamOptions<T>) {
    // `bind.get` seeds the value from the external state; `default` covers a getter that yields undefined.
    const initial = options.bind?.get?.();
    this.$ = guarded(signal(initial === undefined ? options.default : initial), options.validate);
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

  /** Current value; reading inside an effect or computed tracks it. Assigning notifies subscribers and runs the `bind` setter. */
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
