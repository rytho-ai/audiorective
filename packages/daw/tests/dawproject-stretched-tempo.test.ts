import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { Project, openDawProject, saveDawProject } from "../src";
import type { AudioClip } from "../src";
import { parseTree, projectXmlOf } from "./helpers/xml-tree";
import type { Tree } from "./helpers/xml-tree";
import { xsdViolations } from "./helpers/xsd";

const RATE = 1000;
const ORIGINAL = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 37));
const audio = (frames: number, rate = RATE) => ({ sampleRate: rate, channels: [new Float32Array(frames).fill(0.25)] });

const warpsOf = (archive: Uint8Array) => {
  const out: Array<Array<[number, number]>> = [];
  const walk = (tree: Tree) => {
    if (tree.tag === "Warps") out.push(tree.children.filter((c) => c.tag === "Warp").map((c) => [Number(c.attrs.time), Number(c.attrs.contentTime)]));
    tree.children.forEach(walk);
  };
  walk(parseTree(projectXmlOf(archive)));
  return out;
};

type Variant = {
  name: string;
  changes: Array<{ beat: number; bpm: number }>;
  anchors?: boolean;
  after?: boolean;
  at?: number;
  ratio?: number;
  rate?: number;
};
// 4 s of audio at 100 BPM, placed at 1.2 s (beat 2): 1.25x stretch is 5 s = beats 2 to 10 at 100 BPM.
const variants: Variant[] = [
  { name: "no tempo change", changes: [] },
  { name: "tempo change inside", changes: [{ beat: 5, bpm: 130 }] },
  { name: "tempo change at the clip start", changes: [{ beat: 2, bpm: 130 }] },
  // At 100 BPM the clip lasts 5 s from 1.2 s, so it ends on beat 12.333...; 74/6 is the same place to the last digit.
  { name: "tempo change at the clip end", changes: [{ beat: 12 + 1 / 3, bpm: 130 }] },
  // 1.474 s is not on a beat: the marker the writer states to 12 digits and the exact tempo change are one place, a rounding apart.
  { name: "tempo change on a beat the 12-digit marker rounds", changes: [{ beat: 3, bpm: 117 }], at: 1.474, ratio: 0.8, rate: 48_000 },
  {
    name: "two tempo changes inside",
    changes: [
      { beat: 4, bpm: 130 },
      { beat: 7, bpm: 80 },
    ],
  },
  { name: "anchors plus a tempo change", changes: [{ beat: 5, bpm: 130 }], anchors: true },
  { name: "tempo change added after the stretch", changes: [{ beat: 5, bpm: 130 }], after: true },
];

describe("a stretched clip with tempo changes reopens", () => {
  for (const variant of variants) {
    test(variant.name, async () => {
      const project = new Project({ bpm: 100 });
      const track = project.addTrack("T", "audio");
      if (!variant.after) project.setTempoChanges(variant.changes);
      const rate = variant.rate ?? RATE;
      const ratio = variant.ratio ?? 1.25;
      const source = variant.rate ? new Float32Array(rate * 2) : ORIGINAL;
      const clip = project.addAudioClip(track.id, { sampleRate: rate, channels: [source] }, variant.at ?? 1.2);
      const anchors = variant.anchors ? [{ sourceFrame: 1000, outputFrame: 1000 }] : [];
      const stretched = project.applyAudioClipStretch(clip, ratio, audio(Math.round(source.length * ratio), rate), anchors);
      if (variant.after) project.setTempoChanges(variant.changes);
      const saved = saveDawProject(project);
      for (const warps of warpsOf(saved)) {
        for (let i = 1; i < warps.length; i++) {
          expect(warps[i][0]).toBeGreaterThan(warps[i - 1][0]);
          expect(warps[i][1]).toBeGreaterThan(warps[i - 1][1]);
        }
      }
      expect(await xsdViolations([{ name: "x", bytes: saved }])).toEqual([]);
      const { project: reopened, warnings } = openDawProject(saved);
      expect(warnings.join()).not.toMatch(/Audio clip/);
      const back = reopened.tracks[0].clips[0] as AudioClip;
      const now = project.tracks[0].clips[0] as AudioClip;
      expect(back.time).toBeCloseTo(now.time, 6);
      expect(back.duration).toBeCloseTo(now.duration, 6);
      expect(back.stretch?.ratio).toBeCloseTo(ratio, 6);
      expect(back.stretch?.anchors).toEqual(now.stretch?.anchors);
      expect(back.channels[0]).toEqual(stretched.channels[0]);
      reopened.dispose();
      project.dispose();
    });
  }
});

describe("a clip a Bitwig file stretched, with a tempo change added by the app", () => {
  const B = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/dawproject/b-bitwig-native.dawproject", import.meta.url))));
  // b-bitwig-native: 4 s of audio over beats 1 to 9 at 100 BPM. A marker at clip beat 4 (project beat 5) is one anchor.
  const withMarker = () => {
    const entries = unzipSync(B);
    const xml = strFromU8(entries["project.xml"]).replace(
      /<Warp time="0.0" contentTime="0.0"\/>\s*<Warp time="8.0" contentTime="4.0"\/>/,
      '<Warp time="0.0" contentTime="0.0"/><Warp time="4.0" contentTime="1.0"/><Warp time="8.0" contentTime="4.0"/>',
    );
    // The file's own tempo automation is held steps, the form the model can write back.
    entries["project.xml"] = strToU8(
      xml.replace(
        '<RealPoint value="100.000000" interpolation="linear" time="0.000000"/>',
        '<RealPoint value="100.000000" interpolation="hold" time="0.000000"/><RealPoint value="120.000000" interpolation="hold" time="30.000000"/>',
      ),
    );
    return zipSync(entries);
  };
  for (const changes of [
    [{ beat: 5, bpm: 130 }],
    [{ beat: 3, bpm: 130 }],
    [{ beat: 1, bpm: 130 }],
    [{ beat: 9, bpm: 130 }],
    [
      { beat: 4.5, bpm: 90 },
      { beat: 5, bpm: 130 },
    ],
  ]) {
    test(`a tempo change at ${changes.map((c) => c.beat).join(" and ")} saves a file that reopens`, async () => {
      const { project } = openDawProject(withMarker());
      const before = project.tracks[0].clips[0] as AudioClip;
      project.setTempoChanges([...changes, { beat: 30, bpm: 120 }]);
      const saved = saveDawProject(project);
      expect(await xsdViolations([{ name: "x", bytes: saved }])).toEqual([]);
      const { project: reopened, warnings } = openDawProject(saved);
      expect(warnings.join()).not.toMatch(/Audio clip/);
      const back = reopened.tracks[0].clips[0] as AudioClip;
      expect(back.stretch?.anchors).toEqual((project.tracks[0].clips[0] as AudioClip).stretch?.anchors);
      expect(back.duration).toBeCloseTo(before.duration, 6);
      reopened.dispose();
      project.dispose();
    });
  }
});
