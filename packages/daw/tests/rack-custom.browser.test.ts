import { Effect, type EffectOptions } from "@audiorective/effects";
import type { SchedulableParam } from "@audiorective/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Project,
  Workspace,
  defineRackEffect,
  openWorkspace,
  rackDeviceId,
  renderMixRange,
  renderStems,
  saveWorkspace,
  type RackCustom,
  type RackEffect,
  type WorkspaceOptions,
} from "../src";
import { TrackRack, type RackCustomHost } from "../src/track-rack";
import { LiveCapture, sleep } from "./helpers/live-capture";

const RATE = 48_000;
const TARGET = 1e-6;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A gain stage: `amount` multiplies the signal. */
class Scaler extends Effect<{ amount: SchedulableParam }> {
  constructor(ctx: BaseAudioContext, opts: EffectOptions = {}) {
    const gain = new GainNode(ctx);
    super(
      ctx,
      { input: gain, output: gain },
      ({ param }) => ({ params: { amount: param({ default: 0.5, bind: gain.gain, min: 0, max: 4 }) }, cells: {} }),
      opts,
    );
  }
}
/** A plain-node wet arm that delays by 256 frames and declares it. */
class Late extends Effect {
  constructor(ctx: BaseAudioContext, opts: EffectOptions = {}) {
    const delay = new DelayNode(ctx, { delayTime: 256 / ctx.sampleRate, maxDelayTime: 1 });
    super(ctx, { input: delay, output: delay }, () => ({ params: {}, cells: {}, latency: 256 }), opts);
  }
}

const made: Scaler[] = [];
const liveCreates: Scaler[] = [];
/** `create` calls on the page's live context are counted apart from the offline renders', which build their own copy. */
const scaler = (id = "test.scaler", lateBy = 0) =>
  defineRackEffect({
    id,
    name: "Scaler",
    parameters: [{ id: "amount", name: "Amount", min: 0, max: 4, default: 0.5 }],
    create: async (context) => {
      if (lateBy) await sleep(lateBy);
      const effect = new Scaler(context);
      made.push(effect);
      if (!(context instanceof OfflineAudioContext)) liveCreates.push(effect);
      return effect;
    },
  });
const late = defineRackEffect({ id: "test.late", name: "Late", parameters: [], create: (context) => new Late(context) });

const noise = (seconds: number, seed = 7) => {
  let state = seed;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32 - 0.5) * 0.5;
  });
};
const rms = (samples: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
};

async function start(
  setup: (project: Project, track: { id: string }) => void,
  { clip = true, ...options }: WorkspaceOptions & { clip?: boolean } = {},
) {
  made.length = 0;
  liveCreates.length = 0;
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("A", "audio", { volume: 0.8 });
  if (clip) project.addAudioClip(track.id, { sampleRate: RATE, channels: [noise(1.5, 1), noise(1.5, 2)] }, 0);
  setup(project, track);
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const workspace = await Workspace.create(context, project, options);
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return { project, track, context, workspace };
}

