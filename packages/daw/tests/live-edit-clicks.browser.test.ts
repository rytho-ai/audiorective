/**
 * Live-edit stability: plays a song on a real 48 kHz AudioContext, records the master (and a track tap) with an AudioWorklet over the live graph,
 * makes an edit while it plays, and looks for clicks (sample-to-sample jumps above what the steady signal itself produces) and dropouts.
 *
 * A jump is measured against the signal's own steady behaviour: the largest first and second difference in quiet reference windows before and
 * after the edit, scaled by level. A pure tone has a known maximum slope, so a ratio near 1 is "as smooth as the tone"; a click shows as a large ratio.
 * Scenarios marked "clean" must stay under the thresholds; "report" scenarios (a hard content cut, the documented device re-wiring glitch) are only measured.
 * The numbers print as a table at the end of the run.
 */
import type { SoundFactory } from "@audiorective/core";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { Project, Workspace, sessionFor, type AudioClip, type MidiClip, type WorkspaceOptions } from "../src";

const RATE = 48_000;
const FREQ = 250; // 192 samples per period: a whole number of periods in any multiple of 4 ms, so a shifted copy stays in phase
const worklet = "/@fs" + new URL("../../host/dist/webclap-worklet.js", import.meta.url).pathname.replace(/^\/@fs/, "");
const oxo = "/@fs" + new URL("../../../apps/daw-demo/public/plugin/oxo-synth2.wclap", import.meta.url).pathname.replace(/^\/@fs/, "");

/** First difference may be this many times the steady signal's own largest slope; second difference likewise. */
const JUMP1_LIMIT = 3;
const JUMP2_LIMIT = 6;
/** A span this long (ms) below 2% of the steady level, where sound should continue, is a dropout. */
const DROPOUT_MS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sine = (seconds: number, amplitude = 0.3, frequency = FREQ) => ({
  sampleRate: RATE,
  channels: [Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE))],
});

/** A held sine with a 4 ms attack; the player releases it over 5 ms. Pitch 60 plays FREQ. */
const held: SoundFactory = (context, hit) => {
  const osc = new OscillatorNode(context, { frequency: FREQ * 2 ** (hit.pitch / 12) });
  const env = new GainNode(context);
  env.gain.setValueAtTime(0, hit.when);
  env.gain.linearRampToValueAtTime(0.3, hit.when + 0.004);
  osc.connect(env);
  return { output: env, sources: [osc] };
};

const recorderSource = `
class TapRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frames = options.processorOptions.frames;
    this.l = new Float32Array(frames);
    this.r = new Float32Array(frames);
    this.i = 0;
    this.first = -1;
    this.port.onmessage = () => this.port.postMessage({ first: this.first, l: this.l.slice(0, this.i), r: this.r.slice(0, this.i) });
  }
  process(inputs) {
    if (this.i + 128 <= this.l.length) {
      if (this.first < 0) this.first = currentFrame;
      const a = inputs[0][0];
      const b = inputs[0][1] || a;
      if (a) { this.l.set(a, this.i); this.r.set(b, this.i); }
      this.i += 128;
    }
    return true;
  }
}
registerProcessor("tap-recorder", TapRecorder);`;

type Recording = { first: number; l: Float32Array; r: Float32Array };
class Tap {
  private readonly node: AudioWorkletNode;
  private readonly sink: GainNode;
  constructor(
    context: AudioContext,
    source: AudioNode,
    readonly label: string,
    frames: number,
  ) {
    this.node = new AudioWorkletNode(context, "tap-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: "explicit",
      processorOptions: { frames },
    });
    this.sink = new GainNode(context, { gain: 0 });
    source.connect(this.node);
    this.node.connect(this.sink).connect(context.destination);
  }
  dump(): Promise<Recording> {
    return new Promise((resolve) => {
      this.node.port.onmessage = (event) => resolve(event.data as Recording);
      this.node.port.postMessage("dump");
    });
  }
  dispose() {
    this.node.disconnect();
    this.sink.disconnect();
  }
}
let moduleUrl: string | undefined;
const loadRecorder = (context: AudioContext) =>
  context.audioWorklet.addModule((moduleUrl ??= URL.createObjectURL(new Blob([recorderSource], { type: "text/javascript" }))));

