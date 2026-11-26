import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Project, encodeWavBytes, openDawProject, saveDawProject } from "../src";
import { adoptRenderedStretch } from "../src/model";
import { renderMatches } from "../src/internal/stretch-render";
import type { AudioClip } from "../src";
import { takeOpenedStretches } from "../src/internal/open-stretch";
import { decodeWav } from "../src/internal/wav";
import { xsdViolations } from "./helpers/xsd";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";
import type { Tree } from "./helpers/xml-tree";

/**
 * Audio stretched by warp markers, as Bitwig Studio writes it (tests/fixtures/dawproject/SOURCES.md). `b-bitwig-native` holds 4.000 s of 44.1 kHz
 * audio (clicks at 0.5, 1.5, 2.5, 3.5 s) over 8 beats at 100 BPM, 4.8 s: ratio 1.2. The README fixture is 2.8235 s over 8.00003 beats at 149 BPM.
 */
const dir = new URL("./fixtures/dawproject/", import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(name, dir))));
const B = file("b-bitwig-native.dawproject");
const RATE = 44_100;

const audioClips = (project: Project) => project.tracks.flatMap((track) => track.clips).filter((clip): clip is AudioClip => clip.kind === "audio");
const only = (project: Project) => {
  const clips = audioClips(project);
  expect(clips).toHaveLength(1);
  return clips[0];
};
const editXml = (archive: Uint8Array, edit: (xml: string) => string) => {
  const entries = unzipSync(archive);
  entries["project.xml"] = strToU8(edit(strFromU8(entries["project.xml"])));
  return zipSync(entries);
};
const WARPS = /<Warp time="0.0" contentTime="0.0"\/>\s*<Warp time="8.0" contentTime="4.0"\/>/;
const warpsOf = (archive: Uint8Array) => {
  const found: Array<{ audio: Tree; points: Array<[number, number]>; path: string }> = [];
  const walk = (tree: Tree) => {
    if (tree.tag === "Warps") {
      const audio = (function find(node: Tree): Tree | undefined {
        return node.tag === "Audio" ? node : node.children.map(find).find(Boolean);
      })(tree)!;
      found.push({
        audio,
        path: audio.children[0].attrs.path,
        points: tree.children.filter((child) => child.tag === "Warp").map((point) => [Number(point.attrs.time), Number(point.attrs.contentTime)]),
      });
    }
    tree.children.forEach(walk);
  };
  walk(parseTree(projectXmlOf(archive)));
  return found;
};
/** Frames where a click starts: the first sample of each run above the threshold. */
function clicks(channel: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < channel.length; i++) if (Math.abs(channel[i]) > 0.2 && (out.length === 0 || i - out[out.length - 1] > 2000)) out.push(i);
  return out;
}
const renderWavs = (archive: Uint8Array) => Object.keys(unzipSync(archive)).filter((path) => path.startsWith("audiorective/render/"));
const violations = (archive: Uint8Array) => xsdViolations([{ name: "x", bytes: archive }]);

