import { afterEach, expect, test, vi } from "vitest";
import { WavePlayer, type WaveStretchProcessor } from "@audiorective/player";
import { mountWaveformSelector } from "../src";
import type { WaveformRenderer } from "../src/waveform";
import { bandsFile, cleanup, drag, element, host, own } from "./helpers";

// A deterministic shape adapter checks publication/interaction; pitch DSP has its own real-WASM suite.
const stretch: WaveStretchProcessor = {
  async process(input, { ratio }) {
    const output = new AudioBuffer({
      length: Math.round(input.length * ratio),
      numberOfChannels: input.numberOfChannels,
      sampleRate: input.sampleRate,
    });
    for (let c = 0; c < input.numberOfChannels; c++) {
      const channel = input.getChannelData(c);
      output.copyToChannel(
        Float32Array.from({ length: output.length }, (_, i) => channel[Math.min(channel.length - 1, Math.floor(i / ratio))]!),
        c,
      );
    }
    return output;
  },
};
async function fixture() {
  const context = new AudioContext(),
    player = new WavePlayer(context, { stretch });
  own(() => context.close());
  own(() => player.dispose());
  await player.load(bandsFile());
  return { context, player };
}
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

test("shared selectors consume one committed peaks version without rescanning their source PCM", async () => {
  const { player } = await fixture();
  const read = vi.spyOn(player.buffer!, "getChannelData");
  const frames: number[] = [];
  const renderer: WaveformRenderer = () => ({
    render(frame) {
      if (frame.peaks) frames.push(frame.peaks.duration);
    },
  });
  const a = host(),
    b = host();
  const one = mountWaveformSelector(a, { player }),
    two = mountWaveformSelector(b, { player, renderer });
  own(() => one.dispose());
  own(() => two.dispose());
  expect(read).not.toHaveBeenCalled();
  one.setSelection({ start: 1, end: 2 });
  await player.audition();
  element<HTMLButtonElement>(a, "zoom-in").click();
  const before = one.getState().pixelsPerSecond * one.getState().duration;
  const revision = player.cells.version.value!.revision;
  const pending = player.setStretch(1.5);
  expect(element(a, "processing").hidden).toBe(false);
  expect(player.cells.version.value!.revision).toBe(revision);
  await pending;
  expect(player.sourceBuffer!.duration).toBe(6);
  expect(player.buffer!.duration).toBe(9);
  expect(player.cells.version.value!.peaks.duration).toBe(9);
  expect(frames.at(-1)).toBe(9);
  for (const view of [one, two])
    expect(view.getState()).toMatchObject({
      duration: 9,
      selection: { start: 1.5, end: 3 },
      isPlaying: false,
      processing: false,
      stretchRatio: 1.5,
      revision: player.cells.version.value!.revision,
    });
  expect(one.getState().pixelsPerSecond * 9).toBeCloseTo(before, 1);
  expect(element(a, "processing").hidden).toBe(true);
  one.dispose();
  expect(two.getState().duration).toBe(9);
  expect(player.cells.version.value!.revision).toBeGreaterThan(revision);
});

test("selector maps source beat grid into committed output seconds before native pointer snapping", async () => {
  const { player } = await fixture();
  const root = host();
  const view = mountWaveformSelector(root, { player, grid: { beats: [0, 1, 2, 3, 4, 5, 6], downbeats: [0, 4] } });
  own(() => view.dispose());
  await player.setStretch(1.5);
  const snap = element<HTMLSelectElement>(root, "snap");
  snap.value = "beat";
  snap.dispatchEvent(new Event("change"));
  await drag(element(root, "waveform"), 9, 1.65, 4.1);
  expect(player.cells.selection.value).toEqual({ start: 1.5, end: 4.5 });
  await expect.poll(() => player.cells.isPlaying.value).toBe(true);
  expect(view.getState().stretchRatio).toBe(1.5);
});

test("failed render keeps coherent displayed data and rejects to the caller; a new source resets both views", async () => {
  const context = new AudioContext();
  own(() => context.close());
  const player = new WavePlayer(context, {
    stretch: {
      async process() {
        throw Error("Render rejected");
      },
    },
  });
  own(() => player.dispose());
  await player.load(bandsFile());
  const a = host(),
    b = host();
  const one = mountWaveformSelector(a, { player }),
    two = mountWaveformSelector(b, { player });
  own(() => one.dispose());
  own(() => two.dispose());
  one.setSelection({ start: 1, end: 2 });
  const revision = player.cells.version.value!.revision;
  await expect(player.setStretch(1.5)).rejects.toThrow("Render rejected");
  expect(player.cells.version.value!.revision).toBe(revision);
  expect(one.getState()).toMatchObject({ duration: 6, selection: { start: 1, end: 2 }, processing: false, error: null }); // the rejection belongs to the caller of setStretch
  expect(element(a, "error").hidden).toBe(true);
  expect(element(b, "error").hidden).toBe(true);
  await player.load(bandsFile(1));
  for (const view of [one, two])
    expect(view.getState()).toMatchObject({ duration: 1, sourceDuration: 1, selection: null, stretchRatio: 1, error: null });
});
