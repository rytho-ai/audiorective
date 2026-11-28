import { expect, test } from "vitest";
import { Clock } from "@audiorective/clock";
import { AudioRecorder } from "../src/AudioRecorder";

test.each([false, true])("late native capture reports its actual first-frame beat (quantized=%s)", async (quantized) => {
  const context = new AudioContext({ sampleRate: 48000 });
  const clock = new Clock({ context, bpm: 1200 });
  const recorder = new AudioRecorder(context, { channels: 1 });
  const source = new ConstantSourceNode(context, { offset: 0.25 });
  source.connect(recorder.input);
  source.start();
  let plannedBeat = NaN;
  let calls = 0;
  let delayed = false;
  const detach = clock.attach({
    schedule: () => {},
    reset: (reason) => recorder.reset(reason),
    attached: (handle) =>
      recorder.attached({
        ...handle,
        timeline: {
          timeToBeat: (time) => handle.timeline.timeToBeat(time),
          beatToTime: (beat) => {
            const time = handle.timeline.beatToTime(beat);
            if (!delayed && ++calls === (quantized ? 2 : 1)) {
              delayed = true;
              plannedBeat = beat - 0.5; // length "8n" is half a beat.
              const plannedTime = handle.timeline.beatToTime(plannedBeat);
              // Deterministic main-thread work after planning, before the real native graph exists.
              const until = performance.now() + Math.max(0, (plannedTime - context.currentTime) * 1000) + 60;
              while (performance.now() < until) {
                /* test-only delay; native audio clock keeps advancing */
              }
            }
            return time;
          },
        },
      }),
  });
  try {
    await context.resume();
    await recorder.ready;
    clock.start();
    const take = await recorder.record({ length: "8n", ...(quantized ? { quantize: "1m" as const } : {}) });
    expect(delayed).toBe(true);
    expect(take.startTime).toBe(take.startFrame / context.sampleRate);
    expect(take.startBeat).toBeCloseTo(clock.timeline.timeToBeat(take.startTime), 8);
    expect(take.startBeat).toBeGreaterThan(plannedBeat + 0.5);
    expect(take.endFrame - take.startFrame).toBe(1200);
    expect(take.channels[0][0]).toBeCloseTo(0.25, 6);
  } finally {
    detach();
    recorder.dispose();
    clock.dispose();
    source.stop();
    await context.close();
  }
});
