import { computed, endBatch, setActiveSub, signal, startBatch } from "alien-signals";
import { produce, type Draft } from "immer";
import { subscribeTo } from "./subscribe";
import type { ComputedAccessor, SignalAccessor } from "./types";

export class Cell<T> {
  readonly $: SignalAccessor<T>;

  constructor(initial: T) {
    this.$ = signal(initial);
  }

  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  readonly subscribe = (listener: (value: T) => void, options?: { immediate?: boolean }): (() => void) =>
    subscribeTo(() => this.$(), listener, options);

  get value(): T {
    return this.$();
  }

  set value(v: T) {
    this.$(v);
  }

  /** Changes the value through an immer `recipe` that mutates a draft; the cell gets the new immutable value, and nothing changes when the recipe leaves the draft as is. */
  update(recipe: (draft: Draft<T>) => void): void {
    this.$(produce(this.$(), recipe));
  }
}

export function cell<T>(initial: T): Cell<T> {
  return new Cell(initial);
}

/**
 * A tracked view with no way to write: `.value` has no setter and `$` takes no argument.
 * The owner keeps the writable `Cell` private and changes it through its own methods.
 */
export class ReadonlyCell<T> {
  readonly $: ComputedAccessor<T>;
  // Keeps the type nominal: a writable Cell is not assignable where a ReadonlyCell is declared.
  declare private readonly _readonly: true;

  constructor(source: Cell<T> | (() => T)) {
    const read = typeof source === "function" ? source : () => source.$();
    const derived = computed(read);
    this.$ = () => derived();
  }

  /** Calls `listener(value)` after each change (not on subscribe unless `immediate`); returns an unsubscribe function. Valid for useSyncExternalStore. */
  readonly subscribe = (listener: (value: T) => void, options?: { immediate?: boolean }): (() => void) =>
    subscribeTo(() => this.$(), listener, options);

  get value(): T {
    return this.$();
  }
}

/** Read-only view of a cell, or of a value derived from other cells/params. Readers re-run only when the viewed value changes. */
export function readonlyCell<T>(source: Cell<T> | (() => T)): ReadonlyCell<T> {
  return new ReadonlyCell(source);
}

/** Run `fn` without subscribing the surrounding effect/computed to anything it reads. */
export function untracked<T>(fn: () => T): T {
  const previous = setActiveSub(undefined);
  try {
    return fn();
  } finally {
    setActiveSub(previous);
  }
}

/** Apply several writes as one change: effects run once, after `fn`, and never observe a state in between. */
export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}