type Window = { from: number; to: number };
type Stat = { peak: number; d1: number; d2: number };
function stat(x: Float32Array, window: Window, first: number): Stat {
  const a = Math.max(2, Math.round(window.from * RATE) - first);
  const b = Math.min(x.length - 1, Math.round(window.to * RATE) - first);
  let peak = 0;
  let d1 = 0;
  let d2 = 0;
  for (let i = a; i < b; i++) {
    peak = Math.max(peak, Math.abs(x[i]));
    d1 = Math.max(d1, Math.abs(x[i] - x[i - 1]));
    d2 = Math.max(d2, Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]));
  }
  return { peak, d1, d2 };
}
/** Longest run, in milliseconds, where both channels stay under `level`. */
function longestQuiet(rec: Recording, window: Window, level: number): number {
  const a = Math.max(0, Math.round(window.from * RATE) - rec.first);
  const b = Math.min(rec.l.length, Math.round(window.to * RATE) - rec.first);
  let run = 0;
  let worst = 0;
  for (let i = a; i < b; i++) {
    if (Math.abs(rec.l[i]) < level && Math.abs(rec.r[i]) < level) worst = Math.max(worst, ++run);
    else run = 0;
  }
  return (worst / RATE) * 1000;
}

export type Measure = { jump1: number; jump2: number; dropMs: number; at: number };
function measure(rec: Recording, edit: Window, refs: Window[]): Measure {
  let n1 = 0;
  let n2 = 0;
  let level = 0;
  for (const window of refs)
    for (const x of [rec.l, rec.r]) {
      const s = stat(x, window, rec.first);
      if (s.peak < 0.003) continue;
      n1 = Math.max(n1, s.d1 / s.peak);
      n2 = Math.max(n2, s.d2 / s.peak);
      level = Math.max(level, s.peak);
    }
  if (!level)
    console.log(
      `no reference level; whole-recording peak ${stat(rec.l, { from: 0, to: 60 }, rec.first).peak} length ${rec.l.length} first ${rec.first} refs ${JSON.stringify(refs)} segs ${Array.from({ length: 19 }, (_, i) => stat(rec.l, { from: i * 0.5, to: i * 0.5 + 0.5 }, rec.first).peak.toFixed(3)).join(" ")}`,
    );
  if (!level) return { jump1: Infinity, jump2: Infinity, dropMs: Infinity };
  let d1 = 0;
  let d2 = 0;
  for (const x of [rec.l, rec.r]) {
    const s = stat(x, edit, rec.first);
    d1 = Math.max(d1, s.d1);
    d2 = Math.max(d2, s.d2);
  }
  return { jump1: d1 / (n1 * level), jump2: d2 / (n2 * level), dropMs: longestQuiet(rec, edit, level * 0.02), at: worstAt(rec, edit) };
}
/** Seconds into the window of the largest second difference on either channel, for the failure message. */
function worstAt(rec: Recording, window: Window): number {
  const a = Math.max(1, Math.round(window.from * RATE) - rec.first);
  const b = Math.min(rec.l.length, Math.round(window.to * RATE) - rec.first);
  let best = 0;
  let at = a;
  for (let i = a; i < b; i++)
    for (const x of [rec.l, rec.r]) {
      const d = Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]) * 40;
      if (d > best) {
        best = d;
        at = i;
      }
    }
  return (at + rec.first) / RATE - window.from;
}

type Rig = {
  project: Project;
  workspace: Workspace;
  context: AudioContext;
  /** Track IDs by the key the setup gave them. */
  ids: Record<string, string>;
  /** Scratch space for an action to remember what it did last time. */
  memory: Record<string, unknown>;
  clips: Record<string, AudioClip | MidiClip>;
};
type Setup = {
  project: Project;
  ids: Record<string, string>;
  clips?: Record<string, AudioClip | MidiClip>;
  options?: Partial<WorkspaceOptions>;
  /** Seconds to seek to before playing. */
  seek?: number;
  /** Runs before play, with the workspace built. */
  prepare?: (rig: Rig) => Promise<void>;
};
type Spec = {
  name: string;
  expect: "clean" | "report";
  setup: () => Setup;
  /** Track keys whose strip output is recorded besides the master. */
  tap?: string[];
  /** Which recordings to judge; default all ("master" and the tap keys). */
  judge?: string[];
  reps?: number;
  steps?: number;
  /** Milliseconds between steps of a drag-like sequence. */
  interval?: number;
  /** Seconds the edit is allowed to take to land after its last step. */
  hold?: number;
  /** Runs once after play starts and before the first measured edit. */
  warm?: (rig: Rig) => Promise<void> | void;
  act: (rig: Rig, rep: number, step: number) => Promise<void> | void;
  /** Silence is part of the edit (mute, stop): the dropout check is skipped. */
  quiet?: boolean;
  /** Second-difference limit when the edit joins two sources by sample rounding (a split), where a sub-sample kink is inherent. */
  limit2?: number;
};

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export type Row = { name: string; expect: string; tap: string; jump1: number; jump2: number; dropMs: number; at: number; ok: boolean };
const rows: Row[] = [];

