import { afterEach, describe, expect, test } from "vitest";
import { Clock, ManualTickSource } from "@audiorective/clock";
import { ClipLauncher } from "@audiorective/launcher";
import { StepSequencer } from "@audiorective/sequencer";
import { MidiClip, type Instrument, type NoteInit } from "../src";
import { driveOffline, type Step } from "./offline";

const SR = 8000;
type Call = { kind: "on" | "off"; pitch: number; when: number; velocity?: number; channel?: number };

/** Logs every call; `revocable` makes each call return an event with `cancel()` that is logged too. */
function instrument(revocable = false) {
  const calls: Call[] = [];
  const cancels: Array<{ kind: "on" | "off"; pitch: number }> = [];
  const result = (kind: "on" | "off", pitch: number) => (revocable ? { cancel: () => cancels.push({ kind, pitch }) } : undefined);
  const inst: Instrument = {
    noteOn(pitch, options) {
      calls.push({ kind: "on", pitch, when: options?.when ?? NaN, velocity: options?.velocity, channel: options?.channel });
      return result("on", pitch);
    },
    noteOff(pitch, when) {
      calls.push({ kind: "off", pitch, when: when ?? NaN });
      return result("off", pitch);
    },
  };
  return { inst, calls, cancels };
}
const ons = (calls: Call[]) => calls.filter((c) => c.kind === "on").map((c) => [c.pitch, +c.when.toFixed(4)]);
const offs = (calls: Call[]) => calls.filter((c) => c.kind === "off").map((c) => [c.pitch, +c.when.toFixed(4)]);
const note = (pitch: number, start: number, duration: number, extra: Partial<NoteInit> = {}): NoteInit => ({
  pitch,
  velocity: 0.8,
  start,
  duration,
  ...extra,
});

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** A clock at 120 bpm (one beat is 0.5 s) over an offline context, ticked every 25 ms. */
function rig(seconds: number, lookAhead = 0.1) {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  const ticks = new ManualTickSource();
  const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead });
  disposers.push(() => clock.dispose());
  const run = (steps: Step[] = [], start = true) => driveOffline(ctx, ticks, steps, () => start && clock.start());
  return { ctx, ticks, clock, run };
}

