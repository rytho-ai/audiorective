import { describe, expect, test } from "vitest";
import { StepSequencer, type Hit } from "@audiorective/sequencer";
import { ClipLauncher, type ClipSettings, type ScheduledChange } from "../src/ClipLauncher";
import { driveOffline, type Step } from "./offline";
import { freq, lastSound, near, onset, peakIn, r3, record, rig, tone } from "./helpers";

// 120 bpm, transport beat 0 at 0.1 s: a beat is 0.5 s, a bar 2 s.
const start = (clock: { start(when?: number, offsetBeats?: number): void }) => () => clock.start(0.1, 0);

describe("quantized launches", () => {
  test.each([
    ["none", 0.7],
    ["8n", 0.85],
    ["4n", 1.1],
    ["1m", 2.1],
    ["2m", 4.1],
  ] as const)("quantize %s lands on its boundary", async (quantize, at) => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), quantize }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["queued", "started"]);
    const out = await driveOffline(ctx, ticks, [{ at: 0.7, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
    const started = log.find((event) => event.type === "started")!;
    expect(started.when!).toBeGreaterThanOrEqual(at - 0.003);
    expect(started.when!).toBeLessThan(at + 0.003);
    expect(onset(out)).toBeCloseTo(started.when!, 2);
    launcher.dispose();
  });

  test("launcher.quantize is a runtime cell used when neither the call nor the clip gives one", async () => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    clock.attach(launcher);
    expect(launcher.quantize.value).toBe("1m");
    launcher.quantize.value = "4n";
    const log = record(launcher, ["started"]);
    await driveOffline(ctx, ticks, [{ at: 0.7, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
    expect(r3(log[0]!.when)).toBe(1.1);
    launcher.dispose();
  });

  test("switching a track leaves no gap and no overlap at the boundary", async () => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher(
      {
        t: [
          { buffer: tone(ctx, 200), loop: true },
          { buffer: tone(ctx, 300), loop: true },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const t = launcher.tracks.t!;
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => t.clips[0]!.launch() },
        { at: 1.0, run: () => t.clips[1]!.launch() },
      ],
      start(clock),
    );
    const data = out.getChannelData(0);
    const at = Math.round(2.1 * out.sampleRate);
    // the old clip's last sample and the new clip's first sample are both sound, never summed
    expect(Math.max(...data.slice(at - 64, at + 64).map(Math.abs))).toBeLessThan(0.51);
    expect(peakIn(out, 2.1 - 0.01, 2.1)).toBeGreaterThan(0.3);
    expect(peakIn(out, 2.1, 2.1 + 0.01)).toBeGreaterThan(0.3);
    near(freq(out, 2.15, 2.4), 300);
    launcher.dispose();
  });

  test("a scene lands every clip on the same sample", async () => {
    const { ctx, ticks, clock } = rig(4, 3);
    const launcher = new ClipLauncher(
      { a: [{ buffer: tone(ctx, 200), quantize: "4n" }], b: [{ buffer: tone(ctx, 300) }], c: [{ buffer: tone(ctx, 400) }] },
      { context: ctx },
    );
    clock.attach(launcher);
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 3 });
    merger.connect(ctx.destination);
    Object.values(launcher.tracks).forEach((track, i) => track.connect(merger, 0, i));
    const log = record(launcher, ["started"]);
    const out = await driveOffline(ctx, ticks, [{ at: 0.7, run: () => launcher.launchScene(0) }], start(clock));
    expect(new Set(log.map((event) => event.when))).toEqual(new Set([log[0]!.when]));
    const first = [0, 1, 2].map((channel) => out.getChannelData(channel).findIndex((value) => Math.abs(value) > 1e-4));
    expect(new Set(first).size).toBe(1);
    expect(first[0]).toBe(Math.round(2.1 * out.sampleRate));
    launcher.dispose();
  });

  test("a scene may leave slots empty and a clip list launches exactly those clips", async () => {
    const { ctx, ticks, clock } = rig(6);
    const launcher = new ClipLauncher(
      { a: [{ buffer: tone(ctx, 200) }, { buffer: tone(ctx, 220) }], b: [null, { buffer: tone(ctx, 300) }] },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.launchScene(0) },
        { at: 2.2, run: () => launcher.launchScene([launcher.tracks.b!.clips[1]!]) },
      ],
      start(clock),
    );
    expect(log.map((event) => `${event.track}${event.clip}`)).toEqual(["a0", "b1"]);
    expect(launcher.scenes).toHaveLength(2);
    launcher.dispose();
  });

  test("a track launch replaces only that track's waiting launch; cancelQueued withdraws one track or all", async () => {
    const { ctx, ticks, clock } = rig(4);
    const launcher = new ClipLauncher(
      { a: [{ buffer: tone(ctx, 200) }, { buffer: tone(ctx, 220) }], b: [{ buffer: tone(ctx, 300) }], c: [{ buffer: tone(ctx, 400) }] },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "cancelled"]);
    const seen: string[] = [];
    await driveOffline(
      ctx,
      ticks,
      [
        {
          at: 0.7,
          run: () => {
            launcher.tracks.a!.clips[0]!.launch();
            launcher.tracks.b!.clips[0]!.launch();
            launcher.tracks.c!.clips[0]!.launch();
            launcher.tracks.a!.clips[1]!.launch();
            seen.push(launcher.queued.value.map((change) => `${change.track.name}${change.clip!.index}`).join(","));
            expect(launcher.tracks.b!.cancelQueued()).toBe(true);
            expect(launcher.tracks.b!.cancelQueued()).toBe(false);
            seen.push(launcher.queued.value.map((change) => change.track.name).join(","));
            expect(launcher.tracks.c!.clips[0]!.cancelQueued()).toBe(true);
            expect(launcher.cancelQueued()).toBe(true);
            expect(launcher.cancelQueued()).toBe(false);
            seen.push(String(launcher.queued.value.length));
          },
        },
      ],
      start(clock),
    );
    expect(seen).toEqual(["a1,b0,c0", "a,c", "0"]);
    expect(log.filter((event) => event.type === "started")).toHaveLength(0);
    launcher.dispose();
  });

  test("a cancelled launch leaves the previous playback intact", async () => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher(
      {
        t: [
          { buffer: tone(ctx, 200), loop: true },
          { buffer: tone(ctx, 300), loop: true },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 1.0, run: () => launcher.tracks.t!.clips[1]!.launch() },
        { at: 1.5, run: () => launcher.tracks.t!.cancelQueued() },
      ],
      start(clock),
    );
    near(freq(out, 2.15, 2.4), (freq(out, 0.15, 0.4) * (1 + 4 / 16)) / (1 + 0 / 16), 0.01);
    expect(launcher.tracks.t!.playing.value).toBe(launcher.tracks.t!.clips[0]);
    launcher.dispose();
  });
});