describe("a clip stretched by Bitwig's warp markers", { timeout: 60_000 }, () => {
  test("b-bitwig-native at its own 100 BPM: ratio 1.2, 4.8 s, the original 4 s window, a varispeed placeholder of exact length", () => {
    const { project, warnings } = openDawProject(B);
    expect(warnings.join()).not.toMatch(/Audio clip/);
    const clip = only(project);
    expect(clip.stretch?.ratio).toBeCloseTo(1.2, 9);
    expect(clip.stretch?.anchors).toBeUndefined();
    expect(clip.sampleRate).toBe(RATE);
    expect(clip.time).toBeCloseTo(0.6, 9);
    expect(clip.duration).toBeCloseTo(4.8, 9);
    expect(clip.channels[0]).toHaveLength(211_680);
    expect(clip.stretch?.source.channels?.[0]).toHaveLength(176_400);
    expect([clip.stretch?.source.sourceOffset, clip.stretch?.source.sourceLength]).toEqual([0, 4]);
    // The clicks of the original sit at 0.5, 1.5, 2.5 and 3.5 s; the placeholder has them at frame * 1.2 (a tolerance of 2 frames).
    const original = clicks(clip.stretch!.source.channels![0]);
    expect(original).toHaveLength(4);
    original.forEach((frame, i) => expect(Math.abs(frame - RATE * (0.5 + i))).toBeLessThanOrEqual(2));
    const placeholder = clicks(clip.channels[0]);
    expect(placeholder).toHaveLength(4);
    placeholder.forEach((frame, i) => expect(Math.abs(frame - original[i] * 1.2)).toBeLessThanOrEqual(2));
    // The file asks for a pitch-preserving stretch, so the clip waits for the runtime's render.
    expect(takeOpenedStretches(project)).toHaveLength(1);
    project.dispose();
  });

  test("the Bitwig README fixture: 2.8235 s over 8.00003 beats at 149 BPM is ratio 1.141 and 3.2216 s", () => {
    const archive = zipSync({
      "project.xml": file("bitwig-readme/project.xml"),
      "metadata.xml": strToU8("<MetaData><Title>README</Title></MetaData>"),
      "audio/Drumfunk3 170bpm.wav": encodeWavBytes({ sampleRate: 48_000, channels: [new Float32Array(135_530), new Float32Array(135_530)] }),
    });
    const { project } = openDawProject(archive);
    const clip = only(project);
    const seconds = (8.00003433227539 * 60) / 149;
    expect(clip.duration).toBeCloseTo(seconds, 4);
    expect(clip.duration).toBeCloseTo(3.2216, 3);
    expect(clip.stretch?.ratio).toBeCloseTo(seconds / (135_530 / 48_000), 5);
    expect(clip.stretch?.ratio).toBeCloseTo(1.141, 3);
    expect(clip.channels[0]).toHaveLength(Math.round(clip.duration * 48_000));
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(archive)), parseTree(projectXmlOf(saved)))).toEqual([]);
    project.dispose();
  });

  test("two warp slopes make one anchor, and the placeholder puts each click where its segment's speed says", () => {
    // 4 beats (2.4 s) for the first 1 s of audio, then 4 beats for the next 3 s: ratios 2.4 and 0.8.
    const archive = editXml(B, (xml) =>
      xml.replace(WARPS, '<Warp time="0.0" contentTime="0.0"/><Warp time="4.0" contentTime="1.0"/><Warp time="8.0" contentTime="4.0"/>'),
    );
    const { project } = openDawProject(archive);
    const clip = only(project);
    expect(clip.stretch?.anchors).toEqual([{ sourceFrame: 44_100, outputFrame: 105_840 }]);
    expect(clip.stretch?.ratio).toBeCloseTo(1.2, 9);
    expect(clip.channels[0]).toHaveLength(211_680);
    const [first, second, third] = clicks(clip.channels[0]);
    // 0.5 s of audio in the first segment (x2.4), 1.5 s and 2.5 s in the second (x0.8 after the anchor).
    expect(Math.abs(first - 52_920)).toBeLessThanOrEqual(2);
    expect(Math.abs(second - (105_840 + (66_150 - 44_100) * 0.8))).toBeLessThanOrEqual(2);
    expect(Math.abs(third - (105_840 + (110_250 - 44_100) * 0.8))).toBeLessThanOrEqual(2);
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(archive)), parseTree(projectXmlOf(saved)))).toEqual([]);
    project.dispose();
  });

  test("a tempo change inside the clip is an anchor: the same warp steady in beats is not steady in seconds", () => {
    // 100 BPM for beats 0 to 5, then 200 BPM; the clip lies on beats 1 to 9 with the steady warp 8 beats : 4 s.
    const archive = editXml(B, (xml) =>
      xml.replace(
        '<RealPoint value="100.000000" interpolation="linear" time="0.000000"/>',
        '<RealPoint value="100.000000" interpolation="hold" time="0.000000"/><RealPoint value="200.000000" interpolation="hold" time="5.000000"/>',
      ),
    );
    const { project } = openDawProject(archive);
    expect(project.tempoMap.changes).toEqual([{ beat: 5, bpm: 200 }]);
    const clip = only(project);
    // Beats 1 to 5 last 2.4 s and play 2 s of audio; beats 5 to 9 last 1.2 s and play the other 2 s.
    expect(clip.stretch?.anchors).toEqual([{ sourceFrame: 88_200, outputFrame: 105_840 }]);
    expect(clip.duration).toBeCloseTo(3.6, 9);
    expect(clip.stretch?.ratio).toBeCloseTo(0.9, 9);
    const saved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(archive)), parseTree(projectXmlOf(saved)))).toEqual([]);
    // Moved, the clip keeps its seconds and its Warps are written in beats from the tempo map, with a point where the tempo changes.
    project.moveClip(clip.id, project.tracks[1].id, 0);
    const moved = saveDawProject(project);
    const [warp] = warpsOf(moved);
    // The clip's own change of speed (an anchor at 2.4 s) and the song's tempo change (3 s into the clip now) are both points.
    expect(warp.points.map(([, content]) => content)).toEqual([0, 2, 3, 4]);
    warp.points.forEach(([time], i) => expect(time).toBeCloseTo([0, 4, 5, 7][i], 9));
    const reopened = openDawProject(moved);
    const again = only(reopened.project);
    expect(again.stretch?.anchors).toEqual(clip.stretch?.anchors);
    expect(again.duration).toBeCloseTo(clip.duration, 9);
    expect(again.time).toBeCloseTo(0, 9);
    reopened.project.dispose();
    project.dispose();
  });

  test("an algorithm other than stretch plays by varispeed on purpose: it has no render waiting", () => {
    const { project } = openDawProject(editXml(B, (xml) => xml.replace('algorithm="stretch"', 'algorithm="raw"')));
    expect(only(project).stretch?.ratio).toBeCloseTo(1.2, 9);
    expect(takeOpenedStretches(project)).toHaveLength(0);
    // Saved untouched, the file keeps its algorithm.
    expect(strFromU8(unzipSync(saveDawProject(project))["project.xml"])).toContain('algorithm="raw"');
    project.dispose();
  });

  test("moving the clip changes its time only; trimming and resizing rewrite its Warps from the time map, in the form and for the file Bitwig wrote", async () => {
    const { project } = openDawProject(B);
    const clip = only(project);
    project.moveClip(clip.id, project.tracks[1].id, clip.time + 2.4);
    const moved = saveDawProject(project);
    expect(treeDifferences(parseTree(projectXmlOf(B)), parseTree(projectXmlOf(moved)))).toEqual([expect.stringMatching(/Clip\[0\]@time$/)]);
    expect(warpsOf(moved)[0].audio.attrs.algorithm).toBe("stretch");
    expect(await violations(moved)).toEqual(await violations(B));
    const reopened = openDawProject(moved);
    expect(only(reopened.project).time).toBeCloseTo(3, 9);
    expect(only(reopened.project).stretch?.ratio).toBeCloseTo(1.2, 9);
    reopened.project.dispose();

    // Cut 1.2 s from each edge: the window is source 1 s to 3 s, 2.4 s of the timeline, 4 beats.
    const cut = project.resizeClip(clip.id, { start: clip.time + 2.4 + 1.2, end: clip.time + 2.4 + 3.6 }) as AudioClip;
    expect(cut.duration).toBeCloseTo(2.4, 9);
    expect(cut.stretch?.source).toMatchObject({ sourceOffset: 1, sourceLength: 4 });
    const trimmed = saveDawProject(project);
    const [warp] = warpsOf(trimmed);
    expect(warp.path).toBe("audio/click44.wav");
    expect(warp.points).toEqual([
      [0, 1],
      [4, 3],
    ]);
    expect(unzipSync(trimmed)["audio/click44.wav"]).toEqual(unzipSync(B)["audio/click44.wav"]);
    expect(Object.keys(unzipSync(trimmed)).filter((path) => path.startsWith("audio/"))).toEqual(["audio/click44.wav"]);
    expect(await violations(trimmed)).toEqual(await violations(B));
    const again = openDawProject(trimmed);
    const reopenedCut = only(again.project);
    expect(reopenedCut.stretch?.ratio).toBeCloseTo(1.2, 9);
    expect(reopenedCut.stretch?.source).toMatchObject({ sourceOffset: 1, sourceLength: 4 });
    expect(reopenedCut.duration).toBeCloseTo(2.4, 9);
    expect(reopenedCut.time).toBeCloseTo(cut.time, 9);
    // A second save of the reopened file is the same tree.
    expect(treeDifferences(parseTree(projectXmlOf(trimmed)), parseTree(projectXmlOf(saveDawProject(again.project))))).toEqual([]);
    again.project.dispose();
    project.dispose();
  });

  test("a split, a duplicate, fades, gain and a name keep the nested form and the original file", async () => {
    const { project } = openDawProject(B);
    const clip = only(project);
    project.setAudioClipEnvelope(clip.id, { gain: 0.5, fadeIn: 0.3, fadeOut: 0.2 });
    project.setClipName(clip.id, "Loop");
    const [head, tail] = project.splitClip(clip.id, 2.4);
    const copy = project.duplicateClip(tail.id, 20);
    expect([head.id, tail.id, copy.id]).toHaveLength(3);
    const saved = saveDawProject(project);
    const warps = warpsOf(saved);
    expect(warps).toHaveLength(3);
    for (const warp of warps) {
      expect(warp.path).toBe("audio/click44.wav");
      expect(warp.audio.attrs.algorithm).toBe("stretch");
    }
    expect(warps.map((warp) => warp.points)).toEqual([
      [
        [0, 0],
        [4, 2],
      ],
      [
        [0, 2],
        [4, 4],
      ],
      [
        [0, 2],
        [4, 4],
      ],
    ]);
    expect(await violations(saved)).toEqual(await violations(B));
    const reopened = openDawProject(saved);
    const clips = audioClips(reopened.project);
    expect(clips).toHaveLength(3);
    expect(clips.map((item) => item.stretch?.ratio)).toEqual([expect.closeTo(1.2, 9), expect.closeTo(1.2, 9), expect.closeTo(1.2, 9)]);
    expect(reopened.project.clipName(clips[0].id)).toBe("Loop");
    expect(clips[0].envelope?.gain).toBe(0.5);
    reopened.project.dispose();
    project.dispose();
  });

  test("removing the clip removes it from the file", () => {
    const { project } = openDawProject(B);
    project.removeClip(only(project).id);
    const saved = saveDawProject(project);
    expect(warpsOf(saved)).toHaveLength(0);
    project.dispose();
  });
});

