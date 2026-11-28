import { beforeAll, describe, expect, it, vi } from "vitest";

type Host = {
  readonly view: DataView;
  ramps: Map<number, unknown>;
  paramValues: Map<number, number>;
  events: { id?: number; value?: number }[];
  port: { postMessage(message: { type: string; id?: number; value?: number }): void };
  valueText(id: number, value: number): string;
  rampEvents(): void;
  outputEvent(pointer: number): void;
  handle(message: unknown): Promise<void>;
};

let HostClass: new () => Host;

beforeAll(async () => {
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = { postMessage() {}, onmessage: null };
    },
  );
  vi.stubGlobal("sampleRate", 48_000);
  vi.stubGlobal("registerProcessor", (_name: string, processor: new () => Host) => (HostClass = processor));
  await import("../src/webclap-worklet.js");
});

/** A host with a 1 s ramp of parameter 7 from 0 to 1, and a way to hand it the plug-in's output parameter events. */
async function rampingHost() {
  const host = new HostClass();
  const reported: { id?: number; value?: number }[] = [];
  host.port = { postMessage: (message) => message.type === "paramOut" && reported.push({ id: message.id, value: message.value }) };
  host.valueText = () => "";
  const memory = new ArrayBuffer(64);
  const view = new DataView(memory);
  Object.defineProperty(host, "view", { get: () => view });
  host.paramValues.set(7, 0);
  await host.handle({ type: "param", id: 7, value: 1, ramp: 1, from: 0 });
  const output = (value: number) => {
    view.setUint16(8, 0, true);
    view.setUint16(10, 5, true);
    view.setUint32(16, 7, true);
    view.setFloat64(40, value, true);
    host.outputEvent(0);
  };
  return { host, reported, output };
}

describe("WebCLAP worklet parameter ramps", () => {
  it("does not report the plug-in's echo of the ramp's own steps", async () => {
    const { host, reported, output } = await rampingHost();
    host.rampEvents();
    for (const event of host.events) output(event.value!);
    expect(host.events.length).toBeGreaterThan(0);
    expect(reported).toEqual([]);
    expect(host.ramps.has(7)).toBe(true);
  });

  it("a change of the plug-in's own while ramping cancels the ramp and is reported", async () => {
    const { host, reported, output } = await rampingHost();
    host.rampEvents();
    output(0.9);
    expect(reported).toEqual([{ id: 7, value: 0.9 }]);
    expect(host.ramps.has(7)).toBe(false);
    expect(host.paramValues.get(7)).toBe(0.9);
    // The ramp is over: it sends nothing more.
    host.events.length = 0;
    host.rampEvents();
    expect(host.events).toEqual([]);
  });
});
