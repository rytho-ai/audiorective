import { AudioProcessor, batch, cell, readonlyCell, type CancellableEvent, type Cell, type Param, type ReadonlyCell } from "@audiorective/core";

export type WebClapDescriptor = Readonly<{ id: string; name: string; vendor: string; version: string; features: readonly string[] }>;
export type WebClapParameter = Readonly<{
  id: number;
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  value: number;
  text: string;
  flags?: number;
}>;
export type WebClapBundle = Readonly<{ url: string; pluginId?: string; pluginIndex?: number; workletUrl?: string }>;
export type WebClapEvent = CancellableEvent;

type LoadedMessage = {
  type: "loaded";
  descriptor: WebClapDescriptor;
  params: WebClapParameter[];
  hasGui: boolean;
  latencySamples?: number;
  audioInputs: unknown[];
  audioOutputs: unknown[];
};
/** CLAP parameter registry: one `Param<number>` per CLAP parameter id, keyed by the id as a decimal string. */
export type WebClapParams = Record<`${number}`, Param<number>>;
type HostMessage = LoadedMessage | { type: string; [key: string]: unknown };
type Waiter<T> = { resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();

/**
 * Browser host for one WebCLAP plug-in. The audio graph sees a latency-declared processor.
 * Each CLAP parameter is a `Param<number>` in `params`, keyed by its CLAP id (`host.params["7"].value`).
 */
export class WebClapHost extends AudioProcessor<WebClapParams, { parameterInfo: ReadonlyCell<readonly WebClapParameter[]> }> {
  readonly node: AudioWorkletNode;
  readonly bundleUrl: string;
  readonly descriptor: WebClapDescriptor;
  readonly hasEditor: boolean;

  private stateWaiters: Waiter<Uint8Array>[] = [];
  private loadStateWaiters: Waiter<void>[] = [];
  private guiWaiter?: Waiter<string>;
  private editor?: HTMLIFrameElement;
  private editorListener?: (event: MessageEvent) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Set<() => void>>();
  /** Last value known to both sides, per CLAP id. Param writes equal to it are not echoed to the worklet. */
  private readonly synced: Map<number, number>;
  private readonly infoStore: Cell<readonly WebClapParameter[]>;
  private disposed = false;

  /** Tracked frozen parameter metadata (id, name, min, max, default, text) as last reported by the plug-in; the same value as `cells.parameterInfo`. Live values are in `params`. */
  get parameterInfo(): readonly WebClapParameter[] {
    return this.cells.parameterInfo.value;
  }

  private constructor(context: AudioContext, node: AudioWorkletNode, bundleUrl: string, loaded: LoadedMessage, early: HostMessage[]) {
    const synced = new Map<number, number>();
    const infoStore = cell<readonly WebClapParameter[]>(Object.freeze(loaded.params));
    super(context, ({ param }) => {
      const params: Record<string, Param<number>> = {};
      for (const info of loaded.params) {
        synced.set(info.id, info.value);
        params[String(info.id)] = param<number>({
          default: info.value,
          label: info.name,
          min: info.min,
          max: info.max,
          bind: {
            set: (value) => {
              if (!Number.isFinite(value)) {
                params[String(info.id)]!.$(synced.get(info.id) ?? info.value);
                throw new RangeError("WebCLAP parameter needs a finite value.");
              }
              if (synced.get(info.id) === value) return;
              synced.set(info.id, value);
              node.port.postMessage({ type: "param", id: info.id, value });
            },
          },
        });
      }
      return { params: params as WebClapParams, cells: { parameterInfo: readonlyCell(infoStore) }, latency: 0 };
    });
    this.synced = synced;
    this.node = node;
    this.bundleUrl = bundleUrl.replace(/\/$/, "");
    this.descriptor = loaded.descriptor;
    this.infoStore = infoStore;
    this.hasEditor = loaded.hasGui;
    this.latency.value = (loaded.latencySamples ?? 0) / context.sampleRate;
    node.port.onmessage = (event: MessageEvent<HostMessage>) => this.receive(event.data);
    for (const message of early) this.receive(message);
  }

  static async load(context: AudioContext, bundle: WebClapBundle): Promise<WebClapHost> {
    const workletUrl = bundle.workletUrl ?? new URL("./webclap-worklet.js", import.meta.url).href;
    let contextModules = modules.get(context);
    if (!contextModules) {
      contextModules = new Map();
      modules.set(context, contextModules);
    }
    let moduleLoad = contextModules.get(workletUrl);
    if (!moduleLoad) {
      moduleLoad = context.audioWorklet.addModule(workletUrl);
      contextModules.set(workletUrl, moduleLoad);
      moduleLoad.catch(() => contextModules?.delete(workletUrl));
    }
    await moduleLoad;
    const node = new AudioWorkletNode(context, "clap-host", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const bundleUrl = new URL(bundle.url, globalThis.location?.href ?? import.meta.url).href;
    // The plug-in's parameters define the `params` registry, so the host is constructed only after `loaded` arrives.
    const early: HostMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await fetch(new URL("module.wasm", `${bundleUrl.replace(/\/$/, "")}/`));
      if (!response.ok) throw new Error(`WebCLAP bundle HTTP ${response.status}.`);
      const bytes = await response.arrayBuffer();
      const loaded = new Promise<LoadedMessage>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("WebCLAP host response timed out.")), 10_000);
        node.port.onmessage = (event: MessageEvent<HostMessage>) => {
          const message = event.data;
          if (message.type === "loaded") resolve(message as LoadedMessage);
          else if (message.type === "error") reject(new Error(String(message.message)));
          else early.push(message);
        };
      });
      node.port.postMessage({ type: "load", bytes, pluginId: bundle.pluginId, pluginIndex: bundle.pluginIndex ?? 0 }, [bytes]);
      const message = await loaded;
      return new WebClapHost(context, node, bundleUrl, message, early);
    } catch (error) {
      node.port.postMessage({ type: "dispose" });
      node.disconnect();
      node.port.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get input(): AudioNode {
    return this.node;
  }
  get output(): AudioNode {
    return this.node;
  }

  scheduleMidi(data: Uint8Array | readonly number[], when: number): WebClapEvent {
    if (this.disposed || !Number.isFinite(when) || when < 0) throw new RangeError("WebCLAP MIDI needs a finite non-negative audio time.");
    const id = this.nextId++;
    const listeners = new Set<() => void>();
    this.pending.set(id, listeners);
    this.node.port.postMessage({ type: "schedule", id, when, data: [...data] });
    return {
      cancel: () => {
        if (this.pending.delete(id)) this.node.port.postMessage({ type: "cancelScheduled", id });
      },
      onEnded: (listener) => {
        if (this.pending.has(id)) listeners.add(listener);
        else listener();
      },
    };
  }

  panic(): void {
    this.node.port.postMessage({ type: "clearScheduled" });
    for (let channel = 0; channel < 16; channel++) this.node.port.postMessage({ type: "midi", data: [0xb0 | channel, 123, 0] });
    for (const listeners of this.pending.values()) for (const listener of listeners) listener();
    this.pending.clear();
  }

  async saveState(): Promise<Uint8Array> {
    const result = this.wait<Uint8Array>((waiter) => this.stateWaiters.push(waiter));
    this.node.port.postMessage({ type: "saveState" });
    return result;
  }

  async loadState(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("WebCLAP state needs bytes.");
    const expected = new Uint8Array(bytes);
    const confirmation = this.wait<void>((waiter) => this.loadStateWaiters.push(waiter));
    this.node.port.postMessage({ type: "loadState", bytes: expected.buffer }, [expected.buffer]);
    await confirmation;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (sameBytes(await this.saveState(), bytes)) return;
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
      const bytes =
        data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
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

  /** Clears every pending response timer and rejects the callers still waiting on `saveState()`, `loadState()` or `mountEditor()`. */
  private rejectWaiters(error: Error): void {
    const waiters: Waiter<never>[] = [...this.stateWaiters, ...this.loadStateWaiters, ...(this.guiWaiter ? [this.guiWaiter] : [])] as Waiter<never>[];
    this.stateWaiters = [];
    this.loadStateWaiters = [];
    this.guiWaiter = undefined;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private settle<T>(waiter: Waiter<T> | undefined, value: T): void {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  /** Plug-in -> JS: update a Param's signal without echoing the value back to the worklet. */
  private applyParam(id: number, value: number): void {
    const param = (this.params as Record<string, Param<number> | undefined>)[String(id)];
    if (!param || !Number.isFinite(value)) return;
    this.synced.set(id, value);
    param.value = value;
  }

  private receive(message: HostMessage): void {
    switch (message.type) {
      case "paramOut":
        this.applyParam(message.id as number, message.value as number);
        break;
      case "params": {
        const infos = message.params as WebClapParameter[];
        batch(() => {
          this.infoStore.value = Object.freeze(infos);
          for (const info of infos) this.applyParam(info.id, info.value);
        });
        break;
      }
      case "executed": {
        const listeners = this.pending.get(message.id as number);
        this.pending.delete(message.id as number);
        if (listeners) for (const listener of listeners) listener();
        break;
      }
      case "state":
        this.settle(this.stateWaiters.shift(), message.bytes ? new Uint8Array(message.bytes as ArrayBuffer) : new Uint8Array());
        break;
      case "stateLoaded":
        this.settle(this.loadStateWaiters.shift(), undefined);
        break;
      case "gui":
        if (typeof message.uri === "string") {
          this.settle(this.guiWaiter, message.uri);
          this.guiWaiter = undefined;
        }
        break;
      case "send": {
        const bytes = message.bytes as ArrayBuffer;
        this.editor?.contentWindow?.postMessage(bytes, new URL(this.bundleUrl, document.baseURI).origin, [bytes]);
        break;
      }
      case "error": {
        const error = new Error(String(message.message));
        console.error(error);
        this.rejectWaiters(new Error(`WebCLAP plug-in error: ${error.message}`));
        break;
      }
    }
  }

  override destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectWaiters(new Error("WebCLAP host is destroyed."));
    if (this.editor) this.unmountEditor();
    this.panic();
    this.node.port.postMessage({ type: "dispose" });
    this.node.disconnect();
    this.node.port.close();
    super.destroy();
  }
}