async function run(spec: Spec): Promise<Row[]> {
  const setup = spec.setup();
  const reps = spec.reps ?? 3;
  const steps = spec.steps ?? 1;
  const context = new AudioContext({ sampleRate: RATE });
  await loadRecorder(context);
  const workspace = await Workspace.create(context, setup.project, { workletUrl: worklet, ...setup.options });
  cleanups.push(async () => {
    workspace.dispose();
    setup.project.dispose();
    await context.close();
  });
  const rig: Rig = { project: setup.project, workspace, context, ids: setup.ids, memory: {}, clips: setup.clips ?? {} };
  await setup.prepare?.(rig);
  const taps = [new Tap(context, workspace.output, "master", RATE * 40)];
  for (const key of spec.tap ?? []) taps.push(new Tap(context, workspace.trackMixerOutput(setup.ids[key])!, key, RATE * 40));
  cleanups.push(() => taps.forEach((tap) => tap.dispose()));
  if (setup.seek) workspace.seek(setup.seek);
  await workspace.play();
  await spec.warm?.(rig);
  const edits: Array<{ from: number; to: number }> = [];
  const wait = async (time: number) => {
    while (context.currentTime < time) await sleep(2);
  };
  let next = context.currentTime + 0.8;
  for (let rep = 0; rep < reps; rep++) {
    await wait(next);
    const from = context.currentTime;
    for (let step = 0; step < steps; step++) {
      await spec.act(rig, rep, step);
      if (step < steps - 1) await sleep(spec.interval ?? 10);
    }
    const to = Math.max(context.currentTime, from + (spec.hold ?? 0));
    edits.push({ from, to });
    next = to + 1.1 + (spec.hold ? 0 : 0);
  }
  await wait(next - 0.6);
  const out: Row[] = [];
  for (const tap of taps) {
    if (spec.judge && !spec.judge.includes(tap.label)) continue;
    const rec = await tap.dump();
    let worst: Measure = { jump1: 0, jump2: 0, dropMs: 0, at: 0 };
    for (const { from, to } of edits) {
      const result = measure(rec, { from: from - 0.06, to: to + 0.35 }, [
        { from: from - 0.5, to: from - 0.1 },
        { from: to + 0.4, to: to + 0.55 },
      ]);
      if ((result.jump1 > JUMP1_LIMIT || result.jump2 > JUMP2_LIMIT) && Number.isFinite(result.jump1)) {
        const i = Math.round((from - 0.06 + result.at) * RATE) - rec.first;
        const around = rec.l.slice(i - 8, i + 8);
        console.log(`[${spec.name}] L around the jump: ${Array.from(around, (v) => v.toFixed(3)).join(" ")}`);
      }
      worst = {
        at: Math.max(result.jump1, result.jump2 / 40) >= Math.max(worst.jump1, worst.jump2 / 40) ? result.at : worst.at,
        jump1: Math.max(worst.jump1, result.jump1),
        jump2: Math.max(worst.jump2, result.jump2),
        dropMs: spec.quiet ? 0 : Math.max(worst.dropMs, result.dropMs),
      };
    }
    out.push({
      name: spec.name,
      expect: spec.expect,
      tap: tap.label,
      ...worst,
      ok: worst.jump1 <= JUMP1_LIMIT && worst.jump2 <= (spec.limit2 ?? JUMP2_LIMIT) && worst.dropMs <= DROPOUT_MS,
    });
  }
  rows.push(...out);
  return out;
}

afterAll(() => {
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "inf");
  const lines = rows.map(
    (r) =>
      `${r.ok ? "ok   " : "CLICK"} ${r.expect.padEnd(6)} ${r.name.padEnd(46)} ${r.tap.padEnd(7)} jump1 ${fmt(r.jump1).padStart(7)}/${JUMP1_LIMIT}  jump2 ${fmt(r.jump2).padStart(8)}/${JUMP2_LIMIT}  drop ${fmt(r.dropMs).padStart(6)}ms  at ${(r.at * 1000).toFixed(0).padStart(4)}ms`,
  );
  console.log(`\nLIVE-EDIT RESULTS\n${lines.join("\n")}`);
});

