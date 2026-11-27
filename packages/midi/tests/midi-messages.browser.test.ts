import { afterEach, describe, expect, test } from "vitest";
import { Clock, ManualTickSource } from "@audiorective/clock";
import { ClipLauncher } from "@audiorective/launcher";
import { MidiClip, type ClipMessage, type Instrument } from "../src";
import { driveOffline, type Step } from "./offline";

/** Controllers, bend and program changes sent with the notes of a `MidiClip`, standalone: no daw, a plain recording instrument. */
const SR = 8000;
type Call = { kind: "on" | "off" | "msg"; value: number[]; when: number };

function instrument(withMessages = true) {
  const calls: Call[] = [];
  const cancels: number[][] = [];
  const inst: Instrument = {
    noteOn(pitch, options) {
      calls.push({ kind: "on", value: [pitch], when: options?.when ?? NaN });
    },
    noteOff(pitch, when) {
      calls.push({ kind: "off", value: [pitch], when: when ?? NaN });
    },
    ...(withMessages
      ? {
          scheduleMidi(data: Uint8Array, when: number) {
            calls.push({ kind: "msg", value: [...data], when });
            return { cancel: () => void cancels.push([...data]) };
          },
        }
      : {}),
  };
  return { inst, calls, cancels };
}
const log = (calls: Call[]) => calls.map((c) => `${c.kind}:${c.value.join(",")}@${+c.when.toFixed(4)}`);
const msg = (beat: number, ...data: number[]): ClipMessage => ({ beat, data: Uint8Array.from(data) });
const note = (pitch: number, start: number, duration: number) => ({ pitch, velocity: 0.8, start, duration });

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

/** 120 bpm: a beat is 0.5 s. */
function rig(seconds: number) {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  const ticks = new ManualTickSource();
  const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead: 0.1 });
  disposers.push(() => clock.dispose());
  const run = (steps: Step[] = []) => driveOffline(ctx, ticks, steps, () => clock.start());
  return { ctx, ticks, clock, run };
}

function launcherRig(seconds: number) {
  const ctx = new OfflineAudioContext(1, Math.round(seconds * SR), SR);
  const ticks = new ManualTickSource();
  const clock = new Clock({ context: ctx, tickSource: ticks, bpm: 120, lookAhead: 0.1 });
  disposers.push(() => clock.dispose());
  return { ctx, ticks, clock };
}

describe("MidiClip messages on a Clock", () => {
  test("are sent at their beats, a note-off first, then program change, controller and bend, then the note-on", async () => {
    const { clock, run } = rig(3);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 1), note(62, 1, 1)], {
      instrument: inst,
      messages: [msg(1, 0xb0, 64, 127), msg(1, 0xc0, 5), msg(1, 0xe0, 0, 100), msg(1.5, 0xb0, 1, 40)],
    });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    await run();
    expect(log(calls).slice(0, 8)).toEqual([
      "on:60@0",
      "off:60@0.5",
      "msg:192,5@0.5",
      "msg:176,64,127@0.5",
      "msg:224,0,100@0.5",
      "on:62@0.5",
      "msg:176,1,40@0.75",
      "off:62@1",
    ]);
  });

  test("an instrument without scheduleMidi plays the notes as before", async () => {
    const { clock, run } = rig(2);
    const { inst, calls } = instrument(false);
    const clip = new MidiClip([note(60, 0, 1)], { instrument: inst, messages: [msg(0.5, 0xb0, 64, 127)] });
    disposers.push(() => clip.dispose());
    clock.attach(clip);
    await run();
    expect(log(calls)).toEqual(["on:60@0", "off:60@0.5"]);
  });

  test("setMessages validates, freezes a copy and rejects notes", () => {
    const clip = new MidiClip();
    disposers.push(() => clip.dispose());
    const bytes = Uint8Array.of(0xb0, 64, 127);
    clip.setMessages([{ beat: 1, data: bytes }, msg(0, 0xb0, 1, 3)]);
    bytes[2] = 0;
    expect(clip.messages.value.map((m) => [m.beat, ...m.data])).toEqual([
      [0, 0xb0, 1, 3],
      [1, 0xb0, 64, 127],
    ]);
    expect(() => clip.setMessages([msg(0, 0x90, 60, 100)])).toThrow("not notes");
    expect(() => clip.setMessages([msg(-1, 0xb0, 1, 3)])).toThrow("non-negative beat");
  });
});

