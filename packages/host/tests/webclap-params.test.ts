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
    const context = { sampleRate: 48000, destination: {}, audioWorklet: { addModule: async () => {} } } as unknown as AudioContext;
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
    expect(host.latency.value).toBeCloseTo(48 / 48000);
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

  it("destroy() clears the response timers and rejects pending saveState/loadState/mountEditor", async () => {
    vi.useFakeTimers();
    try {
      const { host } = await load();
      const save = host.saveState();
      const loadState = host.loadState(new Uint8Array([1]));
      const results = Promise.allSettled([save, loadState]);
      expect(vi.getTimerCount()).toBe(2);
      host.destroy();
      expect(vi.getTimerCount()).toBe(0);
      const settled = await results;
      for (const r of settled) {
        expect(r.status).toBe("rejected");
        expect((r as PromiseRejectedResult).reason.message).toBe("WebCLAP host is destroyed.");
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
});
