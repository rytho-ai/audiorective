import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { effect } from "@audiorective/core";
import { MidiKeyboard, MidiRecorder } from "../src/web";
import type { Instrument } from "../src";

class MockInput extends EventTarget {
  state = "connected";
  constructor(readonly id: string) {
    super();
  }
  send(...data: number[]) {
    const event = new Event("midimessage");
    Object.defineProperties(event, { data: { value: new Uint8Array(data) }, timeStamp: { value: performance.now() } });
    this.dispatchEvent(event);
  }
}
class MockAccess extends EventTarget {
  inputs = new Map<string, MockInput>();
  plug(input: MockInput) {
    this.inputs.set(input.id, input);
    this.dispatchEvent(new Event("statechange"));
  }
  unplug(input: MockInput) {
    input.state = "disconnected";
    this.inputs.delete(input.id);
    this.dispatchEvent(new Event("statechange"));
  }
}

let access: MockAccess;
let now = 5;
const context = {
  get currentTime() {
    return now;
  },
} as unknown as BaseAudioContext;
const original = Object.getOwnPropertyDescriptor(navigator, "requestMIDIAccess");
beforeEach(() => {
  access = new MockAccess();
  now = 5;
  Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => access, configurable: true });
});
afterEach(() => {
  if (original) Object.defineProperty(navigator, "requestMIDIAccess", original);
  else delete (navigator as unknown as Record<string, unknown>).requestMIDIAccess;
});

function instrument() {
  const log: string[] = [];
  const inst: Instrument = {
    noteOn: (note, options) => void log.push(`on ${note} v${options?.velocity?.toFixed(3)} c${options?.channel} @${options?.when}`),
    noteOff: (note, when) => void log.push(`off ${note} @${when}`),
  };
  return { inst, log };
}
const open = (inst: Instrument, options: { sustain?: boolean; signal?: AbortSignal } = {}) =>
  MidiKeyboard.open(context, { instrument: inst, ...options });