describe("MidiClip on a Clock", () => {
  test("plays notes in beats, pairs every note-on with its note-off, and passes velocity and channel", async () => {
    const { clock, run } = rig(3);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 1), note(64, 2, 0.5, { velocity: 0.5, channel: 3 })], { instrument: inst });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    await run();
    expect(ons(calls)).toEqual([
      [60, 0],
      [64, 1],
    ]);
    expect(offs(calls)).toEqual([
      [60, 0.5],
      [64, 1.25],
    ]);
    expect(calls.find((c) => c.pitch === 64 && c.kind === "on")).toMatchObject({ velocity: 0.5, channel: 3 });
  });

  test("a note plays once even when its start falls on a window boundary", async () => {
    const { clock, run } = rig(2, 0.05);
    const { inst, calls } = instrument();
    clock.attach(new MidiClip([note(60, 0.1, 0.1), note(61, 0.2, 0.1), note(62, 0.3, 0.1)], { instrument: inst }));
    await run();
    expect(ons(calls).map(([pitch]) => pitch)).toEqual([60, 61, 62]);
  });

  test("a loop wraps at `length` and cuts a note at the seam", async () => {
    const { clock, run } = rig(5);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 6), note(64, 3, 2), note(67, 4, 1)], { instrument: inst, loop: true, length: "1m" });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    await run();
    const first = calls.filter((c) => c.when <= 4);
    expect(ons(first.filter((c) => c.when < 4))).toEqual([
      [60, 0],
      [64, 1.5],
      [60, 2],
      [64, 3.5],
    ]);
    // the 6-beat note and the 2-beat note stop at the seam (beat 4 = 2 s, 8 beats = 4 s), a note at or past the seam is not played in pass 0
    expect(offs(first)).toEqual([
      [60, 2],
      [64, 2],
      [60, 4],
      [64, 4],
    ]);
  });

  test("the default loop length is the end of the last note rounded up to a whole bar", async () => {
    const { clock, run } = rig(5);
    const { inst, calls } = instrument();
    clock.attach(new MidiClip([note(60, 0, 1), note(62, 4.5, 1)], { instrument: inst, loop: true }));
    await run();
    expect(ons(calls.filter((c) => c.when < 5)).filter(([pitch]) => pitch === 60)).toEqual([
      [60, 0],
      [60, 4],
    ]);
  });

  test("an edit is one commit with one revision and is heard from the next scheduled window", async () => {
    const { clock, run } = rig(4);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 1, { id: "a" }), note(64, 2, 1, { id: "b" })], { instrument: inst });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    const revisions: number[] = [];
    await run([
      {
        at: 0.05,
        run: () => {
          clip.edit((draft) => {
            draft[0].pitch = 61; // note "a" was already scheduled at the first window
            draft[1].pitch = 65;
            draft.push({ id: "c", pitch: 72, velocity: 1, start: 4, duration: 1, channel: 0 });
          });
          revisions.push(clip.revision.value);
        },
      },
    ]);
    expect(revisions).toEqual([1]);
    expect(clip.notes.value.map((n) => n.pitch)).toEqual([61, 65, 72]);
    expect(ons(calls)).toEqual([
      [60, 0],
      [65, 1],
      [72, 2],
    ]);
  });

  test("setNotes replaces every note in one revision and a failed edit changes nothing", () => {
    const clip = new MidiClip([note(60, 0, 1)]);
    clip.setNotes([note(62, 0, 1), note(64, 1, 1)]);
    expect(clip.revision.value).toBe(1);
    const before = clip.notes.value;
    expect(() =>
      clip.edit((draft) => {
        draft[0].pitch = 200;
      }),
    ).toThrow("MidiClip note pitch must be an integer 0-127.");
    expect(clip.notes.value).toBe(before);
    expect(clip.revision.value).toBe(1);
  });

  test("a tempo change re-times the notes not yet played", async () => {
    const { clock, run } = rig(6);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 0.5), note(64, 4, 0.5)], { instrument: inst });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    await run([{ at: 0.3, run: () => (clock.bpm.value = 60) }]);
    const last = calls.filter((c) => c.kind === "on" && c.pitch === 64).at(-1)!;
    // beat 0.6 at 0.3 s; the remaining 3.4 beats take 3.4 s at 60 bpm
    expect(last.when).toBeCloseTo(3.7, 1);
  });

  test("stop sends a note-off at max(now, start) for every note-on already sent, including one scheduled in the future", async () => {
    const { clock, run } = rig(3, 0.5);
    const { inst, calls, cancels } = instrument(true);
    const clip = new MidiClip([note(60, 0, 8), note(64, 3, 1)], { instrument: inst });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    let mark = 0;
    await run([
      {
        at: 1.2,
        run: () => {
          mark = calls.length;
          clock.stop();
        },
      },
    ]);
    expect(ons(calls)).toEqual([
      [60, 0],
      [64, 1.5],
    ]);
    const releases = calls.slice(mark).filter((c) => c.kind === "off");
    // the sounding note is released now (within one tick of 1.2 s), the future note at its own start
    expect(releases.map((c) => c.pitch).sort()).toEqual([60, 64]);
    expect(releases.find((c) => c.pitch === 60)!.when).toBeGreaterThan(1.1);
    expect(releases.find((c) => c.pitch === 60)!.when).toBeLessThanOrEqual(1.25);
    expect(releases.find((c) => c.pitch === 64)!.when).toBeCloseTo(1.5, 3);
    // a revocable instrument has the pending natural note-offs and the not-yet-started note-on revoked
    expect(cancels).toContainEqual({ kind: "on", pitch: 64 });
    expect(cancels).not.toContainEqual({ kind: "on", pitch: 60 });
    expect(
      cancels
        .filter((c) => c.kind === "off")
        .map((c) => c.pitch)
        .sort(),
    ).toEqual([60, 64]);
  });

  test("pause, seek and detach release sounding notes", async () => {
    for (const leave of ["pause", "seek", "detach"] as const) {
      const { clock, run } = rig(2);
      const { inst, calls } = instrument();
      const clip = new MidiClip([note(60, 0, 8)], { instrument: inst });
      const detach = clock.attach(clip);
      let mark = 0;
      await run([
        {
          at: 0.5,
          run: () => {
            mark = calls.length;
            if (leave === "pause") clock.pause();
            else if (leave === "seek") clock.seek(20);
            else detach();
          },
        },
      ]);
      const early = calls.slice(mark).filter((c) => c.kind === "off");
      expect(early, leave).toHaveLength(1);
      expect(early[0].when, leave).toBeLessThanOrEqual(0.55);
      expect(early[0].when, leave).toBeGreaterThan(0.4);
    }
  });

  test("a disposed clip releases and ignores later windows; dispose twice is safe", async () => {
    const { clock, run } = rig(2);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 8), note(62, 2, 1)], { instrument: inst });
    clock.attach(clip);
    let mark = 0;
    await run([
      {
        at: 0.5,
        run: () => {
          mark = calls.length;
          clip[Symbol.dispose]();
        },
      },
    ]);
    clip.dispose();
    expect(ons(calls)).toEqual([[60, 0]]);
    expect(calls.slice(mark).filter((c) => c.kind === "off")).toHaveLength(1);
    expect(() => clip.setNotes([])).toThrow("MidiClip is disposed.");
  });

  test("an aborted signal disposes the clip", () => {
    const controller = new AbortController();
    const clip = new MidiClip([note(60, 0, 1)], { signal: controller.signal });
    controller.abort();
    expect(() => clip.edit(() => {})).toThrow("MidiClip is disposed.");
  });

  test("a clip without an instrument schedules nothing and picks one up later", async () => {
    const { clock, run } = rig(2);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0.5, 0.25), note(62, 1.5, 0.25)]);
    clock.attach(clip);
    await run([{ at: 0.4, run: () => (clip.instrument = inst) }]);
    expect(ons(calls).map(([pitch]) => pitch)).toEqual([62]);
  });

  test("invalid options are rejected", () => {
    expect(() => new MidiClip([], { length: 0 })).toThrow("MidiClip length must be positive beats or a note value.");
    expect(() => new MidiClip([], { length: "2x" as "2m" })).toThrow('MIDI needs a note value such as "4n" or "1m", got "2x".');
  });
});