describe("MidiClip messages in a ClipLauncher", () => {
  test("a looping clip repeats its messages every pass, and the release at the pass end comes before the next pass", async () => {
    const { ctx, ticks, clock } = launcherRig(5);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 0.5)], {
      instrument: inst,
      messages: [msg(0, 0xb0, 1, 20), msg(0.5, 0xb0, 64, 127), msg(2, 0xb0, 64, 0)],
    });
    const launcher = new ClipLauncher({ lead: [{ scheduler: clip, loop: true, length: "2n" }] }, { context: ctx });
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    await driveOffline(ctx, ticks, [{ at: 0.01, run: () => launcher.tracks.lead!.clips[0]!.launch({ quantize: "none" }) }], () => clock.start());
    const sustain = calls.filter((c) => c.kind === "msg" && c.value[1] === 64).map((c) => `${c.value[2]}@${+c.when.toFixed(2)}`);
    // beat 2 of a two-beat loop is the wrap: the pedal comes up there, then the next pass presses it again a quarter-second later
    expect(sustain.slice(0, 4)).toEqual(["127@0.25", "0@1", "127@1.25", "0@2"]);
  });

  test("stopping a clip with the pedal down puts the controllers it moved back at the stop; a message still ahead is withdrawn", async () => {
    const { ctx, ticks, clock } = launcherRig(4);
    const { inst, calls, cancels } = instrument();
    const clip = new MidiClip([note(60, 0, 4)], {
      instrument: inst,
      messages: [
        msg(0, 0xb0, 64, 127),
        msg(0.5, 0xe0, 0, 80),
        msg(0.5, 0xb0, 1, 90),
        msg(0.5, 0xb0, 7, 100),
        msg(1.3, 0xb0, 11, 30),
        msg(3, 0xb0, 64, 0),
      ],
    });
    const launcher = new ClipLauncher({ lead: [{ scheduler: clip, loop: true, length: "1m" }] }, { context: ctx });
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.01, run: () => launcher.tracks.lead!.clips[0]!.launch({ quantize: "none" }) },
        { at: 0.6, run: () => launcher.tracks.lead!.stop({ quantize: "none" }) },
      ],
      () => clock.start(),
    );
    const sent = log(calls.filter((c) => c.kind === "msg"));
    // the pedal is down and the bend and mod wheel moved: all three are put back at the stop; volume 100 is already at rest
    expect(sent.slice(0, 3)).toEqual(["msg:176,64,127@0", "msg:224,0,80@0.25", "msg:176,1,90@0.25"]);
    const back = calls.filter((c) => c.kind === "msg" && c.when > 0.5 && c.value[1] !== 11);
    expect(back.map((c) => c.value.join(",")).sort()).toEqual(["176,1,0", "176,64,0", "224,0,64"]);
    // together, at the stop (the clip is stopped on the first tick that reaches 0.6 s)
    expect(Math.max(...back.map((c) => c.when)) - Math.min(...back.map((c) => c.when))).toBeLessThan(1e-9);
    expect(back[0]!.when).toBeGreaterThanOrEqual(0.6);
    expect(back[0]!.when).toBeLessThan(0.65);
    // the expression message that was still ahead is withdrawn, and expression is not put back (it was never sent)
    expect(cancels).toContainEqual([0xb0, 11, 30]);
  });

  test("a clip taking the track over at the same time keeps the controller it sets, and one that does not is put back", async () => {
    const { ctx, ticks, clock } = launcherRig(4);
    const { inst, calls } = instrument();
    const a = new MidiClip([note(60, 0, 4)], { instrument: inst, messages: [msg(0, 0xb0, 64, 127), msg(0, 0xb0, 1, 50)] });
    const b = new MidiClip([note(62, 0, 4)], { instrument: inst, messages: [msg(0, 0xb0, 64, 127)] });
    const launcher = new ClipLauncher(
      {
        lead: [
          { scheduler: a, loop: true, length: "4n" },
          { scheduler: b, loop: true, length: "4n" },
        ],
      },
      { context: ctx },
    );
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.01, run: () => launcher.tracks.lead!.clips[0]!.launch({ quantize: "none" }) },
        { at: 0.6, run: () => launcher.tracks.lead!.clips[1]!.launch({ quantize: "none" }) },
      ],
      () => clock.start(),
    );
    const after = calls.filter((c) => c.kind === "msg" && c.when >= 0.59 && c.when < 0.7).map((c) => c.value.join(","));
    expect(after).toContain("176,64,127"); // b's own press
    expect(after).not.toContain("176,64,0"); // a's release must not lift it
    expect(after).toContain("176,1,0"); // the mod wheel only a moved goes back
  });

  test("launching another clip in the launcher (a re-fill) does not lift a held pedal", async () => {
    const { ctx, ticks, clock } = launcherRig(3);
    const { inst, calls } = instrument();
    const a = new MidiClip([note(60, 0, 4)], { instrument: inst, messages: [msg(0, 0xb0, 64, 127), msg(3, 0xb0, 64, 0)] });
    const other = instrument();
    const b = new MidiClip([note(70, 0, 1)], { instrument: other.inst });
    const launcher = new ClipLauncher(
      { lead: [{ scheduler: a, loop: true, length: "4n" }], other: [{ scheduler: b, loop: true, length: "4n" }] },
      { context: ctx },
    );
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.01, run: () => launcher.tracks.lead!.clips[0]!.launch({ quantize: "none" }) },
        { at: 0.6, run: () => launcher.tracks.other!.clips[0]!.launch({ quantize: "none" }) },
      ],
      () => clock.start(),
    );
    const pedal = calls.filter((c) => c.kind === "msg" && c.value[1] === 64).map((c) => `${c.value[2]}@${+c.when.toFixed(2)}`);
    expect(pedal.filter((v) => v.startsWith("0@") && Number(v.slice(2)) < 1.5)).toEqual([]);
  });
});