describe("MidiKeyboard", () => {
  test("decodes note-on, note-off and velocity-0 note-on with velocity / 127, on any channel, at the current audio time", async () => {
    const { inst, log } = instrument();
    const piano = new MockInput("a");
    access.inputs.set("a", piano);
    const keyboard = await open(inst);
    piano.send(0x90, 60, 127);
    now = 5.5;
    piano.send(0x93, 64, 64);
    expect(keyboard.held.value).toEqual([60, 64]);
    now = 6;
    piano.send(0x80, 60, 0);
    piano.send(0x93, 64, 0); // velocity 0 note-on releases
    piano.send(0xe0, 0, 64); // pitch bend is ignored
    piano.send(0xb0, 1, 99); // mod wheel is ignored
    piano.send(0x80, 70, 0); // a key never pressed is ignored
    expect(log).toEqual(["on 60 v1.000 c0 @5", "on 64 v0.504 c3 @5.5", "off 60 @6", "off 64 @6"]);
    expect(keyboard.held.value).toEqual([]);
    expect(keyboard.inputs.value).toEqual([piano]);
    keyboard.dispose();
  });

  test("the sustain pedal (CC 64 >= 64) holds released keys until it lifts", async () => {
    const { inst, log } = instrument();
    const piano = new MockInput("a");
    access.inputs.set("a", piano);
    const keyboard = await open(inst);
    const sustains: boolean[] = [];
    const stop = effect(() => void sustains.push(keyboard.sustain.value));
    piano.send(0x90, 60, 100);
    piano.send(0xb0, 64, 127);
    piano.send(0x80, 60, 0);
    expect(log).toEqual(["on 60 v0.787 c0 @5"]);
    expect(keyboard.held.value).toEqual([60]);
    expect(keyboard.sustain.value).toBe(true);
    now = 7;
    piano.send(0xb0, 64, 63);
    expect(log.at(-1)).toBe("off 60 @7");
    expect(keyboard.held.value).toEqual([]);
    expect(sustains).toEqual([false, true, false]);
    stop();
    keyboard.dispose();
  });

  test("sustain: false ignores the pedal", async () => {
    const { inst, log } = instrument();
    const piano = new MockInput("a");
    access.inputs.set("a", piano);
    const keyboard = await open(inst, { sustain: false });
    piano.send(0x90, 60, 100);
    piano.send(0xb0, 64, 127);
    piano.send(0x80, 60, 0);
    expect(log.at(-1)).toBe("off 60 @5");
    expect(keyboard.sustain.value).toBe(false);
    keyboard.dispose();
  });

  test("an input plugged in later joins; unplugging an input releases its held and sustained notes", async () => {
    const { inst, log } = instrument();
    const keyboard = await open(inst);
    expect(keyboard.inputs.value).toEqual([]);
    const first = new MockInput("a");
    access.plug(first);
    const second = new MockInput("b");
    access.plug(second);
    expect(keyboard.inputs.value).toEqual([first, second]);
    first.send(0x90, 60, 100);
    second.send(0x90, 62, 100);
    second.send(0xb0, 64, 127);
    second.send(0x80, 62, 0); // sustained on the second input
    second.send(0x90, 65, 100);
    expect(keyboard.held.value).toEqual([60, 62, 65]);
    now = 8;
    access.unplug(second);
    expect(log.slice(-2).sort()).toEqual(["off 62 @8", "off 65 @8"]);
    expect(keyboard.held.value).toEqual([60]);
    expect(keyboard.sustain.value).toBe(false);
    expect(keyboard.inputs.value).toEqual([first]);
    second.send(0x90, 70, 100); // the unplugged input is no longer listened to
    expect(log.some((entry) => entry.startsWith("on 70"))).toBe(false);
    keyboard.dispose();
  });

  test("dispose releases every held note and removes the listeners; twice is safe", async () => {
    const { inst, log } = instrument();
    const piano = new MockInput("a");
    access.inputs.set("a", piano);
    const keyboard = await open(inst);
    piano.send(0x90, 60, 100);
    piano.send(0x90, 61, 100);
    now = 9;
    keyboard[Symbol.dispose]();
    keyboard.dispose();
    expect(log.slice(-2).sort()).toEqual(["off 60 @9", "off 61 @9"]);
    expect(keyboard.held.value).toEqual([]);
    expect(keyboard.inputs.value).toEqual([]);
    const count = log.length;
    piano.send(0x90, 62, 100);
    access.plug(new MockInput("c"));
    expect(log).toHaveLength(count);
  });

  test("an aborted signal disposes the keyboard", async () => {
    const { inst, log } = instrument();
    const piano = new MockInput("a");
    access.inputs.set("a", piano);
    const controller = new AbortController();
    const keyboard = await open(inst, { signal: controller.signal });
    piano.send(0x90, 60, 100);
    controller.abort();
    expect(log.at(-1)).toBe("off 60 @5");
    expect(keyboard.held.value).toEqual([]);
  });

  test("open rejects with the DOMException of requestMIDIAccess and needs an instrument", async () => {
    Object.defineProperty(navigator, "requestMIDIAccess", {
      value: async () => {
        throw new DOMException("denied", "NotAllowedError");
      },
      configurable: true,
    });
    await expect(open(instrument().inst)).rejects.toMatchObject({ name: "NotAllowedError" });
    await expect(MidiKeyboard.open(context, {} as never)).rejects.toThrow("MidiKeyboard needs an instrument.");
    Object.defineProperty(navigator, "requestMIDIAccess", { value: undefined, configurable: true });
    await expect(open(instrument().inst)).rejects.toMatchObject({ name: "NotSupportedError" });
  });

  test("access: null is on-screen only and never asks for permission", async () => {
    const asked = vi.fn();
    Object.defineProperty(navigator, "requestMIDIAccess", { value: asked, configurable: true });
    const { inst, log } = instrument();
    const keyboard = await open(inst, { access: null });
    expect(asked).not.toHaveBeenCalled();
    expect(keyboard.access).toBeNull();
    expect(keyboard.inputs.value).toEqual([]);
    keyboard.dispose();
    expect(log).toEqual([]);
  });

  test("press, release and setSustain take the hardware path: instrument at `when`, held and sustain cells, sustain deferral", async () => {
    const { inst, log } = instrument();
    const keyboard = await open(inst, { access: null });
    keyboard.press(60, { velocity: 0.5, when: 5.25, channel: 2 });
    keyboard.press(64);
    expect(log).toEqual(["on 60 v0.504 c2 @5.25", "on 64 v1.000 c0 @5"]);
    expect(keyboard.held.value).toEqual([60, 64]);
    keyboard.setSustain(true);
    expect(keyboard.sustain.value).toBe(true);
    keyboard.release(60, 6);
    expect(log.at(-1)).toBe("on 64 v1.000 c0 @5");
    expect(keyboard.held.value).toEqual([60, 64]);
    now = 7;
    keyboard.setSustain(false, 7.5);
    expect(log.slice(-1)).toEqual(["off 60 @7.5"]);
    expect(keyboard.sustain.value).toBe(false);
    expect(keyboard.held.value).toEqual([64]);
    keyboard.release(64, 8);
    expect(log.at(-1)).toBe("off 64 @8");
    expect(keyboard.held.value).toEqual([]);
    keyboard.release(99); // never pressed: ignored
    keyboard.dispose();
  });

  test("on-screen keys and sustain: false", async () => {
    const { inst, log } = instrument();
    const keyboard = await open(inst, { access: null, sustain: false });
    keyboard.press(60);
    keyboard.setSustain(true);
    keyboard.release(60, 6);
    expect(log.at(-1)).toBe("off 60 @6");
    expect(keyboard.sustain.value).toBe(false);
    keyboard.press(61);
    keyboard.dispose();
    expect(log.at(-1)).toBe("off 61 @5");
    keyboard.press(62); // after dispose: ignored
    expect(log.at(-1)).toBe("off 61 @5");
  });

  test("press validates note, velocity and channel", async () => {
    const keyboard = await open(instrument().inst, { access: null });
    expect(() => keyboard.press(128)).toThrow("MidiKeyboard note must be an integer 0-127.");
    expect(() => keyboard.release(-1)).toThrow("MidiKeyboard note must be an integer 0-127.");
    expect(() => keyboard.press(60, { velocity: 2 })).toThrow("MidiKeyboard velocity must be 0..1.");
    expect(() => keyboard.press(60, { channel: 16 })).toThrow("MidiKeyboard channel must be an integer 0-15.");
    keyboard.dispose();
  });

  test("a recorder records the keyboard: on-screen keys and hardware together", async () => {
    const { inst } = instrument();
    const piano = new MockInput("a");
    access.inputs.set("a", piano);
    const keyboard = await open(inst);
    let time = 10;
    const ctx = { state: "running", currentTime: time, getOutputTimestamp: () => ({ contextTime: time, performanceTime: time * 1000 }) };
    vi.spyOn(performance, "now").mockImplementation(() => time * 1000);
    const recorder = new MidiRecorder(ctx as unknown as AudioContext, keyboard);
    const take = recorder.record();
    keyboard.press(60, { velocity: 1 });
    time = 10.5;
    ctx.currentTime = time;
    keyboard.release(60);
    piano.send(0x90, 64, 127);
    time = 11;
    ctx.currentTime = time;
    await recorder.stop();
    const result = await take;
    expect(result.notes.map((n) => [n.pitch, +n.start.toFixed(3), +n.duration.toFixed(3)])).toEqual([
      [60, 0, 1],
      [64, 1, 1],
    ]);
    vi.restoreAllMocks();
    keyboard.dispose();
  });
});
