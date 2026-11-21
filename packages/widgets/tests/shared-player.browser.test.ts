import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { WavePlayer } from "@audiorective/player";
import { mountWaveformSelector } from "../src";
import { mountWaveform, createSelectionPlugin } from "../src/waveform";
import { bandsFile, cleanup, host, own, element, drag, delay, pointer } from "./helpers";
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
  await expect.poll(() => player.cells.isPlaying.value).toBe(true);
  expect(two.getState().selection).toEqual(player.cells.selection.value);
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
  expect(player.cells.isPlaying.value).toBe(true);
  expect(player.cells.selection.value).toEqual({ start: 3.4, end: 3.7 });
  expect(two.getState().selection).toEqual(player.cells.selection.value);
  expect(element(root, "selection").hidden).toBe(false);
  two.dispose();
  expect(player.cells.isPlaying.value).toBe(true);
  expect(context.state).not.toBe("closed");
  player.pause();
  expect(player.cells.isPlaying.value).toBe(false);
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
  expect(player.cells.selection.value).toEqual({ start: 1, end: 2 });
  attachment.dispose();
  expect(player.cells.selection.value).toEqual({ start: 1, end: 2 });
  await player.audition();
  expect(player.cells.isPlaying.value).toBe(true);
});

test("a neutral selector borrows selection and seeks without auditioning while its controls are hidden", async () => {
  const { player } = await fixture();
  const root = host();
  const play = vi.spyOn(player, "play");
  const audition = vi.spyOn(player, "audition");
  const view = mountWaveformSelector(root, { player, controls: false, audition: false });
  own(() => view.dispose());
  expect(root.querySelector<HTMLElement>(".ar-source")!.hidden).toBe(true);
  expect(root.querySelector<HTMLElement>(".ar-selector > .ar-toolbar")!.hidden).toBe(true);
  expect(root.querySelector<HTMLElement>(".ar-status")!.hidden).toBe(false);
  expect(element(root, "zoom-in").getBoundingClientRect().width).toBeGreaterThan(0);

  await drag(element(root, "waveform"), 6, 1, 2);
  expect(player.cells.selection.value!.start).toBeCloseTo(1, 1);
  expect(player.cells.selection.value!.end).toBeCloseTo(2, 1);
  await drag(element(root, "waveform"), 6, 4, 4);
  expect(player.position).toBeCloseTo(4, 1);
  expect(player.cells.isPlaying.value).toBe(false);
  expect(player.cells.isLooping.value).toBe(false);
  expect(play).not.toHaveBeenCalled();
  expect(audition).not.toHaveBeenCalled();
});

test("selector viewport operations affect only that view and detachment preserves running playback", async () => {
  const { context, player } = await fixture();
  const buffer = player.buffer;
  const first = mountWaveformSelector(host(), { player, controls: false, audition: false });
  const peer = mountWaveformSelector(host(), { player, audition: false });
  own(() => first.dispose());
  own(() => peer.dispose());
  await expect.poll(() => first.getViewport().width).toBeGreaterThan(0);
  const before = first.getViewport();
  const peerBefore = peer.getViewport();
  first.setZoom(4);
  first.setAmplitudeZoom(2);
  first.scrollTo(3);
  expect(first.getViewport().pixelsPerSecond).toBeCloseTo(before.pixelsPerSecond * 4, 2);
  expect(first.getViewport().scrollLeft / first.getViewport().pixelsPerSecond).toBeCloseTo(3, 1);
  expect(first.getAmplitudeZoom()).toBe(2);
  expect(peer.getAmplitudeZoom()).toBe(1);
  expect(peer.getViewport().pixelsPerSecond).toBeCloseTo(peerBefore.pixelsPerSecond, 2);
  expect(player.buffer).toBe(buffer);

  player.setSelection({ start: 1, end: 2 });
  await player.play();
  first.dispose();
  const position = player.position;
  await expect.poll(() => player.position).toBeGreaterThan(position + 0.02);
  expect(player.cells.isPlaying.value).toBe(true);
  expect(peer.getState().selection).toEqual({ start: 1, end: 2 });
  expect(context.state).not.toBe("closed");
});

