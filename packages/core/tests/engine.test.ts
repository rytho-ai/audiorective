import { describe, test, expect, vi } from "vitest";
import { AudioProcessor, AudioEngine, createEngine, type Param } from "../src";

class TestProcessor extends AudioProcessor<{ vol: Param<number> }> {
  constructor(ctx: AudioContext) {
    super(ctx, ({ param }) => ({
      params: { vol: param<number>({ default: 0.5 }) },
    }));
  }

  get output(): AudioNode | undefined {
    return undefined;
  }
}

// Chromium (autoplay flag) starts a context running; most lifecycle tests need one that is suspended.
async function suspendedContext(): Promise<AudioContext> {
  const ctx = new AudioContext();
  await ctx.suspend();
  return ctx;
}

class TestEngine extends AudioEngine {
  constructor(ctx?: AudioContext) {
    super(ctx);
    this.register(new TestProcessor(this.context));
  }

  getProcessor(): TestProcessor {
    return (this as any)._processors[0] as TestProcessor;
  }
}

describe("AudioEngine", () => {
  test("constructor creates AudioContext and registers processors", () => {
    const engine = new TestEngine();
    expect(engine.context).toBeInstanceOf(AudioContext);
    expect(engine.getProcessor()).toBeInstanceOf(TestProcessor);
    engine.dispose();
  });

  test("initial state mirrors the context", async () => {
    const running = new TestEngine();
    await running.resume();
    expect(new TestEngine(running.context).state.value).toBe("running");
    running.dispose();
    const engine = new TestEngine(await suspendedContext());
    expect(engine.state.value).toBe("suspended");
    engine.dispose();
  });

  test("resume() resumes the context, state becomes 'running'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    expect(engine.state.value).toBe("running");
    expect(engine.context.state).toBe("running");
    engine.dispose();
  });

  test("suspend() when the context is not running leaves it suspended", async () => {
    const engine = new TestEngine();
    Object.defineProperty(engine.context, "state", { value: "suspended", configurable: true });
    await engine.suspend();
    expect(engine.state.value).toBe("suspended");
    engine.dispose();
  });

  test("resume() and suspend() reject with InvalidStateError after dispose()", async () => {
    const engine = new TestEngine();
    engine.dispose();
    await expect(engine.resume()).rejects.toMatchObject({ name: "InvalidStateError", message: "AudioEngine is disposed." });
    await expect(engine.suspend()).rejects.toMatchObject({ name: "InvalidStateError", message: "AudioEngine is disposed." });
    await expect(engine.resume()).rejects.toBeInstanceOf(DOMException);
  });

  test("state is a ReadonlyCell that changes through the lifecycle and ends 'closed'", async () => {
    const engine = new TestEngine(await suspendedContext());
    const seen: AudioContextState[] = [];
    engine.state.subscribe((s) => seen.push(s), { immediate: true });
    await engine.resume();
    await engine.suspend();
    await engine.resume();
    engine.dispose();
    expect(seen[0]).toBe("suspended");
    expect(seen).toContain("running");
    expect(seen.at(-1)).toBe("closed");
    expect(engine.state.value).toBe("closed");
  });

  test("[Symbol.dispose]() disposes the engine, and a second dispose is safe", () => {
    const engine = new TestEngine();
    engine[Symbol.dispose]();
    expect(engine.state.value).toBe("closed");
    expect(() => engine.dispose()).not.toThrow();
    expect(() => engine[Symbol.dispose]()).not.toThrow();
  });

  test("aborting options.signal disposes the engine", () => {
    const controller = new AbortController();
    const engine = new AudioEngine(undefined, { signal: controller.signal });
    const processor = engine.register(new TestProcessor(engine.context));
    const spy = vi.spyOn(processor, "dispose");
    controller.abort();
    expect(engine.state.value).toBe("closed");
    expect(spy).toHaveBeenCalledOnce();
  });

  test("an already aborted signal disposes the engine at construction", () => {
    const engine = new AudioEngine(undefined, { signal: AbortSignal.abort() });
    expect(engine.state.value).toBe("closed");
  });

  test("createEngine passes options.signal through", () => {
    const controller = new AbortController();
    const engine = createEngine((ctx) => ({ processor: new TestProcessor(ctx) }), { signal: controller.signal });
    const spy = vi.spyOn(engine.processor, "dispose");
    controller.abort();
    expect(engine.core.state.value).toBe("closed");
    expect(spy).toHaveBeenCalled();
  });

  test("a borrowed context is not closed by dispose(), though the engine reads 'closed'", () => {
    const ctx = new AudioContext();
    const engine = new AudioEngine(ctx);
    engine.dispose();
    expect(engine.state.value).toBe("closed");
    expect(ctx.state).not.toBe("closed");
    void ctx.close();
  });

  test("accepts existing AudioContext in constructor", () => {
    const ctx = new AudioContext();
    const engine = new TestEngine(ctx);
    expect(engine.context).toBe(ctx);
    engine.dispose();
  });

  test("suspend() pauses context, state becomes 'suspended'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    await engine.suspend();
    expect(engine.state.value).toBe("suspended");
    expect(engine.context.state).toBe("suspended");
    engine.dispose();
  });

  test("resume() resumes from suspended, state becomes 'running'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    await engine.suspend();
    await engine.resume();
    expect(engine.state.value).toBe("running");
    engine.dispose();
  });

  test("resume() on non-suspended engine is a no-op", async () => {
    const engine = new TestEngine();
    await engine.resume();
    await engine.resume();
    expect(engine.state.value).toBe("running");
    engine.dispose();
  });

  test("dispose() sets state to 'disposed'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    engine.dispose();
    expect(engine.state.value).toBe("closed");
  });

  test("dispose() cleans up registered processors", () => {
    const engine = createEngine((ctx) => ({
      processor: new TestProcessor(ctx),
    }));
    const disposeSpy = vi.spyOn(engine.processor, "dispose");
    engine.core.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });

  test("dispose() is idempotent", () => {
    const engine = new TestEngine();
    engine.dispose();
    // Second dispose should not throw (context already closed)
    expect(() => engine.dispose()).not.toThrow();
  });

  test("untilReady() resolves when state becomes 'running'", async () => {
    const engine = new TestEngine();
    const promise = engine.untilReady();
    await engine.resume();
    await expect(promise).resolves.toBeUndefined();
    engine.dispose();
  });

  test("untilReady() resolves immediately if already running", async () => {
    const engine = new TestEngine();
    await engine.resume();
    await expect(engine.untilReady()).resolves.toBeUndefined();
    engine.dispose();
  });

  test("untilReady() returns cached promise", async () => {
    const engine = new TestEngine(await suspendedContext());
    const p1 = engine.untilReady();
    const p2 = engine.untilReady();
    expect(p1).toBe(p2);
    p1.catch(() => {}); // dispose() rejects a pending wait
    engine.dispose();
  });

  test("onstatechange syncs external suspension to state signal", async () => {
    const engine = new TestEngine();
    await engine.resume();
    expect(engine.state.value).toBe("running");

    // Simulate browser externally suspending the context by calling onstatechange directly
    // In production, the browser fires this when tab goes to background on mobile
    Object.defineProperty(engine.context, "state", { value: "suspended", writable: true });
    engine.context.dispatchEvent(new Event("statechange"));
    expect(engine.state.value).toBe("suspended");
    engine.dispose();
  });

  test("raw context.suspend() then raw context.resume() is mirrored and resolves untilReady()", async () => {
    const engine = new TestEngine();
    await engine.resume();
    await engine.context.suspend();
    await vi.waitFor(() => expect(engine.state.value).toBe("suspended"));
    await engine.context.resume();
    await vi.waitFor(() => expect(engine.state.value).toBe("running"));
    await expect(engine.untilReady()).resolves.toBeUndefined();
    engine.dispose();
  });

  test("statechange to 'interrupted' is mirrored as 'suspended'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    Object.defineProperty(engine.context, "state", { value: "interrupted", configurable: true });
    engine.context.dispatchEvent(new Event("statechange"));
    expect(engine.state.value).toBe("suspended");
    engine.dispose();
  });

  test("resume() from 'interrupted' calls context.resume() and becomes 'running'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    Object.defineProperty(engine.context, "state", { value: "interrupted", configurable: true });
    engine.context.dispatchEvent(new Event("statechange"));
    expect(engine.state.value).toBe("suspended");

    const spy = vi.spyOn(engine.context, "resume");
    await engine.resume();
    expect(spy).toHaveBeenCalledOnce();
    expect(engine.state.value).toBe("running");
    spy.mockRestore();
    engine.dispose();
  });

  test("resume() resumes a suspended context even when the mirror says 'running'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    expect(engine.state.value).toBe("running");
    // Stub the context as suspended without firing statechange, so the mirror is stale.
    Object.defineProperty(engine.context, "state", { value: "suspended", configurable: true });

    const spy = vi.spyOn(engine.context, "resume");
    await engine.resume();
    expect(spy).toHaveBeenCalledOnce();
    expect(engine.state.value).toBe("running");
    spy.mockRestore();
    engine.dispose();
  });

  test("an external close during an awaited resume() keeps the engine disposed", async () => {
    const engine = new TestEngine();
    await engine.resume();
    await engine.suspend();
    const ctx = engine.context;
    Object.defineProperty(ctx, "state", { value: "suspended", configurable: true });
    ctx.resume = () =>
      new Promise<void>((resolve) => {
        // The context closes while resume() is pending, then the promise settles.
        Object.defineProperty(ctx, "state", { value: "closed", configurable: true });
        ctx.dispatchEvent(new Event("statechange"));
        resolve();
      });
    await engine.resume();
    expect(engine.state.value).toBe("closed");
  });

  test("statechange to 'closed' marks the engine 'disposed'", async () => {
    const engine = new TestEngine();
    await engine.resume();
    Object.defineProperty(engine.context, "state", { value: "closed", configurable: true });
    engine.context.dispatchEvent(new Event("statechange"));
    expect(engine.state.value).toBe("closed");
  });

  test("dispose() still cleans up processors after the context closes externally", async () => {
    const engine = new TestEngine();
    await engine.resume();
    const processorDisposeSpy = vi.spyOn(engine.getProcessor(), "dispose");

    await engine.context.close();
    await vi.waitFor(() => expect(engine.state.value).toBe("closed"));
    expect(processorDisposeSpy).not.toHaveBeenCalled();

    engine.dispose();
    expect(processorDisposeSpy).toHaveBeenCalledOnce();
    processorDisposeSpy.mockRestore();
  });
});

