/** Demo-owned note audition, separate from MIDI data and piano-roll views.
 * Reads: core AudioProcessor for graph/lifecycle; pure MIDI types for caller data.
 */
import { AudioProcessor, type SchedulableParam } from "@audiorective/core";
import { compileMidiPlaybackEvents, type MidiNote, type MidiRange, type MidiData, type MidiPlaybackSource } from "@audiorective/midi";
import { planMidiVoices } from "./voice-plan";
export type Note = MidiNote;
export type Range = MidiRange;
export type State = MidiData & Readonly<{ selection: MidiRange | null; source?: MidiPlaybackSource | null }>;
class DemoMidiAuditioner extends AudioProcessor<{ volume: SchedulableParam }, {}> {
  private voices = new Set<{ osc: OscillatorNode; gain: GainNode }>();
  private command = 0;
  private anchor: { time: number; offset: number; end: number } | null = null;
  private held = 0;
  private dead = false;
  private readonly gain: GainNode;
  constructor(
    private readonly liveContext: AudioContext,
    private readonly read: () => State,
  ) {
    const gain = new GainNode(liveContext);
    super(liveContext, ({ param }) => ({ params: { volume: param({ default: 1, bind: gain.gain }) }, cells: {} }));
    this.gain = gain;
  }
  get output(): GainNode {
    return this.gain;
  }
  get position(): number {
    return this.anchor ? Math.min(this.anchor.end, this.anchor.offset + Math.max(0, this.context.currentTime - this.anchor.time)) : this.held;
  }
  get isPlaying(): boolean {
    return !!this.anchor && this.context.currentTime < this.anchor.time + this.anchor.end - this.anchor.offset;
  }
  get activeVoices(): number {
    return this.voices.size;
  }
  pause(): void {
    ++this.command;
    this.held = this.position;
    this.anchor = null;
    for (const voice of this.voices) {
      voice.osc.onended = null;
      try {
        voice.osc.stop();
      } catch {}
      voice.osc.disconnect();
      voice.gain.disconnect();
    }
    this.voices.clear();
  }
  async play(): Promise<void> {
    if (this.dead) return;
    this.pause();
    const token = this.command;
    await this.liveContext.resume();
    if (this.dead || token !== this.command) return;
    const state = this.read(),
      range = state.selection ?? { start: 0, end: state.duration };
    if (range.end <= range.start) return;
    const offset = this.held >= range.start && this.held < range.end ? this.held : range.start,
      time = this.context.currentTime + 0.03;
    const messages = compileMidiPlaybackEvents(state.source ?? { startTime: 0, events: [] }, state);
    const planned = planMidiVoices(messages, state.duration);
    this.anchor = { time, offset, end: range.end };
    for (const note of planned) {
      const start = Math.max(note.start, offset),
        end = Math.min(note.end, range.end);
      if (end <= start) continue;
      const when = time + start - offset,
        osc = new OscillatorNode(this.context, { type: "sine", frequency: 440 * 2 ** ((note.pitch - 69) / 12) }),
        gain = new GainNode(this.context),
        voice = { osc, gain };
      const level = (note.velocity / 127) * 0.15,
        fade = Math.min(0.003, (end - start) / 4);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level, when + fade);
      gain.gain.setValueAtTime(level, when + end - start - fade);
      gain.gain.linearRampToValueAtTime(0, when + end - start);
      osc.connect(gain);
      gain.connect(this.gain);
      this.voices.add(voice);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
        this.voices.delete(voice);
      };
      osc.start(when);
      osc.stop(when + end - start);
    }
  }
  seek(seconds: number): void {
    const active = this.isPlaying;
    this.pause();
    this.held = Math.max(0, Math.min(this.read().duration, seconds));
    if (active) void this.play();
  }
  override dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.pause();
    this.gain.disconnect();
    super.dispose();
  }
}
export function createAuditioner(context: AudioContext, output: AudioNode, read: () => State): Auditioner {
  const player = new DemoMidiAuditioner(context, read);
  player.output.connect(output);
  return player;
}
export interface Auditioner {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  readonly position: number;
  readonly isPlaying: boolean;
  dispose(): void;
}
export type Dependencies = { context: AudioContext; output: AudioNode; makeAuditioner(read: () => State): Auditioner };
export type MidiApp = {
  load(bytes: ArrayBuffer | Uint8Array): void;
  getState(): State;
  setSelection(range: Range | null): void;
  editNote(id: string, patch: Partial<Pick<Note, "pitch" | "velocity" | "start" | "end">>): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  readonly position: number;
  readonly isPlaying: boolean;
  removeSecondView(): void;
  dispose(): void;
};
