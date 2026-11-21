import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Sampler, playSound, type SoundFactory, type SoundHit } from "../src";

const RATE = 44100;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dc(context: BaseAudioContext, seconds: number, level = 1): AudioBuffer {
  const buffer = context.createBuffer(1, Math.max(1, Math.round(seconds * context.sampleRate)), context.sampleRate);
  buffer.getChannelData(0).fill(level);
  return buffer;
}

/** Render `seconds` of whatever `setup` schedules on an offline context. */
async function render(seconds: number, setup: (context: OfflineAudioContext) => void): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, Math.round(seconds * RATE), RATE);
  setup(context);
  return (await context.startRendering()).getChannelData(0);
}
const at = (data: Float32Array, seconds: number) => data[Math.round(seconds * RATE)]!;

/** A factory whose voice is a constant `level` held for as long as the player holds it. */
const constant =
  (level: number): SoundFactory =>
  (context) =>
    new ConstantSourceNode(context, { offset: level });

describe("sound factories are played by the player", () => {
  test("the factory output is connected, started and stopped by the player, and the voice is freed at the end", async () => {
    const context = new AudioContext();
    const a = new ConstantSourceNode(context, { offset: 0.2 });
    const b = new ConstantSourceNode(context, { offset: 0.3 });
    const mix = new GainNode(context);
    a.connect(mix);
    b.connect(mix);
    const startA = vi.spyOn(a, "start");
    const startB = vi.spyOn(b, "start");
    const stopA = vi.spyOn(a, "stop");
    const stopB = vi.spyOn(b, "stop");
    const disconnect = vi.spyOn(mix, "disconnect");
    const sampler = new Sampler(context, { sound: () => ({ output: mix, sources: [a, b] }), release: 0.01 });
    const voice = sampler.trigger()!;
    expect(startA).toHaveBeenCalledTimes(1);
    expect(startB).toHaveBeenCalledTimes(1);
    expect(voice.playing.value).toBe(true);
    expect(sampler.cells.activeVoices.value).toBe(1);
    voice.stop();
    expect(stopA).toHaveBeenCalled();
    expect(stopB).toHaveBeenCalled();
    expect(voice.playing.value).toBe(false);
    expect(sampler.cells.activeVoices.value).toBe(0);
    await expect.poll(() => disconnect.mock.calls.length).toBeGreaterThan(0);
    sampler.dispose();
    await context.close();
  });

  test("a bare source node is both the output and the only source", async () => {
    const data = await render(0.3, (context) => {
      const sampler = new Sampler(context, { sound: constant(0.5) });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0.1 });
    });
    expect(at(data, 0.05)).toBe(0);
    expect(at(data, 0.2)).toBeCloseTo(0.5, 5);
  });

  test("a voice without its own duration is held for hit.duration, then faded out over release", async () => {
    const data = await render(0.5, (context) => {
      const gain = new GainNode(context);
      const voice = playSound(context, constant(1), gain, { when: 0, velocity: 1, pitch: 0, duration: 0.1 }, { release: 0.1 });
      expect(voice.playing.value).toBe(true);
      gain.connect(context.destination);
    });
    expect(at(data, 0.05)).toBeCloseTo(1, 5);
    expect(at(data, 0.15)).toBeCloseTo(0.5, 1);
    expect(at(data, 0.3)).toBe(0);
  });

  test("a voice with its own duration ends there however long the hit is held", async () => {
    const data = await render(0.5, (context) => {
      const sampler = new Sampler(context, {
        sound: (ctx) => {
          const source = new ConstantSourceNode(ctx, { offset: 1 });
          return { output: source, sources: [source], duration: 0.1 };
        },
      });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0 });
    });
    expect(at(data, 0.05)).toBeCloseTo(1, 5);
    expect(at(data, 0.2)).toBe(0);
  });

  test("velocity scales the voice once, after the factory output, and the factory sees it for timbre", async () => {
    const seen: SoundHit[] = [];
    const data = await render(0.2, (context) => {
      const sampler = new Sampler(context, {
        sound: (ctx, hit) => {
          seen.push(hit);
          return new ConstantSourceNode(ctx, { offset: 1 });
        },
      });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0, velocity: 0.5 });
    });
    expect(seen[0]).toMatchObject({ velocity: 0.5, pitch: 0, duration: Infinity });
    expect(at(data, 0.1)).toBeCloseTo(0.5, 5);
  });

  test("a buffer is scaled by velocity and follows pitch as playback rate", async () => {
    const data = await render(0.3, (context) => {
      const sampler = new Sampler(context, { sound: dc(context, 0.2) });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0, velocity: 0.5, pitch: 12 });
    });
    expect(at(data, 0.05)).toBeCloseTo(0.5, 5);
    expect(at(data, 0.15)).toBe(0);
  });

  test("a factory that returns neither a source node nor { output, sources } is rejected", () => {
    const context = new OfflineAudioContext(1, 128, RATE);
    const sampler = new Sampler(context, { sound: (() => ({})) as unknown as SoundFactory });
    expect(() => sampler.trigger()).toThrow(
      "Sound factory needs to return an AudioScheduledSourceNode or { output, sources } with at least one source.",
    );
    expect(() => new Sampler(context, { sound: "H9" as never })).toThrow(
      'Sound needs a note name like "C4", an AudioBuffer or a sound factory function.',
    );
  });
});