describe("AudioEngine.autoStart", () => {
  test("starts engine on first gesture", async () => {
    const engine = new TestEngine();
    const target = new EventTarget();
    engine.autoStart(target);
    target.dispatchEvent(new Event("click"));
    await engine.untilReady();
    expect(engine.state.value).toBe("running");
    engine.dispose();
  });

  test("self-detaches after firing (subsequent events are no-ops)", async () => {
    const engine = new TestEngine();
    const target = new EventTarget();
    engine.autoStart(target);
    target.dispatchEvent(new Event("click"));
    await engine.untilReady();
    const startSpy = vi.spyOn(engine, "resume");
    target.dispatchEvent(new Event("click"));
    target.dispatchEvent(new Event("keydown"));
    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
    engine.dispose();
  });

  test("re-arms when state drops from running back to suspended", async () => {
    const engine = new TestEngine();
    const target = new EventTarget();
    engine.autoStart(target);

    target.dispatchEvent(new Event("click"));
    await engine.untilReady();
    expect(engine.state.value).toBe("running");

    await engine.suspend();
    expect(engine.state.value).toBe("suspended");

    target.dispatchEvent(new Event("click"));
    await engine.untilReady();
    expect(engine.state.value).toBe("running");
    engine.dispose();
  });

  test("returned detach removes listeners and stops effect", async () => {
    const engine = new TestEngine();
    const target = new EventTarget();
    const detach = engine.autoStart(target);
    detach();
    const startSpy = vi.spyOn(engine, "resume");
    target.dispatchEvent(new Event("click"));
    target.dispatchEvent(new Event("keydown"));
    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
    engine.dispose();
  });

  test("respects custom events option", async () => {
    const engine = new TestEngine(await suspendedContext());
    const target = new EventTarget();
    engine.autoStart(target, { events: ["pointerdown"] });

    target.dispatchEvent(new Event("click"));
    expect(engine.state.value).toBe("suspended");

    target.dispatchEvent(new Event("pointerdown"));
    await engine.untilReady();
    expect(engine.state.value).toBe("running");
    engine.dispose();
  });

  test("disarms permanently when engine is disposed", async () => {
    const engine = new TestEngine();
    const target = new EventTarget();
    engine.autoStart(target);
    engine.dispose();
    const startSpy = vi.spyOn(engine, "resume");
    target.dispatchEvent(new Event("click"));
    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
  });

  test("disarms after a raw context.resume()", async () => {
    const engine = new TestEngine();
    const target = new EventTarget();
    engine.autoStart(target);
    target.dispatchEvent(new Event("click"));
    await engine.untilReady();
    expect(engine.state.value).toBe("running");

    await engine.context.suspend();
    await vi.waitFor(() => expect(engine.state.value).toBe("suspended"));
    await engine.context.resume();
    await vi.waitFor(() => expect(engine.state.value).toBe("running"));

    const startSpy = vi.spyOn(engine, "resume");
    target.dispatchEvent(new Event("click"));
    expect(startSpy).not.toHaveBeenCalled();
    startSpy.mockRestore();
    engine.dispose();
  });
});