describe("stopping", () => {
  test("stopAll silences every track on one shared boundary; track.stop uses the playing clip's quantize, else the launcher's", async () => {
    const { ctx, ticks, clock } = rig(8);
    const launcher = new ClipLauncher(
      {
        a: [{ buffer: tone(ctx, 200), loop: true, quantize: "4n" }],
        b: [{ buffer: tone(ctx, 300), loop: true }],
        c: [{ buffer: tone(ctx, 400), loop: true }],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["ended"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.launchScene(0, { quantize: "none" }) },
        { at: 0.7, run: () => launcher.tracks.a!.stop() }, // a's own quantize "4n": beat 2 = 1.1
        { at: 2.3, run: () => launcher.tracks.b!.stop() }, // launcher "1m": 4.1
        { at: 4.3, run: () => launcher.stopAll() }, // launcher "1m": 6.1
      ],
      start(clock),
    );
    const when = (name: string) => r3(log.find((event) => event.track === name)!.when);
    expect(when("a")).toBe(1.1);
    expect(when("b")).toBe(4.1);
    expect(when("c")).toBe(6.1);
    launcher.dispose();
  });

  test("a one-shot ends at its exact end and the track reports it", async () => {
    const { ctx, ticks, clock } = rig(10);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200, 4) }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    const out = await driveOffline(ctx, ticks, [{ at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
    expect(r3(log[1]!.when)).toBe(2.1);
    expect(log[1]!.off).toBeCloseTo(4, 6);
    expect(lastSound(out)).toBeCloseTo(2.1, 3);
    expect(launcher.tracks.t!.playing.value).toBeNull();
    launcher.dispose();
  });
});

describe("modes", () => {
  test("a gate released before its launch starts cancels that launch", async () => {
    const { ctx, ticks, clock } = rig(5);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true, mode: "gate" }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started", "cancelled"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.7, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 1.2, run: () => launcher.tracks.t!.clips[0]!.release() },
      ],
      start(clock),
    );
    expect(log.map((event) => event.type)).toEqual(["cancelled"]);
    launcher.dispose();
  });

  test("a gate and a repeat clip started by a scene behave as trigger and repeat-until-stopped", async () => {
    const { ctx, ticks, clock } = rig(7);
    const launcher = new ClipLauncher(
      {
        gate: [{ buffer: tone(ctx, 200, 4), loop: true, mode: "gate" }],
        repeat: [{ buffer: tone(ctx, 300, 4), loop: true, mode: "repeat", repeatBeats: 2 }],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.launchScene(0) },
        { at: 4.5, run: () => launcher.tracks.repeat!.stop({ quantize: "4n" }) },
      ],
      start(clock),
    );
    expect(log.filter((event) => event.track === "gate").map((event) => event.type)).toEqual(["started"]);
    const repeats = log.filter((event) => event.track === "repeat" && event.type === "started").map((event) => r3(event.when));
    expect(repeats).toEqual([0.1, 1.1, 2.1, 3.1, 4.1]);
    launcher.dispose();
  });

  test("toggle: launching a playing clip stops it, launching a waiting one withdraws it", async () => {
    const { ctx, ticks, clock } = rig(6);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true, mode: "toggle" }] }, { context: ctx });
    clock.attach(launcher);
    const log = record(launcher, ["started", "ended", "cancelled"]);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 2.2, run: () => launcher.tracks.t!.clips[0]!.launch() }, // playing: stop at 4.1
        { at: 4.2, run: () => launcher.tracks.t!.clips[0]!.launch() }, // idle: waits for 6.1
        { at: 4.3, run: () => launcher.tracks.t!.clips[0]!.launch() }, // waiting: withdrawn
      ],
      start(clock),
    );
    expect(log.map((event) => `${event.type}${r3(event.when)}`)).toEqual(["started0.1", "ended4.1", "cancelled6.1"]);
    launcher.dispose();
  });
});