async function render(workspace: Workspace, seconds = 1) {
  const result = await renderMixRange(workspace, {
    expectedVersion: workspace.project.cells.version.value,
    range: { startSeconds: 0.1, endSeconds: seconds },
    prerollSeconds: 0,
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return result.audio.channels;
}
const level = async (workspace: Workspace) => rms((await render(workspace))[0]);
const scaled = (id: string, values: Record<string, number> = {}, over: Partial<RackCustom> = {}): RackCustom => ({
  ...scaler().slot({ id, values }),
  effect: "test.scaler",
  ...over,
});

describe("custom rack effect in a Workspace", () => {
  test("changes the render, follows setDeviceParameter without rebuilding, and offline equals live", async () => {
    const effect = scaler();
    const { project, track, workspace, context } = await start(() => undefined, { effects: [effect] });
    const dry = await level(workspace);
    project.setTrackEffects(track.id, [effect.slot({ id: "c" })]);
    await workspace.flush();
    expect(workspace.cells.warnings.value).toEqual([]);
    const half = await level(workspace);
    expect(half / dry).toBeCloseTo(0.5, 3);
    expect(liveCreates).toHaveLength(1);

    const id = rackDeviceId(track.id, "c");
    project.setDeviceParameter(id, "amount", 0.25);
    await workspace.flush();
    expect(liveCreates).toHaveLength(1);
    expect(liveCreates[0].params.amount.value).toBe(0.25);
    expect((await level(workspace)) / dry).toBeCloseTo(0.25, 3);
    expect(workspace.deviceParameters(id).find((row) => row.id === "amount")).toMatchObject({ kind: "rack", value: 0.25, min: 0, max: 4 });

    // The same range live: capture the master from the frame of beat 0 and compare with the offline render.
    await context.resume();
    const capture = await LiveCapture.on(context, workspace.output);
    await workspace.play();
    const startTime = workspace.transport.timeline.beatToTime(0);
    await sleep((startTime - context.currentTime + 1.2) * 1000);
    workspace.stop();
    const { first, data } = await capture.stop();
    const offset = Math.round(startTime * RATE) - first;
    const offline = await render(workspace, 1);
    const from = Math.round(0.1 * RATE);
    let diff = 0;
    for (let i = 0; i < offline[0].length; i++) diff = Math.max(diff, Math.abs(data[0][offset + from + i] - offline[0][i]));
    expect(diff).toBeLessThanOrEqual(TARGET);
    expect(liveCreates).toHaveLength(1);
  });

  test("enabled false and wet 0 pass dry audio", async () => {
    const effect = scaler();
    const { project, track, workspace } = await start((p, t) => p.setTrackEffects(t.id, [scaler().slot({ id: "c" })]), { effects: [effect] });
    const full = await level(workspace);
    const id = rackDeviceId(track.id, "c");
    project.setDeviceParameter(id, "wet", 0);
    await workspace.flush();
    const dry = await level(workspace);
    expect(full / dry).toBeCloseTo(0.5, 3);
    project.setDeviceParameter(id, "wet", 1);
    project.setDeviceParameter(id, "enabled", 0);
    await workspace.flush();
    expect(await level(workspace)).toBeCloseTo(dry, 6);
    project.setDeviceParameter(id, "enabled", 1);
    await workspace.flush();
    expect((await level(workspace)) / dry).toBeCloseTo(0.5, 3);
    expect(liveCreates).toHaveLength(1);
  });

  test("reorders with a built-in filter, keeps both, and removing the slot disposes the effect", async () => {
    const filter: RackEffect = { id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 300, q: 1 };
    const effect = scaler();
    const slot = effect.slot({ id: "c" });
    const { project, track, workspace } = await start((p, t) => p.setTrackEffects(t.id, [filter, slot]), { effects: [effect] });
    const both = await level(workspace);
    project.setTrackEffects(track.id, [slot, filter]);
    await workspace.flush();
    expect(project.tracks[0].effects.map((item) => item.id)).toEqual(["c", "lp"]);
    // Gain and low-pass commute, so the order must not change the level; the effect was neither rebuilt nor lost.
    expect((await level(workspace)) / both).toBeCloseTo(1, 3);
    expect(liveCreates).toHaveLength(1);
    const dispose = vi.spyOn(liveCreates[0], "dispose");
    project.setTrackEffects(track.id, [filter]);
    await workspace.flush();
    expect(both / (await level(workspace))).toBeCloseTo(0.5, 2);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled(), { timeout: 3000 });
  });

  test("a custom slot added while the Workspace runs, built asynchronously, is heard once ready", async () => {
    const effect = scaler("test.scaler", 80);
    const { project, track, workspace } = await start(() => undefined, { effects: [effect] });
    const dry = await level(workspace);
    project.setTrackEffects(track.id, [effect.slot({ id: "slow", values: { amount: 2 } })]);
    await workspace.flush();
    expect(liveCreates).toHaveLength(1);
    expect((await level(workspace)) / dry).toBeCloseTo(2, 3);
  });

  test("a bus track processes the bus", async () => {
    const effect = scaler();
    const { project, track, workspace } = await start(
      (p, t) => {
        const bus = p.addTrack("Bus", "bus");
        p.setTrackRouting(t.id, { outputBusId: bus.id, sends: [] });
        p.setTrackEffects(bus.id, [scaler().slot({ id: "c" })]);
      },
      { effects: [effect] },
    );
    const withBus = await level(workspace);
    const bus = project.tracks.find((item) => item.kind === "bus")!;
    project.setTrackEffects(bus.id, []);
    await workspace.flush();
    expect(withBus / (await level(workspace))).toBeCloseTo(0.5, 3);
    expect(track.id).not.toBe(bus.id);
  });

  test("a missing definition passes dry with one warning that names the track, slot and effect", async () => {
    const { workspace, project, track } = await start((p, t) => p.setTrackEffects(t.id, [scaler().slot({ id: "c" })]));
    expect(workspace.cells.warnings.value).toEqual(['Track "A" insert "c": effect "test.scaler" has no definition in this Workspace.']);
    project.setDeviceParameter(rackDeviceId(track.id, "c"), "amount", 2);
    await workspace.flush();
    expect(workspace.cells.warnings.value).toHaveLength(1);
  });

  test("a create that rejects, throws or returns a non-effect passes dry and warns", async () => {
    const rejecting = defineRackEffect({ id: "bad.reject", name: "R", parameters: [], create: () => Promise.reject(new Error("no wasm")) });
    const throwing = defineRackEffect({
      id: "bad.throw",
      name: "T",
      parameters: [],
      create: () => {
        throw new Error("boom");
      },
    });
    const wrong = defineRackEffect({ id: "bad.type", name: "W", parameters: [], create: () => ({}) as never });
    const { workspace } = await start(
      (p, t) => p.setTrackEffects(t.id, [rejecting.slot({ id: "a" }), throwing.slot({ id: "b" }), wrong.slot({ id: "c" })]),
      { effects: [rejecting, throwing, wrong] },
    );
    expect(workspace.cells.warnings.value).toEqual([
      'Track "A" insert "a": effect "bad.reject" could not be created: no wasm.',
      'Track "A" insert "b": effect "bad.throw" could not be created: boom.',
      'Track "A" insert "c": effect "bad.type" did not create an Effect from @audiorective/effects.',
    ]);
  });

  test("a table parameter the effect does not expose warns once and is ignored", async () => {
    const odd = defineRackEffect({
      id: "odd",
      name: "Odd",
      parameters: [
        { id: "amount", name: "Amount", min: 0, max: 4, default: 0.5 },
        { id: "ghost", name: "Ghost", min: 0, max: 1, default: 0 },
      ],
      create: (context) => new Scaler(context),
    });
    const { workspace, project, track } = await start((p, t) => p.setTrackEffects(t.id, [odd.slot({ id: "c" })]), { effects: [odd] });
    expect(workspace.cells.warnings.value).toEqual([
      'Track "A" insert "c": effect "odd" has no numeric parameter "ghost"; the song\'s value is ignored.',
    ]);
    project.setDeviceParameter(rackDeviceId(track.id, "c"), "ghost", 0.5);
    await workspace.flush();
    expect(workspace.cells.warnings.value).toHaveLength(1);
  });

  test("a declared latency on a plain-node arm delays the dry path too, so bypass and a partial wet keep one impulse in one place", async () => {
    const { workspace, project, track } = await start(
      (p, t) => {
        const impulse = new Float32Array(RATE);
        impulse[Math.round(0.5 * RATE)] = 0.5;
        p.addAudioClip(t.id, { sampleRate: RATE, channels: [impulse, impulse] }, 0);
        p.setTrackEffects(t.id, [late.slot({ id: "l" })]);
      },
      { effects: [late], clip: false },
    );
    const peaks = async () => {
      const out = (await render(workspace, 1.2))[0];
      return [...out].flatMap((value, index) => (Math.abs(value) > 0.01 ? [index] : []));
    };
    const id = rackDeviceId(track.id, "l");
    const wet = await peaks();
    project.setDeviceParameter(id, "enabled", 0);
    await workspace.flush();
    const bypassed = await peaks();
    project.setDeviceParameter(id, "enabled", 1);
    project.setDeviceParameter(id, "wet", 0.5);
    await workspace.flush();
    const half = await peaks();
    expect(wet).toHaveLength(1);
    expect(bypassed).toEqual(wet);
    expect(half).toEqual(wet);
  });
});

describe("custom rack effect and the file", () => {
  test("save and open keep the slot and table, and the reopened song renders the same", async () => {
    const effect = scaler();
    const { project, track, workspace, context } = await start(
      (p, t) => p.setTrackEffects(t.id, [effect.slot({ id: "c", values: { amount: 1.5 } })]),
      {
        effects: [effect],
      },
    );
    const original = await render(workspace);
    const bytes = await saveWorkspace(workspace);
    const reopened = await openWorkspace(context, bytes, { effects: [effect] });
    cleanups.push(() => reopened.dispose());
    expect(reopened.project.tracks[0].effects).toEqual(project.tracks[0].effects);
    expect(reopened.cells.warnings.value).toEqual([]);
    const again = await render(reopened);
    let diff = 0;
    for (let i = 0; i < original[0].length; i++) diff = Math.max(diff, Math.abs(original[0][i] - again[0][i]));
    expect(diff).toBeLessThanOrEqual(TARGET);
    expect(track.id).toBeTruthy();
  });

  test("renderStems runs the same effects", async () => {
    const effect = scaler();
    const { workspace, project } = await start((p, t) => p.setTrackEffects(t.id, [effect.slot({ id: "c" })]), { effects: [effect] });
    const result = await renderStems(workspace, {
      expectedVersion: project.cells.version.value,
      range: { startSeconds: 0.1, endSeconds: 1 },
      tailSeconds: 0,
    });
    if (result.status !== "rendered") throw new Error(result.status);
    const mix = await level(workspace);
    expect(rms(result.stems[0].audio.channels[0]) / mix).toBeCloseTo(1, 3);
  });
});

describe("TrackRack with custom slots", () => {
  const offlineRack = async (slots: readonly RackEffect[], host: RackCustomHost, prepare = true) => {
    const context = new OfflineAudioContext(1, RATE / 2, RATE);
    const rack = new TrackRack(context, [], [], host);
    if (prepare) await rack.prepare(slots);
    rack.setEffects(slots);
    const source = new AudioBufferSourceNode(context, { buffer: Object.assign(context.createBuffer(1, RATE / 2, RATE), {}) });
    source.buffer!.copyToChannel(noise(0.5), 0);
    source.connect(rack.input);
    rack.output.connect(context.destination);
    source.start();
    const out = (await context.startRendering()).getChannelData(0);
    return { out, rack, input: noise(0.5) };
  };
  const hostOf = (definitions: ReturnType<typeof scaler>[], warnings: string[]): RackCustomHost => ({
    definition: (id) => definitions.find((definition) => definition.id === id),
    warn: (slot, effect, problem) => warnings.push(`${slot}|${effect}|${problem}`),
  });

  test("a missing definition leaves the audio untouched", async () => {
    const warnings: string[] = [];
    const { out, input, rack } = await offlineRack([scaled("c")], hostOf([], warnings));
    expect(warnings).toEqual(["c|test.scaler|has no definition in this Workspace"]);
    for (let i = 0; i < input.length; i += 997) expect(out[i]).toBeCloseTo(input[i], 6);
    rack.dispose();
  });

  test("a failing create leaves the audio untouched, and a create that answers at once needs no prepare", async () => {
    const warnings: string[] = [];
    const failing = defineRackEffect({ id: "test.scaler", name: "F", parameters: [], create: () => Promise.reject(new Error("x")) });
    const a = await offlineRack([scaled("c")], hostOf([failing as never], warnings));
    expect(warnings).toEqual(["c|test.scaler|could not be created: x"]);
    for (let i = 0; i < a.input.length; i += 997) expect(a.out[i]).toBeCloseTo(a.input[i], 6);
    const sync = defineRackEffect({
      id: "test.scaler",
      name: "S",
      parameters: [{ id: "amount", name: "A", min: 0, max: 4, default: 0.5 }],
      create: (c) => new Scaler(c),
    });
    const b = await offlineRack([scaled("c", { amount: 0.5 })], hostOf([sync as never], []), false);
    for (let i = 5000; i < b.input.length; i += 997) expect(b.out[i]).toBeCloseTo(b.input[i] * 0.5, 5);
    a.rack.dispose();
    b.rack.dispose();
  });
});
