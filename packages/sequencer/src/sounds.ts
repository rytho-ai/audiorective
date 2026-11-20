import type { CancellableEvent } from "@audiorective/core";
import { noteToHz, type NoteName } from "./notation";

/** Called once per hit; `hit.pitch` is the step's semitone offset, which a factory applies itself (a note name or an `AudioBuffer` follow it automatically). */
export type SoundFactory = (context: BaseAudioContext, hit: SoundHit) => AudioScheduledSourceNode;
/** A note played by the built-in tone synth, a decoded sample, or a source factory. */
export type Sound = NoteName | AudioBuffer | SoundFactory;

/** Peak gain of a full-velocity tone: leaves headroom for several lanes summing at the destination. */
const TONE_PEAK = 0.5;
const ATTACK = 0.004;
const MIN_BODY = 0.05;
const RELEASE = 0.02;

export type SoundHit = Readonly<{ when: number; duration: number; velocity: number; /** Semitones. */ pitch: number }>;

const SOUND_ERROR = () => 'Step Sequencer sound needs a note name like "C4", an AudioBuffer or a function returning an audio source node.';

/** Throws when `sound` is not a note name, an AudioBuffer or a function. */
export function assertSound(sound: unknown): asserts sound is Sound {
  if (typeof sound === "string") {
    if (noteToHz(sound) === undefined) throw new Error(SOUND_ERROR());
  } else if (typeof sound !== "function" && !(typeof AudioBuffer !== "undefined" && sound instanceof AudioBuffer)) throw new Error(SOUND_ERROR());
}

/** A source node plus the gain that carries its velocity, wrapped as a cancellable event. */
function voice(
  context: BaseAudioContext,
  source: AudioScheduledSourceNode,
  gain: GainNode,
  when: number,
  stopAt: number | undefined,
): CancellableEvent {
  const listeners: Array<() => void> = [];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      gain.disconnect();
    } catch {
      // already disconnected
    }
    for (const listener of listeners.splice(0)) {
      try {
        listener();
      } catch (error) {
        console.error("Step Sequencer hit end listener failed:", error);
      }
    }
  };
  source.addEventListener("ended", finish);
  source.start(when);
  if (stopAt !== undefined) source.stop(stopAt);
  return {
    cancel() {
      if (finished) return;
      try {
        source.stop(Math.max(context.currentTime, 0));
      } catch {
        // never started or already stopped
      }
      finish();
    },
    onEnded(listener) {
      if (finished) listener();
      else listeners.push(listener);
    },
  };
}

/**
 * Start one hit of `sound` at `hit.when` into `destination`. A note name plays the built-in tone synth (a triangle oscillator
 * with a 4 ms attack and an exponential decay over the hit's duration), an `AudioBuffer` plays once through, and a factory is
 * called for each hit and stopped after `duration` unless it returns a buffer source.
 */
export function playSound(context: BaseAudioContext, sound: Sound, destination: AudioNode, hit: SoundHit): CancellableEvent {
  const gain = new GainNode(context);
  gain.connect(destination);
  if (typeof sound === "string") {
    const hz = noteToHz(sound)! * 2 ** (hit.pitch / 12);
    const osc = new OscillatorNode(context, { type: "triangle", frequency: hz });
    osc.connect(gain);
    const peak = TONE_PEAK * hit.velocity;
    const body = Math.max(hit.duration, MIN_BODY);
    gain.gain.setValueAtTime(0, hit.when);
    gain.gain.linearRampToValueAtTime(peak, hit.when + ATTACK);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak * 0.001, 1e-5), hit.when + body);
    gain.gain.setValueAtTime(0, hit.when + body + 1e-4);
    return voice(context, osc, gain, hit.when, hit.when + body + RELEASE);
  }
  gain.gain.value = hit.velocity;
  if (typeof sound === "function") {
    const node = sound(context, hit);
    if (!node || typeof node.start !== "function" || typeof node.stop !== "function") {
      gain.disconnect();
      throw new Error(
        "Step Sequencer sound factory needs to return an AudioScheduledSourceNode (an oscillator, a buffer source or a constant source).",
      );
    }
    node.connect(gain);
    const oneShot = typeof AudioBufferSourceNode !== "undefined" && node instanceof AudioBufferSourceNode;
    return voice(context, node, gain, hit.when, oneShot ? undefined : hit.when + hit.duration);
  }
  const source = new AudioBufferSourceNode(context, { buffer: sound, playbackRate: 2 ** (hit.pitch / 12) });
  source.connect(gain);
  return voice(context, source, gain, hit.when, undefined);
}