describe("createEngine", () => {
  test("returns engine with user-defined properties and .core", () => {
    const engine = createEngine((ctx) => {
      const processor = new TestProcessor(ctx);
      return { processor, label: "test" };
    });
    expect(engine.processor).toBeInstanceOf(TestProcessor);
    expect(engine.label).toBe("test");
    expect(engine.core).toBeInstanceOf(AudioEngine);
    engine.core.dispose();
  });

  test("auto-registers AudioProcessor instances", () => {
    const engine = createEngine((ctx) => ({
      processor: new TestProcessor(ctx),
    }));
    const disposeSpy = vi.spyOn(engine.processor, "dispose");
    engine.core.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });

  test("setup runs eagerly — properties available immediately", async () => {
    const context = await suspendedContext();
    const engine = createEngine(
      (ctx) => ({
        processor: new TestProcessor(ctx),
      }),
      { context },
    );
    expect(engine.processor).toBeInstanceOf(TestProcessor);
    expect(engine.core.state.value).toBe("suspended");
    engine.core.dispose();
  });

  test("throws on reserved key 'core'", () => {
    expect(() => createEngine(() => ({ core: "oops" }) as any)).toThrow('createEngine: setup returned reserved key "core"');
  });

  test("non-processor values are preserved", () => {
    const fn = () => 42;
    const engine = createEngine(() => ({
      count: 10,
      callback: fn,
      items: [1, 2, 3],
    }));
    expect(engine.count).toBe(10);
    expect(engine.callback).toBe(fn);
    expect(engine.items).toEqual([1, 2, 3]);
    engine.core.dispose();
  });

  test("accepts options.context", () => {
    const ctx = new AudioContext();
    const engine = createEngine(
      (c) => {
        expect(c).toBe(ctx);
        return {};
      },
      { context: ctx },
    );
    expect(engine.core.context).toBe(ctx);
    engine.core.dispose();
  });

  test("full lifecycle: resume → suspend → resume → dispose", async () => {
    const engine = createEngine(
      (ctx) => ({
        processor: new TestProcessor(ctx),
      }),
      { context: await suspendedContext() },
    );

    expect(engine.core.state.value).toBe("suspended");
    await engine.core.resume();
    expect(engine.core.state.value).toBe("running");
    await engine.core.suspend();
    expect(engine.core.state.value).toBe("suspended");
    await engine.core.resume();
    expect(engine.core.state.value).toBe("running");
    engine.core.dispose();
    expect(engine.core.state.value).toBe("closed");
  });

  test("an external context close rejects pending untilReady() waiters", async () => {
    const engine = new TestEngine(await suspendedContext());
    const pending = engine.untilReady();
    const rejected = expect(pending).rejects.toThrow(/disposed before it became ready/);
    Object.defineProperty(engine.context, "state", { value: "closed", configurable: true });
    engine.context.dispatchEvent(new Event("statechange"));
    await rejected;
    engine.dispose();
  });

  // The context calls are stubbed with a deferred promise so `dispose()` lands inside the await.
  function deferred(engine: TestEngine, method: "resume" | "suspend"): () => void {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(engine.context, method).mockImplementation(() => gate);
    return release;
  }

  test("dispose() during an in-flight resume() does not flip the state back", async () => {
    const engine = new TestEngine();
    await engine.resume();
    Object.defineProperty(engine.context, "state", { value: "suspended", configurable: true });
    const release = deferred(engine, "resume");
    const resuming = engine.resume();
    engine.dispose();
    release();
    await resuming;
    expect(engine.state.value).toBe("closed");
  });

  test("dispose() during an in-flight suspend() does not flip the state back", async () => {
    const engine = new TestEngine();
    await engine.resume();
    Object.defineProperty(engine.context, "state", { value: "running", configurable: true });
    const release = deferred(engine, "suspend");
    const suspending = engine.suspend();
    engine.dispose();
    release();
    await suspending;
    expect(engine.state.value).toBe("closed");
  });
});
