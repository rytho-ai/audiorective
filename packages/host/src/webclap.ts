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

export type WebClapDescriptor = Readonly<{
  /** Stable CLAP plug-in identifier, distinct from a bundle URL or slot index. */
  id: string;
  /** Human-readable plug-in display text supplied by its descriptor. */
  name: string;
  /** Vendor text supplied by the plug-in descriptor; may be empty. */
  vendor: string;
  /** Plug-in-reported version text; no semantic-version parsing is imposed. */
  version: string;
  /** CLAP feature identifiers advertised by the plug-in; may be empty. */
  features: readonly string[];
}>;
/** The CLAP wire shape: numeric `id`, `name` and `defaultValue` differ from `ParamSpec`, so only the range is shared. */
export type WebClapParameter = ValueRange &
  Readonly<{
    /** Numeric CLAP parameter identifier; registry keys use its decimal string form. */
    id: number;
    /** Human-readable control text supplied by the plug-in. */
    name: string;
    /** Plug-in's initial amount in its native parameter units, within min..max. */
    defaultValue: number;
    /** Current amount in the plug-in's native parameter units, within min..max. */
    value: number;
    /** Plug-in-formatted current value; may include units or an enumerated choice. */
    text: string;
    /** Optional CLAP parameter bitmask; bit 0 marks stepped values. */
    flags?: number;
    /** Editing granularity: 1 when the plug-in marks the parameter stepped (`CLAP_PARAM_IS_STEPPED`, flag bit 0), else absent (continuous). */
    step?: number;
  }>;
export type WebClapBundle = Readonly<{
  /** URL of the WebCLAP bundle to load; resolved by the browser. */
  url: string;
  /** Optional CLAP identifier to select from the bundle; takes precedence over pluginIndex. */
  pluginId?: string;
  /** Zero-based plug-in slot within the bundle; defaults to 0. */
  pluginIndex?: number;
  /** Optional processor-worklet URL override; omitted to use the host's bundled worklet. */
  workletUrl?: string;
}>;
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
/**
 * `host.params`: a literal id (`params["7"]`) is a `Param<number>`; an id held in a `string` or `number` variable (`params[info.id]`) is `Param<number> | undefined`, because the plug-in may not have it.
 * (`WebClapParams` stays the processor's registry type: a core registry cannot carry a string index signature.)
 */
