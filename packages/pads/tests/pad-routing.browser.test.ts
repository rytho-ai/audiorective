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
    { id: "open", sound: sample(1, 0.3), group: "hat" },
    { id: "closed", sound: sample(0.1, 0.1), group: "hat" },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.routePad("open", left);
  bank.routePad("closed", right);
  bank.trigger("open", { when: 0 });
  bank.trigger("closed", { when: 0.2 });
  const out = await context.startRendering();
  expect(level(out, 0, 0.05, 0.19)).toBeCloseTo(0.3, 3); // open hat reaches its own destination
  expect(level(out, 1, 0.05, 0.19)).toBeLessThan(1e-4);
  expect(level(out, 0, 0.21, 0.45)).toBeLessThan(1e-4); // choked by the closed hat, though routed apart
  expect(level(out, 1, 0.21, 0.29)).toBeCloseTo(0.1, 3); // closed hat reaches the other destination
  expect(level(out, 2, 0, 0.5)).toBeLessThan(1e-4); // nothing falls through to the bank output
  bank.dispose();
});

test("routePad(id, null) restores the bank output", async () => {
  const { context, sample, merger, left } = rig();
  const bank = new PadBank(context, [{ id: "kick", sound: sample(0.4, 0.3) }]);
  bank.output.connect(merger, 0, 2);
  bank.routePad("kick", left);
  bank.routePad("kick", null);
  bank.trigger("kick", { when: 0 });
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.3)).toBeCloseTo(0.3, 3);
  expect(level(out, 0, 0, 0.5)).toBeLessThan(1e-4);
  bank.dispose();
});

test("a routed pad bypasses the bank volume; the other pads keep it", async () => {
  const { context, sample, merger, left } = rig();
  const bank = new PadBank(context, [
    { id: "a", sound: sample(0.4, 0.4) },
    { id: "b", sound: sample(0.4, 0.4) },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.routePad("a", left);
  bank.params.volume.value = 0.5;
  bank.trigger("a", { when: 0 });
  bank.trigger("b", { when: 0 });
  const out = await context.startRendering();
  expect(level(out, 0, 0.05, 0.3)).toBeCloseTo(0.4, 3); // routed away from the bank volume
  expect(level(out, 2, 0.05, 0.3)).toBeCloseTo(0.2, 3);
  bank.dispose();
});

test("dispose disconnects only bank-owned edges and leaves the destinations working", async () => {
  const { context, sample, merger, left } = rig();
  const bank = new PadBank(context, [{ id: "kick", sound: sample(0.4, 0.3) }]);
  bank.routePad("kick", left);
  bank.trigger("kick", { when: 0 });
  bank.dispose();
  // `left` is still wired into the caller's graph: a caller-owned source passes through it.
  const tone = new ConstantSourceNode(context, { offset: 0.5 });
  tone.connect(left);
  tone.start(0);
  const out = await context.startRendering();
  expect(level(out, 0, 0.05, 0.3)).toBeCloseTo(0.5, 3);
  expect(merger.numberOfInputs).toBe(3);
  expect(() => bank.routePad("kick", null)).toThrow("PadBank is disposed.");
});

test("routePad rejects an unknown pad", () => {
  const { context, sample, left } = rig();
  const bank = new PadBank(context, [{ id: "kick", sound: sample(0.1, 0.3) }]);
  expect(() => bank.routePad("snare", left)).toThrow("Unknown pad.");
  bank.dispose();
});

test("an open hat is choked by a later closed hat in its group", async () => {
  const { context, sample, merger } = rig();
  const bank = new PadBank(context, [
    { id: "open", sound: sample(1, 0.3), group: "hat" },
    { id: "closed", sound: sample(0.1, 0.1), group: "hat" },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.trigger("open", { when: 0 });
  bank.trigger("closed", { when: 0.2 });
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.19)).toBeCloseTo(0.3, 3);
  expect(level(out, 2, 0.21, 0.29)).toBeCloseTo(0.1, 3); // only the closed hat; the open hat is gone
  expect(level(out, 2, 0.31, 0.5)).toBeLessThan(1e-4);
  bank.dispose();
});

test("a pad's own repeated hit chokes its earlier voice, and pads without a group layer", async () => {
  const { context, sample, merger } = rig();
  const bank = new PadBank(context, [
    { id: "hat", sound: sample(1, 0.3), group: "hat" },
    { id: "kick", sound: sample(1, 0.2) },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.trigger("hat", { when: 0 });
  bank.trigger("hat", { when: 0.2 });
  bank.trigger("kick", { when: 0 });
  bank.trigger("kick", { when: 0.2 });
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.19)).toBeCloseTo(0.5, 3); // hat + kick
  expect(level(out, 2, 0.25, 0.45)).toBeCloseTo(0.7, 3); // second hat (0.3) over two layered kicks (0.2 + 0.2)
  bank.dispose();
});

test("a factory pad is choked like a sample pad, with the bank's release fade", async () => {
  const { context, sample, merger } = rig();
  const bank = new PadBank(
    context,
    [
      { id: "open", sound: (ctx) => new ConstantSourceNode(ctx, { offset: 0.3 }), group: "hat" },
      { id: "closed", sound: sample(0.1, 0.1), group: "hat" },
    ],
    { release: 0.05 },
  );
  bank.output.connect(merger, 0, 2);
  bank.trigger("open", { when: 0 });
  bank.trigger("closed", { when: 0.2 });
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.19)).toBeCloseTo(0.3, 3);
  expect(level(out, 2, 0.3, 0.5)).toBeLessThan(1e-4);
  expect(out.getChannelData(2)[Math.round(0.225 * RATE)]).toBeGreaterThan(0.1);
  bank.dispose();
});

test("a pad factory sees the hit's velocity and pitch, and velocity scales the voice once", async () => {
  const { context, merger } = rig();
  const seen: Array<{ velocity: number; pitch: number; duration: number }> = [];
  const bank = new PadBank(context, [
    {
      id: "zap",
      sound: (ctx, hit) => {
        seen.push({ velocity: hit.velocity, pitch: hit.pitch, duration: hit.duration });
        const source = new ConstantSourceNode(ctx, { offset: 1 });
        return { output: source, sources: [source], duration: 0.2 };
      },
    },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.trigger("zap", { when: 0, velocity: 0.5, pitch: 7 });
  const out = await context.startRendering();
  expect(seen).toEqual([{ velocity: 0.5, pitch: 7, duration: Infinity }]);
  expect(level(out, 2, 0.05, 0.15)).toBeCloseTo(0.5, 3);
  bank.dispose();
});

test("a note-name pad plays the tone and is choked like any pad; offset and duration reach a buffer pad", async () => {
  const { context, sample, merger } = rig();
  const bank = new PadBank(context, [
    { id: "tone", sound: "A4", group: "g" },
    { id: "short", sound: sample(1, 0.4), group: "g" },
  ]);
  bank.output.connect(merger, 0, 2);
  bank.trigger("tone", { when: 0 });
  bank.trigger("short", { when: 0.2, duration: 0.1, offset: 0.5 });
  const out = await context.startRendering();
  expect(level(out, 2, 0.05, 0.19)).toBeGreaterThan(0.05);
  expect(level(out, 2, 0.21, 0.29)).toBeCloseTo(0.4, 3);
  expect(level(out, 2, 0.32, 0.5)).toBeLessThan(1e-4);
  bank.dispose();
});
