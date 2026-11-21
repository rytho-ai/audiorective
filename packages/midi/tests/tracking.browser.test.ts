import { describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { MidiClip } from "../src";
import { MidiKeyboard, MidiRecorder } from "../src/web";
import * as clipSourceModule from "../src/MidiClip.ts?raw";
import * as recorderSourceModule from "../src/MidiRecorder.ts?raw";
import * as keyboardSourceModule from "../src/MidiKeyboard.ts?raw";
import { coverageGaps, watch } from "../../../scripts/tracking-coverage.mjs";

const touchedClip = new Set<string>();
const touchedRecorder = new Set<string>();
const touchedKeyboard = new Set<string>();

const note = (id: string) => ({ id, start: 0.5, duration: 1, pitch: 60, velocity: 0.7 });

/** Reads inside an effect, mutates through the owner's public method, expects a re-run with a new value. */
function expectTracked(read: () => unknown, mutate: () => void) {
  const seen: unknown[] = [];
  const stop = effect(() => void seen.push(read()));
  const first = seen[0];
  mutate();
  stop();
  expect(seen.length).toBeGreaterThan(1);
  expect(Object.is(seen[seen.length - 1], first)).toBe(false);
}

describe("MidiClip readers are tracked", () => {
  const rows: Array<[string, (c: MidiClip) => unknown, (c: MidiClip) => void]> = [
    ["notes (setNotes)", (c) => c.notes.value, (c) => c.setNotes([note("a")])],
    ["notes (edit)", (c) => c.notes.value, (c) => c.edit((draft) => void (draft[0].pitch = 62))],
    ["revision (setNotes)", (c) => c.revision.value, (c) => c.setNotes([note("a")])],
    ["revision (edit)", (c) => c.revision.value, (c) => c.edit((draft) => void draft.push({ ...draft[0], id: "z" }))],
  ];
  test.each(rows)("%s", (_name, read, mutate) => {
    const clip = watch(new MidiClip([note("n")]), touchedClip);
    expectTracked(
      () => read(clip),
      () => mutate(clip),
    );
    clip.dispose();
  });

  test("an edit runs an effect once and the owner's methods called in an effect do not subscribe it", () => {
    const clip = watch(new MidiClip([note("n")]), touchedClip);
    let runs = 0;
    const stop = effect(() => {
      void clip.notes.value;
      void clip.revision.value;
      runs++;
    });
    clip.edit((draft) => {
      draft[0].pitch = 61;
      draft.push({ id: "m", pitch: 70, velocity: 1, start: 0, duration: 1, channel: 0 });
    });
    expect(runs).toBe(2);
    let outer = 0;
    const stopOuter = effect(() => {
      outer++;
      clip.edit((draft) => void (draft[0].pitch = 63));
      clip.setNotes([note("q")]);
    });
    clip.setNotes([note("r")]);
    expect(outer).toBe(1);
    stop();
    stopOuter();
    clip.dispose();
  });

  test("the instrument, a plain property, is read and written directly and scheduling members are exercised", () => {
    const clip = watch(new MidiClip([note("n")]), touchedClip);
    const inst = { noteOn: vi.fn(), noteOff: vi.fn() };
    clip.instrument = inst;
    expect(clip.instrument).toBe(inst);
    const timing = { beatToTime: (b: number) => b / 2, timeToBeat: (t: number) => t * 2 };
    const detach = clip.attached({ refresh: vi.fn(), detach: vi.fn() });
    clip.schedule({ beat: { start: 0, end: 4 }, time: { current: 0 }, own: vi.fn() }, timing);
    expect(inst.noteOn).toHaveBeenCalledTimes(1);
    clip.transport({ type: "tempo", when: 0, beat: 0 });
    clip.reset("stop");
    expect(inst.noteOff).toHaveBeenCalled();
    detach();
    clip[Symbol.dispose]();
  });
});

describe("MidiRecorder readers are tracked", () => {
  test("cells follow record, stop, cancel and dispose", async () => {
    const input = new EventTarget();
    const ctx = { state: "running", currentTime: 10, getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 10_000 }) };
    const recorder = watch(new MidiRecorder(ctx as unknown as AudioContext, input as MIDIInput), touchedRecorder);
    const states: string[] = [];
    const stop = effect(() => void states.push(recorder.cells.state.value));
    const started: Array<number | null> = [];
    const stopStarted = effect(() => void started.push(recorder.cells.startedAt.value));
    const first = recorder.record();
    await recorder.stop();
    await first;
    const second = recorder.record().catch(() => {});
    recorder.cancel();
    await second;
    recorder.schedule();
    recorder.reset("stop");
    recorder.attached({
      timeline: { beatToTime: (b) => b, timeToBeat: (t) => t },
      state: { value: "stopped" },
      meter: { value: [4, 4] },
      detach() {},
    })();
    expect(recorder.cells.startsAt.value).toBeNull();
    recorder.dispose();
    stop();
    stopStarted();
    expect(states).toEqual(["idle", "recording", "idle", "recording", "idle", "disposed"]);
    expect(started).toEqual([null, 10, null, 10, null]);
  });
});

describe("MidiKeyboard readers are tracked", () => {
  test("inputs, held and sustain re-run an effect through hot-plug, keys and the pedal", async () => {
    const access = new EventTarget() as EventTarget & { inputs: Map<string, MIDIInput> };
    access.inputs = new Map();
    const piano = Object.assign(new EventTarget(), { id: "a", state: "connected" }) as unknown as MIDIInput;
    const send = (...data: number[]) => {
      const event = new Event("midimessage");
      Object.defineProperty(event, "data", { value: new Uint8Array(data) });
      piano.dispatchEvent(event);
    };
    Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => access, configurable: true });
    const keyboard = watch(
      await MidiKeyboard.open({ currentTime: 0 } as BaseAudioContext, { instrument: { noteOn() {}, noteOff() {} } }),
      touchedKeyboard,
    );
    expectTracked(
      () => keyboard.inputs.value,
      () => {
        access.inputs.set("a", piano);
        access.dispatchEvent(new Event("statechange"));
      },
    );
    expectTracked(
      () => keyboard.held.value,
      () => send(0x90, 60, 100),
    );
    expectTracked(
      () => keyboard.sustain.value,
      () => send(0xb0, 64, 127),
    );
    expect(keyboard.access).toBe(access);
    keyboard.dispose();
    delete (navigator as unknown as Record<string, unknown>).requestMIDIAccess;
  });
});

describe("every public MidiClip, MidiRecorder and MidiKeyboard member is covered", () => {
  test("MidiKeyboard", () => {
    expect(coverageGaps(MidiKeyboard, keyboardSourceModule.default, touchedKeyboard, {})).toEqual([]);
  });
  test("MidiClip", () => {
    expect(coverageGaps(MidiClip, clipSourceModule.default, touchedClip, {})).toEqual([]);
  });
  test("MidiRecorder", () => {
    expect(coverageGaps(MidiRecorder, recorderSourceModule.default, touchedRecorder, {})).toEqual([]);
  });
});