function register(specs: Spec[]) {
  for (const spec of specs) {
    test(`${spec.name} [${spec.expect}]`, async () => {
      const result = await run(spec);
      if (spec.expect === "clean") for (const row of result) expect(row, `${row.name} / ${row.tap}`).toMatchObject({ ok: true });
    }, 60_000);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Songs. 120 BPM: a beat is 0.5 s. Audio clips are in seconds, MIDI clips in beats.

/** Track A holds a 250 Hz tone; B a 400 Hz tone; FX is an empty effect bus. The song plays from 2.0 s. */
function audioSong(options: { rack?: "eq" | "filter"; sendTo?: boolean } = {}): Setup {
  const project = new Project({ bpm: 120 });
  const a = project.addTrack("A", "audio");
  const b = project.addTrack("B", "audio");
  const fx = project.addTrack("FX", "bus", { busRole: "effect" });
  const clipA = project.addAudioClip(a.id, sine(14), 0.5);
  const clipB = project.addAudioClip(b.id, sine(14, 0.2, 400), 0.5);
  project.setTrackRouting(a.id, { outputBusId: null, sends: options.sendTo ? [{ busId: fx.id, gain: 0.2 }] : [] });
  if (options.rack === "eq")
    project.setTrackEffects(a.id, [{ id: "eq", type: "eq", enabled: true, wet: 1, bands: [{ frequency: 250, gain: 0, q: 1 }] }]);
  if (options.rack === "filter")
    project.setTrackEffects(a.id, [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 8000, q: 0.7 }]);
  return { project, ids: { a: a.id, b: b.id, fx: fx.id }, clips: { a: clipA, b: clipB }, seek: 2 };
}

/** The same held sound with a stereo output: adding a stereo plug-in to a track whose source is mono switches the channel's pan law, which is a level step of its own. */
const heldStereo: SoundFactory = (context, hit) => {
  const voice = held(context, hit) as { output: AudioNode; sources: AudioScheduledSourceNode[] };
  const panner = new StereoPannerNode(context);
  voice.output.connect(panner);
  return { output: panner, sources: voice.sources };
};

/** One MIDI track playing a held 250 Hz note (a 19 s note in a 20 s clip) through a sine sound. */
function midiSong(): Setup {
  const project = new Project({ bpm: 120 });
  const m = project.addTrack("M", "midi");
  const clip = project.addMidiClip(m.id, { duration: 40, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 38 }] }, 0);
  return { project, ids: { m: m.id }, clips: { m: clip }, options: { instruments: { [m.id]: { sound: held } } } };
}

/** The held note track with its clip placed at `beat`, so a test can move it earlier or later while the note sounds. */
function midiSongAt(beat: number): Setup {
  const project = new Project({ bpm: 120 });
  const m = project.addTrack("M", "midi");
  const clip = project.addMidiClip(m.id, { duration: 40, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 38 }] }, beat);
  return { project, ids: { m: m.id }, clips: { m: clip }, options: { instruments: { [m.id]: { sound: held } } } };
}
const untilTime = (seconds: number) => async (rig: Rig) => {
  while (rig.context.currentTime < seconds) await sleep(5);
};

/** The held-note track played by oxo-synth2 instead of a sine. */
function oxoSong(): Setup {
  const project = new Project({ bpm: 120 });
  const m = project.addTrack("M", "midi");
  const clip = project.addMidiClip(m.id, { duration: 40, notes: [{ pitch: 60, velocity: 0.8, start: 0, duration: 38 }] }, 0);
  return {
    project,
    ids: { m: m.id },
    clips: { m: clip },
    prepare: async (rig) => void (await rig.workspace.addWebClapDevice(m.id, oxo)),
  };
}

/** Two session scenes of a held note each (C and G) on one MIDI track. */
function sessionSong(): Setup {
  const project = new Project({ bpm: 120 });
  const m = project.addTrack("M", "midi");
  const session = sessionFor(project);
  const [one, two] = [session.addScene({ name: "One" }), session.addScene({ name: "Two" })];
  session.setMidiClip({ trackId: m.id, sceneId: one.id }, { duration: 32, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 31 }] });
  session.setMidiClip({ trackId: m.id, sceneId: two.id }, { duration: 32, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 31 }] });
  return { project, ids: { m: m.id }, options: { instruments: { [m.id]: { sound: held } } } };
}

const alternate = <T>(rep: number, a: T, b: T) => (rep % 2 === 0 ? a : b);
const clipOf = (rig: Rig, key: string) => rig.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === rig.clips[key].id)!;
const playhead = (rig: Rig) => rig.workspace.position;

describe("controls", () => {
  register([
    { name: "control: nothing edited", expect: "clean", setup: () => audioSong(), act: () => {} },
    {
      // The detector must see a raw un-smoothed step, or every "clean" below means nothing.
      name: "detector self-test: raw gain step",
      expect: "report",
      setup: () => audioSong(),
      act: (rig) => rig.workspace.output.gain.setValueAtTime(0.4, rig.context.currentTime),
    },
  ]);
  test("the detector flags a raw step", async () => {
    const row = rows.find((r) => r.name === "detector self-test: raw gain step" && r.tap === "master");
    if (row) expect(row.jump1 > JUMP1_LIMIT || row.jump2 > JUMP2_LIMIT).toBe(true);
  });
});

