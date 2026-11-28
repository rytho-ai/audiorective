import { effect, getActiveSub, setActiveSub } from "alien-signals";

export interface SubscribeOptions {
  /** Also call the listener once, with the current value, when subscribing. */
  immediate?: boolean;
}

/**
 * Calls `listener(value)` after each change of `read()`; returns an unsubscribe function.
 * The effect is detached from any running effect so a caller's re-run cannot dispose it, and the
 * listener runs untracked so what it reads never becomes a dependency of this subscription.
 */
export function subscribeTo<T>(read: () => T, listener: (value: T) => void, options?: SubscribeOptions): () => void {
  let first = true;
  const prev = getActiveSub();
  setActiveSub(undefined);
  try {
    return effect(() => {
      const value = read();
      const initial = first;
      first = false;
      if (initial && !options?.immediate) return;
      const outer = setActiveSub(undefined);
      try {
        listener(value);
      } finally {
        setActiveSub(outer);
      }
    });
  } finally {
    setActiveSub(prev);
  }
}