describe("Sampler hits", () => {
  let context: AudioContext;
  beforeEach(async () => {
    context = new AudioContext();
    await context.resume();
  });
  afterEach(() => void context.close());

  test("params.release is read when a voice is released", async () => {
    const data = await render(4, (context) => {
      const sampler = new Sampler(context, { sound: constant(0.5), release: 0.01 });
      expect(sampler.params.release.value).toBe(0.01);
      sampler.connect(context.destination);
      sampler.params.release.value = 2;
      sampler.noteOn(60, { when: 0 });
      sampler.noteOff(60, 1);
    });
    expect(at(data, 0.9)).toBeCloseTo(0.5, 3);
    expect(at(data, 2)).toBeCloseTo(0.25, 2);
    expect(at(data, 3.5)).toBe(0);
  });

  test("an earlier noteOff moves a pending release earlier; a later one is ignored", async () => {
    const data = await render(3, (context) => {
      const sampler = new Sampler(context, { sound: constant(1), release: 0.001 });
      sampler.connect(context.destination);
      sampler.noteOn(60, { when: 0 });
      sampler.noteOff(60, 2); // the natural release, sent ahead
      sampler.noteOff(60, 1); // a cut: earlier wins
      sampler.noteOff(60, 2.5); // later: ignored
      sampler.noteOn(62, { when: 0 });
      sampler.noteOff(62, 0.5);
      sampler.noteOff(62, 2); // later than the pending one: ignored
    });
    expect(at(data, 0.25)).toBeCloseTo(2, 3);
    expect(at(data, 0.75)).toBeCloseTo(1, 3);
    expect(at(data, 1.25)).toBeCloseTo(0, 3);
    expect(at(data, 2.2)).toBeCloseTo(0, 3);
  });

  test("a noteOff at a voice's own start silences a voice that has not started", async () => {
    const data = await render(2, (context) => {
      const sampler = new Sampler(context, { sound: constant(1), release: 0.001 });
      sampler.connect(context.destination);
      sampler.noteOn(60, { when: 1 });
      sampler.noteOff(60, 1);
    });
    expect(Math.max(...data)).toBeCloseTo(0, 3);
  });

  test("sustain keeps noteOff'd voices sounding until it is turned off", () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    expect(sampler.params.sustain.value).toBe(false);
    sampler.params.sustain.value = true;
    sampler.noteOn(60);
    sampler.noteOn(64);
    sampler.noteOff(60);
    expect(sampler.cells.heldNotes.value).toEqual([60, 64]);
    sampler.noteOn(60); // a sustained note pressed again adds a voice
    expect(sampler.cells.activeVoices.value).toBe(3);
    sampler.noteOff(60);
    expect(sampler.cells.activeVoices.value).toBe(3);
    sampler.params.sustain.value = false;
    expect(sampler.cells.activeVoices.value).toBe(1);
    expect(sampler.cells.heldNotes.value).toEqual([64]);
    sampler.dispose();
  });

  test("a sustained voice is not released by a later noteOff while the pedal is up again", () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    sampler.params.sustain.value = true;
    sampler.noteOn(60);
    sampler.noteOff(60);
    sampler.params.sustain.value = false;
    expect(sampler.cells.activeVoices.value).toBe(0);
    sampler.dispose();
  });

  test("heldNotes lists the notes with a sounding voice, ascending", () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    sampler.noteOn(64);
    sampler.noteOn(60);
    sampler.noteOn(60);
    sampler.trigger();
    expect(sampler.cells.heldNotes.value).toEqual([60, 64]);
    sampler.noteOff(60);
    expect(sampler.cells.heldNotes.value).toEqual([64]);
    sampler.stopAll();
    expect(sampler.cells.heldNotes.value).toEqual([]);
    sampler.dispose();
  });

  test("a voice scheduled ahead is not started, counted or held until its start time", async () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    const voice = sampler.noteOn(60, { when: context.currentTime + 0.3 })!;
    expect(voice.started.value).toBe(false);
    expect(voice.playing.value).toBe(true);
    expect(sampler.cells.activeVoices.value).toBe(0);
    expect(sampler.cells.heldNotes.value).toEqual([]);
    await expect.poll(() => voice.started.value).toBe(true);
    expect(context.currentTime).toBeGreaterThanOrEqual(voice.when);
    expect(sampler.cells.activeVoices.value).toBe(1);
    expect(sampler.cells.heldNotes.value).toEqual([60]);
    const dropped = sampler.noteOn(62, { when: context.currentTime + 5 })!;
    dropped.stop();
    expect(dropped.playing.value).toBe(false);
    expect(dropped.started.value).toBe(false);
    expect(sampler.cells.activeVoices.value).toBe(1);
    sampler.dispose();
    expect(sampler.cells.heldNotes.value).toEqual([]);
  });

  test("no sound returns null; setting one applies to the next hit", () => {
    const sampler = new Sampler(context);
    expect(sampler.trigger()).toBeNull();
    sampler.sound = dc(context, 1);
    expect(sampler.trigger()).not.toBeNull();
    expect(sampler.cells.activeVoices.value).toBe(1);
    sampler.dispose();
  });

  test("a past time plays now, and `when` reports where the voice starts", () => {
    const sampler = new Sampler(context, { sound: dc(context, 1) });
    const voice = sampler.trigger({ when: 0 })!;
    expect(voice.when).toBeGreaterThanOrEqual(context.currentTime - 0.01);
    const later = sampler.trigger({ when: context.currentTime + 5 })!;
    expect(later.when).toBeGreaterThan(context.currentTime + 4);
    sampler.dispose();
  });

  test("noteOn transposes from rootNote, passes the pitch to a factory and reports the note", () => {
    const pitches: number[] = [];
    const sampler = new Sampler(context, {
      sound: (ctx, hit) => (pitches.push(hit.pitch), new ConstantSourceNode(ctx)),
      rootNote: 60,
    });
    expect(sampler.noteOn(64)!.note).toBe(64);
    sampler.noteOn("C5");
    sampler.noteOn("C4", { pitch: 1 });
    expect(pitches).toEqual([4, 12, 1]);
    sampler.dispose();
  });

  test("a note struck again adds a voice; noteOff releases every voice of that note only", () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    sampler.noteOn(60);
    sampler.noteOn(60);
    const other = sampler.noteOn("D4")!;
    expect(sampler.cells.activeVoices.value).toBe(3);
    sampler.noteOff("C4");
    expect(sampler.cells.activeVoices.value).toBe(1);
    expect(other.playing.value).toBe(true);
    sampler.noteOff(62);
    expect(sampler.cells.activeVoices.value).toBe(0);
    sampler.dispose();
  });

  test("noteOff releases only held voices started by `when`: a later noteOff keeps an earlier voice's release", async () => {
    const data = await render(4, (context) => {
      const sampler = new Sampler(context, { sound: constant(0.5), release: 0.01 });
      sampler.connect(context.destination);
      sampler.noteOn(60, { when: 0 });
      sampler.noteOff(60, 1);
      sampler.noteOn(60, { when: 2 });
      sampler.noteOff(60, 3);
    });
    expect(at(data, 0.5)).toBeCloseTo(0.5, 3);
    expect(at(data, 1.5)).toBe(0);
    expect(at(data, 2.5)).toBeCloseTo(0.5, 3);
    expect(at(data, 3.5)).toBe(0);
  });

  test("noteOff does not release a voice whose noteOn is scheduled after `when`", async () => {
    const data = await render(4, (context) => {
      const sampler = new Sampler(context, { sound: constant(0.5), release: 0.01 });
      sampler.connect(context.destination);
      sampler.noteOn(60, { when: 2 });
      sampler.noteOff(60, 1);
    });
    expect(at(data, 2.5)).toBeCloseTo(0.5, 3);
    expect(at(data, 3.5)).toBeCloseTo(0.5, 3);
  });

  test("notes outside lowNote..highNote are ignored", () => {
    const sampler = new Sampler(context, { sound: constant(0.1), lowNote: 48, highNote: 72 });
    expect(sampler.noteOn(47)).toBeNull();
    expect(sampler.noteOn(73)).toBeNull();
    expect(sampler.noteOn(48)).not.toBeNull();
    expect(sampler.noteOn(72)).not.toBeNull();
    expect(sampler.cells.activeVoices.value).toBe(2);
    expect(() => sampler.noteOn(200)).toThrow('Note needs a MIDI number from 0 to 127 or a note name like "C4".');
    expect(() => sampler.noteOn("H9" as never)).toThrow("Note needs a MIDI number");
    sampler.dispose();
  });

  test("at the cap steal releases the oldest voice, or drops the new hit with steal none", () => {
    const stealing = new Sampler(context, { sound: constant(0.1), polyphony: 2 });
    const first = stealing.trigger()!;
    stealing.trigger();
    const counts: number[] = [];
    stealing.cells.activeVoices.subscribe((n) => counts.push(n));
    stealing.trigger();
    expect(first.playing.value).toBe(false);
    expect(stealing.cells.activeVoices.value).toBe(2);
    expect(counts.every((n) => n <= 2)).toBe(true);
    const dropping = new Sampler(context, { sound: constant(0.1), polyphony: 1, steal: "none" });
    expect(dropping.trigger()).not.toBeNull();
    expect(dropping.trigger()).toBeNull();
    expect(dropping.cells.activeVoices.value).toBe(1);
    stealing.dispose();
    dropping.dispose();
  });

  test("a voice that runs out is freed and the count follows", async () => {
    const sampler = new Sampler(context, { sound: dc(context, 0.05) });
    const voice = sampler.trigger()!;
    expect(sampler.cells.activeVoices.value).toBe(1);
    await expect.poll(() => voice.playing.value, { timeout: 2000 }).toBe(false);
    expect(sampler.cells.activeVoices.value).toBe(0);
    sampler.dispose();
  });

  test("stopping a voice that has not started drops it silently", async () => {
    const data = await render(0.4, (offline) => {
      const sampler = new Sampler(offline, { sound: constant(1) });
      sampler.connect(offline.destination);
      const voice = sampler.trigger({ when: 0.2 })!;
      voice.stop(0.1);
      expect(voice.playing.value).toBe(false);
      expect(sampler.cells.activeVoices.value).toBe(0);
    });
    expect(at(data, 0.3)).toBe(0);
  });

  test("stopAll fades every voice; stop is idempotent", () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    const voice = sampler.trigger()!;
    sampler.trigger();
    sampler.stopAll();
    voice.stop();
    voice.stop();
    expect(sampler.cells.activeVoices.value).toBe(0);
    sampler.dispose();
  });

  test("activeVoices is read-only and the signal option disposes the sampler", () => {
    const controller = new AbortController();
    const sampler = new Sampler(context, { sound: constant(0.1), signal: controller.signal });
    expect(() => {
      (sampler.cells.activeVoices as unknown as { value: number }).value = 3;
    }).toThrow();
    const voice = sampler.trigger()!;
    controller.abort();
    expect(voice.playing.value).toBe(false);
    expect(() => sampler.trigger()).toThrow("Sampler is disposed.");
  });

  test("hit options must be finite", () => {
    const sampler = new Sampler(context, { sound: constant(0.1) });
    expect(() => sampler.trigger({ when: NaN })).toThrow("Sound hit needs a finite time in seconds.");
    expect(() => sampler.trigger({ velocity: NaN })).toThrow("Sound hit needs a velocity from 0 to 1.");
    expect(() => sampler.trigger({ pitch: Infinity })).toThrow("Sound hit needs finite semitones for pitch.");
    sampler.dispose();
  });
});