describe("mixer", () => {
  register([
    {
      name: "track volume step",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig, rep) => rig.workspace.setTrackVolume(rig.ids.a, alternate(rep, 0.4, 1)),
    },
    {
      name: "track volume drag (30 steps, 8 ms)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 30,
      interval: 8,
      act: (rig, rep, step) => rig.workspace.setTrackVolume(rig.ids.a, alternate(rep, 1 - step * 0.02, 0.4 + step * 0.02)),
    },
    {
      name: "track pan step",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig, rep) => rig.workspace.setTrackPan(rig.ids.a, alternate(rep, -1, 1)),
    },
    {
      name: "track pan drag (30 steps, 8 ms)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 30,
      interval: 8,
      act: (rig, rep, step) => rig.workspace.setTrackPan(rig.ids.a, alternate(rep, -1 + step / 15, 1 - step / 15)),
    },
    {
      name: "track mute on then off",
      expect: "clean",
      setup: () => audioSong(),
      steps: 2,
      interval: 400,
      quiet: true,
      act: (rig, _rep, step) => rig.workspace.setTrackMuted(rig.ids.a, step === 0),
    },
    {
      name: "solo on then off (other track silenced)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 2,
      interval: 400,
      quiet: true,
      act: (rig, _rep, step) => rig.workspace.setTrackSolo(rig.ids.a, step === 0),
    },
    {
      name: "master volume step",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig, rep) => rig.workspace.setMasterVolume(alternate(rep, 0.4, 1)),
    },
    {
      name: "master volume drag (30 steps, 8 ms)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 30,
      interval: 8,
      act: (rig, rep, step) => rig.workspace.setMasterVolume(alternate(rep, 1 - step * 0.02, 0.4 + step * 0.02)),
    },
    {
      name: "send amount step",
      expect: "clean",
      setup: () => audioSong({ sendTo: true }),
      act: (rig, rep) =>
        rig.workspace.setTrackRouting(rig.ids.a, { outputBusId: null, sends: [{ busId: rig.ids.fx, gain: alternate(rep, 0.9, 0.1) }] }),
    },
    {
      name: "send amount drag (30 steps, 8 ms)",
      expect: "clean",
      setup: () => audioSong({ sendTo: true }),
      steps: 30,
      interval: 8,
      act: (rig, rep, step) =>
        rig.workspace.setTrackRouting(rig.ids.a, {
          outputBusId: null,
          sends: [{ busId: rig.ids.fx, gain: alternate(rep, step * 0.03, 0.9 - step * 0.03) }],
        }),
    },
  ]);
});

describe("effects", () => {
  const eq = (gain: number) => [{ id: "eq", type: "eq" as const, enabled: true, wet: 1, bands: [{ frequency: 250, gain, q: 1 }] }];
  const lp = (frequency: number) => [{ id: "lp", type: "filter" as const, enabled: true, wet: 1, mode: "lowpass" as const, frequency, q: 0.7 }];
  register([
    {
      name: "EQ band gain step",
      expect: "clean",
      setup: () => audioSong({ rack: "eq" }),
      act: (rig, rep) => rig.workspace.setTrackEffects(rig.ids.a, eq(alternate(rep, 9, -9))),
    },
    {
      name: "EQ band gain drag (20 steps, 10 ms)",
      expect: "clean",
      setup: () => audioSong({ rack: "eq" }),
      steps: 20,
      interval: 10,
      act: (rig, rep, step) => rig.workspace.setTrackEffects(rig.ids.a, eq(alternate(rep, step * 0.6, 12 - step * 0.6))),
    },
    {
      name: "filter cutoff step",
      expect: "clean",
      setup: () => audioSong({ rack: "filter" }),
      act: (rig, rep) => rig.workspace.setTrackEffects(rig.ids.a, lp(alternate(rep, 1200, 8000))),
    },
    {
      name: "filter cutoff drag (20 steps, 10 ms)",
      expect: "clean",
      setup: () => audioSong({ rack: "filter" }),
      steps: 20,
      interval: 10,
      act: (rig, rep, step) => rig.workspace.setTrackEffects(rig.ids.a, lp(alternate(rep, 8000 - step * 300, 2000 + step * 300))),
    },
  ]);
});

