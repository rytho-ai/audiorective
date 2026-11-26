import { afterEach, expect, test } from "vitest";
import { AudioMedia, Project, Workspace, exportAudioFallbackTo, openWorkspace, saveDawProject } from "../src";

const RATE = 48000;
const SCALE = 2 ** 20;
/** Sample i holds (i+1)/2^20, so an output sample decodes back to its source frame. */
const ramp = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (i + 1) / SCALE);
const zeros = (frames: number) => new Float32Array(frames);
const WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.on=true;this.port.onmessage=()=>this.on=false}
process(i){const x=i[0];if(this.on&&x&&x.length){const l=x[0].slice(0),r=(x[1]||x[0]).slice(0);this.port.postMessage({f:currentFrame,l,r},[l.buffer,r.buffer])}else if(this.on){this.port.postMessage({f:currentFrame,l:null,r:null})}return this.on}}
registerProcessor("audit-capture",C)`;
class Capture {
  chunks: { f: number; l: Float32Array | null; r: Float32Array | null }[] = [];
  node!: AudioWorkletNode;
  static async on(context: AudioContext, source: AudioNode) {
    const c = new Capture();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    c.node = new AudioWorkletNode(context, "audit-capture", {
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    c.node.port.onmessage = (e) => c.chunks.push(e.data);
    source.connect(c.node);
    return c;
  }
  stop() {
    this.node.port.postMessage(0);
    this.node.disconnect();
  }
  /** Contiguous from first to last rendered frame; reports capture gaps. */
  pcm() {
    const first = this.chunks[0].f;
    let next = first;
    const positions = this.chunks.map(({ f }) => {
      // Chromium can repeat currentFrame for one quantum. Keep those samples
      // in arrival order while retaining actual forward gaps.
      const frame = Math.max(f, next);
      next = frame + 128;
      return frame - first;
    });
    const l = new Float32Array(next - first);
    for (const [index, { l: chunk }] of this.chunks.entries()) {
      if (chunk) l.set(chunk, positions[index]);
    }
    return { first, l };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function open(p: Project, opts = {}) {
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const ws = await Workspace.create(context, p, opts);
  await context.resume();
  const cap = await Capture.on(context, ws.output);
  cleanups.push(() => {
    cap.stop();
    ws.dispose();
    p.dispose();
    return context.close();
  });
  return { ws, cap, context };
}
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const bundle = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");
const pluginId = "com.oxo.music.oxosynth2";
const rms = (x: Float32Array, a: number, b: number) => {
  let e = 0;
  for (let i = a; i < b; i++) e += x[i] * x[i];
  return Math.sqrt(e / Math.max(1, b - a));
};
test("N3 real synth note across an unrelated edit, control without edit", async () => {
  const out: Record<string, number[]> = { edit: [], control: [], removeMidi: [] };
  for (const mode of ["control", "edit", "control", "edit", "removeMidi"] as const) {
    const p = new Project({ bpm: 120 });
    const m = p.addTrack("m", "midi"),
      o = p.addTrack("o", "audio");
    p.addWebClapDevice(m.id, { pluginId, name: "s", vendor: "v", version: "1", bundleUrl: bundle });
    p.addMidiClip(m.id, { notes: [{ pitch: 60, start: 0, duration: 6, velocity: 0.9 }], duration: 8 }, 0);
    const oc = p.addAudioClip(o.id, { sampleRate: RATE, channels: [zeros(480), zeros(480)] }, 30);
    const future = p.addMidiClip(m.id, { notes: [{ pitch: 67, start: 0, duration: 1, velocity: 0.9 }], duration: 2 }, 60);
    const { ws, cap } = await open(p, { workletUrl: worklet });
    await ws.play();
    const T = Math.round(ws.timeline.beatToTime(0) * RATE);
    await sleep(900);
    if (mode === "edit") p.moveClip(oc.id, o.id, 31);
    if (mode === "removeMidi") p.removeClip(future.id);
    await sleep(1100);
    ws.stop();
    await sleep(30);
    const x = cap.pcm();
    const b = T - x.first;
    out[mode].push(+(20 * Math.log10(rms(x.l, b + 72000, b + 86400) / rms(x.l, b + 28800, b + 40800))).toFixed(1));
  }
  out.edit.forEach((level, i) => expect(Math.abs(level - out.control[i])).toBeLessThanOrEqual(1));
  expect(Math.abs(out.removeMidi[0] - out.control[0])).toBeLessThanOrEqual(1);
});
test("K1 largest sample step caused by each action on a 0.5 DC clip", async () => {
  type E = (ws: Workspace, p: Project, a: string, bus: string, clip: string) => void;
  const edits: Record<string, E> = {
    control_none: () => {},
    mute: (ws, _p, a) => ws.setTrackMuted(a, true),
    solo_other: (ws, _p, _a, b) => ws.setTrackSolo(b, true),
    route_to_bus: (ws, _p, a, b) => ws.setTrackRouting(a, { outputBusId: b, sends: [] }),
    master: (ws) => ws.setMasterVolume(0.5),
    pause: (ws) => ws.pause(),
    stop: (ws) => ws.stop(),
    seek_to_silence: (ws) => ws.seek(5),
    remove_playing_clip: (_ws, p, _a, _b, c) => p.removeClip(c),
    move_playing_clip_away: (_ws, p, a, _b, c) => p.moveClip(c, a, 10),
    insert_delay: (ws, _p, a) => ws.setTrackEffects(a, [{ id: "d", type: "delay", enabled: true, wet: 0.5, delayTime: 0.1, feedback: 0 }]),
  };

  for (const [name, edit] of Object.entries(edits)) {
    const p = new Project({ bpm: 120 });
    const a = p.addTrack("a", "audio"),
      bus = p.addTrack("bus", "bus");
    const dc = new Float32Array(RATE * 3).fill(0.5);
    const clip = p.addAudioClip(a.id, { sampleRate: RATE, channels: [dc, dc] }, 0);
    const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    const ws = await Workspace.create(context, p);
    await context.resume();
    const cap = await Capture.on(context, ws.output);
    cleanups.push(() => {
      cap.stop();
      ws.dispose();
      p.dispose();
      return context.close();
    });
    await ws.play();
    await sleep(600);
    edit(ws, p, a.id, bus.id, clip.id);
    await sleep(300);
    const x = cap.pcm();
    let first = 0;
    while (first < x.l.length && x.l[first] === 0) first++;
    let step = 0;
    for (let i = first + 4800; i < x.l.length; i++) step = Math.max(step, Math.abs(x.l[i] - x.l[i - 1]));
    expect(step, name).toBeLessThan(0.005);
    ws.stop();
  }
});
test("E1 clip on the play position: start offset with and without an envelope stage", async () => {
  const out: Record<string, number[]> = { none: [], gainEnvelope: [] };
  for (let n = 0; n < 44; n++) {
    const kind = n % 2 ? "gainEnvelope" : "none";
    const scale = kind === "none" ? 1 : 0.5;
    const p = new Project({ bpm: 120 });
    const a = p.addTrack("a", "audio");
    const r = ramp(RATE);
    p.addAudioClip(a.id, { sampleRate: RATE, channels: [r, r] }, 0, kind === "none" ? {} : { envelope: { gain: 0.5, fadeIn: 0, fadeOut: 0 } });
    const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    const ws = await Workspace.create(context, p);
    await context.resume();
    const cap = await Capture.on(context, ws.output);
    await sleep(70);
    await ws.play();
    const T = Math.round(ws.timeline.beatToTime(0) * RATE);
    await sleep(500);
    ws.stop();
    await sleep(20);
    cap.stop();
    const x = cap.pcm();
    let i = 0;
    while (i < x.l.length && !x.l[i]) i++;
    const v0 = Math.round((x.l[i] / scale) * SCALE - 1);
    out[kind].push(x.first + i - v0 - T);
    ws.dispose();
    p.dispose();
    await context.close();
  }
  expect([...out.none, ...out.gainEnvelope]).toEqual(Array(44).fill(0));
}, 120000);
test("M2 slow media read: seam and seek dropouts", async () => {
  for (const delay of [0, 60, 250]) {
    class Slow extends AudioMedia {
      override async readFrames(s: number, c: number) {
        await sleep(delay);
        return super.readFrames(s, c);
      }
    }
    const n = RATE * 8;
    const r = ramp(n);
    const inter = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) inter[2 * i] = inter[2 * i + 1] = r[i];
    const p = new Project({ bpm: 120 });
    const a = p.addTrack("a", "audio");
    p.addAudioMediaClip(a.id, new Slow(new Blob([inter.buffer]), RATE, 2, n), 0);
    const { ws, cap } = await open(p);
    ws.seek(1.5);
    await ws.play();
    await sleep(1000);
    ws.seek(5.5);
    await sleep(1000);
    ws.stop();
    await sleep(40);
    const x = cap.pcm();
    const seq: { from: number; to: number }[] = [];
    let s = -1,
      prev = -2;
    for (let i = 0; i < x.l.length; i++) {
      const v = x.l[i] ? Math.round(x.l[i] * SCALE - 1) : -1;
      if (v < 0) continue;
      if (v !== prev + 1) {
        if (s >= 0) seq.push({ from: s, to: prev });
        s = v;
      }
      prev = v;
    }
    seq.push({ from: s, to: prev });
    // A seek while playing crossfades: the old position fades out and the new one fades in over 12 ms, so the first frames at the target are scaled.
    // The new material must be sample-accurate from the target position once that fade-in window has passed (a play from stopped has no fade and is exact from frame 0).
    const fadeFrames = Math.round(0.03 * RATE);
    for (const start of [1.5, 5.5]) {
      const first = start * RATE;
      const run = seq.find(({ from, to }) =>
        start === 1.5 ? from === first : from >= first && from <= first + fadeFrames && to > first + fadeFrames,
      );
      expect(run?.to, `${delay}ms read at ${start}s`).toBeGreaterThan((start + 0.6) * RATE);
    }
  }
}, 30000);
test("opening a file requires an app resolver to fetch its bundle", async () => {
  const context = new AudioContext();
  const p = new Project();
  const t = p.addTrack("Inst", "midi");
  p.addWebClapDevice(t.id, {
    pluginId: "x.y",
    name: "Evil",
    vendor: "",
    version: "",
    bundleUrl: "https://attacker.invalid/evil.wclap",
    state: new Uint8Array([1]),
  });
  const bytes = saveDawProject(p);
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("attacker.invalid")) {
      seen.push(url);
      return new Response("", { status: 404 });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const w = await openWorkspace(context, bytes);
    expect(seen).toEqual([]);
    w.dispose();
    const approved = await openWorkspace(context, bytes, { resolveBundle: (device) => device.bundleUrl });
    expect(seen).toHaveLength(1);
    approved.dispose();
  } finally {
    globalThis.fetch = real;
    await context.close();
  }
}, 30000);

test("a live media failure reports once and the export aborts before writing a ZIP", async () => {
  const frames = 6 * RATE;
  const interleaved = new Float32Array(frames * 2).fill(0.25);
  class FailingMedia extends AudioMedia {
    failures = 0;

    override async readFrames(start: number, count: number) {
      if (start >= 2 * RATE && start < 4 * RATE) {
        this.failures++;
        throw new Error("disk read failed");
      }
      return super.readFrames(start, count);
    }
  }
  const media = new FailingMedia(new Blob([interleaved.buffer]), RATE, 2, frames);
  const project = new Project();
  const track = project.addTrack("Audio", "audio");
  const clip = project.addAudioMediaClip(track.id, media, 0);
  const { ws } = await open(project);
  const errors: (string | null)[] = [];
  const off = ws.cells.error.subscribe((error) => errors.push(error));
  cleanups.push(off);
  await ws.play();
  await sleep(2200);
  expect(ws.cells.error.value).toContain(`Audio clip ${clip.id} could not read its media`);
  expect(errors.filter(Boolean)).toHaveLength(1);
  expect(media.failures).toBe(1);
  expect(ws.warnings).toEqual([]);
  ws.stop();
  let bytes = 0;
  let aborted = false;
  await expect(
    exportAudioFallbackTo(
      ws,
      new WritableStream({
        write(chunk) {
          bytes += chunk.byteLength;
        },
        abort() {
          aborted = true;
        },
      }),
    ),
  ).rejects.toThrow(/disk read failed/);
  expect(bytes).toBe(0);
  expect(aborted).toBe(true);
}, 10000);
