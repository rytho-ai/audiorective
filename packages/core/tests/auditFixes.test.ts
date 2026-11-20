import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AudioEngine,
  AudioProcessor,
  BufferPlayer,
  FilePlayer,
  Param,
  Sampler,
  SchedulableParam,
  WorkletUnavailableError,
  effect,
  registerWorklet,
} from "../src";
import { AutomationBinding, AutomationCurve, type AutomationTarget } from "../src/automation";

function makeBuffer(ctx: AudioContext, seconds = 0.5): AudioBuffer {
  return ctx.createBuffer(1, Math.max(1, Math.ceil(ctx.sampleRate * seconds)), ctx.sampleRate);
}

let ctx: AudioContext;
beforeEach(async () => {
  ctx = new AudioContext();
  await ctx.resume();
});
afterEach(() => {
  void ctx.close();
});

describe("SchedulableParam raw $ writes", () => {
  test("$(x) reaches the AudioParam like .value, and read-back does not undo it", () => {
    const gain = new GainNode(ctx, { gain: 0 });
    const p = new SchedulableParam({ default: 0.5, audioContext: ctx, audioParam: gain.gain });
    p.$(0.8);
    expect(gain.gain.value).toBeCloseTo(0.8);
    expect(p.read()).toBeCloseTo(0.8);
    p.syncFromAudio();
    expect(p.value).toBeCloseTo(0.8);
    expect(p.$()).toBeCloseTo(0.8);
    p.dispose();
  });

  test("$ stays tracked for reads", () => {
    const gain = new GainNode(ctx);
    const p = new SchedulableParam({ default: 0, audioContext: ctx, audioParam: gain.gain });
    const seen: number[] = [];
    const stop = effect(() => void seen.push(p.$()));
    p.$(1);
    p.value = 2;
    expect(seen).toEqual([0, 1, 2]);
    stop();
    p.dispose();
  });
});

describe("ParamBind.get", () => {
  test("seeds the initial value from external state, falling back to default", () => {
    let external = "square";
    const a = new Param<string>({ default: "sine", bind: { get: () => external, set: (v) => (external = v) } });
    expect(a.value).toBe("square");
    a.value = "saw";
    expect(external).toBe("saw");
    const b = new Param<string | undefined>({ default: "sine", bind: { get: () => undefined } });
    expect(b.value).toBe("sine");
    a.dispose();
  });
});

describe("AudioProcessor.dispose", () => {
  class P extends AudioProcessor<{ s: SchedulableParam }> {
    constructor(c: AudioContext) {
      super(c, ({ schedulableParam }) => ({ params: { s: schedulableParam({ default: 1 }) } }));
    }
    get output() {
      return undefined;
    }
  }

  test("disconnects the silencer and stops its constant sources", () => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const create = ctx.createConstantSource.bind(ctx);
    ctx.createConstantSource = () => {
      const cs = create();
      const stop = vi.spyOn(cs, "stop");
      stops.push(stop);
      return cs;
    };
    const p = new P(ctx);
    const silencer = (p as unknown as { _silencer: GainNode })._silencer;
    const disconnect = vi.spyOn(silencer, "disconnect");
    p.dispose();
    expect(disconnect).toHaveBeenCalled();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveBeenCalled();
  });
});

describe("AudioEngine", () => {
  test("state and latency have no writer", () => {
    const engine = new AudioEngine(ctx);
    expect(engine.state()).toBe("idle");
    expect(engine.state.value).toBe("idle");
    expect(engine.state.$()).toBe("idle");
    expect(() => {
      (engine.state as unknown as { value: string }).value = "running";
    }).toThrow();
    (engine.state.$ as unknown as (v: string) => void)("running");
    expect(engine.state()).toBe("idle");
    expect(() => {
      (engine.latency as unknown as { value: number }).value = 5;
    }).toThrow();
    expect(engine.latency.value).toBe(0);
    engine.dispose();
  });

  test("start/suspend/resume/untilReady do not subscribe a calling effect", async () => {
    const engine = new AudioEngine(ctx);
    let runs = 0;
    const stop = effect(() => {
      runs++;
      void engine.untilReady().catch(() => {});
      void engine.start();
      void engine.suspend();
      void engine.resume();
    });
    await engine.start();
    await engine.suspend();
    await engine.resume();
    expect(runs).toBe(1);
    stop();
    engine.dispose();
  });

  test("dispose rejects a pending untilReady and tears its wait down", async () => {
    const engine = new AudioEngine(ctx);
    await engine.suspend(); // idle stays idle
    const pending = engine.untilReady();
    engine.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    await expect(engine.untilReady()).rejects.toThrow(/disposed/);
  });

  test("a borrowed context is neither closed nor stripped of its onstatechange", () => {
    const owner = vi.fn();
    ctx.onstatechange = owner;
    const engine = new AudioEngine(ctx);
    ctx.dispatchEvent(new Event("statechange"));
    expect(owner).toHaveBeenCalledTimes(1); // the owner's handler survives the engine
    engine.dispose();
    expect(ctx.state).not.toBe("closed");
    expect(ctx.onstatechange).toBe(owner);
  });
});