describe("the rest list is curated: only performance controllers rest", () => {
  test("controllerRestOf and controllerRestValue name the list, and nothing else", async () => {
    const { controllerRestOf, controllerRestValue } = await import("../src");
    const rests: Array<[number, number]> = [
      [1, 0],
      [2, 0],
      [4, 0],
      [7, 100],
      [8, 64],
      [10, 64],
      [11, 127],
      [64, 0],
      [65, 0],
      [66, 0],
      [67, 0],
      [68, 0],
      [69, 0],
      [71, 64],
      [72, 64],
      [73, 64],
      [74, 64],
    ];
    for (const [controller, rest] of rests) {
      expect(controllerRestValue("channelController", controller)).toBe(rest);
      expect(controllerRestOf([0xb0, controller, rest === 0 ? 100 : 1])?.rest).toEqual(Uint8Array.of(0xb0, controller, rest));
    }
    const listed = new Set(rests.map(([controller]) => controller));
    for (let controller = 0; controller < 128; controller++) {
      if (listed.has(controller)) continue;
      expect(controllerRestValue("channelController", controller), `CC${controller}`).toBeUndefined();
      expect(controllerRestOf([0xb0, controller, 99]), `CC${controller}`).toBeUndefined();
    }
    expect(controllerRestValue("pitchBend", 0)).toBe(8192);
    expect(controllerRestValue("channelPressure", 0)).toBe(0);
    expect(controllerRestValue("polyPressure", 60)).toBe(0);
  });

  test("a stop does not touch RPN, data entry or bank select: a bend range of 12 semitones stays", async () => {
    const { ctx, ticks, clock } = launcherRig(3);
    const { inst, calls } = instrument();
    const clip = new MidiClip([note(60, 0, 4)], {
      instrument: inst,
      messages: [
        msg(0, 0xb0, 0, 3),
        msg(0, 0xb0, 32, 5),
        msg(0, 0xb0, 101, 0),
        msg(0, 0xb0, 100, 0),
        msg(0, 0xb0, 6, 12),
        msg(0, 0xb0, 38, 0),
        msg(0, 0xb0, 98, 1),
        msg(0, 0xb0, 96, 1),
        msg(0, 0xb0, 7, 60),
      ],
    });
    const launcher = new ClipLauncher({ lead: [{ scheduler: clip, loop: true, length: "1m" }] }, { context: ctx });
    disposers.push(() => launcher.dispose());
    clock.attach(launcher);
    await driveOffline(
      ctx,
      ticks,
      [
        { at: 0.01, run: () => launcher.tracks.lead!.clips[0]!.launch({ quantize: "none" }) },
        { at: 0.6, run: () => launcher.tracks.lead!.stop({ quantize: "none" }) },
      ],
      () => clock.start(),
    );
    const back = calls.filter((c) => c.kind === "msg" && c.when > 0.5).map((c) => c.value.join(","));
    expect(back).toEqual(["176,7,100"]);
  });
});

