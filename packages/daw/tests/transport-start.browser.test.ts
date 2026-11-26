import { afterEach, expect, test } from "vitest";
import type { ResetReason } from "@audiorective/clock";
import { AudioRecorder } from "@audiorective/recorder";
import { AudioMedia, Project, Workspace } from "../src";
import { fillSession } from "./session-slots";

const RATE = 48000;
const SCALE = 2 ** 20;
/** Sample i holds (i+1)/2^20, so an output sample decodes back to its source frame. */
const ramp = (frames: number) => Float32Array.from({ length: frames }, (_, i) => (i + 1) / SCALE);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.on=true;this.port.onmessage=()=>this.on=false}
process(i){const x=i[0];if(this.on&&x&&x.length){const l=x[0].slice(0);this.port.postMessage({f:currentFrame,l},[l.buffer])}else if(this.on){this.port.postMessage({f:currentFrame,l:null})}return this.on}}
registerProcessor("start-capture",C)`;
class Capture {
  chunks: { f: number; l: Float32Array | null }[] = [];
  node!: AudioWorkletNode;
  static async on(context: AudioContext, source: AudioNode) {
    const c = new Capture();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    c.node = new AudioWorkletNode(context, "start-capture", { numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
    c.node.port.onmessage = (e) => c.chunks.push(e.data);
    source.connect(c.node);
    return c;
  }
  stop() {
    this.node.port.postMessage(0);
    this.node.disconnect();
  }
  pcm() {
    const first = this.chunks[0].f;
    let next = first;
    const positions = this.chunks.map(({ f }) => {
      const frame = Math.max(f, next);
      next = frame + 128;
      return frame - first;
    });
    const l = new Float32Array(next - first);
    for (const [index, { l: chunk }] of this.chunks.entries()) if (chunk) l.set(chunk, positions[index]);
    return { first, l };
  }
}
/** Contiguous source-frame runs of a ramp capture, as capture indexes. */
function runs(l: Float32Array) {
  const out: { from: number; to: number; at: number }[] = [];
  let s = -1;
  let at = 0;
  let prev = -2;
  for (let i = 0; i < l.length; i++) {
    const v = l[i] ? Math.round(l[i] * SCALE - 1) : -1;
    if (v < 0) continue;
    if (v !== prev + 1) {
      if (s >= 0) out.push({ from: s, to: prev, at });
      s = v;
      at = i;
    }
    prev = v;
  }
  if (s >= 0) out.push({ from: s, to: prev, at });
  return out;
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function open(project: Project) {
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  const ws = await Workspace.create(context, project);
  await context.resume();
  const cap = await Capture.on(context, ws.output);
  cleanups.push(() => {
    cap.stop();
    ws.dispose();
    project.dispose();
    return context.close();
  });
  return { ws, cap, context };
}
/** Media whose reads can be slowed or failed on demand. */
class Controlled extends AudioMedia {
  delay = 0;
  fail: ((start: number) => boolean) | undefined;
  reads: number[] = [];
  override async readFrames(start: number, count: number) {
    this.reads.push(start);
    if (this.delay) await sleep(this.delay);
    if (this.fail?.(start)) throw new Error("disk read failed");
    return super.readFrames(start, count);
  }
}
function rampMedia(seconds = 8) {
  const n = RATE * seconds;
  const r = ramp(n);
  const inter = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) inter[2 * i] = inter[2 * i + 1] = r[i];
  return new Controlled(new Blob([inter.buffer]), RATE, 2, n);
}
const frames = (seconds: number) => Math.round(seconds * RATE);

// ---------------------------------------------------------------------------
// 1. Take placement after play()
// ---------------------------------------------------------------------------
function dcProject(seconds = 4) {
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  const dc = new Float32Array(RATE * seconds).fill(0.25);
  p.addAudioClip(a.id, { sampleRate: RATE, channels: [dc, dc] }, 0);
  return { p, a };
}
const trueProjectTime = (ws: Workspace, t: number) => (ws.transport.timeline.timeToBeat(t) * 60) / 120;
const frameError = (placed: number, truth: number) => Math.round((placed - truth) * RATE);

test("a default anchor taken right after play() places a later take with 0 frames of error", async () => {
  for (let run = 0; run < 3; run++) {
    const { p } = dcProject();
    const { ws, context } = await open(p);
    await ws.play();
    const anchor = ws.takeAnchor();
    const t = context.currentTime + 0.4;
    await sleep(500);
    expect(frameError(ws.takePosition(anchor, { startTime: t }), trueProjectTime(ws, t)), `run ${run}`).toBe(0);
    ws.stop();
  }
});

test("an anchor taken during the start lead, an explicit audioTime and one taken later all agree", async () => {
  const { p } = dcProject();
  const { ws, context } = await open(p);
  ws.seek(1);
  await ws.play();
  const when = ws.transport.timeline.beatToTime(2);
  const t = when + 0.5;
  await sleep(700);
  const truth = trueProjectTime(ws, t);
  expect(truth).toBeCloseTo(1.5, 6);
  const lead = ws.takeAnchor(when - 0.01);
  const explicit = ws.takeAnchor(when + 0.2);
  const later = ws.takeAnchor(context.currentTime);
  for (const anchor of [lead, explicit, later]) expect(frameError(ws.takePosition(anchor, { startTime: t }), truth)).toBe(0);
});

test("a take that starts before the transport's start maps linearly earlier; crossing project zero throws", async () => {
  const { p } = dcProject();
  const { ws } = await open(p);
  ws.seek(1);
  await ws.play();
  const when = ws.transport.timeline.beatToTime(2);
  const anchor = ws.takeAnchor(when - 0.01);
  expect(frameError(ws.takePosition(anchor, { startTime: when - 0.01 }), 0.99)).toBe(0);
  ws.stop();
  await ws.play();
  const from0 = ws.transport.timeline.beatToTime(0);
  const early = ws.takeAnchor(from0 - 0.01);
  expect(() => ws.takePosition(early, { startTime: from0 - 0.01 })).toThrow(/crosses project zero/);
  expect(frameError(ws.takePosition(early, { startTime: from0 }), 0)).toBe(0);
});

test("take placement after a seek restart and on a stopped transport", async () => {
  const media = rampMedia();
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  p.addAudioMediaClip(a.id, media, 0);
  const { ws, context } = await open(p);
  await ws.play();
  media.delay = 80;
  ws.seek(5);
  await sleep(500);
  const when = ws.transport.timeline.beatToTime(10);
  const t = when + 0.3;
  await sleep(400);
  const anchor = ws.takeAnchor(when - 0.01);
  expect(frameError(ws.takePosition(anchor, { startTime: t }), trueProjectTime(ws, t))).toBe(0);
  expect(trueProjectTime(ws, t)).toBeCloseTo(5.3, 6);
  ws.pause();
  ws.seek(3);
  const stopped = ws.takeAnchor();
  expect(stopped.advancing).toBe(false);
  expect(ws.takePosition(stopped, { startTime: context.currentTime + 5 })).toBe(3);
});

test("an anchor taken while a seek waits for media is rejected at placement", async () => {
  const media = rampMedia();
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  p.addAudioMediaClip(a.id, media, 0);
  const { ws, context } = await open(p);
  await ws.play();
  media.delay = 300;
  ws.seek(5);
  const anchor = ws.takeAnchor();
  await sleep(700);
  expect(() => ws.takePosition(anchor, { startTime: context.currentTime })).toThrow(/waited for media/);
});

// ---------------------------------------------------------------------------
// 2. Media failure recovery
// ---------------------------------------------------------------------------
function dcMedia(seconds = 6) {
  const n = RATE * seconds;
  const inter = new Float32Array(n * 2).fill(0.5);
  return new Controlled(new Blob([inter.buffer]), RATE, 2, n);
}
const level = (l: Float32Array, a: number, b: number) => {
  let m = 0;
  for (let i = Math.max(0, a); i < Math.min(l.length, b); i++) m = Math.max(m, Math.abs(l[i]));
  return m;
};

test("a transient media failure clears after pause, seek and play retry the read", async () => {
  const media = dcMedia();
  let once = true;
  media.fail = () => {
    if (!once) return false;
    once = false;
    return true;
  };
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  const clip = p.addAudioMediaClip(a.id, media, 0);
  const { ws, cap } = await open(p);
  await ws.play();
  await sleep(300);
  expect(ws.cells.error.value).toContain(`Audio clip ${clip.id} could not read its media`);
  expect(media.reads.length).toBe(1);
  await sleep(300);
  expect(media.reads.length).toBe(1);
  ws.pause();
  ws.seek(0);
  await ws.play();
  await sleep(400);
  const x = cap.pcm();
  expect(level(x.l, x.l.length - 9600, x.l.length)).toBeGreaterThan(0.3);
  expect(ws.cells.error.value).toBeNull();
  ws.stop();
});

test("seeking while playing retries a failed clip", async () => {
  const media = dcMedia();
  let failing = true;
  media.fail = () => failing;
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  p.addAudioMediaClip(a.id, media, 0);
  const { ws, cap } = await open(p);
  await ws.play();
  await sleep(200);
  expect(ws.cells.error.value).not.toBeNull();
  failing = false;
  ws.seek(1);
  await sleep(600);
  const x = cap.pcm();
  expect(level(x.l, x.l.length - 9600, x.l.length)).toBeGreaterThan(0.3);
  expect(ws.cells.error.value).toBeNull();
});

test("a clip that keeps failing is retried by the next play, not every tick", async () => {
  const media = dcMedia();
  media.fail = () => true;
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  p.addAudioMediaClip(a.id, media, 0);
  const { ws } = await open(p);
  await ws.play();
  await sleep(500);
  const first = media.reads.length;
  expect(first).toBeGreaterThan(0);
  await sleep(500);
  expect(media.reads.length).toBe(first);
  ws.pause();
  await ws.play();
  await sleep(300);
  expect(media.reads.length).toBe(first * 2);
  expect(ws.cells.error.value).not.toBeNull();
});

test("a removed or replaced clip does not inherit the failure, even with the same id", async () => {
  const bad = dcMedia();
  bad.fail = () => true;
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  const clip = p.addAudioMediaClip(a.id, bad, 0);
  const { ws, cap } = await open(p);
  await ws.play();
  await sleep(300);
  expect(ws.cells.error.value).not.toBeNull();
  p.removeClip(clip.id);
  await ws.flush();
  expect(ws.cells.error.value).toBeNull();
  p.addAudioMediaClip(a.id, bad, 0, { id: clip.id });
  await ws.flush();
  await sleep(300);
  expect(ws.cells.error.value).not.toBeNull();
  p.removeClip(clip.id);
  p.addAudioMediaClip(a.id, dcMedia(), 0, { id: clip.id });
  await ws.flush();
  await sleep(600);
  const x = cap.pcm();
  expect(level(x.l, x.l.length - 9600, x.l.length)).toBeGreaterThan(0.3);
  expect(ws.cells.error.value).toBeNull();
  ws.stop();
});

// ---------------------------------------------------------------------------
// 3. Seeking while playing keeps the transport playing
// ---------------------------------------------------------------------------
async function seekRig() {
  const media = rampMedia();
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  p.addAudioMediaClip(a.id, media, 0);
  const rig = await open(p);
  const states: string[] = [];
  const playing: boolean[] = [];
  const resets: ResetReason[] = [];
  const changes: string[] = [];
  const offs = [
    rig.ws.transport.state.subscribe((s) => states.push(s)),
    rig.ws.player.isPlaying.subscribe((v) => playing.push(v)),
    rig.ws.transport.attach({
      schedule: () => {},
      reset: (reason) => resets.push(reason),
      transport: (change) => changes.push(change.type),
    }),
  ];
  cleanups.push(() => offs.forEach((off) => off()));
  const clear = () => {
    states.length = playing.length = resets.length = changes.length = 0;
  };
  return { ...rig, media, states, playing, resets, changes, clear };
}

test("seek while playing into slow media keeps the transport playing and resumes at the exact frame", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.clear();
  r.media.delay = 250;
  const seekFrame = Math.round(r.context.currentTime * RATE);
  r.ws.seek(5.5);
  await sleep(100);
  expect(r.ws.transport.state.value).toBe("playing");
  expect(r.ws.player.isPlaying.value).toBe(true);
  expect(r.ws.position).toBeCloseTo(5.5, 3);
  await sleep(800);
  r.ws.stop();
  await sleep(40);
  expect(r.states).toEqual(["stopped"]);
  expect(r.playing).toEqual([false]);
  expect(r.resets).not.toContain("pause");
  expect(r.changes).not.toContain("pause");
  expect(r.changes).not.toContain("resume");
  const x = r.cap.pcm();
  const seek = seekFrame - x.first;
  const run = runs(x.l).find(({ from, to }) => from >= frames(5.5) && from <= frames(5.5) + frames(0.03) && to > from + frames(0.1)); // a seek while playing fades the new material in over 12 ms, so it is exact from just after that window
  expect(run, "audio resumed at source frame 5.5 s").toBeDefined();
  expect(run!.to).toBeGreaterThan(frames(6));
  expect(run!.at - seek).toBeGreaterThanOrEqual(frames(0.2));
  // The new material fades in over 12 ms, so the silence ends where that fade begins.
  expect(level(x.l, seek + frames(0.15), run!.at - frames(0.03))).toBe(0);
});

test("repeated seeks during the wait play only the last target", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.clear();
  r.media.delay = 250;
  r.ws.seek(4.5);
  await sleep(40);
  r.ws.seek(6.5);
  await sleep(40);
  r.ws.seek(5.5);
  await sleep(1000);
  expect(r.states).toEqual([]);
  expect(r.resets).not.toContain("pause");
  r.ws.pause();
  await sleep(40);
  const froms = runs(r.cap.pcm().l).map(({ from }) => from);
  expect(froms.some((from) => from >= frames(5.5) && from <= frames(5.5) + frames(0.03))).toBe(true); // exact once the 12 ms fade-in has passed
  expect(froms).not.toContain(frames(4.5));
  expect(froms).not.toContain(frames(6.5));
});

test("pause during the wait stays paused at the target and plays from it later", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.clear();
  r.media.delay = 250;
  r.ws.seek(5.5);
  await sleep(60);
  r.ws.pause();
  await sleep(600);
  expect(r.states).toEqual(["paused"]);
  expect(r.ws.position).toBeCloseTo(5.5, 3);
  expect(runs(r.cap.pcm().l).map(({ from }) => from)).not.toContain(frames(5.5));
  r.media.delay = 0;
  await r.ws.play();
  await sleep(300);
  r.ws.stop();
  await sleep(40);
  expect(
    runs(r.cap.pcm().l).find(({ from, to }) => from >= frames(5.5) && from <= frames(5.5) + frames(0.03) && to > from + frames(0.1))?.to,
  ).toBeGreaterThan(frames(5.7));
});

test("stop during the wait stops at zero and nothing sounds", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.clear();
  r.media.delay = 250;
  r.ws.seek(5.5);
  await sleep(60);
  r.ws.stop();
  await sleep(600);
  expect(r.states).toEqual(["stopped"]);
  expect(r.ws.position).toBe(0);
  expect(runs(r.cap.pcm().l).map(({ from }) => from)).not.toContain(frames(5.5));
});

test("play during the wait resolves once audio has resumed at the target", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.clear();
  r.media.delay = 250;
  r.ws.seek(5.5);
  await sleep(40);
  await r.ws.play();
  expect(r.states).toEqual([]);
  await sleep(300);
  r.ws.stop();
  await sleep(40);
  expect(
    runs(r.cap.pcm().l).find(({ from, to }) => from >= frames(5.5) && from <= frames(5.5) + frames(0.03) && to > from + frames(0.1))?.to,
  ).toBeGreaterThan(frames(5.7));
});

test("a failed read during the wait reports once, keeps the transport playing and never retries per tick", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.clear();
  r.media.delay = 100;
  r.media.fail = (start) => start >= frames(5);
  r.media.reads.length = 0;
  r.ws.seek(5.5);
  await sleep(800);
  expect(r.ws.cells.error.value).toContain("could not read its media");
  expect(r.ws.transport.state.value).toBe("playing");
  expect(r.states).toEqual([]);
  expect(r.resets).not.toContain("pause");
  expect(r.media.reads.length).toBeLessThanOrEqual(2);
});

test("dispose during the wait leaves no error and no transition", async () => {
  const r = await seekRig();
  await r.ws.play();
  await sleep(300);
  r.media.delay = 200;
  r.ws.seek(5.5);
  r.ws.dispose();
  await sleep(600);
  expect(r.ws.cells.error.value).toBeNull();
});

test("a seek that waits for media cancels an armed take like any seek", async () => {
  const r = await seekRig();
  const recorder = new AudioRecorder(r.context, { channels: 1 });
  cleanups.push(() => recorder.dispose());
  const detach = r.ws.transport.attach(recorder);
  cleanups.push(detach);
  await recorder.ready;
  await r.ws.play();
  await sleep(300);
  r.media.delay = 250;
  const take = recorder.record({ when: r.context.currentTime + 2 });
  const outcome = take.then(
    () => "resolved",
    (error: Error) => error.name,
  );
  r.ws.seek(5);
  expect(await Promise.race([outcome, sleep(150).then(() => "pending")])).toBe("AbortError");
  expect(r.ws.transport.state.value).toBe("playing");
});

test("a quantized take requested during the seek wait settles with AbortError instead of hanging", async () => {
  const r = await seekRig();
  const recorder = new AudioRecorder(r.context, { channels: 1 });
  cleanups.push(() => recorder.dispose());
  cleanups.push(r.ws.transport.attach(recorder));
  await recorder.ready;
  await r.ws.play();
  await sleep(300);
  r.media.delay = 250;
  r.ws.seek(5.5);
  r.clear();
  const take = recorder.record({ quantize: "1m", length: 0.05 });
  const outcome = take.then(
    () => "resolved",
    (error: Error) => error.name,
  );
  expect(await Promise.race([outcome, sleep(1200).then(() => "pending")])).toBe("AbortError");
  expect(recorder.cells.error.value).toBeNull();
  expect(r.states).toEqual([]);
  expect(r.resets).not.toContain("pause");
});

test("a launch queued during the seek wait is still audible", async () => {
  const media = new Controlled(new Blob([new Float32Array(RATE * 8 * 2).buffer]), RATE, 2, RATE * 8);
  const p = new Project({ bpm: 120 });
  const a = p.addTrack("a", "audio");
  p.addAudioMediaClip(a.id, media, 0);
  const b = p.addTrack("b", "audio");
  const dc = new Float32Array(RATE * 2).fill(0.25);
  fillSession(p, b.id, [{ sampleRate: RATE, channels: [dc, dc] }]);
  const { ws, cap } = await open(p);
  await ws.play();
  await sleep(300);
  media.delay = 250;
  ws.seek(5.5);
  ws.cells.session.value.tracks[b.id].clips[0]!.launch({ quantize: "4n" });
  await sleep(1500);
  const x = cap.pcm();
  expect(level(x.l, x.l.length - RATE / 2, x.l.length)).toBeGreaterThan(0.1);
  expect(ws.transport.state.value).toBe("playing");
});
