import { Effect, type EffectOptions } from "@audiorective/effects";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
import {
  Project,
  Workspace,
  defineRackEffect,
  exportAudioFallbackTo,
  rackDeviceId,
  renderMixRange,
  renderStems,
  type WorkspaceOptions,
} from "../src";

const RATE = 48_000;
const LATE = 256;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A plain-node wet arm that delays by 256 frames and declares it. */
class Late extends Effect {
  constructor(ctx: BaseAudioContext, opts: EffectOptions = {}) {
    const delay = new DelayNode(ctx, { delayTime: LATE / ctx.sampleRate, maxDelayTime: 1 });
    super(ctx, { input: delay, output: delay }, () => ({ params: {}, cells: {}, latency: LATE }), opts);
  }
}
const late = defineRackEffect({ id: "test.late", name: "Late", parameters: [], create: (context) => new Late(context) });
/** Declares more latency than one second of compensation can hold. */
class Huge extends Effect {
  constructor(ctx: BaseAudioContext, opts: EffectOptions = {}) {
    const gain = new GainNode(ctx);
    super(ctx, { input: gain, output: gain }, () => ({ params: {}, cells: {}, latency: 60_000 }), opts);
  }
}
const huge = defineRackEffect({ id: "test.huge", name: "Huge", parameters: [], create: (context) => new Huge(context) });

const AT = 0.5;
const FROM = 0.1;
/** Frame of the impulse in a render that starts at FROM. */
const EXPECTED = Math.round((AT - FROM) * RATE);

function impulse() {
  const data = new Float32Array(RATE);
  data[Math.round(AT * RATE)] = 0.5;
  return { sampleRate: RATE, channels: [data, data] };
}

async function start(setup: (project: Project) => void, options: WorkspaceOptions = {}) {
  const project = new Project({ bpm: 120 });
  setup(project);
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const workspace = await Workspace.create(context, project, { effects: [late, huge], ...options });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  return { project, workspace, context };
}

