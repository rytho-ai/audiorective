import { signal, effect as alienEffect } from "alien-signals";
import type { ParamOptions, SignalAccessor } from "./types";

export class Param<T> {
  readonly $: SignalAccessor<T>;
  readonly label?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly display?: (value: T) => string;
  private _stopEffect?: () => void;

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
      this._stopEffect = alienEffect(() => {
        setter(this.value);
      });
    }
  }

  get value(): T {
    return this.$();
  }

  set value(newValue: T) {
    this.$(newValue);
  }

  destroy(): void {
    this._stopEffect?.();
    this._stopEffect = undefined;
  }
}
