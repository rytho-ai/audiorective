import { describe, expect, test } from "vitest";
import { ClipLauncher } from "../src/ClipLauncher";
import { driveOffline } from "./offline";
import { rig, SR } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s. Buffers are 4-second ramps (value = seconds into the material / 4), scaled per layer.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);
function ramp(ctx: BaseAudioContext, scale: number, seconds = 4): AudioBuffer {
  const buffer = new AudioBuffer({ length: seconds * SR, sampleRate: SR, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (scale * i) / (4 * SR);
  return buffer;
}

describe("clip.buffer and configure({ buffer })", () => {
  test("buffer is the clip's current audio and follows a replacement", async () => {
    const { ctx } = rig(1);
    const first = ramp(ctx, 0.5);
    const launcher = new ClipLauncher(
      { t: [{ buffer: first }, { sound: () => ({ output: ctx.createGain(), dispose() {} }) as never }] },
      { context: ctx },
    );
    const clip = launcher.tracks.t!.clips[0]!;
    expect(clip.buffer.value).toBe(first);
    const next = ramp(ctx, 0.5);
    clip.configure({ buffer: next });
    expect(clip.buffer.value).toBe(next);
    expect(launcher.tracks.t!.clips[1]!.buffer.value).toBeNull();
    expect(() => launcher.tracks.t!.clips[1]!.configure({ buffer: next })).toThrow("Clip Launcher can only replace the buffer of a buffer clip.");
    launcher.dispose();
  });

  test("replacing the buffer of a playing loop swaps without a gap and keeps the phase", async () => {
    const { ctx, ticks, clock } = rig(7);
    const launcher = new ClipLauncher({ t: [{ buffer: ramp(ctx, 0.5), loop: true }] }, { context: ctx });
    clock.attach(launcher);
    const clip = launcher.tracks.t!.clips[0]!;
    // 1.2 s in the loop plays a 0..0.5 ramp; the replacement is the same ramp with twice the level
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => clip.launch() },
        { at: 1.3, run: () => clip.configure({ buffer: ramp(ctx, 1) }) },
      ],
      start(clock),
    );
    const data = out.getChannelData(0);
    const at = (seconds: number) => data[Math.round(seconds * SR)]!;
    // the clip starts at the 1 m boundary 0.1 s after the transport start of 0.1 s: 2.1 s? it is the first bar line at or after 0.1 s, i.e. 0.1 s
    const t0 = 0.1;
    expect(at(1.2)).toBeCloseTo((0.5 * (1.2 - t0)) / 4, 3); // before the swap: the old layer
    expect(at(3)).toBeCloseTo((1 * (3 - t0)) / 4, 3); // after: the new layer at the same position, not restarted
    // no sample between 1.2 s and 3 s drops below the old ramp: nothing was silenced at the swap
    for (let i = Math.round(1.2 * SR); i < Math.round(3 * SR); i++) expect(data[i]!).toBeGreaterThan((0.5 * (1.2 - t0)) / 4 - 1e-3);
    launcher.dispose();
  });
});

describe("ClipLauncher event listeners", () => {
  test("removeEventListener takes the typed ClipEvent listener addEventListener does", () => {
    const { ctx } = rig(1);
    const launcher = new ClipLauncher({ t: [{ buffer: ramp(ctx, 1) }] }, { context: ctx });
    const seen: string[] = [];
    const listener = (event: { type: string }) => void seen.push(event.type);
    launcher.addEventListener("queued", listener);
    launcher.removeEventListener("queued", listener);
    launcher.dispatchEvent(new Event("queued"));
    expect(seen).toEqual([]);
    launcher.dispose();
  });
});
