import { expect, test } from "vitest";
import { PadBank } from "@audiorective/pads";
import type { CancellableEvent, Voice } from "@audiorective/core";
import { Clock, LinearBarRuler, ManualTickSource, Timeline } from "@audiorective/clock";

/** A voice as a clock-owned event: the clock stops it when the transport retracts it. */
const queued: Voice[] = [];
const pending = () => queued.filter((voice) => voice.playing.value).length;
const owned = (voice: Voice): CancellableEvent => (
  queued.push(voice),
  {
    cancel: () => voice.stop(),
    onEnded: (listener) => void voice.playing.subscribe((playing) => playing || listener()),
  }
);

test("a Clock-owned future choke is cancellable while a manual pad hit keeps sounding", async () => {
  const context = new AudioContext();
  await context.resume();
  const buffer = (seconds: number, level: number) => {
    const value = context.createBuffer(1, Math.round(seconds * context.sampleRate), context.sampleRate);
    value.getChannelData(0).fill(level);
    return value;
  };
  const bank = new PadBank(context, [
    { id: "open", sound: buffer(0.4, 0.3), group: "hat" },
    { id: "closed", sound: buffer(0.06, 0.1), group: "hat" },
  ]);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  bank.output.connect(analyser);
  analyser.connect(context.destination);
  const source = new ManualTickSource();
  const timeline = new Timeline({ audioContext: context, bpm: 120 }).addRuler("bar", new LinearBarRuler({ numerator: 4, denominator: 4 }));
  let closedEnabled = true;
  const clock = new Clock({
    timeline,
    tickSource: source,
    lookAhead: 0.2,
    onTick(window) {
      for (const point of window.rulers.bar.grid(16)) {
        if (point.index !== 1 || !closedEnabled) continue;
        const hit = bank.trigger("closed", { when: point.time });
        if (hit) window.own(owned(hit), point.time);
      }
    },
  });
  const level = () => {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
  };
  try {
    const manual = bank.trigger("open")!;
    clock.start();
    source.tick();
    // The queued hit is scheduled ahead, so only the manual hit is sounding.
    expect(bank.cells.activeVoices.value).toBe(1);
    expect(pending()).toBe(1);
    closedEnabled = false;
    clock.refresh(); // pattern edit retracts the queued hit and its choke
    expect(pending()).toBe(0);
    expect(bank.cells.activeVoices.value).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(level()).toBeCloseTo(0.3, 2);
    clock.stop();
    closedEnabled = true;
    clock.start();
    source.tick();
    expect(pending()).toBe(1);
    await expect.poll(level, { timeout: 1000 }).toBeLessThan(0.001);
    expect(bank.cells.activeVoices.value).toBe(0);
    manual.stop();
  } finally {
    clock.dispose();
    bank.dispose();
    analyser.disconnect();
    await context.close();
  }
});

test("refresh at a hit's exact audio time renders one hit, not two", async () => {
  async function render(refresh: boolean) {
    const rate = 48_000;
    const context = new OfflineAudioContext(1, rate / 10, rate);
    const buffer = context.createBuffer(1, rate / 10, rate);
    buffer.getChannelData(0).fill(0.3);
    const bank = new PadBank(context, [{ id: "hit", sound: buffer }]);
    bank.output.connect(context.destination);
    const ticks = new ManualTickSource();
    const timeline = new Timeline({ audioContext: context, bpm: 120 }).addRuler("bar", new LinearBarRuler({ numerator: 4, denominator: 4 }));
    const clock = new Clock({
      timeline,
      tickSource: ticks,
      lookAhead: 0.05,
      onTick(window) {
        for (const point of window.rulers.bar.grid(16)) {
          if (point.index !== 0) continue;
          const hit = bank.trigger("hit", { when: point.time });
          if (hit) window.own(owned(hit), point.time);
        }
      },
    });
    clock.start();
    ticks.tick();
    if (refresh) clock.refresh(); // the same AudioContext time: 0
    const output = await context.startRendering();
    clock.dispose();
    bank.dispose();
    return output.getChannelData(0)[rate / 100]!;
  }
  expect(await render(false)).toBeCloseTo(0.3, 5);
  expect(await render(true)).toBeCloseTo(0.3, 5);
});
