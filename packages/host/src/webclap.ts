import {
  AudioProcessor,
  batch,
  cell,
  readonlyCell,
  type CancellableEvent,
  type Cell,
  type Param,
  type ReadonlyCell,
  type ValueRange,
} from "@audiorective/core";

export type WebClapDescriptor = Readonly<{ id: string; name: string; vendor: string; version: string; features: readonly string[] }>;
/** The CLAP wire shape: numeric `id`, `name` and `defaultValue` differ from `ParamSpec`, so only the range is shared. */
export type WebClapParameter = ValueRange &
  Readonly<{
    id: number;
    name: string;
    defaultValue: number;
    value: number;
    text: string;
    flags?: number;
    /** Editing granularity: 1 when the plug-in marks the parameter stepped (`CLAP_PARAM_IS_STEPPED`, flag bit 0), else absent (continuous). */
    step?: number;
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

const withStep = (info: WebClapParameter): WebClapParameter =>
  info.flags !== undefined && info.flags & 1 && info.step === undefined ? { ...info, step: 1 } : info;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();

/**
 * Browser host for one WebCLAP plug-in: an AudioProcessor (`host.connect(context.destination)`) that plays notes with the `Sampler` shape (`noteOn(note, { velocity, when })`, `noteOff(note, when)`), so a `MidiClip` or `MidiKeyboard` takes it as `instrument`.
 * Each CLAP parameter is a `Param<number>` in `params`, keyed by its CLAP id (`host.params["7"].value`); writes reach the plug-in and the plug-in's own changes update the Param.
 */
export class WebClapHost extends AudioProcessor<WebClapParams, { parameterInfo: ReadonlyCell<readonly WebClapParameter[]> }> {
  readonly node: AudioWorkletNode;
  readonly bundleUrl: string;
  readonly descriptor: WebClapDescriptor;
  readonly hasEditor: boolean;

  private stateWaiters: Waiter<Uint8Array>[] = [];
  private loadStateWaiters: Waiter<void>[] = [];
  private syncWaiters: Waiter<void>[] = [];
  private guiWaiter?: Waiter<string>;
  private editor?: HTMLIFrameElement;
  private editorListener?: (event: MessageEvent) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Set<() => void>>();
  /** Last value known to both sides, per CLAP id. Param writes equal to it are not echoed to the worklet. */
  private readonly synced: Map<number, number>;
  private readonly infoStore: Cell<readonly WebClapParameter[]>;
  /** Channels each sounding note was started on, so `noteOff(note)` releases it where it plays. */
  private readonly noteChannels = new Map<number, Map<number, object>>();
  private disposed = false;

  /** Tracked frozen parameter metadata in the plug-in's order (id, name, min, max, default, text, step); `host.params[String(info.id)]` is its live Param. Last reported by the plug-in; the same value as `cells.parameterInfo`. Live values are in `params`. */
  get parameterInfo(): readonly WebClapParameter[] {
    return this.cells.parameterInfo.value;
  }

  private constructor(context: AudioContext, node: AudioWorkletNode, bundleUrl: string, loaded: LoadedMessage, early: HostMessage[]) {
    const synced = new Map<number, number>();
    const loadedParams = loaded.params.map(withStep);
    const infoStore = cell<readonly WebClapParameter[]>(Object.freeze(loadedParams));
    super(context, ({ param }) => {
      const params: Record<string, Param<number>> = {};
      for (const info of loadedParams) {
        synced.set(info.id, info.value);
        params[String(info.id)] = param<number>({
          default: info.value,
          label: info.name,
          min: info.min,
          max: info.max,
          step: info.step,
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
    this.latency.value = loaded.latencySamples ?? 0;
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
        timer = setTimeout(() => reject(new DOMException("WebCLAP host response timed out.", "TimeoutError")), 10_000);
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

  /** Plays `note` (0-127) at `when` (audio seconds, default now) with `velocity` 0..1 (default 1) on `channel` 0-15 (default 0), sent as a MIDI note-on. */
  noteOn(note: number, options: Readonly<{ velocity?: number; when?: number; channel?: number }> = {}): WebClapEvent {
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new RangeError("WebCLAP note must be an integer 0-127.");
    const velocity = options.velocity ?? 1;
    if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1) throw new RangeError("WebCLAP velocity must be 0..1.");
    const channel = options.channel ?? 0;
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) throw new RangeError("WebCLAP channel must be an integer 0-15.");
    const event = this.scheduleMidi([0x90 | channel, note, Math.max(1, Math.round(velocity * 127))], options.when ?? this.context.currentTime);
    const channels = this.noteChannels.get(note) ?? new Map<number, object>();
    channels.set(channel, {});
    this.noteChannels.set(note, channels);
    return event;
  }

  /** Releases `note` at `when` (audio seconds, default now) on every channel it was started on. */
  noteOff(note: number, when: number = this.context.currentTime): WebClapEvent {
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new RangeError("WebCLAP note must be an integer 0-127.");
    const channels = this.noteChannels.get(note) ?? new Map([[0, {}]]);
    const events = [...channels].map(([channel, owner]) => {
      const event = this.scheduleMidi([0x80 | channel, note, 0], when);
      event.onEnded(() => {
        const current = this.noteChannels.get(note);
        // Scheduling or cancelling an off does not release its channel; executing it does.
        // An older off must also leave a later note-on's ownership intact.
        if (current?.get(channel) !== owner) return;
        current.delete(channel);
        if (!current.size) this.noteChannels.delete(note);
      });
      return event;
    });
    if (events.length === 1) return events[0]!;
    return {
      cancel: () => events.forEach((event) => event.cancel()),
      onEnded: (listener) => {
        let left = events.length;
        for (const event of events) event.onEnded(() => --left === 0 && listener());
      },
    };
  }

  /** Sends raw MIDI bytes other than notes (controllers, program change) at `when`; `noteOn` and `noteOff` play notes. */
  scheduleMidi(data: Uint8Array | readonly number[], when: number): WebClapEvent {
    if (this.disposed) throw new DOMException("WebCLAP MIDI needs a finite non-negative audio time.", "InvalidStateError");
    if (!Number.isFinite(when) || when < 0) throw new RangeError("WebCLAP MIDI needs a finite non-negative audio time.");
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

  /** Releases every sounding note now (MIDI All Notes Off on every channel) and drops scheduled messages not yet played. */
  allNotesOff(): void {
    this.noteChannels.clear();
    this.node.port.postMessage({ type: "clearScheduled" });
    for (let channel = 0; channel < 16; channel++) this.node.port.postMessage({ type: "midi", data: [0xb0 | channel, 123, 0] });
    for (const listeners of this.pending.values()) for (const listener of listeners) listener();
    this.pending.clear();
  }

  /** @internal Resolves once the worklet has handled every message posted before this call, without calling into the plug-in. */
  messagesHandled(): Promise<void> {
    const result = this.wait<void>((waiter) => this.syncWaiters.push(waiter));
    this.node.port.postMessage({ type: "sync" });
    return result;
  }

  async saveState(): Promise<Uint8Array> {
    return this.readState(false);
  }

  private readState(withParams: boolean): Promise<Uint8Array> {
    const result = this.wait<Uint8Array>((waiter) => this.stateWaiters.push(waiter));
    this.node.port.postMessage({ type: "saveState", withParams });
    return result;
  }

  async loadState(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("WebCLAP state needs bytes.");
    const expected = new Uint8Array(bytes);
    const confirmation = this.wait<void>((waiter) => this.loadStateWaiters.push(waiter));
    this.node.port.postMessage({ type: "loadState", bytes: expected.buffer, settle: this.context.state !== "running" }, [expected.buffer]);
    await confirmation;
    for (let attempt = 0; attempt < 10; attempt++) {
      // The plug-in may report its loaded parameters only once the state has applied.
      if (sameBytes(await this.readState(true), bytes)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new DOMException("WebCLAP state did not settle after load.", "TimeoutError");
  }

  async mountEditor(frame: HTMLIFrameElement): Promise<() => void> {
    if (!this.hasEditor) throw new Error("WebCLAP plug-in has no editor.");
    if (this.editor) throw new DOMException("WebCLAP editor is already mounted.", "InvalidStateError");
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
    if (this.disposed) return Promise.reject(new DOMException("WebCLAP host is disposed.", "InvalidStateError"));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // Drop the dead waiter, or the next reply would settle it instead of the next real caller.
          this.dropWaiter(waiter);
          reject(new DOMException("WebCLAP host response timed out.", "TimeoutError"));
        }, 10_000),
      };
      register(waiter);
    });
  }

  private dropWaiter(waiter: Waiter<never> | Waiter<unknown>): void {
    this.stateWaiters = this.stateWaiters.filter((w) => w !== waiter);
    this.loadStateWaiters = this.loadStateWaiters.filter((w) => w !== waiter);
    this.syncWaiters = this.syncWaiters.filter((w) => w !== waiter);
    if (this.guiWaiter === waiter) this.guiWaiter = undefined;
  }

  /** Clears every pending response timer and rejects the callers still waiting on `saveState()`, `loadState()` or `mountEditor()`. */
  private rejectWaiters(error: Error): void {
    const waiters: Waiter<never>[] = [
      ...this.stateWaiters,
      ...this.loadStateWaiters,
      ...this.syncWaiters,
      ...(this.guiWaiter ? [this.guiWaiter] : []),
    ] as Waiter<never>[];
    this.stateWaiters = [];
    this.loadStateWaiters = [];
    this.syncWaiters = [];
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
        const infos = (message.params as WebClapParameter[]).map(withStep);
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
      case "synced":
        this.settle(this.syncWaiters.shift(), undefined);
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

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectWaiters(new DOMException("WebCLAP host is disposed.", "InvalidStateError"));
    if (this.editor) this.unmountEditor();
    this.allNotesOff();
    this.node.port.postMessage({ type: "dispose" });
    this.node.disconnect();
    this.node.port.close();
    super.dispose();
  }
}