describe("a window that begins mid-content chases the position", () => {
  const chased = (calls: Call[], from: number) => log(calls.filter((c) => c.kind === "msg" && c.when >= from - 1e-9));

  function chaseClip() {
    const { inst, calls, cancels } = instrument();
    const clip = new MidiClip([note(60, 0, 8)], {
      instrument: inst,
      messages: [
        msg(0, 0xb0, 0, 3),
        msg(0, 0xc0, 9),
        msg(0, 0xb0, 7, 60),
        msg(0, 0xb0, 10, 20),
        msg(1, 0xb0, 64, 127),
        msg(2, 0xb0, 1, 90),
        msg(2, 0xe0, 0, 100),
        msg(6, 0xb0, 64, 0),
      ],
    });
    disposers.push(() => clip.dispose());
    return { clip, inst, calls, cancels };
  }

  test("a start at beat 4 sends what the song set before it, a bank select before its program change, and nothing it did not set", async () => {
    const { clock, run } = rig(3);
    const { clip, calls } = chaseClip();
    clock.attach(clip);
    await run([]);
    clock.stop();
    calls.length = 0;
    const second = rig(3);
    const other = chaseClip();
    second.clock.attach(other.clip);
    await driveOffline(second.ctx, second.ticks, [], () => second.clock.start(undefined, 4));
    const sent = log(other.calls.filter((c) => c.kind === "msg" && c.when < 0.05));
    expect(sent).toEqual([
      "msg:176,0,3@0",
      "msg:192,9@0",
      "msg:176,7,60@0",
      "msg:176,10,20@0",
      "msg:176,64,127@0",
      "msg:176,1,90@0",
      "msg:224,0,100@0",
    ]);
  });

  test("a seek forward sends only what differs: the song's volume and pan stay, the pedal held on both sides does not dip", async () => {
    const { clock, ctx, ticks } = rig(3);
    const { clip, calls } = chaseClip();
    clock.attach(clip);
    await driveOffline(ctx, ticks, [{ at: 1.05, run: () => clock.seek(3) }], () => clock.start());
    // the pedal went down at beat 1 (0.5 s); the seek at 1.05 s lands on beat 3, still inside the held region
    const after = log(calls.filter((c) => c.kind === "msg" && c.when >= 1.05 && c.when < 1.3));
    expect(after.filter((line) => line.includes("176,64"))).toEqual([]);
    expect(after.filter((line) => line.includes("176,7,") || line.includes("176,10,"))).toEqual([]);
    // the wheel and the bend of beat 2 are already where beat 3 needs them
    expect(after.filter((line) => line.includes("176,1,") || line.includes("224,"))).toEqual([]);
  });

  test("a seek back before the pedal and the wheel puts those back to rest and keeps what the song set before", async () => {
    const { clock, ctx, ticks } = rig(3);
    const { clip, calls } = chaseClip();
    clock.attach(clip);
    await driveOffline(ctx, ticks, [{ at: 1.55, run: () => clock.seek(0.5) }], () => clock.start());
    const after = chased(calls, 1.5).filter((line) => Number(line.split("@")[1]) < 1.7);
    expect(after.some((line) => line.startsWith("msg:176,64,0@"))).toBe(true);
    expect(after.some((line) => line.startsWith("msg:176,1,0@"))).toBe(true);
    expect(after.some((line) => line.startsWith("msg:224,0,64@"))).toBe(true);
    expect(after.some((line) => line.startsWith("msg:176,64,127@"))).toBe(false);
    expect(after.some((line) => line.startsWith("msg:176,7,"))).toBe(false);
  });
});

describe("an instrument that throws on one message", () => {
  test("loses that message only: the notes and messages after it still play, and the error is reported once", async () => {
    const calls: string[] = [];
    const inst: Instrument = {
      noteOn(pitch) {
        calls.push(`on:${pitch}`);
      },
      noteOff(pitch) {
        calls.push(`off:${pitch}`);
      },
      scheduleMidi(data: Uint8Array) {
        if (data[1] === 1) throw new Error("device refused CC1");
        calls.push(`msg:${[...data].join(",")}`);
        return { cancel() {} };
      },
    };
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const { clock, run } = rig(2);
      const clip = new MidiClip([note(60, 0, 0.5), note(62, 0.5, 0.5), note(64, 1, 0.5)], {
        instrument: inst,
        messages: [msg(0, 0xb0, 7, 90), msg(0, 0xb0, 1, 10), msg(0, 0xb0, 10, 30), msg(0.5, 0xb0, 1, 20), msg(0.5, 0xb0, 11, 70)],
      });
      disposers.push(() => clip.dispose());
      clock.attach(clip);
      await run();
    } finally {
      console.error = original;
    }
    expect(calls).toContain("msg:176,7,90");
    expect(calls).toContain("msg:176,10,30");
    expect(calls).toContain("msg:176,11,70");
    expect(calls.filter((call) => call.startsWith("on:"))).toEqual(["on:60", "on:62", "on:64"]);
    expect(errors.filter(([message]) => String(message).includes("MidiClip message failed"))).toHaveLength(1);
  });
});
