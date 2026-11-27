import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { Project, openDawProject, saveDawProject } from "../src";
import type { AudioClip } from "../src";
import { archiveReaders } from "../src/internal/decoded-audio";
import { warpVerdict, warpTolerance } from "../src/internal/nested-audio";

const dir = new URL("./fixtures/dawproject/", import.meta.url);
const file = (name: string, folder = "dawproject") =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${folder}/${name}`, import.meta.url))));
const B = file("b-bitwig-native.dawproject");
const A = file("a-bitwig-export.dawproject");
void dir;

const audioClips = (project: Project) => project.tracks.flatMap((track) => track.clips).filter((clip): clip is AudioClip => clip.kind === "audio");
const flat = (project: Project) =>
  project.tracks
    .flatMap((track, index) => track.clips.map((clip) => ({ index, clip })))
    .sort((a, b) => a.index - b.index || a.clip.time - b.clip.time);

describe("a compressed file that decodes a little shorter than its stated duration keeps the clip that reaches the end", () => {
  const compressed = file("compressed-audio.dawproject", "compressed-audio");
  // click.ogg: 44.1 kHz, 1 s, stereo; the clip on the Ogg track plays all of it.
  const decoded = (frames: number) =>
    new Map([["audio/click.ogg", { sampleRate: 44_100, channels: [new Float32Array(frames), new Float32Array(frames)] }]]);
  const ogg = (project: Project) => project.tracks.find((track) => track.name === "Ogg")!.clips[0] as AudioClip | undefined;

  test("a window ending 1500 frames past the decoded audio is accepted and clamped, silently", () => {
    const { project, warnings } = archiveReaders().bytes(compressed, decoded(44_100 - 1_500));
    const clip = ogg(project)!;
    expect(clip).toBeDefined();
    expect(clip.channels![0]).toHaveLength(44_100 - 1_500);
    expect(clip.duration).toBeCloseTo((44_100 - 1_500) / 44_100, 9);
    expect(warnings.join(" ")).not.toContain("click.ogg");
    project.dispose();
  });

  test("a shortfall past 2048 frames leaves the clip in the file, and the warnings say so", () => {
    const { project, warnings } = archiveReaders().bytes(compressed, decoded(44_100 - 3_000));
    expect(ogg(project)).toBeUndefined();
    expect(warnings.join(" ")).toContain("Project audio asset does not match its XML metadata");
    project.dispose();
  });
});

describe("a stretched clip keeps its ratio through every save and reopen", () => {
  test("twenty cycles of split, trim and move leave the ratio within 1e-9 of the file's 1.2", () => {
    let bytes = B;
    const ratios: number[] = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const { project } = openDawProject(bytes);
      const stretched = audioClips(project).filter((clip) => clip.stretch);
      expect(stretched.length).toBeGreaterThan(0);
      for (const clip of stretched) ratios.push(clip.stretch!.ratio);
      const clip = stretched.at(-1)!;
      const track = project.tracks.find((item) => item.clips.some((other) => other.id === clip.id))!;
      if (cycle % 4 === 0 && clip.duration > 0.2) {
        const [, right] = project.splitClip(clip.id, clip.duration * (0.31 + cycle / 100));
        project.resizeClip(right.id, { start: right.time + 0.0123457 });
      } else if (cycle % 4 === 1 && clip.duration > 0.1) project.resizeClip(clip.id, { end: clip.time + clip.duration - 0.0234567 });
      else if (cycle % 4 === 2 && clip.duration > 0.1) project.resizeClip(clip.id, { start: clip.time + 0.0171 });
      else project.moveClip(clip.id, track.id, clip.time + 0.37);
      bytes = saveDawProject(project);
      project.dispose();
    }
    expect(ratios.length).toBeGreaterThan(20);
    for (const ratio of ratios) expect(Math.abs(ratio - 1.2)).toBeLessThan(1e-9);
  });

  test("a save that does not change a clip's time map keeps the file's own warp points", () => {
    const { project } = openDawProject(B);
    const clip = audioClips(project).find((item) => item.stretch)!;
    project.moveClip(clip.id, project.tracks.find((track) => track.clips.some((other) => other.id === clip.id))!.id, clip.time + 1);
    const warps = strFromU8(unzipSync(saveDawProject(project))["project.xml"]).match(/<Warp [^>]*\/>/g);
    expect(warps).toEqual(['<Warp time="0.0" contentTime="0.0"/>', '<Warp time="8.0" contentTime="4.0"/>']);
    project.dispose();
  });
});

describe("the identity warp is judged by slope as well as by an absolute tolerance", () => {
  const input = (length: number, content: number) => ({
    points: [
      { time: 0, contentTime: 0 },
      { time: length, contentTime: content },
    ],
    from: 0,
    length,
    start: 0,
    elapsed: (position: number) => position,
    tempoBreaks: [],
    tolerance: warpTolerance(44_100),
  });

  test("a 10 ms clip stretched by 0.1 percent is a stretch, not the identity", () => {
    // 10 µs of difference is inside 1.5 frames (34 µs), so the absolute test alone called it the identity.
    expect(warpVerdict(input(0.01, 0.01 * 1.001)).identity).toBe(false);
  });

  test("rounding noise on a short clip and the file's float32 beat rounding on a long one stay the identity", () => {
    expect(warpVerdict(input(0.01, 0.01 + 1e-8)).identity).toBe(true);
    // Bitwig writes a 4 s clip at 100 BPM as 6.6666669845581055 beats: 8e-8 s of difference over 4 s.
    expect(warpVerdict(input(4, 4 + 1.9e-8)).identity).toBe(true);
    expect(warpVerdict(input(4, 4)).identity).toBe(true);
  });

  test("a long clip with a real stretch of a few thousandths of a percent is still a stretch", () => {
    expect(warpVerdict(input(4, 4 * 1.00001)).identity).toBe(false);
  });
});

describe("a split clip in a beats file comes back where it was", () => {
  test("every piece of every clip, split at many places, reopens within 1e-9 s in time, length and window", () => {
    let worst = 0;
    for (let k = 1; k < 40; k += 3) {
      const { project } = openDawProject(A);
      for (const { id } of project.tracks.flatMap((track) => track.clips)) {
        const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === id)!;
        project.splitClip(id, clip.duration * (k / 40.123));
      }
      const reopened = openDawProject(saveDawProject(project)).project;
      const before = flat(project);
      const after = flat(reopened);
      expect(after).toHaveLength(before.length);
      before.forEach(({ clip }, n) => {
        const other = after[n].clip;
        worst = Math.max(worst, Math.abs(other.time - clip.time), Math.abs(other.duration - clip.duration));
        worst = Math.max(worst, Math.abs(((other as AudioClip).sourceOffset ?? 0) - ((clip as AudioClip).sourceOffset ?? 0)));
      });
      project.dispose();
      reopened.dispose();
    }
    expect(worst).toBeLessThan(1e-9);
  });
});