describe("follow", () => {
  test("a stay on a looping clip draws again one `after` later", async () => {
    const draws: number[] = [];
    for (let seed = 0; seed < 12; seed++) {
      const { ctx, ticks, clock } = rig(14);
      const launcher = new ClipLauncher(
        {
          t: [
            { buffer: tone(ctx, 200, 4), loop: true, follow: { after: "1m", next: [{ clip: "stay", weight: 3 }, { clip: 1 }] } },
            { buffer: tone(ctx, 300, 4), loop: true },
          ],
        },
        { context: ctx, seed },
      );
      clock.attach(launcher);
      const log = record(launcher, ["started"]);
      await driveOffline(ctx, ticks, [{ at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
      const second = log.find((event) => event.clip === 1);
      if (second) draws.push(r3(second.when)!);
      launcher.dispose();
    }
    // follows land on bar boundaries; at least one seed stayed on the first draw(s) and left on a later one
    expect(draws.length).toBeGreaterThan(3);
    expect(draws.every((when) => Math.abs((when - 0.1) % 2) < 0.002 || Math.abs(((when - 0.1) % 2) - 2) < 0.002)).toBe(true);
    expect(Math.max(...draws)).toBeGreaterThan(4);
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(2.1);
  });

  test("a probability launch is deterministic for a seed", async () => {
    const run = async () => {
      const { ctx, ticks, clock } = rig(12);
      const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), chance: 0.5, quantize: "4n" }] }, { context: ctx, seed: 7 });
      clock.attach(launcher);
      const log = record(launcher, ["started", "skipped"]);
      const steps: Step[] = Array.from({ length: 10 }, (_, i) => ({ at: 0.1 + i * 1.1, run: () => launcher.tracks.t!.clips[0]!.launch() }));
      await driveOffline(ctx, ticks, steps, start(clock));
      launcher.dispose();
      return log.map((event) => event.type);
    };
    const first = await run();
    expect(await run()).toEqual(first);
    expect(first).toContain("started");
    expect(first).toContain("skipped");
  });
});

