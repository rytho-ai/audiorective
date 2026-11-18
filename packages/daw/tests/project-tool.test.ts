import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { Project, unityClipEnvelope, type ClipEnvelope, type RackPreset } from "@audiorective/daw/project";
import { openDawProject, saveDawProject } from "@audiorective/daw/dawproject";

const sources = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

test("the project tool runs with no browser audio globals", () => {
  expect(typeof AudioContext).toBe("undefined");
  expect(typeof OfflineAudioContext).toBe("undefined");
  expect(typeof document).toBe("undefined");
});

test("open, move a clip to bar 9, save and reopen keeps media, envelope and rack preset", () => {
  const rate = 8000;
  const envelope: ClipEnvelope = { gain: 0.5, fadeIn: 0.25, fadeOut: 0.25 };
  const preset: RackPreset = {
    effects: [{ id: "lp", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1200, q: 0.8 }],
    macros: [
      { id: "tone", label: "Tone", value: 0.25, targets: [{ slotId: "lp", parameter: "frequency", min: 200, max: 8000, scale: "exponential" }] },
    ],
  };

  const project = new Project({ title: "Tool", bpm: 120, signature: [4, 4] });
  const audio = project.addTrack("Audio", "audio");
  const midi = project.addTrack("Keys", "midi");
  const pcm = Float32Array.from({ length: rate }, (_, index) => Math.sin((index / rate) * 2 * Math.PI * 220) * 0.5);
  project.addAudioClip(audio.id, { sampleRate: rate, channels: [pcm] }, 0, { envelope });
  project.addMidiClip(midi.id, { duration: 4, notes: [{ id: "n1", start: 0, end: 1, pitch: 60, velocity: 90, channel: 0, track: 0 }] }, 0, {
    timeUnit: "beats",
  });
  project.setTrackRackPreset(audio.id, preset);

  const first = openDawProject(saveDawProject(project));
  expect(first.warnings).toEqual([]);
  const [audioTrack, midiTrack] = first.project.tracks;
  const audioClip = audioTrack.clips[0];
  const midiClip = midiTrack.clips[0];
  expect(audioClip.kind).toBe("audio");
  expect(midiClip.kind).toBe("midi");

  // Bar 9 at 4/4 is beat 32: audio clips are placed in seconds (16 s at 120 bpm), beat-unit MIDI clips in beats.
  first.project.moveClip(audioClip.id, audioTrack.id, first.project.tempoMap.beatToSeconds(32));
  first.project.moveClip(midiClip.id, midiTrack.id, 32);

  const second = openDawProject(saveDawProject(first.project));
  const [audioAfter, midiAfter] = second.project.tracks;
  expect(audioAfter.id).toBe(audioTrack.id);
  expect(midiAfter.id).toBe(midiTrack.id);
  expect(audioAfter.clips[0].id).toBe(audioClip.id);
  expect(audioAfter.clips[0].time).toBeCloseTo(16, 9);
  expect(midiAfter.clips[0].id).toBe(midiClip.id);
  expect(midiAfter.clips[0].time).toBeCloseTo(32, 9);
  const reopened = audioAfter.clips[0];
  if (reopened.kind !== "audio") throw new Error("expected an audio clip");
  expect(reopened.sampleRate).toBe(rate);
  expect(reopened.envelope ?? unityClipEnvelope).toEqual(envelope);
  expect(audioAfter.effects).toEqual(preset.effects);
  expect(audioAfter.effectMacros).toEqual(preset.macros);
});

test("project and dawproject entries import no browser-runtime packages", () => {
  const forbidden = /from "@audiorective\/(blocks|host|clock|widgets|effects)(?!\/rack-preset")[^"]*"/;
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    expect(text.match(forbidden), file).toBeNull();
    for (const [, specifier] of text.matchAll(/from "(\.[^"]+)"/g)) visit(resolve(dirname(file), `${specifier}.ts`));
  };
  visit(resolve(sources, "project.ts"));
  visit(resolve(sources, "dawproject.ts"));
  expect([...seen].some((file) => file.endsWith("runtime.ts"))).toBe(false);
});