describe("MidiClip in a ClipLauncher", () => {
  test("switching clips leaves no stuck notes", async () => {
    const ctx = new OfflineAudioContext(1, 6 * SR, SR);
    const ticks = new ManualTickSource();
    const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead: 0.1 });
    disposers.push(() => clock.dispose());
    const { inst, calls } = instrument();
    const a = new MidiClip([note(60, 0, 1), note(62, 1, 1), note(64, 2, 1)], { instrument: inst });
    const b = new MidiClip([note(72, 0, 1), note(74, 1, 1)], { instrument: inst });
    const launcher = new ClipLauncher(
      {
        lead: [
          { scheduler: a, loop: true, length: "1m" },
          { scheduler: b, loop: true, length: "1m" },
        ],
      },
      { context: ctx },
    );
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    const [clipA, clipB] = launcher.tracks.lead!.clips;
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.1, run: () => clipA!.launch() },
        { at: 2.2, run: () => clipB!.launch() },
        { at: 5, run: () => launcher.stopAll() },
      ],
      () => clock.start(),
    );
    const played = ons(calls);
    expect(played.some(([pitch]) => pitch === 60)).toBe(true);
    expect(played.some(([pitch]) => pitch === 72)).toBe(true);
    // every note-on has a later or equal note-off of its pitch, and nothing is left sounding at the end
    const held = new Map<number, number>();
    for (const call of [...calls].sort((x, y) => x.when - y.when || (x.kind === "off" ? -1 : 1))) {
      const count = (held.get(call.pitch) ?? 0) + (call.kind === "on" ? 1 : -1);
      held.set(call.pitch, Math.max(0, count));
    }
    expect([...held.values()].every((count) => count === 0)).toBe(true);
    for (const on of calls.filter((c) => c.kind === "on")) {
      expect(calls.some((c) => c.kind === "off" && c.pitch === on.pitch && c.when >= on.when - 1e-9)).toBe(true);
    }
  });

  test("a clip is accepted as a launcher scheduler and as a clock scheduler by the type system", () => {
    const clip = new MidiClip([]);
    const clock = new Clock({ context: { currentTime: 0 }, tickSource: new ManualTickSource() });
    clock.attach(clip)();
    const launcher = new ClipLauncher({ t: [{ scheduler: clip, length: "1m" }] }, { context: new OfflineAudioContext(1, 128, SR) });
    launcher.dispose();
    clock.dispose();
    expect(launcher.tracks.t!.clips[0]).not.toBeNull();
  });
});