describe("a clip stretched in the app", () => {
  const original = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((i / 48) * Math.PI * 2));
  const stretchedProject = (anchors: Array<{ sourceFrame: number; outputFrame: number }> = [], ratio = 1.25) => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 48_000, channels: [original] }, 1);
    const rendered = { sampleRate: 48_000, channels: [new Float32Array(Math.round(original.length * ratio)).fill(0.25)] };
    return { project, clip: project.applyAudioClipStretch(clip, ratio, rendered, anchors) };
  };

  test("is written as the original audio with Warps and algorithm stretch, and reopens with the same ratio", async () => {
    const { project, clip } = stretchedProject();
    const saved = saveDawProject(project);
    const files = unzipSync(saved);
    // The original is the file; the render stays in the Audiorective folder, where other DAWs do not look.
    expect(Object.keys(files).filter((path) => path.includes(".wav"))).toEqual([`audio/${clip.id}.wav`, `audiorective/render/${clip.id}.wav`]);
    expect(Object.keys(files).some((path) => path.startsWith("audiorective/source/"))).toBe(false);
    // The file holds the original frames, not the render.
    expect(decodeWav(files[`audio/${clip.id}.wav`]).channels[0]).toEqual(original);
    const [warp] = warpsOf(saved);
    expect(warp.audio.attrs).toMatchObject({ algorithm: "stretch", sampleRate: "48000", duration: "0.1" });
    // 6000 frames = 0.125 s of 120 BPM timeline = 0.25 beats.
    expect(warp.points[0]).toEqual([0, 0]);
    expect(warp.points[1][0]).toBeCloseTo(0.25, 9);
    expect(warp.points[1][1]).toBeCloseTo(0.1, 9);
    expect(await violations(saved)).toEqual([]);
    const reopened = openDawProject(saved).project;
    const again = only(reopened);
    expect(again.stretch?.ratio).toBe(1.25);
    expect(again.stretch?.anchors).toBeUndefined();
    expect([again.time, again.duration]).toEqual([clip.time, clip.duration]);
    expect(again.stretch?.source.channels?.[0]).toEqual(original);
    expect(again.id).toBe(clip.id);
    reopened.dispose();
    project.dispose();
  });

  test("keeps its anchors through a save", () => {
    const anchors = [{ sourceFrame: 2400, outputFrame: 4000 }];
    const { project, clip } = stretchedProject(anchors);
    const reopened = openDawProject(saveDawProject(project)).project;
    const again = only(reopened);
    expect(again.stretch?.anchors).toEqual(anchors);
    expect(again.stretch?.ratio).toBe(1.25);
    expect(again.duration).toBe(clip.duration);
    reopened.dispose();
    project.dispose();
  });

  test("a tempo change after the stretch keeps the clip's seconds and ratio; the Warps are written in beats at the new tempo", () => {
    const { project, clip } = stretchedProject();
    project.setTempoChanges([{ beat: 1.5, bpm: 60 }]);
    const saved = saveDawProject(project);
    // The clip lasts 0.125 s from 1 s, after the tempo fell to 60 BPM at 0.75 s: one second is one beat there.
    const [warp] = warpsOf(saved);
    expect(warp.points[1][0]).toBeCloseTo(0.125, 9);
    expect(warp.points[1][1]).toBeCloseTo(0.1, 9);
    const reopened = openDawProject(saved).project;
    const again = only(reopened);
    expect(again.time).toBeCloseTo(clip.time, 9);
    expect(again.duration).toBeCloseTo(clip.duration, 9);
    expect(again.stretch?.ratio).toBe(1.25);
    reopened.dispose();
    project.dispose();
  });
});