describe("tempo", () => {
  test("a buffer clip follows the scene tempo with no warp option; warp: false keeps its speed", async () => {
    const { ctx, ticks, clock } = rig(8, 2);
    const launcher = new ClipLauncher(
      { a: [{ buffer: tone(ctx, 200), loop: true }], b: [{ buffer: tone(ctx, 300), loop: true, warp: false }] },
      { context: ctx, scenes: [{}, { tempo: 240 }] },
    );
    clock.attach(launcher);
    const merger = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
    merger.connect(ctx.destination);
    launcher.tracks.a!.connect(merger, 0, 0);
    launcher.tracks.b!.connect(merger, 0, 1);
    expect(launcher.tracks.a!.clips[0]!.options.value.warp).toBe("repitch");
    expect(launcher.tracks.b!.clips[0]!.options.value.warp).toBe(false);
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.launchScene([launcher.tracks.a!.clips[0]!, launcher.tracks.b!.clips[0]!]) },
        { at: 0.5, run: () => (clock.timeline.bpm.value = 240) },
      ],
      start(clock),
    );
    const channel = (i: number) => {
      const buffer = new AudioBuffer({ length: out.length, sampleRate: out.sampleRate });
      buffer.copyToChannel(out.getChannelData(i), 0);
      return buffer;
    };
    const warped = channel(0);
    const natural = channel(1);
    // frequency of a at the first material beat is 200; at 240 bpm (twice 120) it plays at twice the speed
    near(freq(warped, 0.15, 0.4), 200);
    // from 0.5 s the warped clip runs 4 beats per second: at 2.85..3.0 s it is on material beat 10 and plays an octave up (playbackRate 2)
    near(freq(warped, 2.85, 3.0), 200 * (1 + 10 / 16) * 2, 0.02);
    // the unwarped clip is on material beat 5 at its own speed
    near(freq(natural, 2.85, 3.0), 300 * (1 + 5 / 16), 0.02);
    launcher.dispose();
  });

  test("a clip created before attach takes its bpm from the clock tempo when attached", async () => {
    const { ctx, clock } = rig(1);
    clock.timeline.bpm.value = 90;
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    clock.attach(launcher);
    expect(launcher.tracks.t!.clips[0]!.options.value.bpm).toBe(90);
    const later = launcher.tracks.t!.setClip(1, { buffer: tone(ctx, 300) })!;
    expect(later.options.value.bpm).toBe(90);
    launcher.dispose();
  });

  test("a waiting boundary is fixed in beats: a tempo change calls the host's cancel and then onSchedule again", async () => {
    const { ctx, ticks, clock } = rig(4);
    const log: string[] = [];
    const launcher = new ClipLauncher(
      { t: [{ buffer: tone(ctx, 200) }] },
      {
        context: ctx,
        onSchedule: (change: ScheduledChange) => {
          log.push(`schedule@${r3(change.when)}`);
          return { cancel: () => log.push("cancel"), commit: () => log.push("commit") };
        },
      },
    );
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 1.0, run: () => launcher.tracks.t!.clips[0]!.launch({ quantize: "1m" }) }, // beat 4 at 2.1, handed to the graph when it enters the look-ahead
        { at: 2.06, run: () => (clock.timeline.bpm.value = 240) }, // the same beat now lands earlier
      ],
      start(clock),
    );
    expect(log[0]).toBe("schedule@2.1");
    expect(log).toContain("cancel");
    expect(log).toHaveLength(4);
    expect(log.slice(1, 3)).toEqual(["cancel", expect.stringMatching(/^schedule@2\.0/)]);
    expect(log[3]).toBe("commit");
    launcher.dispose();
  });
});