describe("automation", () => {
  test("AutomationCurve.$ writes are validated, sorted and frozen like .value", () => {
    const curve = new AutomationCurve([{ time: 0, value: 0, shape: "linear" }]);
    expect(() => curve.$([])).toThrow(RangeError);
    expect(() => curve.$([{ time: -1, value: 0, shape: "linear" }])).toThrow(RangeError);
    curve.$([
      { time: 2, value: 1, shape: "linear" },
      { time: 1, value: 0, shape: "hold" },
    ]);
    expect(curve.value.map((p) => p.time)).toEqual([1, 2]);
    expect(Object.isFrozen(curve.value)).toBe(true);
    expect(Object.isFrozen(curve.value[0])).toBe(true);
  });

  test("AutomationBinding.start does not subscribe a calling effect to the curve", () => {
    const curve = new AutomationCurve([
      { time: 0, value: 0, shape: "linear" },
      { time: 1, value: 1, shape: "linear" },
    ]);
    const target: AutomationTarget = { program() {}, hold() {} };
    const binding = new AutomationBinding({ currentTime: 0 }, curve, target);
    let runs = 0;
    const stop = effect(() => {
      runs++;
      binding.start();
    });
    curve.value = [{ time: 0, value: 5, shape: "linear" }];
    expect(runs).toBe(1);
    stop();
    binding.dispose();
  });
});

describe("registerWorklet", () => {
  test("lives in core and rejects without audioWorklet", async () => {
    await expect(registerWorklet({} as BaseAudioContext, "x", "")).rejects.toBeInstanceOf(WorkletUnavailableError);
  });
});

describe("BufferPlayer", () => {
  test("isPlaying is read-only", () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 2) });
    expect(() => {
      (p.cells.isPlaying as unknown as { value: boolean }).value = true;
    }).toThrow();
    p.start();
    expect(p.cells.isPlaying.value).toBe(true);
    p.dispose();
  });

  test("loop controls are observable params that reach the live source", () => {
    const p = new BufferPlayer(ctx, { buffer: makeBuffer(ctx, 2) });
    const seen: boolean[] = [];
    const stop = effect(() => void seen.push(p.params.loop.value));
    p.loop = true;
    expect(p.params.loop.value).toBe(true);
    expect(p.loop).toBe(true);
    expect(seen).toEqual([false, true]);
    p.start();
    const src = (p as unknown as { _source: AudioBufferSourceNode })._source;
    expect(src.loop).toBe(true);
    p.params.loopStart.value = 0.25;
    p.loopEnd = 1;
    expect(src.loopStart).toBeCloseTo(0.25);
    expect(src.loopEnd).toBeCloseTo(1);
    expect(p.loopStart).toBeCloseTo(0.25);
    stop();
    p.dispose();
  });
});

describe("Sampler", () => {
  test("activeVoices is read-only", () => {
    const s = new Sampler(ctx, { buffer: makeBuffer(ctx, 1) });
    expect(() => {
      (s.cells.activeVoices as unknown as { value: number }).value = 3;
    }).toThrow();
    s.trigger();
    expect(s.cells.activeVoices.value).toBe(1);
    s.dispose();
  });

  test("buffer and reverse are observable params", () => {
    const s = new Sampler(ctx);
    const seen: Array<AudioBuffer | null> = [];
    const stop = effect(() => void seen.push(s.params.buffer.value));
    const b = makeBuffer(ctx);
    s.buffer = b;
    expect(s.params.buffer.value).toBe(b);
    expect(seen).toEqual([null, b]);
    s.reverse = true;
    expect(s.params.reverse.value).toBe(true);
    // The reversed copy follows a swapped buffer.
    s.trigger();
    const b2 = makeBuffer(ctx);
    s.buffer = b2;
    expect(s.trigger()).not.toBeNull();
    stop();
    s.dispose();
  });
});

describe("FilePlayer", () => {
  test("playback cells are read-only; loop and playbackRate are params", () => {
    const f = new FilePlayer(ctx);
    for (const c of [f.cells.isPlaying, f.cells.currentTime, f.cells.duration]) {
      expect(() => {
        (c as unknown as { value: unknown }).value = 1;
      }).toThrow();
    }
    f.loop = true;
    expect(f.audio.loop).toBe(true);
    expect(f.params.loop.value).toBe(true);
    f.params.playbackRate.value = 1.5;
    expect(f.audio.playbackRate).toBe(1.5);
    expect(f.playbackRate).toBe(1.5);
    f.dispose();
  });

  test("the element still drives the cells", () => {
    const f = new FilePlayer(ctx);
    f.audio.dispatchEvent(new Event("play"));
    expect(f.cells.isPlaying.value).toBe(true);
    f.audio.dispatchEvent(new Event("pause"));
    expect(f.cells.isPlaying.value).toBe(false);
    f.dispose();
  });

  test("onEnded returns an unsubscribe", () => {
    const f = new FilePlayer(ctx);
    const cb = vi.fn();
    const off = f.onEnded(cb);
    f.audio.dispatchEvent(new Event("ended"));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    f.audio.dispatchEvent(new Event("ended"));
    expect(cb).toHaveBeenCalledTimes(1);
    f.dispose();
  });
});