test("a selection drag previews locally and writes the borrowed player once on release", async () => {
  const { player } = await fixture();
  const root = host();
  const view = mountWaveform(root, { data: player.buffer! });
  own(() => view.dispose());
  const onCommit = vi.fn();
  const onChange = vi.fn();
  view.attach(createSelectionPlugin({ model: player, onCommit, onChange }));
  const write = vi.spyOn(player, "setSelection");
  const surface = element(root, "waveform");
  const rect = surface.getBoundingClientRect();
  const y = rect.y + rect.height * 0.6;
  await pointer({ action: "down", x: rect.x + rect.width / 6, y });
  await pointer({ action: "move", x: rect.x + rect.width / 2, y });
  expect(element(root, "selection").hidden).toBe(false);
  expect(player.cells.selection.value).toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalled();
  await pointer({ action: "up" });
  expect(player.cells.selection.value!.start).toBeCloseTo(1, 1);
  expect(player.cells.selection.value!.end).toBeCloseTo(3, 1);
  expect(write).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledOnce();
});

test("Escape discards a borrowed selection preview before a late release", async () => {
  const { player } = await fixture();
  player.setSelection({ start: 4, end: 5 });
  const root = host();
  const view = mountWaveform(root, { data: player.buffer! });
  own(() => view.dispose());
  const onCommit = vi.fn();
  const plugin = createSelectionPlugin({ model: player, onCommit });
  view.attach(plugin);
  const write = vi.spyOn(player, "setSelection");
  const surface = element(root, "waveform");
  const rect = surface.getBoundingClientRect();
  const y = rect.y + rect.height * 0.6;
  await pointer({ action: "down", x: rect.x + rect.width / 6, y });
  await pointer({ action: "move", x: rect.x + rect.width / 2, y });
  expect(plugin.getSelection()!.start).toBeCloseTo(1, 1);
  await userEvent.keyboard("{Escape}");
  expect(plugin.getSelection()).toEqual({ start: 4, end: 5 });
  await pointer({ action: "move", x: rect.x + rect.width * 0.6, y });
  await pointer({ action: "up" });
  expect(player.cells.selection.value).toEqual({ start: 4, end: 5 });
  expect(write).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});

test("an external borrowed selection replacement cancels an active preview", async () => {
  const { player } = await fixture();
  const root = host();
  const view = mountWaveform(root, { data: player.buffer! });
  own(() => view.dispose());
  const onCommit = vi.fn();
  const plugin = createSelectionPlugin({ model: player, onCommit });
  view.attach(plugin);
  const surface = element(root, "waveform");
  const rect = surface.getBoundingClientRect();
  const y = rect.y + rect.height * 0.6;
  await pointer({ action: "down", x: rect.x + rect.width / 6, y });
  await pointer({ action: "move", x: rect.x + rect.width / 2, y });
  player.setSelection({ start: 4, end: 5 });
  expect(plugin.getSelection()).toEqual({ start: 4, end: 5 });
  await pointer({ action: "move", x: rect.x + rect.width * 0.6, y });
  await pointer({ action: "up" });
  expect(player.cells.selection.value).toEqual({ start: 4, end: 5 });
  expect(onCommit).not.toHaveBeenCalled();
});

test.each(["pointercancel", "capture loss", "detach"] as const)("%s discards a preview without writing the borrowed player", async (reason) => {
  const { player } = await fixture();
  const root = host();
  const view = mountWaveform(root, { data: player.buffer! });
  own(() => view.dispose());
  const onCommit = vi.fn();
  const attachment = view.attach(createSelectionPlugin({ model: player, onCommit }));
  const write = vi.spyOn(player, "setSelection");
  const surface = element(root, "waveform");
  let pointerId = 0;
  surface.addEventListener("pointerdown", (event) => (pointerId = event.pointerId), { once: true });
  const rect = surface.getBoundingClientRect();
  const y = rect.y + rect.height * 0.6;
  await pointer({ action: "down", x: rect.x + rect.width / 6, y });
  await pointer({ action: "move", x: rect.x + rect.width / 2, y });
  if (reason === "pointercancel") surface.dispatchEvent(new PointerEvent("pointercancel", { pointerId, bubbles: true }));
  else if (reason === "capture loss") surface.releasePointerCapture(pointerId);
  else attachment.dispose();
  await pointer({ action: "move", x: rect.x + rect.width * 0.6, y });
  await pointer({ action: "up" });
  expect(player.cells.selection.value).toBeNull();
  expect(write).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
});
