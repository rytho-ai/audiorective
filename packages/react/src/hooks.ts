import { useCallback, useMemo, useSyncExternalStore } from "react";
import { effect as alienEffect } from "alien-signals";
import { type Readable, type ComputedAccessor } from "@audiorective/core";

// A bare accessor has no `subscribe`; this gives it the same contract.
function subscribeAccessor<T>(read: ComputedAccessor<T>) {
  return (onChange: () => void): (() => void) => {
    let first = true;
    return alienEffect(() => {
      read();
      if (first) first = false;
      else onChange();
    });
  };
}

export function useValue<T>(source: Readable<T>): T;
export function useValue<T>(source: ComputedAccessor<T>): T;
export function useValue<T>(source: Readable<T> | ComputedAccessor<T>): T {
  const subscribe = useMemo(() => (typeof source === "function" ? subscribeAccessor(source) : source.subscribe), [source]);
  const getSnapshot = useCallback(() => (typeof source === "function" ? source() : source.value), [source]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
