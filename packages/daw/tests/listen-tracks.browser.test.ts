/**
 * Listening to selected tracks: `renderMixRange({ trackIds })` is the audio of a live solo of the same tracks (within 1e-6), a track that is not selected adds nothing,
 * the send returns they feed are heard, and the MCP `listen` tool passes the selection through and returns sound only when the app allows it.
 */
import type { SoundFactory } from "@audiorective/core";
import { afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, renderMixRange, type WorkspaceOptions } from "../src";
import { mcpTools, type McpToolResult } from "../src/mcp";
import type { McpToolCategory } from "../src/mcp-policy";
import { LiveCapture, sleep } from "./helpers/live-capture";

const RATE = 48_000;
const TARGET = 1e-6;
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tone: SoundFactory = (context, hit) => {
  const osc = new OscillatorNode(context, { frequency: 220 * 2 ** ((hit.pitch - 57) / 12) });
  const env = new GainNode(context, { gain: 0 });
  env.gain.setValueAtTime(0, hit.when);
  env.gain.linearRampToValueAtTime(0.3 * hit.velocity, hit.when + 0.005);
  env.gain.exponentialRampToValueAtTime(0.001, hit.when + 0.4);
  osc.connect(env);
  return { output: env, sources: [osc], duration: 0.4 };
};

const noise = (seconds: number, seed: number) => {
  let state = seed;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32 - 0.5) * 0.5;
  });
};

/** Drums (a short noise burst, a filter insert, a send to the Echo bus), Keys (a MIDI track on a sampler) and the Echo effect bus (a delay). `solo` marks the tracks a live solo hears. */
function song(solo: readonly string[] = []) {
  const project = new Project({ bpm: 120 });
  const drums = project.addTrack("Drums", "audio", { volume: 0.7, pan: -0.3 });
  const keys = project.addTrack("Keys", "midi", { volume: 0.9, pan: 0.2 });
  const echo = project.addTrack("Echo", "bus", { busRole: "effect", volume: 0.9 });
  project.addAudioClip(drums.id, { sampleRate: RATE, channels: [noise(0.4, 3), noise(0.4, 4)] }, 0.1);
  project.addMidiClip(keys.id, { duration: 8, notes: [0, 2, 4].map((start, i) => ({ pitch: 57 + i * 3, velocity: 0.8, start, duration: 0.5 })) }, 0);
  project.setTrackEffects(drums.id, [{ id: "f", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 2000, q: 2 }]);
  project.setTrackEffects(echo.id, [{ id: "d", type: "delay", enabled: true, wet: 1, delayTime: 0.21, feedback: 0.45 }]);
  project.setTrackRouting(drums.id, { outputBusId: null, sends: [{ busId: echo.id, gain: 0.8 }] });
  for (const id of solo) project.setTrackSolo(id, true);
  cleanups.push(() => project.dispose());
  return { project, drums, keys, echo, options: { instruments: { [keys.id]: { sound: tone } } } satisfies WorkspaceOptions };
}

async function live(project: Project, options: WorkspaceOptions, seconds: number) {
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, ...options });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  expect(workspace.cells.warnings.value).toEqual([]);
  await context.resume();
  const capture = await LiveCapture.on(context, workspace.output);
  await workspace.play();
  const startTime = workspace.transport.timeline.beatToTime(0);
  await sleep((startTime - context.currentTime + seconds + 0.2) * 1000);
  workspace.stop();
  const { first, data } = await capture.stop();
  const offset = Math.round(startTime * RATE) - first;
  return data.map((x) => x.subarray(offset, offset + Math.round(seconds * RATE)));
}

async function offline(workspace: Workspace, seconds: number, trackIds?: readonly string[]) {
  const result = await renderMixRange(workspace, {
    expectedVersion: workspace.project.cells.version.value,
    range: { startSeconds: 0, endSeconds: seconds },
    prerollSeconds: 0,
    trackIds,
  });
  if (result.status !== "rendered") throw new Error(result.status);
  return result;
}

async function renderWorkspace(project: Project, options: WorkspaceOptions = {}) {
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, { workletUrl: worklet, ...options });
  cleanups.push(async () => {
    workspace.dispose();
    await context.close();
  });
  return workspace;
}

const maxDiff = (a: readonly ArrayLike<number>[], b: readonly ArrayLike<number>[]) => {
  let diff = 0;
  for (let c = 0; c < a.length; c++)
    for (let i = 0; i < Math.min(a[c]!.length, b[c]!.length); i++) diff = Math.max(diff, Math.abs(a[c]![i]! - b[c]![i]!));
  return diff;
};
const peakIn = (channels: readonly ArrayLike<number>[], from: number, to: number) => {
  let peak = 0;
  for (const channel of channels) for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) peak = Math.max(peak, Math.abs(channel[i]!));
  return peak;
};