describe("audio clip edits under the playhead", () => {
  register([
    {
      name: "clip move by whole periods (0.5 s)",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig, rep) => {
        const clip = clipOf(rig, "a");
        rig.project.moveClip(clip.id, rig.ids.a, alternate(rep, clip.time + 0.5, clip.time - 0.5));
      },
    },
    {
      name: "clip trim start (behind the playhead)",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig) => {
        const clip = clipOf(rig, "a");
        rig.project.resizeClip(clip.id, { start: clip.time + 0.2 });
      },
    },
    {
      name: "clip trim end (ahead of the playhead)",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig) => {
        const clip = clipOf(rig, "a");
        rig.project.resizeClip(clip.id, { end: clip.time + clip.duration - 1 });
      },
    },
    {
      name: "clip split at the playhead",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig) => {
        const clip = rig.project.tracks
          .find((t) => t.id === rig.ids.a)!
          .clips.find((c) => c.time <= playhead(rig) && playhead(rig) < c.time + c.duration)!;
        rig.project.splitClip(clip.id, Math.round((playhead(rig) + 0.03 - clip.time) * 250) / 250);
      },
    },
    {
      name: "clip trim end to the playhead (hard stop)",
      expect: "clean",
      reps: 1,
      quiet: true,
      setup: () => audioSong(),
      act: (rig) => {
        const clip = clipOf(rig, "a");
        rig.project.resizeClip(clip.id, { end: playhead(rig) + 0.03 });
      },
    },
    {
      name: "clip delete under the playhead",
      expect: "report",
      reps: 1,
      quiet: true,
      setup: () => audioSong(),
      act: (rig) => rig.project.removeClip(clipOf(rig, "a").id),
    },
    {
      name: "setClipSourceRange by whole periods",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig, rep) => {
        const clip = clipOf(rig, "a") as AudioClip;
        const start = alternate(rep, 0.5, 0);
        rig.project.setClipSourceRange(clip.id, { start, end: 12 + start });
      },
    },
  ]);
});

describe("audio clip edits faster than the crossfade", () => {
  /** Moves the clip by half a second back and forth (a whole number of periods), one move per step. */
  const flip = (rig: Rig, step: number) => {
    const clip = clipOf(rig, "a");
    rig.project.moveClip(clip.id, rig.ids.a, clip.time + (step % 2 === 0 ? 0.5 : -0.5));
  };
  const trimmed = (rig: Rig, step: number) => {
    const clip = clipOf(rig, "a");
    const end = ((rig.memory.end as number | undefined) ?? (rig.memory.end = clip.time + clip.duration)) as number;
    rig.project.resizeClip(clip.id, { end: end - (step % 2 === 0 ? 1 : 2) });
  };
  register([
    {
      name: "rapid: 10 clip moves in 50 ms",
      expect: "clean",
      setup: () => audioSong(),
      steps: 10,
      interval: 5,
      act: (rig, _rep, step) => flip(rig, step),
    },
    {
      name: "rapid: 4 clip moves at 12 ms",
      expect: "clean",
      setup: () => audioSong(),
      steps: 4,
      interval: 12,
      act: (rig, _rep, step) => flip(rig, step),
    },
    {
      name: "rapid: 8 clip moves at 16 ms",
      expect: "clean",
      setup: () => audioSong(),
      steps: 8,
      interval: 16,
      act: (rig, _rep, step) => flip(rig, step),
    },
    {
      name: "rapid: 60 Hz clip drag (30 moves at 16.7 ms)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 30,
      interval: 16.7,
      act: (rig, _rep, step) => flip(rig, step),
    },
    {
      name: "rapid: 10 clip trim-ends in 50 ms",
      expect: "clean",
      setup: () => audioSong(),
      steps: 10,
      interval: 5,
      act: (rig, _rep, step) => trimmed(rig, step),
    },
    {
      name: "rapid: 60 Hz trim-end drag (30 at 16.7 ms)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 30,
      interval: 16.7,
      act: (rig, _rep, step) => trimmed(rig, step),
    },
  ]);
});

