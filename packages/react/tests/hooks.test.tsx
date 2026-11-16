import { describe, test, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { computed as alienComputed } from "alien-signals";
import { Param, Cell } from "@audiorective/core";
import { useValue } from "../src/hooks";

describe("useValue with Readable (Param)", () => {
  test("returns initial param value", () => {
    const p = new Param({ default: 42 });
    const { result } = renderHook(() => useValue(p));
    expect(result.current).toBe(42);
  });

  test("re-renders when param value changes", () => {
    const p = new Param({ default: "hello" });
    const { result } = renderHook(() => useValue(p));
    expect(result.current).toBe("hello");

    act(() => {
      p.value = "world";
    });

    expect(result.current).toBe("world");
  });

  test("tracks multiple updates", () => {
    const p = new Param({ default: 0 });
    const { result } = renderHook(() => useValue(p));

    act(() => {
      p.value = 1;
    });
    act(() => {
      p.value = 2;
    });
    act(() => {
      p.value = 3;
    });

    expect(result.current).toBe(3);
  });

  test("direct mutation via param.value is the canonical write path", () => {
    const p = new Param({ default: 0 });
    const { result } = renderHook(() => useValue(p));

    act(() => {
      p.value = 99;
    });

    expect(result.current).toBe(99);
    expect(p.value).toBe(99);
  });
});

describe("useValue with Readable (Cell)", () => {
  test("tracks Cell value changes", () => {
    const c = new Cell({ count: 0 });
    const { result } = renderHook(() => useValue(c));
    expect(result.current).toEqual({ count: 0 });

    act(() => {
      c.update((draft) => {
        draft.count = 5;
      });
    });

    expect(result.current).toEqual({ count: 5 });
  });
});

describe("useValue with ComputedAccessor", () => {
  test("returns initial computed value", () => {
    const p = new Param({ default: 10 });
    const doubled = alienComputed(() => p.value * 2);
    const { result } = renderHook(() => useValue(doubled));
    expect(result.current).toBe(20);
  });

  test("re-renders when underlying signal changes", () => {
    const p = new Param({ default: 10 });
    const doubled = alienComputed(() => p.value * 2);
    const { result } = renderHook(() => useValue(doubled));
    expect(result.current).toBe(20);

    act(() => {
      p.value = 25;
    });

    expect(result.current).toBe(50);
  });
});

describe("useValue with ReadonlyCell", () => {
  test("re-renders when the owner changes the viewed cell", async () => {
    const { cell, readonlyCell } = await import("@audiorective/core");
    const source = cell({ start: 0, end: 1 });
    const view = readonlyCell(source);
    const { result } = renderHook(() => useValue(view));
    expect(result.current).toEqual({ start: 0, end: 1 });
    act(() => {
      source.value = { start: 1, end: 2 };
    });
    expect(result.current).toEqual({ start: 1, end: 2 });
  });

  test("value types come from `.value`, for writable and read-only sources", () => {
    const fromParam: number = renderHook(() => useValue(new Param({ default: 1 }))).result.current;
    const fromCell: string = renderHook(() => useValue(new Cell("a"))).result.current;
    expect([fromParam, fromCell]).toEqual([1, "a"]);
  });
});
