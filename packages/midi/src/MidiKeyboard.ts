/** Plays every Web MIDI input, and on-screen keys, live into an instrument. Mirrors MicrophoneInput.open: the caller owns the gesture, the instrument and the AudioContext.
 * Reads: ./midi-data for the Instrument contract.
 */
import { batch, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import type { Instrument } from "./midi-data";

/** Anything that emits `midimessage` events: a `MIDIInput`, or a `MidiKeyboard` (which re-emits hardware messages and its own `press`, `release` and `setSustain`). A `MidiRecorder` records from one. */
export interface MidiSource {
  /** Subscribes to raw midimessage events using the browser EventTarget contract. */
  addEventListener(type: "midimessage", listener: EventListener): void;
  /** Removes the same midimessage listener previously registered with addEventListener. */
  removeEventListener(type: "midimessage", listener: EventListener): void;
}

export interface MidiKeyboardOptions {
  /** Where played notes go, at the current audio time (no look-ahead, lowest latency). */
  instrument: Instrument;
  /** Hold released keys while the sustain pedal (CC 64, value >= 64, or `setSustain(true)`) is down. Default true. */
  sustain?: boolean;
  /** A `MIDIAccess` you already hold, or `null` for on-screen keys only (no permission prompt). Default: request one with `navigator.requestMIDIAccess()`, which needs a click. */
  access?: MIDIAccess | null;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}

type Port = {
  input: MIDIInput | null;
  /** Keys (channel * 128 + pitch) held down, and keys released while the pedal was down. */
  down: Set<number>;
  sustained: Set<number>;
  pedal: Set<number>;
  listener: (event: Event) => void;
};

/**
 * Plays every Web MIDI input live into an instrument: note-on (velocity / 127), note-off and note-on with velocity 0 on any channel; other messages are ignored except the sustain pedal.
 * `press`, `release` and `setSustain` are the same path for on-screen keys. Inputs plugged in later join; unplugging an input releases the notes it held or sustained; `dispose()` releases every note.
 * It is also a `MidiSource`: a recorder can record every input and the on-screen keys at once.
 */
export class MidiKeyboard extends EventTarget implements MidiSource {
  /** The connected inputs, updated on hot-plug. Empty with `access: null`. */
  readonly inputs: ReadonlyCell<readonly MIDIInput[]>;
  /** Notes sounding now (held or sustained), lowest first. */
  readonly held: ReadonlyCell<readonly number[]>;
  /** True while a sustain pedal is down. */
  readonly sustain: ReadonlyCell<boolean>;

  private readonly inputsStore: Cell<readonly MIDIInput[]> = cell<readonly MIDIInput[]>(Object.freeze([]));
  private readonly heldStore: Cell<readonly number[]> = cell<readonly number[]>(Object.freeze([]));
  private readonly sustainStore: Cell<boolean> = cell(false);
  private readonly ports = new Map<string, Port>();
  private readonly screen: Port = { input: null, down: new Set(), sustained: new Set(), pedal: new Set(), listener: () => {} };
  private readonly signal: AbortSignal | undefined;
  private disposed = false;
  private readonly onState = () => this.sync();
  private readonly onAbort = () => this.dispose();

  /** Resolves listening to every input of `access` (default: requests Web MIDI access, call it from a click; `null` is on-screen only). Rejects with the DOMException of `navigator.requestMIDIAccess` (`NotAllowedError`, `NotSupportedError`). */
  static async open(context: BaseAudioContext, options: MidiKeyboardOptions): Promise<MidiKeyboard> {
    if (!options?.instrument) throw new TypeError("MidiKeyboard needs an instrument.");
    let access = options.access;
    if (access === undefined) {
      if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function")
        throw new DOMException("Web MIDI is not supported in this browser.", "NotSupportedError");
      access = await navigator.requestMIDIAccess();
    }
    return new MidiKeyboard(context, access, options);
  }

  private constructor(
    private readonly context: BaseAudioContext,
    /** The `MIDIAccess` in use, or null for on-screen keys only. */
    readonly access: MIDIAccess | null,
    private readonly options: MidiKeyboardOptions,
  ) {
    super();
    this.inputs = readonlyCell(this.inputsStore);
    this.held = readonlyCell(this.heldStore);
    this.sustain = readonlyCell(this.sustainStore);
    access?.addEventListener("statechange", this.onState);
    this.sync();
    this.signal = options.signal;
    if (this.signal) {
      if (this.signal.aborted) this.dispose();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  /** Adds listeners to inputs that connected, drops (and releases) inputs that went away. */
  private sync(): void {
    if (this.disposed || !this.access) return;
    const connected = new Map<string, MIDIInput>();
    this.access.inputs.forEach((input) => {
      if (input.state !== "disconnected") connected.set(input.id, input);
    });
    for (const [id, port] of [...this.ports])
      if (connected.get(id) !== port.input) {
        this.detach(port, id);
      }
    for (const [id, input] of connected) {
      if (this.ports.has(id)) continue;
      const port: Port = { input, down: new Set(), sustained: new Set(), pedal: new Set(), listener: () => {} };
      port.listener = (event) => this.onMessage(port, event as MIDIMessageEvent);
      input.addEventListener("midimessage", port.listener);
      this.ports.set(id, port);
    }
    batch(() => {
      this.inputsStore.value = Object.freeze([...connected.values()]);
      this.publish();
    });
  }

  private detach(port: Port, id: string): void {
    port.input?.removeEventListener("midimessage", port.listener);
    this.ports.delete(id);
    this.releaseAll(port);
  }

  private now(): number {
    return this.context.currentTime;
  }

  /** Re-emits a message to `MidiSource` listeners (a recorder), with the original timestamp for hardware and `performance.now()` shifted to `when` for on-screen keys. */
  private emit(data: Uint8Array, timeStamp: number): void {
    const event = new Event("midimessage");
    Object.defineProperties(event, { data: { value: data }, timeStamp: { value: timeStamp } });
    this.dispatchEvent(event);
  }

  private onMessage(port: Port, event: MIDIMessageEvent): void {
    const data = event.data;
    if (this.disposed || !data || data.length < 2) return;
    this.apply(port, data[0]!, data[1]!, data.length > 2 ? data[2]! : 0, this.now());
    this.emit(data, event.timeStamp);
  }

  /** The one decoder: hardware messages and on-screen keys both end here. */
  private apply(port: Port, status: number, a: number, b: number, when: number): void {
    if (status < 0x80 || status >= 0xf0 || a > 127 || b > 127) return;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const sustain = this.options.sustain !== false;
    if (kind === 0x90 && b > 0) {
      const key = channel * 128 + a;
      // a key the pedal alone is holding is released at the re-strike, so the pitch has one voice and pedal-up releases only the new note
      if (port.sustained.delete(key)) this.options.instrument.noteOff(a, when);
      port.down.add(key);
      this.options.instrument.noteOn(a, { velocity: b / 127, when, channel });
    } else if (kind === 0x80 || kind === 0x90) {
      const key = channel * 128 + a;
      if (!port.down.delete(key)) return;
      if (port.pedal.has(channel) && sustain) port.sustained.add(key);
      else this.options.instrument.noteOff(a, when);
    } else if (kind === 0xb0 && a === 64 && sustain) {
      if (b >= 64) port.pedal.add(channel);
      else {
        port.pedal.delete(channel);
        for (const key of [...port.sustained]) {
          if (Math.floor(key / 128) !== channel) continue;
          port.sustained.delete(key);
          this.options.instrument.noteOff(key % 128, when);
        }
      }
    } else return;
    this.publish();
  }

  /** Strikes `note` (0-127) like a key on a keyboard (a note the pedal alone is holding is released at `when` first, so a pitch has one voice): `velocity` 0..1 (default 1) on `channel` 0-15 (default 0), sounding at `when` (audio-context seconds, default now). The same path as hardware: `held`, sustain and the recorder see it. */
  press(note: number, options: Readonly<{ velocity?: number; when?: number; channel?: number }> = {}): void {
    if (this.disposed) return;
    const { velocity = 1, channel = 0 } = options;
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new RangeError("MidiKeyboard note must be an integer 0-127.");
    if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1) throw new RangeError("MidiKeyboard velocity must be 0..1.");
    if (!Number.isInteger(channel) || channel < 0 || channel > 15) throw new RangeError("MidiKeyboard channel must be an integer 0-15.");
    const when = options.when ?? this.now();
    const byte = Math.max(1, Math.round(velocity * 127));
    this.apply(this.screen, 0x90 | channel, note, byte, when);
    this.emit(new Uint8Array([0x90 | channel, note, byte]), this.stamp(when));
  }

  /** Lets go of an on-screen key at `when` (default now), on every channel it was pressed on. */
  release(note: number, when: number = this.now()): void {
    if (this.disposed) return;
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new RangeError("MidiKeyboard note must be an integer 0-127.");
    for (let channel = 0; channel < 16; channel++) {
      if (!this.screen.down.has(channel * 128 + note)) continue;
      this.apply(this.screen, 0x80 | channel, note, 0, when);
      this.emit(new Uint8Array([0x80 | channel, note, 0]), this.stamp(when));
    }
  }

  /** Presses (`true`) or lifts the sustain pedal for the on-screen keys, on every channel, at `when` (default now). Ignored with `sustain: false`. */
  setSustain(down: boolean, when: number = this.now()): void {
    if (this.disposed || this.options.sustain === false) return;
    for (let channel = 0; channel < 16; channel++) {
      this.apply(this.screen, 0xb0 | channel, 64, down ? 127 : 0, when);
    }
    this.emit(new Uint8Array([0xb0, 64, down ? 127 : 0]), this.stamp(when));
  }

  /** The Web MIDI timestamp (performance.now() based) of audio time `when`. */
  private stamp(when: number): number {
    return performance.now() + (when - this.now()) * 1000;
  }

  private releaseAll(port: Port): void {
    const keys = new Set([...port.down, ...port.sustained]);
    port.down.clear();
    port.sustained.clear();
    port.pedal.clear();
    for (const key of keys) this.options.instrument.noteOff(key % 128, this.now());
  }

  private publish(): void {
    const held = new Set<number>();
    let pedal = false;
    for (const port of [...this.ports.values(), this.screen]) {
      for (const key of port.down) held.add(key % 128);
      for (const key of port.sustained) held.add(key % 128);
      if (port.pedal.size) pedal = true;
    }
    const next = [...held].sort((x, y) => x - y);
    const current = untracked(() => this.heldStore.value);
    batch(() => {
      if (next.length !== current.length || next.some((n, i) => n !== current[i])) this.heldStore.value = Object.freeze(next);
      this.sustainStore.value = pedal;
    });
  }

  /** Releases every held and sustained note, removes the listeners and stops following the inputs. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.access?.removeEventListener("statechange", this.onState);
    this.signal?.removeEventListener("abort", this.onAbort);
    for (const [id, port] of [...this.ports]) this.detach(port, id);
    this.releaseAll(this.screen);
    batch(() => {
      this.inputsStore.value = Object.freeze([]);
      this.heldStore.value = Object.freeze([]);
      this.sustainStore.value = false;
    });
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
