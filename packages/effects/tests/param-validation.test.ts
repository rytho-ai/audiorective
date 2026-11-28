import { describe, expect, it } from "vitest";
import { Filter, Phaser, PitchShift } from "../src";

const ctx = () => new OfflineAudioContext(2, 4410, 44100);

describe("effect params refuse values the audio graph cannot take", () => {
  it("Filter type: an unknown type throws and the param keeps the type the filter plays", () => {
    const f = new Filter(ctx(), { type: "lowpass" });
    expect(() => ((f.params.type as { value: string }).value = "bogus")).toThrow('Effect: invalid filter type "bogus".');
    expect(f.params.type.value).toBe("lowpass");
    f.params.type.value = "highpass";
    expect(f.params.type.value).toBe("highpass");
  });

  it("Phaser baseFrequency and octaves: a non-finite sweep throws, keeps the value and later writes still retune", () => {
    const p = new Phaser(ctx(), { baseFrequency: 350, octaves: 3 });
    expect(() => (p.params.baseFrequency.value = NaN)).toThrow("Phaser needs a baseFrequency that gives a finite sweep, got NaN.");
    expect(() => (p.params.octaves.value = Infinity)).toThrow("Phaser needs octaves that give a finite sweep, got Infinity.");
    expect(() => (p.params.octaves.value = 2000)).toThrow(RangeError);
    expect(p.params.baseFrequency.value).toBe(350);
    expect(p.params.octaves.value).toBe(3);
    p.params.baseFrequency.value = 500;
    p.params.octaves.value = 2;
    expect([p.params.baseFrequency.value, p.params.octaves.value]).toEqual([500, 2]);
  });

  it("PitchShift pitch: NaN throws and keeps the value", () => {
    const s = new PitchShift(ctx());
    expect(() => (s.params.pitch.value = NaN)).toThrow("PitchShift needs a finite pitch in semitones, got NaN.");
    expect(s.params.pitch.value).toBe(0);
    s.params.pitch.value = 3;
    expect(s.params.pitch.value).toBe(3);
  });
});
