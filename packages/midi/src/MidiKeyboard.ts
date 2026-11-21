/** Plays every Web MIDI input live into an instrument. Mirrors MicrophoneInput.open: the caller owns the gesture, the instrument and the AudioContext.
 * Reads: ./midi-data for the Instrument contract.
 */
import { batch, cell, readonlyCell, untracked, type Cell, type ReadonlyCell } from "@audiorective/core";
import type { Instrument } from "./midi-data";

export interface MidiKeyboardOptions {
  /** Where played notes go, at the current audio time (no look-ahead, lowest latency). */
  instrument: Instrument;
  /** Hold released keys while the sustain pedal (CC 64, value >= 64) is down. Default true. */
  sustain?: boolean;
  /** Aborting the signal calls `dispose()`. */
  signal?: AbortSignal;
}

type Port = {
  input: MIDIInput;
  /** Keys (channel * 128 + pitch) held down, and keys released while the pedal was down. */
  down: Set<number>;
  sustained: Set<number>;
  pedal: Set<number>;
  listener: (event: Event) => void;
};

/**
 * Plays every Web MIDI input live into an instrument: note-on (velocity / 127), note-off and note-on with velocity 0 on any channel; other messages are ignored except the sustain pedal.
 * Inputs plugged in later join; unplugging an input releases the notes it held or sustained; `dispose()` releases every note and removes the listeners.
 */
export class MidiKeyboard {
  /** The connected inputs, updated on hot-plug. */
  readonly inputs: ReadonlyCell<readonly MIDIInput[]>;
  /** Notes sounding now (held or sustained), lowest first. */
  readonly held: ReadonlyCell<readonly number[]>;
  /** True while the sustain pedal is down. */
  readonly sustain: ReadonlyCell<boolean>;

  private readonly inputsStore: Cell<readonly MIDIInput[]> = cell<readonly MIDIInput[]>(Object.freeze([]));
  private readonly heldStore: Cell<readonly number[]> = cell<readonly number[]>(Object.freeze([]));
  private readonly sustainStore: Cell<boolean> = cell(false);
  private readonly ports = new Map<string, Port>();
  private readonly signal: AbortSignal | undefined;
  private disposed = false;
  private readonly onState = () => this.sync();
  private readonly onAbort = () => this.dispose();

  /** Requests Web MIDI access (call it from a click) and resolves listening to every input. Rejects with the DOMException of `navigator.requestMIDIAccess` (`NotAllowedError`, `NotSupportedError`). */
  static async open(context: BaseAudioContext, options: MidiKeyboardOptions): Promise<MidiKeyboard> {
    if (!options?.instrument) throw new TypeError("MidiKeyboard needs an instrument.");
    if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function")
      throw new DOMException("Web MIDI is not supported in this browser.", "NotSupportedError");
    const access = await navigator.requestMIDIAccess();
    return new MidiKeyboard(context, access, options);
  }

  private constructor(
    private readonly context: BaseAudioContext,
    readonly access: MIDIAccess,
    private readonly options: MidiKeyboardOptions,
  ) {
    this.inputs = readonlyCell(this.inputsStore);
    this.held = readonlyCell(this.heldStore);
    this.sustain = readonlyCell(this.sustainStore);
    access.addEventListener("statechange", this.onState);
    this.sync();
    this.signal = options.signal;
    if (this.signal) {
      if (this.signal.aborted) this.dispose();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  /** Adds listeners to inputs that connected, drops (and releases) inputs that went away. */
  private sync(): void {
    if (this.disposed) return;
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
    port.input.removeEventListener("midimessage", port.listener);
    this.ports.delete(id);
    this.releaseAll(port);
  }

  private now(): number {
    return this.context.currentTime;
  }

  private onMessage(port: Port, event: MIDIMessageEvent): void {
    const data = event.data;
    if (this.disposed || !data || data.length < 2) return;
    const status = data[0];
    if (status < 0x80 || status >= 0xf0) return;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const a = data[1];
    const b = data.length > 2 ? data[2] : 0;
    if (a > 127 || b > 127) return;
    if (kind === 0x90 && b > 0) {
      const key = channel * 128 + a;
      port.sustained.delete(key);
      port.down.add(key);
      this.options.instrument.noteOn(a, { velocity: b / 127, when: this.now(), channel });
    } else if (kind === 0x80 || kind === 0x90) {
      const key = channel * 128 + a;
      if (!port.down.delete(key)) return;
      if (port.pedal.has(channel) && this.options.sustain !== false) port.sustained.add(key);
      else this.options.instrument.noteOff(a, this.now());
    } else if (kind === 0xb0 && a === 64 && this.options.sustain !== false) {
      if (b >= 64) port.pedal.add(channel);
      else {
        port.pedal.delete(channel);
        for (const key of [...port.sustained]) {
          if (Math.floor(key / 128) !== channel) continue;
          port.sustained.delete(key);
          this.options.instrument.noteOff(key % 128, this.now());
        }
      }
    } else return;
    this.publish();
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
    for (const port of this.ports.values()) {
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
    this.access.removeEventListener("statechange", this.onState);
    this.signal?.removeEventListener("abort", this.onAbort);
    for (const [id, port] of [...this.ports]) this.detach(port, id);
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