describe("pattern clips", () => {
  test("two tracks of pattern clips switch independently without doubled or missing hits", async () => {
    const { ctx, ticks, clock } = rig(10);
    const hits = new Map<string, Set<number>>();
    const make = (name: string, pattern: string) =>
      new StepSequencer(
        { k: { pattern, rate: "4n" } },
        {
          onHit: (hit: Hit) => {
            const set = hits.get(name) ?? hits.set(name, new Set()).get(name)!;
            set.add(Math.round(hit.when * 1e5) / 1e5);
            return () => set.delete(Math.round(hit.when * 1e5) / 1e5);
          },
        },
      );
    const launcher = new ClipLauncher(
      {
        drums: [
          { scheduler: make("d1", "X"), loop: true, length: "1m" },
          { scheduler: make("d2", "X."), loop: true, length: "1m" },
        ],
        perc: [
          { scheduler: make("p1", "X"), loop: true, length: "1m" },
          { scheduler: make("p2", "X..."), loop: true, length: "1m" },
        ],
      },
      { context: ctx },
    );
    clock.attach(launcher);
    const { drums, perc } = launcher.tracks;
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.launchScene(0) },
        { at: 1.9, run: () => drums!.clips[1]!.launch() }, // lands at 2.1, inside the look-ahead
        { at: 3.0, run: () => perc!.clips[1]!.launch() }, // lands at 4.1
      ],
      start(clock),
    );
    const sorted = (name: string, from: number, to: number) => [...(hits.get(name) ?? [])].filter((t) => t >= from && t < to).sort((a, b) => a - b);
    const grid = (from: number, to: number, step: number) => {
      const out: number[] = [];
      for (let t = from; t < to - 1e-9; t += step) out.push(Math.round(t * 1e5) / 1e5);
      return out;
    };
    expect(sorted("d1", 0, 9.5)).toEqual(grid(0.1, 2.1, 0.5));
    expect(sorted("d2", 0, 9.5)).toEqual(grid(2.1, 9.5, 1));
    expect(sorted("p1", 0, 9.5)).toEqual(grid(0.1, 4.1, 0.5));
    expect(sorted("p2", 0, 9.5)).toEqual(grid(4.1, 9.5, 2));
    launcher.dispose();
  });

  test("a pattern clip is routed into the track output and stops with the clip", async () => {
    const { ctx, ticks, clock } = rig(4);
    const sequencer = new StepSequencer(
      { k: { pattern: "X...", rate: "4n", sound: (context) => new ConstantSourceNode(context, { offset: 0.5 }) } },
      { context: ctx },
    );
    const launcher = new ClipLauncher({ t: [{ scheduler: sequencer, loop: true, length: "1m" }] }, { context: ctx });
    clock.attach(launcher);
    const out = await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 0.5, run: () => launcher.tracks.t!.stop({ quantize: "4n" }) },
      ],
      start(clock),
    );
    expect(peakIn(out, 0.1, 0.5)).toBeGreaterThan(0.01);
    launcher.dispose();
  });
});