describe("MIDI note edits in a playing clip", () => {
  register([
    {
      name: "add a future note while another is held",
      expect: "clean",
      setup: () => midiSong(),
      act: (rig, rep) =>
        (rig.clips.m as MidiClip).midi.edit((notes) => {
          notes.push({ pitch: 67, velocity: 0.8, start: 30 + rep * 2, duration: 1 });
        }),
    },
    {
      name: "edit a different note's velocity while one is held",
      expect: "clean",
      setup: () => {
        const setup = midiSong();
        (setup.clips!.m as MidiClip).midi.edit((notes) => {
          notes.push({ pitch: 67, velocity: 0.8, start: 30, duration: 1 });
        });
        return setup;
      },
      act: (rig, rep) =>
        (rig.clips.m as MidiClip).midi.edit((notes) => {
          notes[1].velocity = alternate(rep, 0.4, 0.9);
        }),
    },
    {
      name: "edit the held note's own pitch (it sounds the new pitch at once)",
      expect: "clean",
      setup: () => midiSong(),
      act: (rig, rep) =>
        (rig.clips.m as MidiClip).midi.edit((notes) => {
          notes[0].pitch = alternate(rep, 67, 60);
        }),
    },
    {
      name: "edit the held note's start (still under the playhead)",
      expect: "clean",
      setup: () => midiSong(),
      act: (rig, rep) =>
        (rig.clips.m as MidiClip).midi.edit((notes) => {
          notes[0].start = alternate(rep, 1, 0);
        }),
    },
    {
      name: "edit the held note's length (still under the playhead)",
      expect: "clean",
      setup: () => midiSong(),
      act: (rig, rep) =>
        (rig.clips.m as MidiClip).midi.edit((notes) => {
          notes[0].duration = alternate(rep, 30, 38);
        }),
    },
    {
      name: "linked clip: edit through the other placement",
      expect: "clean",
      setup: () => {
        const setup = midiSong();
        const first = setup.clips!.m as MidiClip;
        const twin = setup.project.duplicateClip(first.id, 60, { linked: true }) as MidiClip;
        return { ...setup, clips: { ...setup.clips, twin } };
      },
      act: (rig, rep) =>
        (rig.clips.twin as MidiClip).midi.edit((notes) => {
          notes.push({ pitch: 67, velocity: 0.8, start: 30 + rep * 2, duration: 1 });
        }),
    },
    {
      // The held note (a 38-beat note in a 40-beat clip) still covers the playhead after a 3-beat move either way, so it keeps sounding without a break.
      name: "MIDI clip move by 3 beats under the playhead (held note continues)",
      expect: "clean",
      reps: 3,
      setup: () => midiSongAt(7),
      warm: untilTime(4.2),
      act: (rig, rep) => rig.project.moveClip(clipOf(rig, "m").id, rig.ids.m, alternate(rep, 4, 7)),
    },
    {
      // Moved past the playhead's note start the note no longer sounds there: it ends with the normal release, not a click.
      name: "MIDI clip move that uncovers the playhead (note ends with its release)",
      expect: "clean",
      reps: 1,
      quiet: true,
      setup: () => midiSongAt(7),
      warm: untilTime(4.2),
      act: (rig) => rig.project.moveClip(clipOf(rig, "m").id, rig.ids.m, 37),
    },
  ]);
});

describe("transport and loop while playing", () => {
  register([
    {
      name: "loop on then off (region far from the playhead)",
      expect: "clean",
      setup: () => audioSong(),
      steps: 2,
      interval: 400,
      warm: (rig) => rig.workspace.loop.setRegion({ startBeat: 4, endBeat: 40 }),
      act: (rig, _rep, step) => rig.workspace.loop.setEnabled(step === 0),
    },
    {
      name: "loop region change while looping",
      expect: "clean",
      setup: () => audioSong(),
      warm: (rig) => {
        rig.workspace.loop.setRegion({ startBeat: 4, endBeat: 40 });
        rig.workspace.loop.setEnabled(true);
      },
      act: (rig, rep) =>
        rig.workspace.loop.setRegion(
          [
            { startBeat: 5, endBeat: 40 },
            { startBeat: 4, endBeat: 30 },
            { startBeat: 5, endBeat: 35 },
          ][rep],
        ),
    },
    {
      name: "loop wrap (1 s region, whole periods)",
      expect: "clean",
      reps: 3,
      setup: () => audioSong(),
      warm: (rig) => {
        rig.workspace.loop.setRegion({ startBeat: 4, endBeat: 6 });
        rig.workspace.loop.setEnabled(true);
      },
      act: async (rig) => {
        // Wait for the wrapping transport to come back to the region start.
        let last = playhead(rig);
        for (let i = 0; i < 800; i++) {
          await sleep(2);
          const now = playhead(rig);
          if (now < last - 0.5) break;
          last = now;
        }
      },
    },
    {
      name: "seek to a later whole second while playing",
      expect: "clean",
      setup: () => audioSong(),
      act: (rig, rep) => rig.workspace.seek(5 + rep),
    },
  ]);
});

describe("session", () => {
  const scenes = (rig: Rig, rep: number) => rig.workspace.session.value.launchScene(rep % 2 === 0 ? 1 : 0);
  register([
    {
      name: "scene launch (one held note to the next)",
      expect: "clean",
      reps: 2,
      hold: 2.2,
      setup: () => sessionSong(),
      warm: async (rig) => {
        rig.workspace.session.value.launchScene(0);
        await sleep(2600);
      },
      act: scenes,
    },
    {
      name: "scene stop at the boundary",
      expect: "clean",
      reps: 1,
      hold: 2.2,
      quiet: true,
      setup: () => sessionSong(),
      warm: async (rig) => {
        rig.workspace.session.value.launchScene(0);
        await sleep(2600);
      },
      act: (rig) => rig.workspace.session.value.tracks[rig.ids.m].stop(),
    },
  ]);
});

