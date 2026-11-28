import { describe, expect, test, vi } from "vitest";
import { withCancel, type CancellableEvent } from "../src";

function fakeEvent() {
  const listeners: Array<() => void> = [];
  const event: CancellableEvent & { end(): void; cancel: ReturnType<typeof vi.fn> } = {
    cancel: vi.fn(),
    onEnded: (listener) => void listeners.push(listener),
    end: () => listeners.splice(0).forEach((listener) => listener()),
  };
  return event;
}

describe("withCancel", () => {
  test("cancel cancels the event and runs undo once", () => {
    const inner = fakeEvent();
    const undo = vi.fn();
    const event = withCancel(inner, undo);
    event.cancel();
    event.cancel();
    expect(inner.cancel).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  test("cancel forwards the requested audio-time boundary only once", () => {
    const inner = fakeEvent();
    const undo = vi.fn();
    const event = withCancel(inner, undo);

    event.cancel(12.5);
    event.cancel(15);

    expect(inner.cancel).toHaveBeenCalledTimes(1);
    expect(inner.cancel).toHaveBeenCalledWith(12.5);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  test("onEnded passes through to the wrapped event", () => {
    const inner = fakeEvent();
    const event = withCancel(inner, () => {});
    const ended = vi.fn();
    event.onEnded(ended);
    inner.end();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  test("an event that already ended is not undone by a late cancel", () => {
    const inner = fakeEvent();
    const undo = vi.fn();
    const event = withCancel(inner, undo);
    inner.end();
    event.cancel();
    expect(undo).not.toHaveBeenCalled();
    expect(inner.cancel).not.toHaveBeenCalled();
  });

  test("a null event ends when cancelled and still runs undo", () => {
    const undo = vi.fn();
    const event = withCancel(null, undo);
    const early = vi.fn();
    event.onEnded(early);
    expect(early).not.toHaveBeenCalled();
    event.cancel();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(early).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    event.onEnded(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  test("a throwing wrapped cancel propagates", () => {
    const inner = fakeEvent();
    inner.cancel.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => withCancel(inner, () => {}).cancel()).toThrow("boom");
  });
});