describe("a file written before the stretch moved into the warp (the render and a sidecar)", () => {
  test("still opens with the render as playback, the original as source and the ratio", () => {
    const original = Float32Array.from({ length: 40 }, (_, i) => i / 40);
    const rendered = Float32Array.from({ length: 80 }, (_, i) => i / 80);
    const project = new Project();
    const track = project.addTrack("Track", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 100, channels: [rendered] }, 1);
    const entries = unzipSync(saveDawProject(project));
    const state = JSON.parse(strFromU8(entries["audiorective/state.json"]));
    state.clips[0].stretchRatio = 2;
    entries["audiorective/state.json"] = strToU8(JSON.stringify(state));
    entries[`audiorective/source/${clip.id}.wav`] = encodeWavBytes({ sampleRate: 100, channels: [original] });
    const opened = openDawProject(zipSync(entries));
    const again = only(opened.project);
    expect(again.stretch?.ratio).toBe(2);
    again.stretch?.source.channels?.[0].forEach((sample, i) => expect(Math.abs(sample - original[i])).toBeLessThan(1e-3));
    expect(again.channels[0]).toHaveLength(80);
    again.channels[0].forEach((sample, i) => expect(Math.abs(sample - rendered[i])).toBeLessThan(1e-3));
    expect(again.duration).toBe(0.8);
    expect(takeOpenedStretches(opened.project)).toHaveLength(0);
    // Saved again it is the new form with its render beside it, and reopens with the same ratio and the same samples.
    const resaved = saveDawProject(opened.project);
    expect(warpsOf(resaved)).toHaveLength(1);
    expect(renderWavs(resaved)).toHaveLength(1);
    const reopened = openDawProject(resaved).project;
    expect(only(reopened).stretch?.ratio).toBe(2);
    expect(only(reopened).channels).toEqual(again.channels);
    expect(takeOpenedStretches(reopened)).toHaveLength(0);
    reopened.dispose();
    opened.project.dispose();
    project.dispose();
  });
});