describe("WebCLAP devices", () => {
  const addDevice = async (rig: Rig, trackId: string) => {
    rig.memory.device = await rig.workspace.addWebClapDevice(trackId, oxo);
  };
  const removeDevice = async (rig: Rig) => {
    const device = rig.memory.device as { id: string };
    rig.project.edit("Remove device", () => rig.project.removeDevice(device.id));
    await rig.workspace.flush();
  };
  register([
    {
      name: "oxo-synth2: track volume drag",
      expect: "clean",
      setup: () => oxoSong(),
      steps: 30,
      interval: 8,
      act: (rig, rep, step) => rig.workspace.setTrackVolume(rig.ids.m, alternate(rep, 1 - step * 0.02, 0.4 + step * 0.02)),
    },
    {
      name: "oxo-synth2: add a note to the playing clip",
      expect: "report",
      setup: () => oxoSong(),
      act: (rig, rep) =>
        (rig.clips.m as MidiClip).midi.edit((notes) => {
          notes.push({ pitch: 67, velocity: 0.8, start: 30 + rep * 2, duration: 1 });
        }),
    },
    {
      name: "add then remove a device on another track",
      expect: "clean",
      reps: 2,
      tap: ["a"],
      judge: ["a"],
      setup: () => {
        const setup = audioSong();
        const x = setup.project.addTrack("X", "midi");
        setup.project.addMidiClip(x.id, { duration: 40, notes: [{ pitch: 60, velocity: 1, start: 0, duration: 38 }] }, 0);
        return { ...setup, ids: { ...setup.ids, x: x.id } };
      },
      steps: 2,
      interval: 300,
      act: async (rig, _rep, step) => (step === 0 ? addDevice(rig, rig.ids.x) : removeDevice(rig)),
    },
    {
      name: "add a device to a track playing an instrument sound",
      expect: "clean",
      // The sampler's held notes end with their own 5 ms linear release; its corners show in the second difference.
      limit2: 10,
      reps: 1,
      quiet: true,
      setup: () => {
        const setup = midiSong();
        return { ...setup, options: { instruments: { [setup.ids.m]: { sound: heldStereo } } } };
      },
      act: async (rig) => void (await rig.workspace.addWebClapDevice(rig.ids.m, oxo)),
    },
    {
      // A mono source into a plug-in that outputs stereo: the channel's pan law switches, which must be a glide inside the chain crossfade, not a step.
      name: "add then remove a stereo plug-in on a mono audio track",
      expect: "clean",
      quiet: true,
      reps: 3,
      setup: () => audioSong(),
      steps: 2,
      interval: 300,
      act: async (rig, _rep, step) => (step === 0 ? addDevice(rig, rig.ids.a) : removeDevice(rig)),
    },
    {
      // The sound is a mono instrument (not stereo like the test above): the width of its source is not known from the project, so the switch must not need it.
      name: "add then remove a stereo plug-in on a track playing a mono instrument sound",
      expect: "clean",
      quiet: true,
      reps: 1,
      setup: () => midiSong(),
      steps: 2,
      interval: 300,
      act: async (rig, _rep, step) => (step === 0 ? addDevice(rig, rig.ids.m) : removeDevice(rig)),
    },
    {
      // Audio goes through a submix bus; the plug-in goes on the bus.
      name: "add then remove a stereo plug-in on a bus",
      expect: "clean",
      quiet: true,
      reps: 2,
      setup: () => {
        const setup = audioSong();
        const bus = setup.project.addTrack("Sub", "bus", { busRole: "submix" });
        setup.project.setTrackRouting(setup.ids.a, { outputBusId: bus.id, sends: [] });
        return { ...setup, ids: { ...setup.ids, bus: bus.id } };
      },
      steps: 2,
      interval: 300,
      act: async (rig, _rep, step) => (step === 0 ? addDevice(rig, rig.ids.bus) : removeDevice(rig)),
    },
    {
      name: "add then remove a device on the playing track",
      expect: "clean",
      quiet: true,
      reps: 2,
      setup: () => oxoSong(),
      steps: 2,
      interval: 300,
      act: async (rig, _rep, step) => (step === 0 ? addDevice(rig, rig.ids.m) : removeDevice(rig)),
    },
  ]);
});