describe("renderMixRange with trackIds", () => {
  const seconds = 2;
  test.each([
    ["Drums", "drums"],
    ["Keys", "keys"],
    ["Drums and Keys", "both"],
  ] as const)(
    "%s equals a live solo of the same tracks",
    async (_, which) => {
      const ids = (s: ReturnType<typeof song>) => (which === "drums" ? [s.drums.id] : which === "keys" ? [s.keys.id] : [s.drums.id, s.keys.id]);
      const soloed = song();
      const soloIds = ids(soloed);
      const control = song(soloIds);
      const captured = await live(control.project, control.options, seconds);
      const plain = song();
      const workspace = await renderWorkspace(plain.project, plain.options);
      const rendered = await offline(workspace, seconds, ids(plain));
      const diff = maxDiff(captured, rendered.audio.channels);
      console.info(
        `[listen-tracks ${which}] max |diff| vs live solo = ${diff.toExponential(3)}, peak ${peakIn(rendered.audio.channels, 0, seconds).toFixed(4)}`,
      );
      expect(peakIn(rendered.audio.channels, 0, seconds)).toBeGreaterThan(0.02);
      expect(diff).toBeLessThanOrEqual(TARGET);
    },
    60_000,
  );

  test("a track that is not selected adds nothing, and the parts sum to the whole mix", async () => {
    const { project, drums, keys, options } = song();
    const workspace = await renderWorkspace(project, options);
    const version = project.cells.version.value;
    const [onlyDrums, onlyKeys, all] = [
      await offline(workspace, seconds, [drums.id]),
      await offline(workspace, seconds, [keys.id]),
      await offline(workspace, seconds),
    ];
    // Keys' notes start at 1 s (beat 2) and 2 s; before that only the drums (0.1 to 0.5 s, then the echo) sound.
    expect(peakIn(onlyDrums.audio.channels, 0.05, 2)).toBeGreaterThan(0.02);
    expect(peakIn(onlyKeys.audio.channels, 0.05, 0.9)).toBeGreaterThan(0.01);
    const sum = onlyDrums.audio.channels.map((channel, c) => channel.map((x, i) => x + onlyKeys.audio.channels[c]![i]!));
    const diff = maxDiff(sum, all.audio.channels);
    console.info(`[listen-tracks sum] max |drums + keys - all| = ${diff.toExponential(3)}`);
    expect(diff).toBeLessThanOrEqual(TARGET);
    expect(onlyKeys.peakDbFS).toBeLessThan(all.peakDbFS! - 3);
    // The song, its version and playback are untouched, and the project's own solo flags did not leak into the next render.
    expect(project.cells.version.value).toBe(version);
    expect(project.tracks.some((track) => track.solo)).toBe(false);
    expect(workspace.player.isPlaying.value).toBe(false);
  }, 60_000);

  test("the send return a selected track feeds is heard, and one it does not feed is not", async () => {
    const { project, drums, keys, options } = song();
    const workspace = await renderWorkspace(project, options);
    // The drums stop at 0.5 s: from 0.6 s only the Echo bus is sounding the drums.
    const withEcho = await offline(workspace, seconds, [drums.id]);
    expect(peakIn(withEcho.audio.channels, 0.7, 0.95)).toBeGreaterThan(0.005);
    const keysOnly = await offline(workspace, seconds, [keys.id]);
    expect(peakIn(keysOnly.audio.channels, 0.7, 0.95)).toBeLessThan(1e-6);
    // Selecting the bus brings in what feeds it, as a solo of a bus does.
    const bus = await offline(workspace, seconds, [project.tracks[2]!.id]);
    expect(peakIn(bus.audio.channels, 0.7, 0.95)).toBeGreaterThan(0.005);
  }, 60_000);

  test("an unknown id or an empty list is a RangeError", async () => {
    const { project, drums } = song();
    const workspace = await renderWorkspace(project);
    await expect(offline(workspace, 1, ["nope"])).rejects.toThrow(/renderMixRange has no track with id "nope"/);
    await expect(offline(workspace, 1, [])).rejects.toThrow(RangeError);
    await expect(offline(workspace, 1, [drums.id, "nope"])).rejects.toThrow(RangeError);
  }, 60_000);
});

