type Voice = { source: AudioBufferSourceNode; gate: GainNode; end?: number; released: boolean };

function release(voice: Voice, stop = true): void {
  if (voice.released) return;
  voice.released = true;
  if (stop) voice.source.stop();
  voice.source.disconnect();
  voice.gate.disconnect();
}

/** Switches one track upstream of its shared devices, effects and mixer. */
export class AudioTrackSession {
  readonly arrangementInput: GainNode;
  private active?: Voice;

  constructor(
    private readonly context: AudioContext,
    private readonly input: AudioNode,
  ) {
    this.arrangementInput = context.createGain();
    this.arrangementInput.connect(input);
  }

  schedule(buffer: AudioBuffer | null, when: number, loop = true) {
    const previous = this.active;
    let incoming: Voice | undefined;
    if (buffer) {
      const source = this.context.createBufferSource();
      const gate = this.context.createGain();
      source.buffer = buffer;
      source.loop = loop;
      gate.gain.value = 0;
      gate.gain.setValueAtTime(1, when);
      source.connect(gate).connect(this.input);
      const voice: Voice = { source, gate, end: loop ? undefined : when + buffer.duration, released: false };
      source.onended = () => {
        release(voice, false);
        if (this.active === voice) this.active = undefined;
      };
      source.start(when);
      incoming = voice;
    }

    const arrangement = this.arrangementInput.gain;
    arrangement.cancelScheduledValues(when);
    arrangement.setValueAtTime(incoming ? 0 : 1, when);
    if (incoming?.end !== undefined) arrangement.setValueAtTime(1, incoming.end);
    previous?.gate.gain.setValueAtTime(0, when);
    return {
      end: incoming?.end,
      commit: () => {
        if (previous) release(previous);
        this.active = incoming?.released ? undefined : incoming;
      },
      cancel: () => {
        arrangement.cancelScheduledValues(when);
        if (previous?.end !== undefined && previous.end >= when) arrangement.setValueAtTime(1, previous.end);
        previous?.gate.gain.cancelScheduledValues(when);
        if (incoming) release(incoming);
      },
    };
  }

  reset(): void {
    if (this.active) release(this.active);
    this.active = undefined;
    const now = this.context.currentTime;
    this.arrangementInput.gain.cancelScheduledValues(now);
    this.arrangementInput.gain.setValueAtTime(1, now);
  }

  destroy(): void {
    this.reset();
    this.arrangementInput.disconnect();
  }
}
