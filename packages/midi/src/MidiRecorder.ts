import { cell, readonlyCell, type ReadonlyCell } from "@audiorective/core";
import type { MidiNote, RecordedMidi, RecordedMidiEvent } from "./midi-data";

export type { RecordedMidi, RecordedMidiEvent } from "./midi-data";

export type MidiRecorderState = "idle" | "recording" | "destroyed";

type ActiveNote = { start: number; pitch: number; velocity: number; channel: number; id: string };
type Session = {
  startTime: number;
  events: RecordedMidiEvent[];
  notes: MidiNote[];
  held: Map<number, ActiveNote[]>;
};
let nextRecorderId = 0;

/** Records one Web MIDI input without owning its permission, playback, or the destination sequence. */
export class MidiRecorder {
  readonly cells: Readonly<{ state: ReadonlyCell<MidiRecorderState> }>;
  private readonly stateStore = cell<MidiRecorderState>("idle");
  private active: Session | null = null;
  private readonly recorderId = ++nextRecorderId;
  private takeNumber = 0;
  private noteNumber = 0;
  private disposed = false;

  constructor(
    readonly context: AudioContext,
    readonly input: MIDIInput,
  ) {
    this.cells = Object.freeze({ state: readonlyCell(this.stateStore) });
  }

  /** Map the Web MIDI performance timestamp to the audible AudioContext output position. */
  private audioTime(performanceTime: number): number {
    const pair = this.context.getOutputTimestamp?.();
    if (typeof pair?.contextTime === "number" && typeof pair.performanceTime === "number" && (pair.contextTime > 0 || pair.performanceTime > 0)) {
      return Math.max(0, pair.contextTime + (performanceTime - pair.performanceTime) / 1000);
    }
    return Math.max(0, this.context.currentTime + (performanceTime - performance.now()) / 1000);
  }

  private readonly onMessage = (event: MIDIMessageEvent): void => {
    const session = this.active;
    if (!session || !event.data || !Number.isFinite(event.timeStamp)) return;
    const time = this.audioTime(event.timeStamp);
    if (time < session.startTime) return;
    const data = new Uint8Array(event.data);
    let noteId: string | undefined;
    if (data.length >= 3 && data[1] <= 127 && data[2] <= 127) {
      const status = data[0];
      const kind = status & 0xf0;
      if (status >= 0x80 && status < 0xf0 && (kind === 0x80 || kind === 0x90)) {
        const channel = status & 0x0f;
        const pitch = data[1];
        const key = channel * 128 + pitch;
        const relative = time - session.startTime;
        if (kind === 0x90 && data[2] > 0) {
          const held = session.held.get(key) ?? [];
          noteId = `${this.recorderId}:${this.takeNumber}:${++this.noteNumber}`;
          held.push({ start: relative, pitch, velocity: data[2], channel, id: noteId });
          session.held.set(key, held);
        } else {
          const held = session.held.get(key);
          const note = held?.shift();
          if (note) {
            noteId = note.id;
            session.notes.push(Object.freeze({ ...note, end: Math.max(note.start, relative), track: 0 }));
          }
          if (held?.length === 0) session.held.delete(key);
        }
      }
    }
    session.events.push(Object.freeze({ audioTime: time, data, ...(noteId ? { noteId } : {}) }));
  };

  /** Arm one take. `when` is an absolute AudioContext time; omitted means the current audible output position. */
  start(options: { when?: number } = {}): void {
    if (this.disposed) throw new Error("MidiRecorder is destroyed.");
    if (this.active) throw new Error("MidiRecorder already has an active take.");
    if (this.context.state !== "running") throw new Error("MidiRecorder needs a running AudioContext.");
    const when = options.when ?? this.audioTime(performance.now());
    if (!Number.isFinite(when) || when < 0) throw new RangeError("MidiRecorder time must be finite, non-negative seconds.");
    const session: Session = { startTime: Math.max(when, this.audioTime(performance.now())), events: [], notes: [], held: new Map() };
    this.input.addEventListener("midimessage", this.onMessage);
    this.active = session;
    this.takeNumber++;
    this.stateStore.value = "recording";
  }

  /** Finish now; notes use seconds relative to the take start and may be handed to MidiSequence. */
  stop(): RecordedMidi {
    if (this.disposed) throw new Error("MidiRecorder is destroyed.");
    const session = this.active;
    if (!session) throw new Error("MidiRecorder has no active take to stop.");
    let endTime = Math.max(session.startTime, this.audioTime(performance.now()));
    for (const event of session.events) endTime = Math.max(endTime, event.audioTime);
    if (endTime <= session.startTime) throw new RangeError("MidiRecorder stop must follow its start time.");
    const duration = endTime - session.startTime;
    for (const held of session.held.values()) {
      for (const note of held) session.notes.push(Object.freeze({ ...note, end: Math.max(note.start, duration), track: 0 }));
    }
    const notes = Object.freeze(session.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch));
    const take: RecordedMidi = Object.freeze({
      startTime: session.startTime,
      endTime,
      duration,
      notes,
      events: Object.freeze(session.events),
    });
    this.release();
    return take;
  }

  /** Discard the active take without touching the borrowed input or context. */
  cancel(): void {
    if (this.active) this.release();
  }

  private release(): void {
    this.input.removeEventListener("midimessage", this.onMessage);
    this.active = null;
    if (!this.disposed) this.stateStore.value = "idle";
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.release();
    this.stateStore.value = "destroyed";
  }
}