describe("a launched MidiClip is cut where the launcher stops or replaces it", () => {
  function launched(clips: MidiClip[], seconds = 6) {
    const ctx = new OfflineAudioContext(1, seconds * SR, SR);
    const ticks = new ManualTickSource();
    const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead: 0.1 });
    disposers.push(() => clock.dispose());
    const launcher = new ClipLauncher({ lead: clips.map((scheduler) => ({ scheduler, length: "4m" as const })) }, { context: ctx });
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    const track = launcher.tracks.lead!;
    const run = (steps: Step[]) => driveOffline(ctx, ticks, steps, () => clock.start());
    return { track, run, launcher };
  }
  const releasesAfter = (calls: Call[], mark: number, pitch: number) => calls.slice(mark).filter((c) => c.kind === "off" && c.pitch === pitch);

  test("a quantized stop releases the sounding note at the boundary and cancels its natural note-off", async () => {
    const { inst, calls, cancels } = instrument(true);
    const a = new MidiClip([note(60, 0, 16), note(64, 0.5, 16)], { instrument: inst });
    const { track, run } = launched([a]);
    let mark = 0;
    await run([
      { at: 0.01, run: () => track.clips[0]!.launch({ quantize: "none" }) },
      {
        at: 0.7,
        run: () => {
          mark = calls.length;
          track.stop({ quantize: "1m" });
        },
      },
    ]);
    expect(ons(calls).map(([pitch]) => pitch)).toEqual([60, 64]);
    for (const pitch of [60, 64]) {
      const released = releasesAfter(calls, mark, pitch);
      expect(released, `pitch ${pitch}`).toHaveLength(1);
      expect(released[0].when).toBeCloseTo(2, 2);
      expect(cancels.filter((c) => c.kind === "off" && c.pitch === pitch)).toHaveLength(1);
    }
  });

  test("switching to another clip cuts the old clip's sounding notes at the switch; nothing is stuck or doubled", async () => {
    const { inst, calls } = instrument();
    const a = new MidiClip([note(60, 0, 16)], { instrument: inst });
    const b = new MidiClip([note(72, 0, 1), note(74, 1, 1)], { instrument: inst });
    const { track, run } = launched([a, b]);
    let mark = 0;
    await run([
      { at: 0.01, run: () => track.clips[0]!.launch({ quantize: "none" }) },
      {
        at: 0.7,
        run: () => {
          mark = calls.length;
          track.clips[1]!.launch({ quantize: "1m" });
        },
      },
    ]);
    const cut = releasesAfter(calls, mark, 60);
    expect(cut).toHaveLength(1);
    expect(cut[0].when).toBeCloseTo(2, 2);
    expect(ons(calls).filter(([pitch]) => pitch === 60)).toHaveLength(1);
    expect(
      ons(calls)
        .filter(([pitch]) => pitch === 72)
        .map(([, when]) => when),
    ).toEqual([2]);
    expect(
      ons(calls)
        .filter(([pitch]) => pitch === 74)
        .map(([, when]) => when),
    ).toEqual([2.5]);
    const held = new Map<number, number>();
    for (const call of [...calls].sort((x, y) => x.when - y.when || (x.kind === "off" ? -1 : 1)))
      held.set(call.pitch, (held.get(call.pitch) ?? 0) + (call.kind === "on" ? 1 : -1));
    // every note-on has at least one note-off after it; the cut note-off may be followed by its (stale) natural one
    for (const [pitch, count] of held) expect(count, `pitch ${pitch}`).toBeLessThanOrEqual(0);
  });

  test("a refresh never cuts or doubles a sounding note", async () => {
    const { clock, run } = rig(3);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 4), note(62, 2, 1)], { instrument: inst });
    clock.attach(clip);
    let mark = 0;
    await run([
      {
        at: 0.5,
        run: () => {
          mark = calls.length;
          clock.refresh();
        },
      },
    ]);
    expect(ons(calls)).toEqual([
      [60, 0],
      [62, 1],
    ]);
    expect(calls.slice(mark).filter((c) => c.kind === "off" && c.pitch === 60)).toHaveLength(0);
    expect(offs(calls).filter(([pitch]) => pitch === 60)).toEqual([[60, 2]]);
  });

  test("a step-sequencer pattern clip is stopped at the boundary as before", async () => {
    const ctx = new OfflineAudioContext(1, 4 * SR, SR);
    const ticks = new ManualTickSource();
    const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead: 0.1 });
    disposers.push(() => clock.dispose());
    const hits = new Set<number>();
    const pattern = new StepSequencer(
      { k: { pattern: "XXXXXXXX", rate: "4n" } },
      {
        onHit: (hit) => {
          hits.add(Math.round(hit.when * 1e4) / 1e4);
          return () => hits.delete(Math.round(hit.when * 1e4) / 1e4);
        },
      },
    );
    const launcher = new ClipLauncher({ p: [{ scheduler: pattern, loop: true, length: "4m" }] }, { context: ctx });
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.01, run: () => launcher.tracks.p!.clips[0]!.launch({ quantize: "none" }) },
        { at: 0.7, run: () => launcher.tracks.p!.stop({ quantize: "1m" }) },
      ],
      () => clock.start(),
    );
    expect([...hits].every((when) => when < 2 - 1e-6)).toBe(true);
    expect(hits.size).toBeGreaterThanOrEqual(4);
  });
});
