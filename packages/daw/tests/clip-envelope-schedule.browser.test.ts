import { expect, test } from "vitest";
import { clipGainAt, normalizeClipEnvelope, scheduleClipEnvelope } from "../src";

test("a standalone playback window starts at its original fade level and follows the requested window", async () => {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  const source = new ConstantSourceNode(context, { offset: 1 });
  const gain = context.createGain();
  const envelope = normalizeClipEnvelope({ gain: 0.8, fadeIn: 0.4, fadeOut: 0.2 }, 0.8);
  source.connect(gain).connect(context.destination);
  scheduleClipEnvelope(gain.gain, envelope, 0.8, { when: 0.1, offset: 0.2, length: 0.5 });
  source.start(0.1);
  source.stop(0.6);
  const result = (await context.startRendering()).getChannelData(0);
  expect(result[4_000]).toBe(0);
  for (const time of [0.101, 0.25, 0.4, 0.55]) {
    expect(result[Math.round(time * 48_000)]).toBeCloseTo(clipGainAt(envelope, 0.8, time + 0.1), 4);
  }
});
