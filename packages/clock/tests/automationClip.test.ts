import { describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { AutomationClip, AutomationCurve, audioParamTarget, type AutomationTarget } from "@audiorective/core/automation";
import { Clock, ManualTickSource, renderTimeline } from "../src";

const SR = 48000;
const ramp = () =>
  new AutomationCurve([
    { time: 0, value: 0, shape: "linear" },
    { time: 4, value: 1, shape: "hold" },
  ]);
const sample = (buffer: AudioBuffer, time: number) => buffer.getChannelData(0)[Math.round(time * SR)]!;
function gainTarget(ctx: OfflineAudioContext, initial = 0) {
  const gain = new GainNode(ctx, { gain: initial });
  const source = new ConstantSourceNode(ctx, { offset: 1 });
  source.connect(gain).connect(ctx.destination);
  source.start();
  return audioParamTarget(gain.gain);
}

describe("AutomationClip with Clock", () => {
  test("maps beats to audio time, holds a finite endpoint, and follows the public attachment contract", async () => {
    let clip!: AutomationClip;
    let clock!: Clock;
    const attached: boolean[] = [];
    let stop!: () => void;
    const buffer = await renderTimeline({ seconds: 2.5, sampleRate: SR, channels: 1 }, (ctx, tickSource) => {
      clock = new Clock({ context: ctx, tickSource, bpm: 120 });
      clip = new AutomationClip(ramp(), { target: gainTarget(ctx) });
      stop = effect(() => {
        attached.push(clip.cells.attached.value);
      });
      clock.attach(clip);
      clock.start();
    });
    expect(sample(buffer, 0.5)).toBeCloseTo(0.25, 5);
    expect(sample(buffer, 1.5)).toBeCloseTo(0.75, 5);
    expect(sample(buffer, 2.4)).toBeCloseTo(1, 5);
    expect(Object.isFrozen(clip.cells)).toBe(true);
    clip.dispose();
    clip[Symbol.dispose]();
    expect(attached).toEqual([false, true, false]);
    stop();
    clock.dispose();
  });

  test("preserves hold jumps and discontinuous loop seams through a scheduled nonlinear tempo ramp", async () => {
    let clip!: AutomationClip;
    let clock!: Clock;
    const curve = new AutomationCurve([
      { time: 0, value: 0, shape: "linear" },
      { time: 1, value: 1, shape: "hold" },
      { time: 1.5, value: 0.2, shape: "linear" },
      { time: 2, value: 0.8, shape: "hold" },
    ]);
    const buffer = await renderTimeline({ seconds: 3, sampleRate: SR, channels: 1 }, (ctx, tickSource) => {
      clock = new Clock({ context: ctx, tickSource, bpm: 60, lookAhead: 0.2 });
      clock.bpm.setValueAtTime(60, 0).linearRampToValueAtTime(180, 2);
      clip = new AutomationClip(curve, { target: gainTarget(ctx), loop: true });
      clock.attach(clip);
      clock.start();
    });
    // Independently integrate 60 + 60t BPM until 2 s, then 180 BPM.
    const beatAt = (t: number) => (t <= 2 ? t + (t * t) / 2 : 4 + 3 * (t - 2));
    const expected = (t: number) => {
      const beat = beatAt(t) % 2;
      return beat < 1 ? beat : beat < 1.5 ? 1 : 0.2 + (beat - 1.5) * 1.2;
    };
    for (const time of [0.1, 0.5, 0.8, 1, 1.1, 1.3, 1.6, 1.9, 2.1, 2.4, 2.8])
      expect(sample(buffer, time), `time ${time}`).toBeCloseTo(expected(time), 4);
    // At 2 s exactly, beat 4 starts the third pass without interpolating its jump.
    expect(sample(buffer, 2 - 1 / SR)).toBeCloseTo(0.8, 3);
    expect(sample(buffer, 2)).toBeCloseTo(0, 5);
    clip.dispose();
    clock.dispose();
  });

  test("re-times an already queued look-ahead after a live tempo edit", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const change = 0.512;
    const buffer = await renderTimeline(
      {
        seconds: 2,
        sampleRate: SR,
        channels: 1,
        actions: [
          {
            at: change,
            run: () => {
              clock.bpm.value = 240;
            },
          },
        ],
      },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.4 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx) });
        clock.attach(clip);
        clock.start();
      },
    );
    for (const time of [0.25, 0.55, 0.65, 0.9, 1.1, 1.5]) {
      const beat = time < change ? 2 * time : 2 * change + 4 * (time - change);
      expect(sample(buffer, time)).toBeCloseTo(Math.min(beat / 4, 1), 4);
    }
    clip.dispose();
    clock.dispose();
  });

  test("pause holds the actual target and resume continues from the frozen beat", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const buffer = await renderTimeline(
      {
        seconds: 2,
        sampleRate: SR,
        channels: 1,
        actions: [
          { at: 0.512, run: () => clock.pause() },
          { at: 1.024, run: () => clock.resume() },
        ],
      },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.3 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx) });
        clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.4)).toBeCloseTo(0.2, 5);
    expect(sample(buffer, 0.8)).toBeCloseTo(0.256, 5);
    expect(sample(buffer, 1.2)).toBeCloseTo((1.2 - 0.512) / 2, 5);
    clip.dispose();
    clock.dispose();
  });

  test("seek replaces pending ramps with the correct mid-curve value", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const buffer = await renderTimeline(
      { seconds: 1, sampleRate: SR, channels: 1, actions: [{ at: 0.256, run: () => clock.seek(3) }] },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.4 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx) });
        clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.2)).toBeCloseTo(0.1, 5);
    expect(sample(buffer, 0.3)).toBeCloseTo((3 + 2 * (0.3 - 0.256)) / 4, 5);
    expect(sample(buffer, 0.9)).toBeCloseTo(1, 5);
    clip.dispose();
    clock.dispose();
  });

  test.each(["stop", "detach", "dispose", "abort"] as const)("%s cancels pending ramps and leaves actual current audio held", async (action) => {
    let clock!: Clock;
    let clip!: AutomationClip;
    let detach!: () => void;
    const controller = new AbortController();
    const buffer = await renderTimeline(
      {
        seconds: 1,
        sampleRate: SR,
        channels: 1,
        actions: [
          {
            at: 0.512,
            run: () => {
              if (action === "stop") clock.stop();
              else if (action === "detach") detach();
              else if (action === "dispose") clip.dispose();
              else controller.abort();
            },
          },
        ],
      },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.4 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx), signal: controller.signal });
        detach = clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.9)).toBeCloseTo(0.256, 5);
    expect(clip.cells.attached.value).toBe(action === "stop");
    clip.dispose();
    clock.dispose();
  });

  test("curve edits retract pending automation from now and use the current transport beat", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const curve = ramp();
    const buffer = await renderTimeline(
      {
        seconds: 1,
        sampleRate: SR,
        channels: 1,
        actions: [
          {
            at: 0.256,
            run: () => {
              curve.value = [
                { time: 0, value: 1, shape: "linear" },
                { time: 4, value: 0, shape: "hold" },
              ];
            },
          },
        ],
      },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.5 });
        clip = new AutomationClip(curve, { target: gainTarget(ctx) });
        clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.2)).toBeCloseTo(0.1, 5);
    expect(sample(buffer, 0.3)).toBeCloseTo(0.85, 5);
    expect(sample(buffer, 0.8)).toBeCloseTo(0.6, 5);
    clip.dispose();
    clock.dispose();
  });

  test.each([0.512, 1.792])("external refresh at %s preserves an active ramp and its finite endpoint", async (at) => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const buffer = await renderTimeline(
      { seconds: 2.3, sampleRate: SR, channels: 1, actions: [{ at, run: () => clock.refresh() }] },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.4 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx) });
        clock.attach(clip);
        clock.start();
      },
    );
    for (const time of [0.6, 1.8, 1.9, 2.2]) expect(sample(buffer, time)).toBeCloseTo(Math.min(time / 2, 1), 5);
    clip.dispose();
    clock.dispose();
  });

  test("future starts and negative count-ins preserve the target until curve beat zero", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const buffer = await renderTimeline({ seconds: 1.5, sampleRate: SR, channels: 1 }, (ctx, tickSource) => {
      clock = new Clock({ context: ctx, tickSource, bpm: 120 });
      clip = new AutomationClip(ramp(), { target: gainTarget(ctx, 0.7) });
      clock.attach(clip);
      clock.start(0.5, -1);
    });
    expect(sample(buffer, 0.25)).toBeCloseTo(0.7, 5);
    expect(sample(buffer, 0.75)).toBeCloseTo(0.7, 5);
    expect(sample(buffer, 1)).toBeCloseTo(0, 5);
    expect(sample(buffer, 1.4)).toBeCloseTo(0.2, 5);
    clip.dispose();
    clock.dispose();
  });

  test.each([0.5, 2])("explicit loop length %s truncates the curve or holds its endpoint", async (length) => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const curve = new AutomationCurve([
      { time: 0, value: 0, shape: "linear" },
      { time: 1, value: 1, shape: "hold" },
    ]);
    const buffer = await renderTimeline({ seconds: 1.5, sampleRate: SR, channels: 1 }, (ctx, tickSource) => {
      clock = new Clock({ context: ctx, tickSource, bpm: 120 });
      clip = new AutomationClip(curve, { target: gainTarget(ctx), loop: true, length });
      clock.attach(clip);
      clock.start();
    });
    for (const time of [0.1, 0.3, 0.7, 1.1, 1.3]) expect(sample(buffer, time)).toBeCloseTo(Math.min((2 * time) % length, 1), 5);
    clip.dispose();
    clock.dispose();
  });

  test("finite explicit length truncates at the sampled endpoint", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const buffer = await renderTimeline(
      { seconds: 1, sampleRate: SR, channels: 1, actions: [{ at: 0.512, run: () => clock.seek(3) }] },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx), length: 1 });
        clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.3)).toBeCloseTo(0.15, 5);
    expect(sample(buffer, 0.9)).toBeCloseTo(0.25, 5);
    clip.dispose();
    clock.dispose();
  });

  test("editing an inferred loop length updates the wrap inside the queued look-ahead", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const curve = new AutomationCurve([
      { time: 0, value: 0, shape: "linear" },
      { time: 2, value: 1, shape: "hold" },
    ]);
    const buffer = await renderTimeline(
      {
        seconds: 1.5,
        sampleRate: SR,
        channels: 1,
        actions: [
          {
            at: 0.512,
            run: () => {
              curve.value = [
                { time: 0, value: 0, shape: "linear" },
                { time: 1, value: 1, shape: "hold" },
              ];
            },
          },
        ],
      },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.4 });
        clip = new AutomationClip(curve, { target: gainTarget(ctx), loop: true });
        clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.3)).toBeCloseTo(0.3, 5);
    expect(sample(buffer, 0.6)).toBeCloseTo(0.2, 5);
    expect(sample(buffer, 1.1)).toBeCloseTo(0.2, 5);
    clip.dispose();
    clock.dispose();
  });

  test("cancelling a future start leaves the preexisting target value untouched", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const buffer = await renderTimeline(
      { seconds: 1, sampleRate: SR, channels: 1, actions: [{ at: 0.256, run: () => clip.dispose() }] },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource, bpm: 120, lookAhead: 0.8 });
        clip = new AutomationClip(ramp(), { target: gainTarget(ctx, 0.7) });
        clock.attach(clip);
        clock.start(0.5);
      },
    );
    expect(sample(buffer, 0.2)).toBeCloseTo(0.7, 5);
    expect(sample(buffer, 0.9)).toBeCloseTo(0.7, 5);
    expect(clip.cells.attached.value).toBe(false);
    clock.dispose();
  });

  test("its curve watcher survives a caller effect being disposed", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const curve = ramp();
    const buffer = await renderTimeline(
      {
        seconds: 1,
        sampleRate: SR,
        channels: 1,
        actions: [
          {
            at: 0.256,
            run: () => {
              curve.value = [{ time: 0, value: 0.7, shape: "hold" }];
            },
          },
        ],
      },
      (ctx, tickSource) => {
        clock = new Clock({ context: ctx, tickSource });
        const stopCaller = effect(() => {
          clip = new AutomationClip(curve, { target: gainTarget(ctx) });
        });
        stopCaller();
        clock.attach(clip);
        clock.start();
      },
    );
    expect(sample(buffer, 0.8)).toBeCloseTo(0.7, 5);
    clip.dispose();
    clock.dispose();
  });

  test("one-point curves, explicit length, invalid lengths and single-clock ownership", async () => {
    let clock!: Clock;
    let clip!: AutomationClip;
    const curve = new AutomationCurve([{ time: 0, value: 0.4, shape: "hold" }]);
    const target: AutomationTarget = { program: vi.fn(), hold: vi.fn() };
    expect(() => new AutomationClip(curve, { target, loop: true })).toThrow("positive length");
    expect(() => new AutomationClip(curve, { target, length: NaN })).toThrow("positive finite");
    const buffer = await renderTimeline({ seconds: 0.5, sampleRate: SR, channels: 1 }, (ctx, tickSource) => {
      clock = new Clock({ context: ctx, tickSource });
      clip = new AutomationClip(curve, { target: gainTarget(ctx) });
      const detach = clock.attach(clip);
      const other = new Clock({ context: ctx, tickSource: new ManualTickSource() });
      expect(() => other.attach(clip)).toThrow("already attached");
      other.dispose();
      detach();
      clock.attach(clip);
      clock.start();
    });
    expect(sample(buffer, 0.3)).toBeCloseTo(0.4, 5);
    clock.dispose();
    expect(clip.cells.attached.value).toBe(false);
    clip.dispose();
    const stopped = new Clock({ context: { currentTime: 0 }, tickSource: new ManualTickSource() });
    expect(() => stopped.attach(clip)).toThrow("disposed");
    stopped.dispose();
  });
});
