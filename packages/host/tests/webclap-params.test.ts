import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effect } from "@audiorective/core";
import { WebClapHost } from "../src/webclap";

const info = (id: number, value: number) => ({ id, name: `p${id}`, min: 0, max: 1, defaultValue: 0, value, text: "" });

class FakeGain {
  gain = { value: 1 };
  connect() {}
  disconnect() {}
}
class FakeAudioParam {}
class FakePort {
  sent: { type: string; [key: string]: unknown }[] = [];
  onmessage?: (event: { data: unknown }) => void;
  postMessage(message: { type: string }) {
    this.sent.push(message);
    if (message.type === "load") {
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            type: "loaded",
            descriptor: { id: "x", name: "x", vendor: "", version: "", features: [] },
            params: [info(7, 0.25), info(9, 0.5)],
            hasGui: false,
            latencySamples: 48,
            audioInputs: [],
            audioOutputs: [],
          },
        }),
      );
    }
  }
  close() {}
}
class FakeNode {
  port = new FakePort();
  connect() {}
  disconnect() {}
}

describe("WebClapHost params", () => {
  beforeEach(() => {
    vi.stubGlobal("GainNode", FakeGain);
    vi.stubGlobal("AudioParam", FakeAudioParam);
    vi.stubGlobal("AudioWorkletNode", FakeNode);
    vi.stubGlobal("fetch", async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const load = async () => {
    const context = { sampleRate: 48000, currentTime: 3, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
    const host = await WebClapHost.load(context, { url: "http://localhost/bundle.wclap", workletUrl: "http://localhost/w.js" });
    const port = host.node.port as unknown as FakePort;
    port.sent.length = 0;
    return { host, port };
  };

  it("exposes CLAP parameters as reactive Params keyed by id", async () => {
    const { host } = await load();
    expect(Object.keys(host.params).sort()).toEqual(["7", "9"]);
    expect(host.params["7"].value).toBe(0.25);
    expect(host.params["7"].label).toBe("p7");
    expect(host.params["7"].max).toBe(1);
    expect(host.parameterInfo).toHaveLength(2);
    expect(host.latency.value).toBe(48);
  });

  it("forwards writes to the worklet", async () => {
    const { host, port } = await load();
    host.params["7"].value = 0.75;
    expect(port.sent).toEqual([{ type: "param", id: 7, value: 0.75 }]);
  });

  it("applies plug-in changes without echoing and notifies effects", async () => {
    const { host, port } = await load();
    const seen: number[] = [];
    effect(() => void seen.push(host.params["9"].value));
    (host.node.port as unknown as FakePort).onmessage?.({ data: { type: "paramOut", id: 9, value: 0.9, text: "" } });
    expect(host.params["9"].value).toBe(0.9);
    expect(seen).toEqual([0.5, 0.9]);
    expect(port.sent).toEqual([]);
  });

  it("rejects non-finite writes and keeps the last good value", async () => {
    const { host, port } = await load();
    expect(() => (host.params["7"].value = Number.NaN)).toThrow("WebCLAP parameter needs a finite value.");
    expect(host.params["7"].value).toBe(0.25);
    expect(port.sent).toEqual([]);
  });

  it("parameterInfo and cells.parameterInfo are tracked and follow plug-in rescans", async () => {
    const { host, port } = await load();
    const viaGetter: unknown[] = [];
    const viaCell: unknown[] = [];
    const stopGetter = effect(() => void viaGetter.push(host.parameterInfo));
    const stopCell = effect(() => void viaCell.push(host.cells.parameterInfo.value));
    port.onmessage?.({ data: { type: "params", params: [info(7, 0.6), info(9, 0.1)] } });
    stopGetter();
    stopCell();
    expect(viaGetter).toHaveLength(2);
    expect(viaCell).toHaveLength(2);
    expect(viaGetter[1]).toBe(host.parameterInfo);
    expect(host.parameterInfo[0].value).toBe(0.6);
    expect(Object.isFrozen(host.parameterInfo)).toBe(true);
    expect(host.params["7"].value).toBe(0.6);
  });

  it("a rescan updates metadata and values in one change", async () => {
    const { host, port } = await load();
    const seen: Array<[number, number]> = [];
    const stop = effect(() => void seen.push([host.parameterInfo[0].value, host.params["7"].value]));
    port.onmessage?.({ data: { type: "params", params: [info(7, 0.8), info(9, 0.5)] } });
    stop();
    expect(seen).toEqual([
      [0.25, 0.25],
      [0.8, 0.8],
    ]);
  });

  it("marks a stepped CLAP parameter with step 1 in parameterInfo and on its Param, at load and on a rescan", async () => {
    const { host, port } = await load();
    expect(host.parameterInfo[0].step).toBeUndefined();
    expect(host.params["7"].step).toBeUndefined();
    port.onmessage?.({
      data: {
        type: "params",
        params: [
          { ...info(7, 0.6), flags: 1 },
          { ...info(9, 0.1), flags: 2 },
        ],
      },
    });
    expect(host.parameterInfo.map((p) => p.step)).toEqual([1, undefined]);
  });

  it("noteOn and noteOff are the Sampler shape: velocity 0..1 becomes a MIDI byte, channel and time are carried", async () => {
    const { host, port } = await load();
    host.noteOn(60, { velocity: 1, when: 5, channel: 2 });
    host.noteOn(61);
    host.noteOn(62, { velocity: 0.5 });
    host.noteOff(60, 6);
    host.noteOff(61);
    const sent = port.sent.map((m) => [m.type, m.when, m.data]);
    expect(sent).toEqual([
      ["schedule", 5, [0x92, 60, 127]],
      ["schedule", 3, [0x90, 61, 127]],
      ["schedule", 3, [0x90, 62, 64]],
      ["schedule", 6, [0x82, 60, 0]],
      ["schedule", 3, [0x80, 61, 0]],
    ]);
  });

  it("noteOff releases a note on every channel it was started on and returns one cancellable event", async () => {
    const { host, port } = await load();
    host.noteOn(60, { channel: 1 });
    host.noteOn(60, { channel: 4 });
    port.sent.length = 0;
    const event = host.noteOff(60, 8);
    expect(port.sent.map((m) => m.data)).toEqual([
      [0x81, 60, 0],
      [0x84, 60, 0],
    ]);
    event.cancel();
    expect(port.sent.filter((m) => m.type === "cancelScheduled")).toHaveLength(2);
    port.sent.length = 0;
    host.noteOff(61, 9); // never started: channel 0
    expect(port.sent.map((m) => m.data)).toEqual([[0x80, 61, 0]]);
  });

  it("noteOn returns the cancellable event of its message", async () => {
    const { host, port } = await load();
    const event = host.noteOn(60, { when: 5 });
    const ended = vi.fn();
    event.onEnded(ended);
    port.onmessage?.({ data: { type: "executed", id: (port.sent[0] as { id: number }).id } });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("validates note, velocity and channel", async () => {
    const { host } = await load();
    expect(() => host.noteOn(128)).toThrow("WebCLAP note must be an integer 0-127.");
    expect(() => host.noteOff(-1)).toThrow("WebCLAP note must be an integer 0-127.");
    expect(() => host.noteOn(60, { velocity: 1.5 })).toThrow("WebCLAP velocity must be 0..1.");
    expect(() => host.noteOn(60, { channel: 16 })).toThrow("WebCLAP channel must be an integer 0-15.");
  });

  it("allNotesOff clears scheduled messages, sends All Notes Off on every channel and ends pending events", async () => {
    const { host, port } = await load();
    const event = host.noteOn(60, { when: 9 });
    const ended = vi.fn();
    event.onEnded(ended);
    port.sent.length = 0;
    host.allNotesOff();
    expect(port.sent[0]).toEqual({ type: "clearScheduled" });
    expect(port.sent.slice(1).map((m) => m.data)).toEqual(Array.from({ length: 16 }, (_, channel) => [0xb0 | channel, 123, 0]));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears the response timers and rejects pending saveState/loadState/mountEditor", async () => {
    vi.useFakeTimers();
    try {
      const { host } = await load();
      const save = host.saveState();
      const loadState = host.loadState(new Uint8Array([1]));
      const results = Promise.allSettled([save, loadState]);
      expect(vi.getTimerCount()).toBe(2);
      host.dispose();
      expect(vi.getTimerCount()).toBe(0);
      const settled = await results;
      for (const r of settled) {
        expect(r.status).toBe("rejected");
        expect((r as PromiseRejectedResult).reason.message).toBe("WebCLAP host is disposed.");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plug-in error message rejects pending waiters with a clear message", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { host } = await load();
      const save = host.saveState();
      const assertion = expect(save).rejects.toThrow("WebCLAP plug-in error: boom");
      (host.node.port as unknown as FakePort).onmessage?.({ data: { type: "error", message: "boom" } });
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a timed-out saveState() leaves no stale waiter: the next saveState() resolves with the next reply", async () => {
    vi.useFakeTimers();
    try {
      const { host } = await load();
      const port = host.node.port as unknown as FakePort;
      const first = host.saveState();
      const firstResult = expect(first).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      await firstResult;
      const second = host.saveState();
      port.onmessage?.({ data: { type: "state", bytes: new Uint8Array([7]).buffer } });
      await expect(second).resolves.toEqual(new Uint8Array([7]));
    } finally {
      vi.useRealTimers();
    }
  });
});