export type WebClapParamAccess = WebClapParams & {
  readonly [id: string]: Param<number> | undefined;
  readonly [id: number]: Param<number> | undefined;
};
type HostMessage = LoadedMessage | { type: string; [key: string]: unknown };
type Waiter<T> = { resolve(value: T): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Seconds a continuous parameter takes to move to a new value while the context runs: long enough for no step to be heard, short enough to feel immediate. */
const PARAM_RAMP_SECONDS = 0.02;
/** `CLAP_PARAM_IS_ENUM`: a stepped parameter whose values are choices, not amounts. */
const ENUM_FLAG = 1 << 16;
/** Fewest distinct values a stepped parameter needs to be moved through its values instead of jumped: 128 is a 7-bit control, which is fine enough to hear as continuous. */
const RAMP_MIN_VALUES = 128;
/** Whether a change of this parameter is spread over `PARAM_RAMP_SECONDS`: a continuous one, or a stepped one with many values that is not an enum. A switch, a mode or an enum jumps. */
const smooth = (info: WebClapParameter): boolean =>
  !((info.flags ?? 0) & ENUM_FLAG) && (info.step === undefined || (info.max - info.min) / info.step + 1 >= RAMP_MIN_VALUES);
const withStep = (info: WebClapParameter): WebClapParameter =>
  info.flags !== undefined && info.flags & 1 && info.step === undefined ? { ...info, step: 1 } : info;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const modules = new WeakMap<AudioContext, Map<string, Promise<void>>>();

/**
 * Browser host for one WebCLAP plug-in: an AudioProcessor (`host.connect(context.destination)`) that plays notes with the `Sampler` shape (`noteOn(note, { velocity, when })`, `noteOff(note, when)`), so a `MidiClip` or `MidiKeyboard` takes it as `instrument`.
 * Each CLAP parameter is a `Param<number>` in `params`, keyed by its CLAP id (`host.params["7"].value`); writes reach the plug-in and the plug-in's own changes update the Param.
 */
export class WebClapHost extends AudioProcessor<WebClapParams, { parameterInfo: ReadonlyCell<readonly WebClapParameter[]> }> {
  /** CLAP parameters as `Param<number>`s keyed by CLAP id (string or number); an unknown id is `undefined`. */
  declare readonly params: WebClapParamAccess;
  /** The AudioWorkletNode that runs the plug-in. */
  readonly node: AudioWorkletNode;
  /** The URL the bundle was loaded from, as passed to `load`. */
  readonly bundleUrl: string;
  /** The loaded plug-in's identity: CLAP ID, name, vendor and version. */
  readonly descriptor: WebClapDescriptor;
  /** True when the plug-in has a GUI that `mountEditor` can show. */
  readonly hasEditor: boolean;

  private stateWaiters: Waiter<Uint8Array<ArrayBuffer>>[] = [];
  private loadStateWaiters: Waiter<void>[] = [];
  private syncWaiters: Waiter<void>[] = [];
  private guiWaiter?: Waiter<string>;
  private editor?: HTMLIFrameElement;
  private editorListener?: (event: MessageEvent) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Set<() => void>>();
  /** Last value known to both sides, per CLAP id. Param writes equal to it are not echoed to the worklet. */
  private readonly synced: Map<number, number>;
  /**
   * Values this host wrote that the plug-in has not reported back yet, per CLAP id. A plug-in that has not processed audio since (a suspended context) still reports its old value
   * when asked, so a report that differs from a pending write is ignored for that id; a report that matches it, a `paramOut` or a loaded state ends the wait.
   */
  private readonly unconfirmed: Map<number, number>;
  private readonly infoStore: Cell<readonly WebClapParameter[]>;
  /** Channels each sounding note was started on, so `noteOff(note)` releases it where it plays. */
  private readonly noteChannels = new Map<number, Map<number, object>>();
  private disposed = false;

  /** Tracked frozen parameter metadata in the plug-in's order (id, name, min, max, default, text, step); `host.params[String(info.id)]` is its live Param. Last reported by the plug-in; the same value as `cells.parameterInfo`. Live values are in `params`. */
  get parameterInfo(): readonly WebClapParameter[] {
    return this.cells.parameterInfo.value;
  }

  /** The live Param of a CLAP parameter id (a number or its decimal string), or undefined when the plug-in has no such id. */
  param(id: number | string): Param<number> | undefined {
    return (this.params as Record<string, Param<number> | undefined>)[String(id)];
  }

  private constructor(context: AudioContext, node: AudioWorkletNode, bundleUrl: string, loaded: LoadedMessage, early: HostMessage[]) {
    const synced = new Map<number, number>();
    const unconfirmed = new Map<number, number>();
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
              const from = synced.get(info.id);
              if (from === value) return;
              synced.set(info.id, value);
              unconfirmed.set(info.id, value);
              // A smooth parameter moves over PARAM_RAMP_SECONDS while audio runs, as several value events on its own grid (CLAP has no smoothing hint, and a plug-in that does not smooth steps);
              // a switch or an enum jumps. A context that is not running (a render being prepared, a suspended page) takes the value at once.
              const ramp = smooth(info) && context.state === "running" ? PARAM_RAMP_SECONDS : 0;
              node.port.postMessage({ type: "param", id: info.id, value, from, ramp, step: info.step });
            },
          },
        });
      }
      return { params: params as WebClapParams, cells: { parameterInfo: readonlyCell(infoStore) }, latency: 0 };
    });
    this.synced = synced;
    this.unconfirmed = unconfirmed;
    this.node = node;
    this.bundleUrl = bundleUrl.replace(/\/$/, "");
    this.descriptor = loaded.descriptor;
    this.infoStore = infoStore;
    this.hasEditor = loaded.hasGui;
    this.latency.value = loaded.latencySamples ?? 0;
    node.port.onmessage = (event: MessageEvent<HostMessage>) => this.receive(event.data);
    for (const message of early) this.receive(message);
  }

  /** Fetches the bundle, starts the plug-in in an AudioWorklet and resolves when it is ready. Rejects with the loader's error when the bundle or worklet cannot load. */
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

  /** The node that receives audio into the plug-in (an instrument plug-in ignores it). */
  get input(): AudioNode {
    return this.node;
  }
  /** The plug-in's audio output; connect it onward like any node. */
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

  /** Resolves once the worklet has handled every message posted before this call, without calling into the plug-in. */
  messagesHandled(): Promise<void> {
    const result = this.wait<void>((waiter) => this.syncWaiters.push(waiter));
    this.node.port.postMessage({ type: "sync" });
    return result;
  }

  /**
   * The plug-in's state as bytes; pass them to `loadState` later to restore it. It also refreshes `parameterInfo` and `params` from the plug-in, so a parameter the plug-in changed inside
   * (loading a preset in its own editor) is in them by the time the bytes arrive; a reported value that differs from one this host wrote and the plug-in has not confirmed yet is ignored (a plug-in that has processed no audio still reports the old value). Rejects on timeout or `dispose()`.
   */
  async saveState(): Promise<Uint8Array<ArrayBuffer>> {
    return this.readState(true);
  }

  private readState(withParams: boolean): Promise<Uint8Array<ArrayBuffer>> {
    const result = this.wait<Uint8Array<ArrayBuffer>>((waiter) => this.stateWaiters.push(waiter));
    this.node.port.postMessage({ type: "saveState", withParams });
    return result;
  }

  /** Restores bytes made by `saveState`, resolves once the plug-in has applied them. Rejects on timeout or `dispose()`. */
  async loadState(bytes: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("WebCLAP state needs bytes.");
    const expected = new Uint8Array(bytes);
    // The loaded state decides every value, including the ones this host wrote before.
    this.unconfirmed.clear();
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

  /** Shows the plug-in's GUI in `frame`; returns a function that unmounts it. Throws when `hasEditor` is false. */
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
        this.unconfirmed.delete(message.id as number);
        this.applyParam(message.id as number, message.value as number);
        break;
      case "params": {
        const infos = (message.params as WebClapParameter[]).map(withStep);
        batch(() => {
          this.infoStore.value = Object.freeze(infos);
          for (const info of infos) {
            const pending = this.unconfirmed.get(info.id);
            if (pending !== undefined) {
              if (pending !== info.value) continue;
              this.unconfirmed.delete(info.id);
            }
            this.applyParam(info.id, info.value);
          }
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

  /** Unmounts the editor, stops the worklet and rejects pending state requests; safe to call twice. */
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