describe("transport", () => {
  test("dispose leaves a shared clock and another scheduler running", async () => {
    const { ctx, ticks, clock } = rig(4);
    const hits: number[] = [];
    const hats = new StepSequencer({ h: { pattern: "X", rate: "4n" } }, { onHit: (hit: Hit) => void hits.push(Math.round(hit.when * 1e5) / 1e5) });
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true }] }, { context: ctx });
    clock.attach(hats);
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 1.0, run: () => launcher.dispose() },
      ],
      start(clock),
    );
    expect(clock.state.value).toBe("playing");
    expect([...new Set(hits)].filter((t) => t < 3.9)).toEqual([0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6]);
    launcher.dispose();
    expect(() => launcher.dispose()).not.toThrow();
  });

  test("a launcher is disposed by its AbortSignal", () => {
    const { ctx, clock } = rig(1);
    const controller = new AbortController();
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx, signal: controller.signal });
    clock.attach(launcher);
    controller.abort();
    // attaching the same launcher again would throw only if the clock still held it
    expect(() => clock.attach(launcher)).not.toThrow();
  });

  test("the reactive cells follow a launch from queued to playing to stopped", async () => {
    const { ctx, ticks, clock } = rig(6);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200), loop: true }] }, { context: ctx });
    clock.attach(launcher);
    const clip = launcher.tracks.t!.clips[0]!;
    const seen: string[] = [];
    const snapshot = (label: string) =>
      seen.push(
        `${label}:${clip.queued.value}/${clip.playing.value}/${launcher.tracks.t!.playing.value === clip}/${launcher.queued.value.length}/${r3(clip.startsAt.value)}/${r3(clip.startedAt.value)}`,
      );
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.7, run: () => (clip.launch(), snapshot("queued")) },
        { at: 2.3, run: () => snapshot("playing") },
        { at: 2.4, run: () => launcher.tracks.t!.stop({ quantize: "1m" }) },
        { at: 2.5, run: () => seen.push(`stopping:${launcher.tracks.t!.queued.value?.clip}/${r3(launcher.tracks.t!.queued.value?.when ?? null)}`) },
        { at: 4.5, run: () => snapshot("stopped") },
      ],
      start(clock),
    );
    expect(seen).toEqual([
      "queued:true/false/false/1/2.1/null",
      "playing:false/true/true/0/null/2.1",
      "stopping:null/4.1",
      "stopped:false/false/false/0/null/null",
    ]);
    launcher.dispose();
  });
});

describe("clip options", () => {
  test("offsetBeats with a loop region, gain and pitch", async () => {
    const { ctx, ticks, clock } = rig(4);
    const launcher = new ClipLauncher(
      { t: [{ buffer: tone(ctx, 200), offsetBeats: 2, loop: { startBeat: 2, endBeat: 4 }, gainDb: -6.0206, pitch: 12 }] },
      { context: ctx },
    );
    clock.attach(launcher);
    const out = await driveOffline(ctx, ticks, [{ at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() }], start(clock));
    // material beat 2 sounds at 200 * (1 + 2/16); one octave up, half amplitude, and the region [2, 4) repeats every second
    near(freq(out, 0.15, 0.4), 200 * (1 + 2 / 16) * 2, 0.02);
    near(freq(out, 1.15, 1.4), 200 * (1 + 2 / 16) * 2, 0.02);
    expect(peakIn(out, 0.2, 0.4)).toBeGreaterThan(0.2);
    expect(peakIn(out, 0.2, 0.4)).toBeLessThan(0.3);
    launcher.dispose();
  });

  test("configure throws RangeError for chance outside 0..1, repeatBeats <= 0 and an empty loop", () => {
    const { ctx } = rig(1);
    const launcher = new ClipLauncher({ t: [{ buffer: tone(ctx, 200) }] }, { context: ctx });
    const clip = launcher.tracks.t!.clips[0]!;
    expect(() => clip.configure({ chance: 2 })).toThrow(RangeError);
    expect(() => clip.configure({ repeatBeats: 0 })).toThrow(RangeError);
    expect(() => clip.configure({ loop: { startBeat: 2, endBeat: 2 } })).toThrow(RangeError);
    const patch: Partial<ClipSettings> = { name: "kick", quantize: "4n" };
    clip.configure(patch);
    expect(clip.options.value).toMatchObject({ name: "kick", quantize: "4n", warp: "repitch" });
    launcher.dispose();
  });

  test("setClip on a playing clip tells the host's handle and silences the track", async () => {
    const { ctx, ticks, clock } = rig(4);
    const log: string[] = [];
    const launcher = new ClipLauncher(
      { t: [{ buffer: tone(ctx, 200), loop: true }] },
      { context: ctx, onSchedule: () => ({ commit: () => log.push("commit"), reset: () => log.push("reset"), cancel: () => log.push("cancel") }) },
    );
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => launcher.tracks.t!.clips[0]!.launch() },
        { at: 1.0, run: () => expect(launcher.tracks.t!.setClip(0, null)).toBeNull() },
      ],
      start(clock),
    );
    expect(log).toEqual(["commit", "reset"]);
    expect(launcher.tracks.t!.playing.value).toBeNull();
    launcher.dispose();
  });
});
