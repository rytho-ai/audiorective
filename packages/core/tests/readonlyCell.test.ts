import { describe, test, expect, expectTypeOf } from "vitest";
import { AudioProcessor, batch, cell, Cell, computed, effect, readonlyCell, ReadonlyCell, untracked, type Readable } from "../src";

describe("ReadonlyCell", () => {
  test("views a cell: reads track, the owner's writes propagate", () => {
    const source = cell(1);
    const view = readonlyCell(source);
    expect(view).toBeInstanceOf(ReadonlyCell);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(view.value);
    });
    source.value = 2;
    expect(seen).toEqual([1, 2]);
    expect(view.$()).toBe(2);
    stop();
  });

  test("cannot be written: no setter, no update, and `$` ignores arguments", () => {
    const source = cell(1);
    const view = readonlyCell(source);
    expect(() => {
      // @ts-expect-error read-only: `.value` has no setter
      view.value = 5;
    }).toThrow(TypeError);
    // @ts-expect-error read-only: `$` takes no argument
    view.$(5);
    // @ts-expect-error read-only: no `update`
    expect(view.update).toBeUndefined();
    expect(view.value).toBe(1);
    expect(source.value).toBe(1);
  });

  test("types: is Readable, and a writable Cell is not a ReadonlyCell", () => {
    expectTypeOf(readonlyCell(cell(1))).toExtend<Readable<number>>();
    expectTypeOf<Cell<number>>().toExtend<Readable<number>>();
    expectTypeOf<Cell<number>>().not.toExtend<ReadonlyCell<number>>();
  });

  test("derived view re-runs readers only when its own value changes", () => {
    const source = cell({ a: 1, b: 1 });
    const a = readonlyCell(() => source.value.a);
    let runs = 0;
    const stop = effect(() => {
      void a.value;
      runs++;
    });
    source.update((s) => {
      s.b = 2;
    });
    expect(runs).toBe(1);
    source.update((s) => {
      s.a = 2;
    });
    expect(runs).toBe(2);
    stop();
  });

  test("registers in an AudioProcessor's cells beside writable cells", () => {
    class Owner extends AudioProcessor<{}, { ready: ReadonlyCell<boolean>; note: Cell<string> }> {
      private readonly _ready: Cell<boolean>;
      constructor(ctx: AudioContext) {
        const ready = cell(false);
        super(ctx, ({ cell: make }) => ({ params: {}, cells: { ready: readonlyCell(ready), note: make("") } }));
        this._ready = ready;
      }
      get output() {
        return undefined;
      }
      markReady() {
        this._ready.value = true;
      }
    }
    const ctx = new AudioContext();
    const owner = new Owner(ctx);
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(owner.cells.ready.value);
    });
    owner.markReady();
    owner.cells.note.value = "x";
    expect(seen).toEqual([false, true]);
    stop();
    owner.destroy();
    void ctx.close();
  });
});

describe("effect / computed", () => {
  test("core exports the observers, so an app needs no direct alien-signals import", () => {
    const a = cell(1);
    const doubled = computed(() => a.value * 2);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(doubled());
    });
    a.value = 2;
    stop();
    a.value = 3;
    expect(seen).toEqual([2, 4]);
  });
});

describe("batch / untracked", () => {
  test("batch runs effects once, after all writes", () => {
    const a = cell(0),
      b = cell(0);
    const seen: Array<[number, number]> = [];
    const stop = effect(() => {
      seen.push([a.value, b.value]);
    });
    const result = batch(() => {
      a.value = 1;
      b.value = 1;
      return "done";
    });
    expect(result).toBe("done");
    expect(seen).toEqual([
      [0, 0],
      [1, 1],
    ]);
    stop();
  });

  test("batch still flushes when the callback throws", () => {
    const a = cell(0);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(a.value);
    });
    expect(() =>
      batch(() => {
        a.value = 1;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(seen).toEqual([0, 1]);
    stop();
  });

  test("untracked reads do not subscribe the surrounding effect", () => {
    const a = cell(0),
      b = cell(0);
    let runs = 0;
    const stop = effect(() => {
      void a.value;
      untracked(() => b.value);
      runs++;
    });
    b.value = 1;
    expect(runs).toBe(1);
    a.value = 1;
    expect(runs).toBe(2);
    stop();
  });
});
