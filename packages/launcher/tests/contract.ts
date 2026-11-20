// Headless contract: the same launcher module the page uses, rendered on an OfflineAudioContext.
import { Clock, ManualTickSource } from "@audiorective/clock";
import { driveOffline } from "./offline";
import { ClipLauncher, ClipEvent as LauncherEvent, type ClipOptions as LClipOptions, type FollowTarget, type Quantize } from "../src/ClipLauncher";

export type TrackId = "drums" | "bass" | "chords";
type Q = "none" | "beat" | "bar" | "2 bars";
export type ClipOptions = {
  quantize?: Q;
  startBeat?: number;
  loop?: { startBeat: number; lengthBeats: number } | false;
  gainDb?: number;
  pitch?: number;
  follow?: { afterBars: number; actions: Array<{ to: "next" | "previous" | "random" | number; chance: number }> };
  chance?: number;
};
export type Action =
  | { at: number; kind: "launch"; track: TrackId; clip: number; quantize?: Q; legato?: boolean }
  | { at: number; kind: "release"; track: TrackId; clip: number }
  | { at: number; kind: "cancel"; track: TrackId }
  | { at: number; kind: "stop"; track: TrackId; quantize?: Q }
  | { at: number; kind: "scene"; scene: number; quantize?: Q };
export type Scenario = {
  seconds: number;
  sampleRate?: number;
  seed?: number;
  globalQuantize?: Q;
  clips?: Partial<Record<TrackId, Array<ClipOptions & { mode?: "trigger" | "gate" | "toggle" }>>>;
  sceneBpm?: Record<number, number>;
  actions: Action[];
};
export type ClipEvent = { track: TrackId; clip: number; kind: "start" | "stop"; when: number; offsetBeats: number };

const TRACKS: TrackId[] = ["drums", "bass", "chords"];
const BASE: Record<TrackId, number> = { drums: 100, bass: 200, chords: 400 };
const BPM = 120;
const QUANT: Record<Q, Quantize> = { none: "none", beat: "4n", bar: "1m", "2 bars": "2m" };

/** Clip `n` of track `t`: a sine whose frequency steps every beat, so the position is measurable. 4 bars at 120 BPM. */
export function material(ctx: BaseAudioContext, t: TrackId, n: number): AudioBuffer {
  const frames = Math.round(16 * (60 / BPM) * ctx.sampleRate);
  const buf = new AudioBuffer({ length: frames, sampleRate: ctx.sampleRate, numberOfChannels: 1 });
  const data = buf.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < frames; i++) {
    const beat = Math.floor((i / ctx.sampleRate) * (BPM / 60));
    phase += (2 * Math.PI * BASE[t] * (n + 1) * (1 + beat / 16)) / ctx.sampleRate;
    data[i] = 0.5 * Math.sin(phase);
  }
  return buf;
}

function clipSpec(
  ctx: BaseAudioContext,
  t: TrackId,
  n: number,
  o: (ClipOptions & { mode?: "trigger" | "gate" | "toggle" }) | undefined,
): LClipOptions {
  const next: FollowTarget[] | undefined = o?.follow?.actions.map((a) => ({ clip: a.to, weight: a.chance }));
  if (next) {
    const sum = o!.follow!.actions.reduce((s, a) => s + a.chance, 0);
    if (sum < 1) next.push({ clip: "stay", weight: 1 - sum });
  }
  return {
    buffer: material(ctx, t, n),
    bpm: BPM,
    loop: o?.loop === false ? false : o?.loop ? { startBeat: o.loop.startBeat, endBeat: o.loop.startBeat + o.loop.lengthBeats } : true,
    quantize: o?.quantize ? QUANT[o.quantize] : undefined,
    offsetBeats: o?.startBeat,
    gainDb: o?.gainDb,
    pitch: o?.pitch,
    mode: o?.mode,
    chance: o?.chance,
    follow: next ? { after: `${o!.follow!.afterBars}m`, next } : undefined,
  };
}

export async function renderScenario(s: Scenario): Promise<{ events: ClipEvent[]; perTrack: Record<TrackId, AudioBuffer> }> {
  const sr = s.sampleRate ?? 44100;
  const length = Math.round(s.seconds * sr);
  const ctx = new OfflineAudioContext(TRACKS.length, length, sr);
  const ticks = new ManualTickSource();
  const clock = new Clock({ context: ctx, bpm: BPM, tickSource: ticks });
  const specs: Record<string, ClipOptions[] | LClipOptions[]> = {};
  const tracks: Record<string, LClipOptions[]> = {};
  for (const t of TRACKS) tracks[t] = [0, 1, 2, 3].map((n) => clipSpec(ctx, t, n, s.clips?.[t]?.[n]));
  void specs;
  const scenes = Object.keys(s.sceneBpm ?? {}).length
    ? Array.from({ length: 1 + Math.max(...Object.keys(s.sceneBpm!).map(Number)) }, (_, i) => ({ tempo: s.sceneBpm![i] }))
    : undefined;
  const launcher = new ClipLauncher(tracks, { context: ctx, quantize: QUANT[s.globalQuantize ?? "bar"], seed: s.seed ?? 0, scenes });
  const merger = new ChannelMergerNode(ctx, { numberOfInputs: TRACKS.length });
  merger.connect(ctx.destination);
  TRACKS.forEach((t, i) => launcher.tracks[t]!.connect(merger, 0, i));
  clock.attach(launcher);

  const events: ClipEvent[] = [];
  let recording = true;
  const record = (kind: "start" | "stop") => (e: Event) => {
    if (!recording) return;
    const ev = e as LauncherEvent;
    events.push({ track: ev.track.name as TrackId, clip: ev.clip!.index, kind, when: ev.when!, offsetBeats: ev.offsetBeats ?? 0 });
  };
  launcher.addEventListener("started", record("start"));
  launcher.addEventListener("ended", record("stop"));

  const apply = (a: Action) => {
    switch (a.kind) {
      case "launch":
        launcher.tracks[a.track]!.clips[a.clip]!.launch({ quantize: a.quantize ? QUANT[a.quantize] : undefined, legato: a.legato });
        break;
      case "release":
        launcher.tracks[a.track]!.clips[a.clip]!.release();
        break;
      case "cancel":
        launcher.tracks[a.track]!.cancelQueued();
        break;
      case "stop":
        launcher.tracks[a.track]!.stop({ quantize: a.quantize ? QUANT[a.quantize] : undefined });
        break;
      case "scene":
        launcher.launchScene(a.scene, { quantize: a.quantize ? QUANT[a.quantize] : undefined });
        break;
    }
  };

  const rendered = await driveOffline(
    ctx,
    ticks,
    s.actions.map((a) => ({ at: a.at, run: () => apply(a) })),
    () => clock.start(0.1, 0),
  );
  recording = false; // tearing down silences what still plays: not a clip event of the scenario
  clock.destroy();
  launcher.dispose();

  const perTrack = {} as Record<TrackId, AudioBuffer>;
  TRACKS.forEach((t, i) => {
    const b = new AudioBuffer({ length: rendered.length, sampleRate: sr, numberOfChannels: 1 });
    b.copyToChannel(rendered.getChannelData(i), 0);
    perTrack[t] = b;
  });
  return { events, perTrack };
}
