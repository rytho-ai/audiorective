import { expect, test } from "vitest";
import { createAuditioner } from "../../src/demos/midi/audition";

async function render(releaseFirst: boolean): Promise<number> {
  const context = new OfflineAudioContext(1, 48_000, 48_000);
  // Offline rendering starts only after scheduling; the demo's resume call is a no-op here.
  Object.defineProperty(context, "resume", { value: async () => {} });
  const noteId = "a";
  // The demo plays at 120 BPM: one beat is half a second.
  const source = {
    events: [
      { beat: 0, data: new Uint8Array([0x90, 60, 90]), noteId },
      ...(releaseFirst
        ? [
            { beat: 0.6, data: new Uint8Array([0x80, 60, 0]), noteId },
            { beat: 0.6, data: new Uint8Array([0xb0, 64, 127]) },
          ]
        : [
            { beat: 0.6, data: new Uint8Array([0xb0, 64, 127]) },
            { beat: 0.6, data: new Uint8Array([0x80, 60, 0]), noteId },
          ]),
      { beat: 1.2, data: new Uint8Array([0xb0, 64, 0]) },
    ],
  };
  const player = createAuditioner(context as unknown as AudioContext, context.destination, () => ({
    notes: [{ id: noteId, start: 0, duration: 0.6, pitch: 62, velocity: 90 / 127, channel: 0 }],
    duration: 1.6,
    selection: null,
    source,
  }));
  await player.play();
  const audio = (await context.startRendering()).getChannelData(0);
  player.dispose();
  let sum = 0;
  for (let i = 0.45 * 48_000; i < 0.5 * 48_000; i++) sum += audio[i] ** 2;
  return Math.sqrt(sum / (0.05 * 48_000));
}

test("edited take playback sustains in rendered audio only when pedal-down precedes release", async () => {
  expect(await render(true)).toBeLessThan(0.001);
  expect(await render(false)).toBeGreaterThan(0.02);
});