describe("the render of a clip stretched in the app travels in the file's own folder", () => {
  const original = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((i / 48) * Math.PI * 2));
  /** A render that is not flat, so a wrong sample shows. */
  const render = (frames: number) => ({ sampleRate: 48_000, channels: [Float32Array.from({ length: frames }, (_, i) => Math.sin(i / 11) * 0.4)] });
  const stretched = (ratio = 1.25, anchors: Array<{ sourceFrame: number; outputFrame: number }> = []) => {
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Take", "audio");
    const clip = project.addAudioClip(track.id, { sampleRate: 48_000, channels: [original] }, 1);
    const done = project.applyAudioClipStretch(clip, ratio, render(Math.round(original.length * ratio)), anchors);
    return { project, clip: done };
  };
  const without = (archive: Uint8Array, drop: (path: string) => boolean) => {
    const entries = unzipSync(archive);
    for (const path of Object.keys(entries)) if (drop(path)) delete entries[path];
    return zipSync(entries);
  };
  const waiting = (archive: Uint8Array) => {
    const { project, warnings } = openDawProject(archive);
    const clip = only(project);
    return { project, clip, warnings, queued: takeOpenedStretches(project).length };
  };

  test("a reader with no engine plays the same samples: no placeholder, no engine call, no warning", () => {
    const { project, clip } = stretched();
    const saved = saveDawProject(project);
    expect(renderWavs(saved)).toEqual([`audiorective/render/${clip.id}.wav`]);
    const record = JSON.parse(strFromU8(unzipSync(saved)["audiorective/state.json"])).clips[0].render;
    expect(record).toMatchObject({
      source: `audio/${clip.id}.wav`,
      from: 0,
      length: 4800,
      frames: 6000,
      rate: 48_000,
      channels: 1,
      ratio: 1.25,
      anchors: [],
    });
    expect(record.hash).toMatch(/^[0-9a-f]{8}$/);
    const opened = waiting(saved);
    expect(opened.queued).toBe(0);
    expect(opened.warnings).toEqual([]);
    expect(opened.clip.channels).toEqual(clip.channels);
    expect(opened.clip.stretch?.ratio).toBe(1.25);
    expect(opened.clip.stretch?.source.channels?.[0]).toEqual(original);
    // Saved again, the render is stored again and still matches.
    const again = saveDawProject(opened.project);
    expect(waiting(again).clip.channels).toEqual(clip.channels);
    opened.project.dispose();
    project.dispose();
  });

  test("anchors travel with the render and an anchored clip reopens with the same samples", () => {
    const { project, clip } = stretched(1.25, [{ sourceFrame: 2400, outputFrame: 4000 }]);
    const opened = waiting(saveDawProject(project));
    expect(opened.queued).toBe(0);
    expect(opened.clip.stretch?.anchors).toEqual([{ sourceFrame: 2400, outputFrame: 4000 }]);
    expect(opened.clip.channels).toEqual(clip.channels);
    opened.project.dispose();
    project.dispose();
  });

  test("a warp point the file adds on the same line is the same map; one off the line is not", () => {
    const render = {
      path: "audiorective/render/x.wav",
      offset: 0,
      frames: 6000,
      rate: 48_000,
      channels: 1,
      source: "audio/x.wav",
      from: 0,
      length: 4800,
    };
    const stored = { ...render, ratio: 1.25, anchors: [] };
    const now = { source: "audio/x.wav", from: 0, length: 4800, output: 6000, rate: 48_000, channels: 1 };
    const hash = () => "";
    expect(renderMatches(stored, { ...now, anchors: [] }, hash)).toBe(true);
    // Where the song's tempo changes the writer adds a point; the speed there is the same.
    expect(renderMatches(stored, { ...now, anchors: [{ sourceFrame: 2400, outputFrame: 3000 }] }, hash)).toBe(true);
    expect(renderMatches(stored, { ...now, anchors: [{ sourceFrame: 2400, outputFrame: 3100 }] }, hash)).toBe(false);
    expect(renderMatches({ ...stored, anchors: [{ sourceFrame: 2400, outputFrame: 3000 }] }, { ...now, anchors: [] }, hash)).toBe(true);
    expect(renderMatches(stored, { ...now, output: 6001, anchors: [] }, hash)).toBe(false);
    expect(renderMatches(stored, { ...now, from: 1, anchors: [] }, hash)).toBe(false);
    expect(renderMatches({ ...stored, hash: "00000001" }, { ...now, anchors: [] }, hash)).toBe(false);
  });

  test("without the Audiorective folder (as Bitwig saves it) the clip is the standard form: a placeholder the engine renders, and it stores no render", () => {
    const { project, clip } = stretched();
    const bare = without(saveDawProject(project), (path) => path.startsWith("audiorective/"));
    const opened = waiting(bare);
    expect(opened.queued).toBe(1);
    expect(opened.clip.channels[0]).toHaveLength(clip.channels[0].length);
    expect(opened.clip.channels).not.toEqual(clip.channels);
    expect(opened.clip.stretch?.ratio).toBe(1.25);
    // A clip that only has the varispeed placeholder has no render to store, itself or as a piece or a copy.
    const [, tail] = opened.project.splitClip(opened.clip.id, 0.05);
    opened.project.duplicateClip(tail.id, 5);
    opened.project.duplicateClip(opened.clip.id, 7);
    expect(renderWavs(saveDawProject(opened.project))).toEqual([]);
    opened.project.dispose();
    project.dispose();
  });

  test("a render the engine made after opening is stored: the placeholder's replacement is a render", () => {
    const { project } = stretched();
    const bare = without(saveDawProject(project), (path) => path.startsWith("audiorective/"));
    const opened = waiting(bare);
    const made = render(opened.clip.channels[0].length);
    adoptRenderedStretch(opened.project, opened.clip, made);
    const saved = saveDawProject(opened.project);
    expect(renderWavs(saved)).toHaveLength(1);
    expect(waiting(saved).clip.channels).toEqual(only(opened.project).channels);
    opened.project.dispose();
    project.dispose();
  });

  describe("a render that no longer describes the file is never played", () => {
    const warped = (xml: string, from: RegExp, to: string) => {
      expect(xml).toMatch(from);
      return xml.replace(from, to);
    };
    const stale = (archive: Uint8Array) => {
      const opened = waiting(archive);
      expect(opened.queued).toBe(1);
      return opened;
    };

    test("a warp point moved", () => {
      const { project, clip } = stretched(1.25, [{ sourceFrame: 2400, outputFrame: 4000 }]);
      const saved = saveDawProject(project);
      // The middle warp point plays 0.05 s of the file; Bitwig moved it to 0.04 s.
      const moved = editXml(saved, (xml) => warped(xml, /contentTime="0\.05"/, 'contentTime="0.04"'));
      const opened = stale(moved);
      expect(opened.clip.channels).not.toEqual(clip.channels);
      opened.project.dispose();
      project.dispose();
    });

    test("the end of the window moved", () => {
      const { project, clip } = stretched();
      const moved = editXml(saveDawProject(project), (xml) => warped(xml, /contentTime="0\.1"/, 'contentTime="0.09"'));
      const opened = stale(moved);
      expect(opened.clip.channels).not.toEqual(clip.channels);
      opened.project.dispose();
      project.dispose();
    });

    test("the tempo changed, so the clip has another length", () => {
      const { project, clip } = stretched();
      const slower = editXml(saveDawProject(project), (xml) => warped(xml, /(<Tempo [^>]*value=")120(\.0*)?"/, '$160"'));
      const opened = stale(slower);
      expect(opened.clip.channels[0].length).not.toBe(clip.channels[0].length);
      opened.project.dispose();
      project.dispose();
    });

    test("the audio file was replaced by other samples of the same length", () => {
      const { project, clip } = stretched();
      const entries = unzipSync(saveDawProject(project));
      entries[`audio/${clip.id}.wav`] = encodeWavBytes({ sampleRate: 48_000, channels: [original.map((sample) => sample * 0.5)] });
      const opened = stale(zipSync(entries));
      opened.project.dispose();
      project.dispose();
    });

    test("a stale render is dropped from the file by the next save, and a damaged record is ignored", () => {
      const { project, clip } = stretched();
      const saved = saveDawProject(project);
      const entries = unzipSync(saved);
      const state = JSON.parse(strFromU8(entries["audiorective/state.json"]));
      state.clips[0].render.offset = -3;
      entries["audiorective/state.json"] = strToU8(JSON.stringify(state));
      const opened = waiting(zipSync(entries));
      expect(opened.queued).toBe(1);
      expect(opened.clip.channels).not.toEqual(clip.channels);
      expect(renderWavs(saveDawProject(opened.project))).toEqual([]);
      state.clips[0].render = { path: "audiorective/render/missing.wav" };
      entries["audiorective/state.json"] = strToU8(JSON.stringify(state));
      expect(waiting(zipSync(entries)).queued).toBe(1);
      opened.project.dispose();
      project.dispose();
    });
  });

  test("a Bitwig clip the app rendered with an engine reopens with that render and no engine, and the rest of the file is untouched", () => {
    const first = openDawProject(B);
    const placeholder = only(first.project);
    expect(takeOpenedStretches(first.project)).toHaveLength(1);
    const made = { sampleRate: RATE, channels: [Float32Array.from({ length: placeholder.channels[0].length }, (_, i) => Math.sin(i / 13) * 0.3)] };
    adoptRenderedStretch(first.project, placeholder, made);
    const rendered = only(first.project);
    const saved = saveDawProject(first.project);
    const [was, now] = [unzipSync(B), unzipSync(saved)];
    expect(treeDifferences(parseTree(projectXmlOf(B)), parseTree(projectXmlOf(saved)))).toEqual([]);
    for (const path of Object.keys(was)) if (path !== "metadata.xml" && path !== "project.xml") expect(now[path], path).toEqual(was[path]);
    expect(Object.keys(now).filter((path) => !(path in was) && !path.startsWith("audiorective/"))).toEqual([]);
    expect(renderWavs(saved)).toHaveLength(1);
    const reopened = waiting(saved);
    expect(reopened.queued).toBe(0);
    expect(reopened.warnings.join()).not.toMatch(/Audio clip/);
    expect(reopened.clip.channels).toEqual(rendered.channels);
    reopened.project.dispose();
    first.project.dispose();
  });

  test("a split and copies of a rendered clip store the render once, and every clip reopens with its own samples", () => {
    const { project, clip } = stretched();
    const copy = project.duplicateClip(clip.id, 4);
    const [, tail] = project.splitClip(clip.id, 0.05);
    const pieceCopy = project.duplicateClip(tail.id, 6);
    const saved = saveDawProject(project);
    expect(renderWavs(saved)).toHaveLength(1);
    // The one render holds no more than the clip had: header and 6000 frames of float32.
    expect(unzipSync(saved)[renderWavs(saved)[0]].length).toBe(44 + 6000 * 4);
    const reopened = openDawProject(saved);
    expect(takeOpenedStretches(reopened.project)).toHaveLength(0);
    expect(reopened.warnings).toEqual([]);
    const clips = audioClips(reopened.project);
    expect(clips).toHaveLength(4);
    for (const expected of [clip, copy, tail, pieceCopy]) {
      const found = clips.find((item) => item.id === expected.id)!;
      const now = audioClips(project).find((item) => item.id === expected.id)!;
      expect(found.channels, expected.id).toEqual(now.channels);
      expect(found.stretch?.source.channels?.[0], expected.id).toEqual(now.stretch?.source.channels?.[0]);
    }
    reopened.project.dispose();
    project.dispose();
  });

  test("trimming, moving and changing the ratio after the render keep the saved render matching, or re-render", () => {
    const { project, clip } = stretched();
    const trimmed = project.resizeClip(clip.id, { start: clip.time + 0.02, end: clip.time + 0.1 });
    project.moveClip(clip.id, project.tracks[0].id, 3);
    const opened = waiting(saveDawProject(project));
    expect(opened.queued).toBe(0);
    expect(opened.clip.channels).toEqual((trimmed as AudioClip).channels);
    expect(opened.clip.time).toBe(3);
    // A new ratio is a new render: the model has the render of the old ratio only until the caller applies the new one.
    const [kept] = audioClips(opened.project);
    const again = opened.project.applyAudioClipStretch(kept, 1, undefined, []);
    expect(again.stretch).toBeUndefined();
    expect(renderWavs(saveDawProject(opened.project))).toEqual([]);
    opened.project.dispose();
    project.dispose();
  });
});

