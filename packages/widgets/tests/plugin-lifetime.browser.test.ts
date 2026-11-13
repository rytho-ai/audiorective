import { afterEach, describe, expect, test, vi } from "vitest";
import { mountWaveform, type WaveformPluginContext } from "../src/waveform";
import { cleanup, host, own } from "./helpers";

function fixture() {
  const root = host();
  const view = mountWaveform(root, { data: { peaks: Float32Array.of(0.1, 0.3, 0.2), duration: 4 } });
  own(() => view.destroy());
  let context!: WaveformPluginContext;
  const attachment = view.attach({
    attach(ctx) {
      context = ctx;
    },
  });
  return { root, view, context, attachment };
}

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe("waveform plugin ownership", () => {
  test("detach removes registrations and overlay exactly once", () => {
    const { context, attachment, view } = fixture();
    const listener = vi.fn();
    const dispose = vi.fn();
    const overlay = document.createElement("div");
    context.mountOverlay(overlay);
    context.listen(context.surface, "probe", listener);
    context.onCleanup(dispose);
    context.surface.dispatchEvent(new Event("probe"));
    expect(listener).toHaveBeenCalledTimes(1);

    attachment.destroy();
    attachment.destroy();
    view.destroy();
    context.surface.dispatchEvent(new Event("probe"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(overlay.isConnected).toBe(false);
  });

  test("a listener registered by late asynchronous work stays inactive", async () => {
    const { context, attachment } = fixture();
    const listener = vi.fn();
    attachment.destroy();
    await Promise.resolve();
    const off = context.listen(context.surface, "probe", listener);
    context.surface.dispatchEvent(new Event("probe"));
    off();
    off();
    expect(listener).not.toHaveBeenCalled();
  });

  test("late data and viewport subscriptions stay inactive", () => {
    const { context, attachment, view } = fixture();
    attachment.destroy();
    const viewport = vi.fn();
    const data = vi.fn();
    const offViewport = context.onViewportChange(viewport);
    const offData = context.onDataChange(data);
    view.setZoom(2);
    view.setData({ peaks: Float32Array.of(0.2, 0.1), duration: 2 });
    offViewport();
    offData();
    expect(viewport).not.toHaveBeenCalled();
    expect(data).not.toHaveBeenCalled();
  });

  test("late cleanup runs immediately and is not repeated", () => {
    const { context, attachment, view } = fixture();
    attachment.destroy();
    const dispose = vi.fn();
    const off = context.onCleanup(dispose);
    expect(dispose).toHaveBeenCalledTimes(1);
    off();
    off();
    view.destroy();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("throwing cleanup cannot prevent peer cleanup or removal of the view", () => {
    const { root, view } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = vi.fn();
    const last = vi.fn();
    const peer = vi.fn();
    view.attach({
      attach(ctx) {
        ctx.onCleanup(first);
        ctx.onCleanup(() => {
          throw new Error("expected cleanup failure");
        });
        ctx.onCleanup(last);
        return () => {
          throw new Error("expected plugin destroy failure");
        };
      },
    });
    const attachment = view.attach({
      attach(ctx) {
        ctx.onCleanup(peer);
      },
    });
    expect(() => view.destroy()).not.toThrow();
    attachment.destroy();
    expect(first).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    expect(peer).toHaveBeenCalledTimes(1);
    expect(root.childElementCount).toBe(0);
  });

  test("failed attachment cleans its registrations and preserves the original error", () => {
    const { view } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("original attach failure");
    const listener = vi.fn();
    let context!: WaveformPluginContext;
    let caught: unknown;
    try {
      view.attach({
        attach(ctx) {
          context = ctx;
          ctx.listen(ctx.surface, "probe", listener);
          ctx.onCleanup(() => {
            throw new Error("secondary cleanup failure");
          });
          throw original;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    context.surface.dispatchEvent(new Event("probe"));
    expect(listener).not.toHaveBeenCalled();
  });

  test("cleanup registered during reentrant disposal also runs once", () => {
    const { context, attachment, view } = fixture();
    const inner = vi.fn();
    const outer = vi.fn(() => {
      attachment.destroy();
      context.onCleanup(inner);
    });
    context.onCleanup(outer);
    attachment.destroy();
    attachment.destroy();
    view.destroy();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });
  test.each(["function", "object"] as const)("destroy during attach disposes a late returned %s exactly once", (kind) => {
    const { view, root } = fixture();
    const cleanup = vi.fn();
    const returned = vi.fn();
    const attachment = view.attach({
      attach(ctx) {
        ctx.onCleanup(cleanup);
        view.destroy();
        return kind === "function" ? returned : { destroy: returned };
      },
    });
    attachment.destroy();
    attachment.destroy();
    view.destroy();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(root.childElementCount).toBe(0);
  });
});
