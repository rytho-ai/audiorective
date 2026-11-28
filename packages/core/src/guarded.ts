import type { SignalAccessor } from "./types";

/** Wraps a signal so `validate` runs on its current value and before every write; returns the signal itself without a validator. */
export function guarded<T>(raw: SignalAccessor<T>, validate: ((value: T) => void) | undefined): SignalAccessor<T> {
  if (!validate) return raw;
  validate(raw());
  return ((...args: [] | [T]) => {
    if (args.length === 0) return raw();
    validate(args[0]);
    raw(args[0]);
  }) as SignalAccessor<T>;
}