describe("a stretched clip's file always reopens", () => {
  const original = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7));
  const inApp =
    (at: number, ratio: number, anchors: Array<{ sourceFrame: number; outputFrame: number }>, changes: Array<{ beat: number; bpm: number }>) =>
    () => {
      const project = new Project({ bpm: 120 });
      const track = project.addTrack("Take", "audio");
      project.setTempoChanges(changes);
      const clip = project.addAudioClip(track.id, { sampleRate: 48_000, channels: [original] }, at);
      project.applyAudioClipStretch(clip, ratio, { sampleRate: 48_000, channels: [new Float32Array(Math.round(original.length * ratio))] }, anchors);
      return project;
    };
  const fromFile = (archive: Uint8Array) => () => openDawProject(archive).project;
  const steps = (xml: string, extra: string) =>
    xml.replace(
      '<RealPoint value="100.000000" interpolation="linear" time="0.000000"/>',
      `<RealPoint value="100.000000" interpolation="hold" time="0.000000"/>${extra}`,
    );
  const fixtures: Array<[string, () => Project]> = [
    ["b-bitwig-native", fromFile(B)],
    [
      "b-bitwig-native with a middle marker",
      fromFile(
        editXml(B, (xml) =>
          xml.replace(WARPS, '<Warp time="0.0" contentTime="0.0"/><Warp time="4.0" contentTime="1.0"/><Warp time="8.0" contentTime="4.0"/>'),
        ),
      ),
    ],
    [
      "b-bitwig-native with a tempo change inside",
      fromFile(editXml(B, (xml) => steps(xml, '<RealPoint value="200.000000" interpolation="hold" time="5.000000"/>'))),
    ],
    [
      "b-bitwig-native with a tempo change on its marker",
      fromFile(
        editXml(B, (xml) =>
          steps(
            xml.replace(WARPS, '<Warp time="0.0" contentTime="0.0"/><Warp time="4.0" contentTime="1.0"/><Warp time="8.0" contentTime="4.0"/>'),
            '<RealPoint value="130.000000" interpolation="hold" time="5.000000"/>',
          ),
        ),
      ),
    ],
    ["in app, no tempo change", inApp(1, 1.25, [], [])],
    ["in app, anchors", inApp(1, 1.25, [{ sourceFrame: 2400, outputFrame: 4000 }], [])],
    ["in app, tempo change inside", inApp(1, 0.8, [], [{ beat: 2.5, bpm: 117 }])],
    ["in app, off-grid start and a tempo change on a beat", inApp(1.474, 0.8, [], [{ beat: 3, bpm: 117 }])],
    [
      "in app, anchors and two tempo changes",
      inApp(
        0.9,
        2,
        [{ sourceFrame: 2400, outputFrame: 6000 }],
        [
          { beat: 2, bpm: 90 },
          { beat: 3.5, bpm: 150 },
        ],
      ),
    ],
  ];
  test.each(fixtures)("%s: save then open does not throw and keeps the clip", (_name, make) => {
    const project = make();
    const before = only(project);
    const reopened = openDawProject(saveDawProject(project));
    expect(reopened.warnings.join()).not.toMatch(/Audio clip/);
    const after = only(reopened.project);
    expect(after.stretch?.ratio).toBeCloseTo(before.stretch!.ratio, 6);
    expect(after.time).toBeCloseTo(before.time, 6);
    expect(after.duration).toBeCloseTo(before.duration, 6);
    reopened.project.dispose();
    project.dispose();
  });
});