test("the nodes of a released voice are disconnected once it rings out", async () => {
  const context = new AudioContext();
  const source = new ConstantSourceNode(context);
  const disconnect = vi.spyOn(source, "disconnect");
  const sampler = new Sampler(context, { sound: () => source, release: 0.02 });
  sampler.trigger()!.stop();
  await delay(150);
  expect(disconnect).toHaveBeenCalled();
  sampler.dispose();
  await context.close();
});

test("a later stop(when) replaces an earlier pending one, like AudioScheduledSourceNode.stop", async () => {
  const data = await render(0.6, (context) => {
    const sampler = new Sampler(context, { sound: constant(1), release: 0.01 });
    sampler.connect(context.destination);
    const voice = sampler.trigger({ when: 0 })!;
    voice.stop(0.1);
    voice.stop(0.4);
  });
  expect(at(data, 0.2)).toBeCloseTo(1, 5);
  expect(at(data, 0.5)).toBe(0);
});

describe("note-name sounds and buffer regions", () => {
  test("a note name plays the built-in triangle tone at its pitch, held until stopped, scaled by velocity once", async () => {
    const data = await render(0.3, (context) => {
      const sampler = new Sampler(context, { sound: "A4" });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0, velocity: 0.5 });
    });
    let peak = 0;
    for (let i = Math.round(0.1 * RATE); i < Math.round(0.25 * RATE); i++) peak = Math.max(peak, Math.abs(data[i]!));
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThanOrEqual(0.25 + 1e-3); // tone peak 0.5 x velocity 0.5
    let crossings = 0;
    for (let i = Math.round(0.1 * RATE); i < Math.round(0.2 * RATE); i++) if (data[i - 1]! < 0 && data[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThan(40);
    expect(crossings).toBeLessThan(48); // 440 Hz over 0.1 s
  });

  test("a note tone follows hit.pitch and decays over a finite hit duration", async () => {
    const data = await render(0.5, (context) => {
      const bus = new GainNode(context);
      bus.connect(context.destination);
      playSound(context, "A4", bus, { when: 0, velocity: 1, pitch: 12, duration: 0.1 });
    });
    let crossings = 0;
    for (let i = Math.round(0.02 * RATE); i < Math.round(0.07 * RATE); i++) if (data[i - 1]! < 0 && data[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(42); // ~880 Hz over 0.05 s
    expect(at(data, 0.3)).toBe(0);
  });

  test("a buffer plays from offset for duration, like AudioBufferSourceNode.start", async () => {
    const data = await render(0.5, (context) => {
      const buffer = context.createBuffer(1, Math.round(0.4 * RATE), RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = i < 0.1 * RATE ? 0.2 : 0.8;
      const sampler = new Sampler(context, { sound: buffer });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0, offset: 0.15, duration: 0.1 });
    });
    expect(at(data, 0.05)).toBeCloseTo(0.8, 5);
    expect(at(data, 0.2)).toBe(0);
  });

  test("without duration a buffer plays from offset to its end", async () => {
    const data = await render(0.5, (context) => {
      const sampler = new Sampler(context, { sound: dc(context, 0.2) });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0, offset: 0.1 });
    });
    expect(at(data, 0.05)).toBeCloseTo(1, 5);
    expect(at(data, 0.15)).toBe(0);
  });

  test("duration becomes hit.duration for a factory, which is held that long then released", async () => {
    const seen: number[] = [];
    const data = await render(0.5, (context) => {
      const sampler = new Sampler(context, { sound: (ctx, hit) => (seen.push(hit.duration), new ConstantSourceNode(ctx)), release: 0.01 });
      sampler.connect(context.destination);
      sampler.trigger({ when: 0, duration: 0.1 });
    });
    expect(seen).toEqual([0.1]);
    expect(at(data, 0.05)).toBeCloseTo(1, 5);
    expect(at(data, 0.2)).toBe(0);
  });

  test("offset and duration must be finite seconds from 0", () => {
    const context = new OfflineAudioContext(1, 128, RATE);
    const sampler = new Sampler(context, { sound: dc(context, 0.1) });
    expect(() => sampler.trigger({ offset: -1 })).toThrow("Sound hit needs finite seconds from 0 for offset and duration.");
    expect(() => sampler.trigger({ duration: NaN })).toThrow("Sound hit needs finite seconds from 0 for offset and duration.");
  });
});