describe("MCP listen with trackIds", () => {
  const parse = (result: McpToolResult) => JSON.parse(result.content);
  async function tools(listenAudio?: { maxSeconds: number }, allow?: readonly McpToolCategory[]) {
    const s = song();
    const workspace = await renderWorkspace(s.project, s.options);
    const call = (name: string, args: unknown) =>
      mcpTools(workspace, { listenAudio, allow })
        .find((tool) => tool.name === name)!
        .call(args);
    return { ...s, workspace, call };
  }
  const range = { startSeconds: 0, endSeconds: 2 };

  test("returns the evidence of the subset, and the whole mix without it", async () => {
    const { project, drums, keys, workspace, call } = await tools();
    const direct = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range, trackIds: [drums.id] });
    const whole = await renderMixRange(workspace, { expectedVersion: project.cells.version.value, range });
    if (direct.status !== "rendered" || whole.status !== "rendered") throw new Error("expected a render");
    const subset = parse(await call("listen", { range, trackIds: [drums.id] }));
    expect(subset.status).toBe("rendered");
    expect(subset.trackIds).toEqual([drums.id]);
    expect(subset.peakDbFS).toBeCloseTo(direct.peakDbFS!, 1);
    expect(subset.loudnessLUFS).toBeCloseTo(direct.loudnessLUFS!, 1);
    const all = parse(await call("listen", { range }));
    expect(all.trackIds).toBeUndefined();
    expect(all.loudnessLUFS).toBeCloseTo(whole.loudnessLUFS!, 1);
    expect(all.peakDbFS).toBeCloseTo(subset.peakDbFS, 1);
    expect(parse(await call("listen", { range, trackIds: [keys.id] })).peakDbFS).toBeLessThan(subset.peakDbFS - 3);
    for (const bad of [[], "x", [1], ["nope"]]) {
      const result = await call("listen", { range, trackIds: bad });
      expect(result.isError).toBe(true);
    }
    expect((await call("listen", { range, audio: "yes" })).isError).toBe(true);
  }, 60_000);

  test("listenAudio.maxSeconds must be finite and above 0", async () => {
    const { workspace } = await tools();
    for (const maxSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2" as never, undefined as never])
      expect(() => mcpTools(workspace, { listenAudio: { maxSeconds } })).toThrow(
        "mcpTools: listenAudio.maxSeconds must be a finite number greater than 0.",
      );
    expect(() => mcpTools(workspace, { listenAudio: { maxSeconds: 0.5 } })).not.toThrow();
  }, 60_000);

  test("sound needs the export permission as well: a read-only app gets the numbers and a sentence", async () => {
    const readOnly = await tools({ maxSeconds: 1 }, ["read"]);
    const asked = await readOnly.call("listen", { range, trackIds: [readOnly.drums.id], audio: true });
    expect(asked.isError).toBeUndefined();
    expect(asked.audio).toBeUndefined();
    expect(parse(asked).audioNote).toMatch(/needs the export permission/);
    expect(parse(asked).peakDbFS).toBeLessThan(0);
    const withExport = await tools({ maxSeconds: 1 }, ["read", "export"]);
    expect((await withExport.call("listen", { range, trackIds: [withExport.drums.id], audio: true })).audio?.mimeType).toBe("audio/wav");
  }, 60_000);

  test("sound travels only when the app allows it, and within maxSeconds", async () => {
    const off = await tools();
    const plain = await off.call("listen", { range, trackIds: [off.drums.id] });
    expect(plain.audio).toBeUndefined();
    const asked = await off.call("listen", { range, trackIds: [off.drums.id], audio: true });
    expect(asked.isError).toBeUndefined();
    expect(asked.audio).toBeUndefined();
    expect(parse(asked).audioNote).toMatch(/not enabled/);
    expect(parse(asked).peakDbFS).toBeLessThan(0);

    const on = await tools({ maxSeconds: 1 });
    expect((await on.call("listen", { range, trackIds: [on.drums.id] })).audio).toBeUndefined();
    const short = await on.call("listen", { range: { startSeconds: 0, endSeconds: 0.75 }, trackIds: [on.drums.id], audio: true });
    const full = await on.call("listen", { range, trackIds: [on.drums.id], audio: true });
    const wav = (result: McpToolResult) => {
      expect(result.audio?.mimeType).toBe("audio/wav");
      const bytes = Uint8Array.from(atob(result.audio!.base64), (c) => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
      expect(view.getUint16(22, true)).toBe(2);
      return view.getUint32(40, true) / 4;
    };
    expect(wav(short)).toBe(Math.round(0.75 * RATE));
    expect(parse(short).audioNote).toBeUndefined();
    expect(wav(full)).toBe(RATE);
    expect(parse(full).audioNote).toMatch(/first 1 s/);
    expect(JSON.stringify(parse(full))).not.toContain(full.audio!.base64.slice(0, 40));
  }, 60_000);
});
