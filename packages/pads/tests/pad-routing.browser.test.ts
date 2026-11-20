import { expect, test } from "vitest";
import { PadBank } from "../src/PadBank";

const RATE = 48_000;

/** 3 channels: 0 and 1 are two destinations pads can be routed to, 2 is the bank output. */
function rig(seconds = 0.5) {
  const context = new OfflineAudioContext(3, RATE * seconds, RATE);
  const sample = (length: number, level: number) => {
    const value = context.createBuffer(1, Math.round(RATE * length), RATE);
    value.getChannelData(0).fill(level);
    return value;
  };
  const merger = new ChannelMergerNode(context, { numberOfInputs: 3 });
  merger.connect(context.destination);
  const left = new GainNode(context);
  const right = new GainNode(context);
  left.connect(merger, 0, 0);
  right.connect(merger, 0, 1);
  return { context, sample, merger, left, right };
}

/** Mean absolute value of `channel` between two times. */
const level = (buffer: AudioBuffer, channel: number, from: number, to: number) => {
  const data = buffer.getChannelData(channel).slice(Math.round(from * RATE), Math.round(to * RATE));
  return data.reduce((sum, value) => sum + Math.abs(value), 0) / data.length;
};

test("two pads in one choke group go to different destinations and the choke still cuts across them", async () => {
  const { context, sample, merger, left, right } = rig();
  const bank = new PadBank(context, [
    { id: "open", buffer: sample(1, 0.3), group: "hat" },
    { id: "closed", buffer: sample(0.1, 0.1), group: "hat" },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.routePad("open", left);
  bank.routePad("closed", right);
  bank.trigger("open", 1, 0);
  bank.trigger("closed", 1, 0.2);
  const out = await context.startRendering();
  expect(level(out, 0, 0.05, 0.19)).toBeCloseTo(0.3, 3); // open hat reaches its own destination
  expect(level(out, 1, 0.05, 0.19)).toBeLessThan(1e-4);
  expect(level(out, 0, 0.21, 0.45)).toBeLessThan(1e-4); // choked by the closed hat, though routed apart
  expect(level(out, 1, 0.21, 0.29)).toBeCloseTo(0.1, 3); // closed hat reaches the other destination
  expect(level(out, 2, 0, 0.5)).toBeLessThan(1e-4); // nothing falls through to the bank output
  bank.destroy();
});

test("routePad(id, null) restores the bank output", async () => {
  const { context, sample, merger, left } = rig();
  const bank = new PadBank(context, [{ id: "kick", buffer: sample(0.4, 0.3) }]);
  bank.output.connect(merger, 0, 2);
  bank.routePad("kick", left);
  bank.routePad("kick", null);
  bank.trigger("kick", 1, 0);
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.3)).toBeCloseTo(0.3, 3);
  expect(level(out, 0, 0, 0.5)).toBeLessThan(1e-4);
  bank.destroy();
});

test("a routed pad bypasses the bank volume; the other pads keep it", async () => {
  const { context, sample, merger, left } = rig();
  const bank = new PadBank(context, [
    { id: "a", buffer: sample(0.4, 0.4) },
    { id: "b", buffer: sample(0.4, 0.4) },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.routePad("a", left);
  bank.params.volume.value = 0.5;
  bank.trigger("a", 1, 0);
  bank.trigger("b", 1, 0);
  const out = await context.startRendering();
  expect(level(out, 0, 0.05, 0.3)).toBeCloseTo(0.4, 3); // routed away from the bank volume
  expect(level(out, 2, 0.05, 0.3)).toBeCloseTo(0.2, 3);
  bank.destroy();
});

test("destroy disconnects only bank-owned edges and leaves the destinations working", async () => {
  const { context, sample, merger, left } = rig();
  const bank = new PadBank(context, [{ id: "kick", buffer: sample(0.4, 0.3) }]);
  bank.routePad("kick", left);
  bank.trigger("kick", 1, 0);
  bank.destroy();
  // `left` is still wired into the caller's graph: a caller-owned source passes through it.
  const tone = new ConstantSourceNode(context, { offset: 0.5 });
  tone.connect(left);
  tone.start(0);
  const out = await context.startRendering();
  expect(level(out, 0, 0.05, 0.3)).toBeCloseTo(0.5, 3);
  expect(merger.numberOfInputs).toBe(3);
  expect(() => bank.routePad("kick", null)).toThrow("PadBank is destroyed.");
});

test("routePad rejects an unknown pad", () => {
  const { context, sample, left } = rig();
  const bank = new PadBank(context, [{ id: "kick", buffer: sample(0.1, 0.3) }]);
  expect(() => bank.routePad("snare", left)).toThrow("Unknown pad.");
  bank.destroy();
});

test("a one-shot (gate: false) open hat is choked by a later closed hat in its group", async () => {
  const { context, sample, merger } = rig();
  const bank = new PadBank(context, [
    { id: "open", buffer: sample(1, 0.3), group: "hat" }, // gate omitted: plays once
    { id: "closed", buffer: sample(0.1, 0.1), group: "hat" },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.trigger("open", 1, 0);
  bank.trigger("closed", 1, 0.2);
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.19)).toBeCloseTo(0.3, 3);
  expect(level(out, 2, 0.21, 0.29)).toBeCloseTo(0.1, 3); // only the closed hat; the open hat is gone
  expect(level(out, 2, 0.31, 0.5)).toBeLessThan(1e-4);
  bank.destroy();
});

test("gate: true loops past the buffer end; gate: false stops at it; duration closes the gate", async () => {
  const { context, sample, merger } = rig(1);
  const bank = new PadBank(context, [
    { id: "once", buffer: sample(0.1, 0.3) },
    { id: "loop", buffer: sample(0.1, 0.3), gate: true },
    { id: "timed", buffer: sample(0.1, 0.3), gate: true },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.trigger("once", 1, 0);
  const looping = bank.trigger("loop", 1, 0)!;
  bank.trigger("timed", 1, 0, { duration: 0.25 });
  const out = await context.startRendering();
  // once ends at 0.1; loop and timed (0.3 each) sound together until timed closes at 0.25; only loop remains after.
  expect(level(out, 2, 0.05, 0.09)).toBeCloseTo(0.9, 3);
  expect(level(out, 2, 0.15, 0.24)).toBeCloseTo(0.6, 3);
  expect(level(out, 2, 0.3, 0.9)).toBeCloseTo(0.3, 3);
  looping.cancel();
  bank.destroy();
});
