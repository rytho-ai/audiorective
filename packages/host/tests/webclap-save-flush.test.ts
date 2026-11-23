import { beforeAll, describe, expect, it, vi } from "vitest";

type Host = {
  ready: boolean;
  params: number;
  plugin: number;
  events: { type: number; id?: number; value?: number; key?: number; velocity?: number }[];
  fn(pointer: number): (...args: unknown[]) => unknown;
  writeEvents(): void;
  saveState(): ArrayBuffer | null;
  afterMainThreadCall(): void;
  handle(message: { type: string }): Promise<void>;
  port: { postMessage(message: unknown): void };
};

let HostClass: new () => Host;

beforeAll(async () => {
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = { postMessage() {}, onmessage: null };
    },
  );
  vi.stubGlobal("registerProcessor", (_name: string, processor: new () => Host) => (HostClass = processor));
  await import("../src/webclap-worklet.js");
});

describe("WebCLAP worklet save", () => {
  it("hands queued parameters to the plug-in before saving and leaves queued notes", async () => {
    const order: string[] = [];
    const host = new HostClass();
    host.ready = true;
    host.params = 100;
    host.plugin = 1;
    const note = { type: 0, key: 60, velocity: 1 };
    host.events = [{ type: 5, id: 7, value: 0.25 }, note, { type: 5, id: 7, value: 0.75 }];
    host.writeEvents = function (this: Host) {
      order.push(`write:${this.events.map((event) => event.value).join(",")}`);
      this.events = [];
    };
    host.fn = (pointer) => () => void order.push(`call:${pointer}`);
    host.saveState = () => {
      order.push("save");
      return new ArrayBuffer(1);
    };
    await host.handle({ type: "saveState" });
    expect(order).toEqual(["write:0.25,0.75", "call:120", "save"]);
    expect(host.events).toEqual([note]);
  });
});
