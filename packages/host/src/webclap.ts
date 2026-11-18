import { AudioProcessor } from "@audiorective/core";

export type WebClapDescriptor = Readonly<{ id: string; name: string; vendor: string; version: string; features: readonly string[] }>;
export type WebClapParameter = Readonly<{ id: number; name: string; min: number; max: number; defaultValue: number; value: number; text: string }>;
export type WebClapBundle = Readonly<{ url: string; pluginIndex?: number; workletUrl?: string }>;
export type WebClapEvent = { cancel(): void; onEnded(listener: () => void): void };

type LoadedMessage = {
  type: "loaded";
  descriptor: WebClapDescriptor;
  params: WebClapParameter[];
  hasGui: boolean;
  latencySamples?: number;
  audioInputs: unknown[];
  audioOutputs: unknown[];
};
type HostMessage = LoadedMessage | { type: string; [key: string]: unknown };
type Waiter<T> = { resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();

/** Browser host for one WebCLAP plug-in. The audio graph sees a latency-declared processor. */
export class WebClapHost extends AudioProcessor<Record<never, never>, Record<never, never>> {
  readonly node: AudioWorkletNode;
  readonly bundleUrl: string;
  descriptor?: WebClapDescriptor;
  parameters: readonly WebClapParameter[] = [];
  hasEditor = false;

  private loaded?: Waiter<void>;
  private stateWaiters: Waiter<Uint8Array>[] = [];
  private loadStateWaiters: Waiter<void>[] = [];
  private guiWaiter?: Waiter<string>;
  private editor?: HTMLIFrameElement;
  private editorListener?: (event: MessageEvent) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Set<() => void>>();
  private disposed = false;

  private constructor(context: AudioContext, node: AudioWorkletNode, bundleUrl: string) {
    super(context, () => ({ params: {}, cells: {}, latency: 0 }));
    this.node = node;
    this.bundleUrl = bundleUrl.replace(/\/$/, "");
    node.port.onmessage = (event: MessageEvent<HostMessage>) => this.receive(event.data);
  }

  static async load(context: AudioContext, bundle: WebClapBundle): Promise<WebClapHost> {
    const workletUrl = bundle.workletUrl ?? new URL("./webclap-worklet.js", import.meta.url).href;
    let contextModules = modules.get(context);
    if (!contextModules) { contextModules = new Map(); modules.set(context, contextModules); }
    let moduleLoad = contextModules.get(workletUrl);
    if (!moduleLoad) {
      moduleLoad = context.audioWorklet.addModule(workletUrl);
      contextModules.set(workletUrl, moduleLoad);
      moduleLoad.catch(() => contextModules?.delete(workletUrl));
    }
    await moduleLoad;
    const node = new AudioWorkletNode(context, "clap-host", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const host = new WebClapHost(context, node, new URL(bundle.url, globalThis.location?.href ?? import.meta.url).href);
    try {
      const response = await fetch(new URL("module.wasm", `${host.bundleUrl}/`));
      if (!response.ok) throw new Error(`WebCLAP bundle HTTP ${response.status}.`);
      const bytes = await response.arrayBuffer();
      const ready = host.wait<void>((waiter) => (host.loaded = waiter));
      node.port.postMessage({ type: "load", bytes, pluginIndex: bundle.pluginIndex ?? 0 }, [bytes]);
      await ready;
      return host;
    } catch (error) {
      host.destroy();
      throw error;
    }
  }

  get input(): AudioNode { return this.node; }
  get output(): AudioNode { return this.node; }

  scheduleMidi(data: Uint8Array | readonly number[], when: number): WebClapEvent {
    if (this.disposed || !Number.isFinite(when) || when < 0) throw new RangeError("WebCLAP MIDI needs a finite non-negative audio time.");
    const id = this.nextId++;
    const listeners = new Set<() => void>();
    this.pending.set(id, listeners);
    this.node.port.postMessage({ type: "schedule", id, when, data: [...data] });
    return {
      cancel: () => { if (this.pending.delete(id)) this.node.port.postMessage({ type: "cancelScheduled", id }); },
      onEnded: (listener) => { if (this.pending.has(id)) listeners.add(listener); else listener(); },
    };
  }

  panic(): void {
    this.node.port.postMessage({ type: "clearScheduled" });
    for (let channel = 0; channel < 16; channel++) this.node.port.postMessage({ type: "midi", data: [0xb0 | channel, 123, 0] });
    for (const listeners of this.pending.values()) for (const listener of listeners) listener();
    this.pending.clear();
  }

  setParameter(id: number, value: number): void {
    if (!Number.isFinite(value)) throw new RangeError("WebCLAP parameter needs a finite value.");
    this.node.port.postMessage({ type: "param", id, value });
  }

  async getState(): Promise<Uint8Array> {
    const result = this.wait<Uint8Array>((waiter) => this.stateWaiters.push(waiter));
    this.node.port.postMessage({ type: "saveState" });
    return result;
  }

  async setState(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("WebCLAP state needs bytes.");
    const expected = new Uint8Array(bytes);
    const confirmation = this.wait<void>((waiter) => this.loadStateWaiters.push(waiter));
    this.node.port.postMessage({ type: "loadState", bytes: expected.buffer }, [expected.buffer]);
    await confirmation;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (sameBytes(await this.getState(), bytes)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("WebCLAP state did not settle after load.");
  }

  async mountEditor(frame: HTMLIFrameElement): Promise<() => void> {
    if (!this.hasEditor) throw new Error("WebCLAP plug-in has no editor.");
    if (this.editor) throw new Error("WebCLAP editor is already mounted.");
    this.editor = frame;
    const origin = new URL(this.bundleUrl, document.baseURI).origin;
    this.editorListener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data;
      const bytes = data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
      if (bytes) this.node.port.postMessage({ type: "receive", bytes }, [bytes]);
    };
    window.addEventListener("message", this.editorListener);
    try {
      const gui = this.wait<string>((waiter) => (this.guiWaiter = waiter));
      this.node.port.postMessage({ type: "openGui" });
      const uri = await gui;
      frame.src = new URL(uri.replace(/^\//, ""), `${this.bundleUrl}/`).href;
    } catch (error) {
      this.unmountEditor();
      throw error;
    }
    return () => this.unmountEditor();
  }

  private unmountEditor(): void {
    if (this.editorListener) window.removeEventListener("message", this.editorListener);
    this.editorListener = undefined;
    if (this.editor) this.editor.removeAttribute("src");
    this.editor = undefined;
    this.node.port.postMessage({ type: "closeGui" });
  }

  private wait<T>(register: (waiter: Waiter<T>) => void): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("WebCLAP host is destroyed."));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject, timer: setTimeout(() => reject(new Error("WebCLAP host response timed out.")), 10_000) };
      register(waiter);
    });
  }

  private settle<T>(waiter: Waiter<T> | undefined, value: T): void {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  private receive(message: HostMessage): void {
    switch (message.type) {
      case "loaded": {
        const loaded = message as LoadedMessage;
        this.descriptor = loaded.descriptor;
        this.parameters = Object.freeze(loaded.params);
        this.hasEditor = loaded.hasGui;
        this.latency.value = (loaded.latencySamples ?? 0) / this.context.sampleRate;
        this.settle(this.loaded, undefined); this.loaded = undefined;
        break;
      }
      case "executed": {
        const listeners = this.pending.get(message.id as number);
        this.pending.delete(message.id as number);
        if (listeners) for (const listener of listeners) listener();
        break;
      }
      case "state": this.settle(this.stateWaiters.shift(), message.bytes ? new Uint8Array(message.bytes as ArrayBuffer) : new Uint8Array()); break;
      case "stateLoaded": this.settle(this.loadStateWaiters.shift(), undefined); break;
      case "gui": if (typeof message.uri === "string") { this.settle(this.guiWaiter, message.uri); this.guiWaiter = undefined; } break;
      case "send": {
        const bytes = message.bytes as ArrayBuffer;
        this.editor?.contentWindow?.postMessage(bytes, new URL(this.bundleUrl, document.baseURI).origin, [bytes]);
        break;
      }
      case "error": {
        const error = new Error(String(message.message));
        if (this.loaded) { clearTimeout(this.loaded.timer); this.loaded.reject(error); this.loaded = undefined; }
        else console.error(error);
        break;
      }
    }
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.editor) this.unmountEditor();
    this.panic();
    this.node.port.postMessage({ type: "dispose" });
    this.node.disconnect();
    this.node.port.close();
    super.destroy();
  }
}