async function render(workspace: Workspace, endSeconds = 1.2) {
  const result = await renderMixRange(workspace, {
    expectedVersion: workspace.project.cells.version.value,
    range: { startSeconds: FROM, endSeconds },
    prerollSeconds: 0,
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return result.audio.channels;
}
const onsets = (channel: ArrayLike<number>) =>
  Array.from(channel, (value, index) => (Math.abs(value) > 0.01 ? index : -1)).filter((index) => index >= 0);

/** Two audio tracks with one impulse at the same position. */
function twoTracks(project: Project) {
  const a = project.addTrack("Latent", "audio");
  const b = project.addTrack("Direct", "audio");
  project.addAudioClip(a.id, impulse(), 0);
  project.addAudioClip(b.id, impulse(), 0);
  return { a, b };
}

describe("latency compensation in a Workspace", () => {
  test("aligns a latent track with a direct one, enabled and bypassed", async () => {
    let a!: { id: string };
    const { workspace, project } = await start((p) => {
      ({ a } = twoTracks(p));
      p.setTrackEffects(a.id, [late.slot({ id: "l" })]);
    });
    expect(workspace.cells.latency.value).toBe(LATE);
    expect(onsets((await render(workspace))[0])).toEqual([EXPECTED]);
    project.setDeviceParameter(rackDeviceId(a.id, "l"), "enabled", 0);
    await workspace.flush();
    expect(workspace.cells.latency.value).toBe(LATE);
    expect(onsets((await render(workspace))[0])).toEqual([EXPECTED]);
  });

  test("a latent effect on a bus aligns the track routed through it with a direct one", async () => {
    const { workspace } = await start((p) => {
      const { a } = twoTracks(p);
      const bus = p.addTrack("Bus", "bus");
      p.setTrackEffects(bus.id, [late.slot({ id: "l" })]);
      p.setTrackRouting(a.id, { outputBusId: bus.id, sends: [] });
    });
    expect(workspace.cells.latency.value).toBe(LATE);
    expect(onsets((await render(workspace))[0])).toEqual([EXPECTED]);
  });

  test("a send into a latent bus lines up with the dry output", async () => {
    const { workspace } = await start((p) => {
      const a = p.addTrack("Dry", "audio");
      p.addAudioClip(a.id, impulse(), 0);
      const bus = p.addTrack("Bus", "bus");
      p.setTrackEffects(bus.id, [late.slot({ id: "l" })]);
      p.setTrackRouting(a.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 1 }] });
    });
    expect(workspace.cells.latency.value).toBe(LATE);
    const [left] = await render(workspace);
    expect(onsets(left)).toEqual([EXPECTED]);
    // Dry and send add up on one frame.
    expect(Math.abs(left[EXPECTED])).toBeGreaterThan(0.6);
  });

  test("cells.latency follows the effect and returns to 0 when it is removed", async () => {
    let a!: { id: string };
    const { workspace, project } = await start((p) => {
      ({ a } = twoTracks(p));
    });
    expect(workspace.cells.latency.value).toBe(0);
    project.setTrackEffects(a.id, [late.slot({ id: "l" })]);
    await workspace.flush();
    expect(workspace.cells.latency.value).toBe(LATE);
    project.setTrackEffects(a.id, []);
    await workspace.flush();
    expect(workspace.cells.latency.value).toBe(0);
    expect(onsets((await render(workspace))[0])).toEqual([EXPECTED]);
  });

  test("renderMixRange starts on the requested frame and has the requested length", async () => {
    const { workspace } = await start((p) => {
      const a = p.addTrack("Only", "audio");
      p.addAudioClip(a.id, impulse(), 0);
      p.setTrackEffects(a.id, [late.slot({ id: "l" })]);
    });
    const channels = await render(workspace, 1);
    expect(channels[0].length).toBe(Math.round((1 - FROM) * RATE));
    expect(onsets(channels[0])).toEqual([EXPECTED]);
  });

  test("renderStems keeps the mix on the timeline", async () => {
    const { workspace, project } = await start((p) => {
      const { a } = twoTracks(p);
      p.setTrackEffects(a.id, [late.slot({ id: "l" })]);
    });
    const result = await renderStems(workspace, {
      expectedVersion: project.cells.version.value,
      range: { startSeconds: FROM, endSeconds: 1.2 },
      tailSeconds: 0,
    });
    if (result.status !== "rendered" || !result.mix) throw new Error(result.status);
    expect(result.mix.channels[0].length).toBe(Math.round((1.2 - FROM) * RATE));
    expect(onsets(result.mix.channels[0])).toEqual([EXPECTED]);
  });

  test("the audio fallback mix starts on the timeline", async () => {
    const { workspace } = await start((p) => {
      const { a } = twoTracks(p);
      p.setTrackEffects(a.id, [late.slot({ id: "l" })]);
    });
    const parts: Uint8Array[] = [];
    await exportAudioFallbackTo(workspace, new WritableStream({ write: (chunk) => void parts.push(chunk) }), { tailSeconds: 0.5 });
    const files = unzipSync(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()));
    const bytes = files["mix.wav"];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames = (bytes.length - 44) / 8;
    const left = Float32Array.from({ length: frames }, (_, i) => view.getFloat32(44 + i * 8, true));
    expect(onsets(left)).toEqual([Math.round(AT * RATE)]);
    expect(frames).toBe(Math.ceil((Math.max(workspace.duration, 0.1) + 0.5) * RATE));
  });

  test("a project with no latency builds no compensation delays", async () => {
    const created: number[] = [];
    const Original = globalThis.DelayNode;
    globalThis.DelayNode = class extends Original {
      constructor(context: BaseAudioContext, options?: DelayOptions) {
        super(context, options);
        created.push(options?.maxDelayTime ?? 1);
      }
    };
    try {
      const { workspace } = await start((p) => {
        const { a } = twoTracks(p);
        const bus = p.addTrack("Bus", "bus");
        p.setTrackRouting(a.id, { outputBusId: null, sends: [{ busId: bus.id, gain: 0.5 }] });
      });
      expect(workspace.cells.latency.value).toBe(0);
      const channels = await render(workspace);
      expect(created).toEqual([]);
      expect(onsets(channels[0])).toEqual([EXPECTED]);
    } finally {
      globalThis.DelayNode = Original;
    }
  });

  test("compensation above one second is clamped with one warning that names the track", async () => {
    const { workspace } = await start((p) => {
      const { a } = twoTracks(p);
      p.setTrackEffects(a.id, [huge.slot({ id: "h" })]);
    });
    expect(workspace.cells.latency.value).toBe(60_000);
    expect(workspace.cells.warnings.value).toEqual([
      'Track "Direct" needs 60000 samples of latency compensation, more than the 1 second limit: its compensation is clamped to 1 second.',
    ]);
  });
});
