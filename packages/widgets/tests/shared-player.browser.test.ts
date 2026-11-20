import { afterEach, expect, test, vi } from "vitest";
import { WavePlayer } from "@audiorective/player";
import { mountWaveformSelector } from "../src";
import { mountWaveform, createSelectionPlugin } from "../src/waveform";
import { bandsFile, cleanup, host, own, element, drag, delay } from "./helpers";
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});
async function fixture() {
  const context = new AudioContext();
  const player = new WavePlayer(context);
  own(() => context.close());
  own(() => player.dispose());
  await player.load(bandsFile());
  return { context, player };
}
test("two selectors share one block; headless edits and gestures update both without mirrored selection", async () => {
  const { player } = await fixture();
  const a = host(),
    b = host();
  const onA = vi.fn(),
    onB = vi.fn();
  const one = mountWaveformSelector(a, { player, onSelectionChange: onA });
  const two = mountWaveformSelector(b, { player, onSelectionChange: onB });
  own(() => one.dispose());
  own(() => two.dispose());
  player.setSelection({ start: 1, end: 2 });
  expect(one.getState().selection).toEqual({ start: 1, end: 2 });
  expect(two.getState().selection).toEqual({ start: 1, end: 2 });
  expect(element(a, "selection").hidden).toBe(false);
  expect(element(b, "selection").hidden).toBe(false);
  expect(onA).toHaveBeenLastCalledWith({ start: 1, end: 2 });
  expect(onB).toHaveBeenLastCalledWith({ start: 1, end: 2 });
  two.setSelection({ start: 2, end: 3 });
  expect(one.getState().selection).toEqual({ start: 2, end: 3 });
  await drag(element(a, "waveform"), 6, 4.5, 4.8);
  await expect.poll(() => player.isPlaying).toBe(true);
  expect(two.getState().selection).toEqual(player.getSelection());
  expect(two.getState().isLooping).toBe(true);
  expect(one.output).toBe(two.output);
  expect(one.output).toBe(player.output);
});
test("removing one shared view preserves loop, peer selection and caller ownership", async () => {
  const { context, player } = await fixture();
  const one = mountWaveformSelector(host(), { player });
  const root = host();
  const two = mountWaveformSelector(root, { player });
  own(() => one.dispose());
  own(() => two.dispose());
  player.setSelection({ start: 3.4, end: 3.7 });
  await player.audition();
  one.dispose();
  await delay(400);
  expect(player.isPlaying).toBe(true);
  expect(player.getSelection()).toEqual({ start: 3.4, end: 3.7 });
  expect(two.getState().selection).toEqual(player.getSelection());
  expect(element(root, "selection").hidden).toBe(false);
  two.dispose();
  expect(player.isPlaying).toBe(true);
  expect(context.state).not.toBe("closed");
  player.pause();
  expect(player.isPlaying).toBe(false);
});
test("external source replacement resets both views and destruction while loading does not cancel caller load", async () => {
  const { player } = await fixture();
  const a = host(),
    b = host();
  const one = mountWaveformSelector(a, { player }),
    two = mountWaveformSelector(b, { player });
  own(() => one.dispose());
  own(() => two.dispose());
  one.setSelection({ start: 1, end: 2 });
  element<HTMLButtonElement>(a, "zoom-in").click();
  await player.load(bandsFile(1));
  for (const view of [one, two]) expect(view.getState()).toMatchObject({ duration: 1, selection: null, isPlaying: false, isLooping: false });
  expect(element(a, "selection").hidden).toBe(true);
  expect(element(b, "selection").hidden).toBe(true);
  const pending = player.load(bandsFile(2));
  one.dispose();
  await pending;
  expect(player.duration).toBeCloseTo(2, 3);
  expect(two.getState().duration).toBeCloseTo(2, 3);
});
test("pure waveform accepts a structural selection model; disposing or clearing a view leaves it intact", async () => {
  const { player } = await fixture();
  player.setSelection({ start: 1, end: 2 });
  const view = mountWaveform(host(), { data: player.buffer! });
  own(() => view.dispose());
  const plugin = createSelectionPlugin({ model: player });
  const attachment = view.attach(plugin);
  expect(plugin.getSelection()).toEqual({ start: 1, end: 2 });
  view.setData(null);
  expect(player.getSelection()).toEqual({ start: 1, end: 2 });
  attachment.dispose();
  expect(player.getSelection()).toEqual({ start: 1, end: 2 });
  await player.audition();
  expect(player.isPlaying).toBe(true);
});
