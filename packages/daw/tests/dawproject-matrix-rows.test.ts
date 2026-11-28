import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { MidiClip, Project, encodeWavBytes, openDawProject, openDawProjectBlob, saveDawProject, sessionFor } from "../src";
import type { AudioClip } from "../src";
import { writeStoredZip } from "../src/internal/stored-zip";
import { zipBlobDirectory, zipDirectory } from "../src/internal/zip-directory";
import { parseTree, projectXmlOf, treeDifferences } from "./helpers/xml-tree";

/**
 * Rows of docs/dawproject-support.md that no real file in the fixtures exercises, each built here from a small synthetic file written the way another
 * application would: the part the model has no field for stays in the file ("kept"), the open warning names it, a save with no edit and a save after an edit
 * elsewhere change nothing of it, and the model plays only what it carries.
 */
const wav = () => encodeWavBytes({ sampleRate: 48000, channels: [new Float32Array(4800).fill(0.25)] });
const base = (structure: string, arrangement: string, scenes = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><Project version="1.0"><Application name="Other DAW" version="1"/><Transport><Tempo unit="bpm" value="120"/></Transport>` +
  `<Structure>${structure}</Structure>${arrangement}${scenes}</Project>`;
const master = `<Channel role="master" id="m"><Volume id="mv" unit="linear" value="1"/></Channel>`;
const channel = (id: string, extra = "") =>
  `<Channel id="${id}c" role="regular" destination="m">${extra}<Volume id="${id}v" unit="linear" value="1"/></Channel>`;
const noteTrack = (id: string, name: string) => `<Track id="${id}" contentType="notes" name="${name}">${channel(id)}</Track>`;
const audioTrack = (id: string, name: string) => `<Track id="${id}" contentType="audio" name="${name}">${channel(id)}</Track>`;
const note = `<Note time="0" duration="1" key="60" channel="0" vel="0.8" rel="0.5"/>`;
const notes = (id: string, inner = note) => `<Notes id="${id}">${inner}</Notes>`;
const lane = (track: string, clips: string) => `<Lanes id="l-${track}" track="${track}"><Clips id="cs-${track}">${clips}</Clips></Lanes>`;
const arrangement = (lanes: string, unit = "beats") => `<Arrangement id="arr"><Lanes id="al" timeUnit="${unit}">${lanes}</Lanes></Arrangement>`;
/** The clip every scenario moves, to prove an edit elsewhere leaves the kept part alone. */
const plain = `<Clip time="16" duration="4" name="Plain">${notes("np")}</Clip>`;
const audio = (id: string, path: string, external = false) =>
  `<Audio id="${id}" sampleRate="48000" channels="1" duration="0.1"><File path="${path}"${external ? ' external="true"' : ""}/></Audio>`;

const pack = (xml: string, entries: Record<string, Uint8Array> = {}) =>
  zipSync({ "project.xml": strToU8(xml), "metadata.xml": strToU8("<MetaData><Title>Synthetic</Title></MetaData>"), ...entries });
const tree = (archive: Uint8Array) => parseTree(projectXmlOf(archive));

/**
 * Opens `archive` and checks what every kept row promises: a save with no edit keeps `project.xml` the same tree and every other entry byte for byte
 * (only `audiorective/` is added), and moving the "Plain" clip changes that clip's `time` and nothing else. Returns the opened project.
 */
function openAndCheckKept(archive: Uint8Array, warning: string): Project {
  const { project, warnings } = openDawProject(archive);
  expect(warnings.join("\n")).toContain(warning);
  const saved = saveDawProject(project);
  expect(treeDifferences(tree(archive), tree(saved))).toEqual([]);
  const before = unzipSync(archive);
  const after = unzipSync(saved);
  for (const [path, bytes] of Object.entries(before))
    if (path !== "project.xml" && path !== "metadata.xml" && !path.endsWith("/")) expect(after[path], path).toEqual(bytes);
  for (const path of Object.keys(after)) if (!(path in before)) expect(path.startsWith("audiorective/"), path).toBe(true);
  const keys = project.tracks.find((track) => track.name === "Keys")!;
  const clip = keys.clips.find((candidate) => project.clipName(candidate.id) === "Plain")!;
  project.moveClip(clip.id, keys.id, 20);
  const moved = saveDawProject(project);
  const changed = treeDifferences(tree(archive), tree(moved));
  expect(changed).toHaveLength(1);
  expect(changed[0]).toMatch(/Clip\[\d+\]@time$/);
  for (const [path, bytes] of Object.entries(before))
    if (path !== "project.xml" && path !== "metadata.xml" && !path.endsWith("/")) expect(unzipSync(moved)[path], path).toEqual(bytes);
  const reopened = openDawProject(moved).project;
  expect(reopened.tracks.find((track) => track.name === "Keys")!.clips.map((candidate) => candidate.time)).toContain(20);
  reopened.dispose();
  return project;
}

describe("Channel role vca", () => {
  test("a track whose channel is a VCA is kept, not in the model, and untouched by saves and edits elsewhere", () => {
    const vca = `<Track id="v" contentType="audio" name="Drum VCA"><Channel id="vc" role="vca"><Volume id="vv" unit="linear" value="0.5"/></Channel></Track>`;
    const project = openAndCheckKept(pack(base(noteTrack("t1", "Keys") + vca + master, arrangement(lane("t1", plain)))), 'Track of type "audio"');
    expect(project.tracks.map((track) => track.name)).toEqual(["Keys"]);
    project.dispose();
  });
});

describe("Clip@enable", () => {
  test('a disabled clip is kept, left out of the model (so silent), and keeps enable="false" through saves and edits', () => {
    const disabled = `<Clip time="0" duration="4" name="Muted" enable="false">${notes("nd")}</Clip>`;
    const archive = pack(
      base(noteTrack("t1", "Keys"), "")
        .replace("</Structure>", `${master}</Structure>`)
        .replace("</Project>", `${arrangement(lane("t1", disabled + plain))}</Project>`),
    );
    const project = openAndCheckKept(archive, "Disabled clip");
    const keys = project.tracks[0];
    expect(keys.clips.map((clip) => project.clipName(clip.id))).toEqual(["Plain"]);
    expect(projectXmlOf(saveDawProject(project))).toContain('enable="false"');
    project.dispose();
  });
});

describe("MIDI clip fades", () => {
  const faded = `<Clip time="0" duration="4" name="Faded" fadeInTime="1" fadeOutTime="1">${notes("nf")}</Clip>`;
  const archive = pack(base(noteTrack("t1", "Keys") + master, arrangement(lane("t1", faded + plain))));

  test("the clip is read and plays its notes unfaded; the fade attributes stay in the file through saves, note edits and moves, with no warning", () => {
    const project = openAndCheckKept(archive, "");
    const keys = project.tracks[0];
    const clip = keys.clips.find((candidate) => project.clipName(candidate.id) === "Faded") as MidiClip;
    expect(clip).toBeInstanceOf(MidiClip);
    expect(
      clip
        .playbackEvents()
        .filter((event) => (event.data[0] & 0xf0) === 0x90)
        .map((event) => event.data[2]),
    ).toEqual([Math.round(0.8 * 127)]);
    clip.midi.edit((notes) => {
      notes[0].velocity = 0.5;
    });
    const edited = projectXmlOf(saveDawProject(project));
    expect(edited).toMatch(/<Clip [^>]*name="Faded"[^>]*fadeInTime="1"[^>]*fadeOutTime="1"/);
    expect(edited).toContain('vel="0.5"');
    project.moveClip(clip.id, keys.id, 8);
    expect(projectXmlOf(saveDawProject(project))).toMatch(/<Clip time="8"[^>]*fadeInTime="1"[^>]*fadeOutTime="1"/);
    project.dispose();
  });

  test("the open warning does not mention the fades: nothing in the model says what MIDI fades would do", () => {
    const { project, warnings } = openDawProject(archive);
    expect(warnings).toEqual([]);
    project.dispose();
  });
});

describe("Clip@reference on audio", () => {
  test("an audio clip that refers to another clip's audio is kept and silent; the clip it points at plays", () => {
    const clips = `<Clip time="0" duration="0.1" name="Source">${audio("au", "audio/a.wav")}</Clip><Clip time="2" duration="0.1" name="Alias" reference="au"/>`;
    const archive = pack(
      base(
        noteTrack("t1", "Keys") + audioTrack("a1", "Vox") + master,
        arrangement(lane("t1", plain) + lane("a1", clips), "seconds").replace('timeUnit="seconds"', 'timeUnit="beats"'),
      ),
      { "audio/a.wav": wav() },
    );
    const project = openAndCheckKept(archive, "Audio clip without audio content");
    const vox = project.tracks.find((track) => track.name === "Vox")!;
    expect(vox.clips.map((clip) => project.clipName(clip.id))).toEqual(["Source"]);
    expect(projectXmlOf(saveDawProject(project))).toContain('reference="au"');
    project.dispose();
  });
});

describe("Points inside a Note", () => {
  const expression = `<Note time="0" duration="1" key="60" channel="0" vel="0.8"><Points id="np1" unit="normalized"><Target expression="timbre"/><RealPoint time="0" value="0.2"/><RealPoint time="0.5" value="0.8"/></Points></Note>`;
  const archive = pack(
    base(
      noteTrack("t1", "Keys") + master,
      arrangement(lane("t1", `<Clip time="0" duration="4" name="Expressive">${notes("ne", expression)}</Clip>` + plain)),
    ),
  );

  test("the clip is read, the expression is kept untouched while the clip is not edited, and the warning names it", () => {
    const project = openAndCheckKept(archive, "Note/Points");
    expect(project.tracks[0].clips).toHaveLength(2);
    expect(projectXmlOf(saveDawProject(project))).toContain('<Target expression="timbre"/>');
    project.dispose();
  });

  test("editing a note of that clip rewrites its content from the model: the expression is lost (the ◐ in the matrix)", () => {
    const { project } = openDawProject(archive);
    const clip = project.tracks[0].clips.find((candidate) => project.clipName(candidate.id) === "Expressive") as MidiClip;
    clip.midi.edit((notes) => {
      notes[0].velocity = 0.5;
    });
    const out = projectXmlOf(saveDawProject(project));
    expect(out).toContain('vel="0.5"');
    expect(out).not.toContain("timbre");
    project.dispose();
  });
});

describe("File@external", () => {
  test("an audio clip whose file is outside the archive is kept and silent, and no entry is made for it", () => {
    const external = `<Clip time="0" duration="0.1" name="Outside">${audio("ae", "C:/samples/kick.wav", true)}</Clip>`;
    const archive = pack(base(noteTrack("t1", "Keys") + audioTrack("a1", "Vox") + master, arrangement(lane("t1", plain) + lane("a1", external))));
    const project = openAndCheckKept(archive, "Project audio asset is missing");
    expect(project.tracks.find((track) => track.name === "Vox")!.clips).toEqual([]);
    const saved = saveDawProject(project);
    expect(projectXmlOf(saved)).toContain('external="true"');
    expect(Object.keys(unzipSync(saved)).filter((path) => path.endsWith(".wav"))).toEqual([]);
    project.dispose();
  });
});

describe("Video", () => {
  test("a video track and its file are kept: the model has no video track, the audio beside it plays, the video bytes come back unchanged", () => {
    const video = `<Track id="vt" contentType="video" name="Video"><Channel id="vtc" role="regular"/></Track>`;
    const clips = `<Clip time="0" duration="0.1" name="Take">${audio("au", "audio/a.wav")}</Clip>`;
    const videoLane = `<Lanes id="vl" track="vt"><Clips id="vcs"><Clip time="0" duration="2"><Video id="vid" sampleRate="48000" duration="2" algorithm="x" channels="2"><File path="video/clip.mp4"/></Video></Clip></Clips></Lanes>`;
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3]);
    const archive = pack(
      base(noteTrack("t1", "Keys") + audioTrack("a1", "Vox") + video + master, arrangement(lane("t1", plain) + lane("a1", clips) + videoLane)),
      {
        "audio/a.wav": wav(),
        "video/clip.mp4": bytes,
      },
    );
    const project = openAndCheckKept(archive, 'Track of type "video"');
    expect(project.tracks.map((track) => track.name)).toEqual(["Keys", "Vox"]);
    expect(project.tracks[1].clips).toHaveLength(1);
    expect(unzipSync(saveDawProject(project))["video/clip.mp4"]).toEqual(bytes);
    project.dispose();
  });
});

describe("Track of another contentType, and units the model does not carry", () => {
  test.each(["markers", "automation"])('a Track of contentType="%s" (no Channel) is kept and not a track of the model', (type) => {
    const extra = `<Track id="x" contentType="${type}" name="Other"/>`;
    const project = openAndCheckKept(pack(base(noteTrack("t1", "Keys") + extra + master, arrangement(lane("t1", plain)))), "Track without a Channel");
    expect(project.tracks.map((track) => track.name)).toEqual(["Keys"]);
    project.dispose();
  });

  test("a Volume in a unit other than linear or decibel, and a Pan in a unit other than normalized, are kept as written", () => {
    const track = (volume: string, pan = "") =>
      `<Track id="t1" contentType="notes" name="Keys"><Channel id="c" role="regular" destination="m">${pan}${volume}</Channel></Track>`;
    for (const [structure, warning] of [
      [track(`<Volume id="v" unit="normalized" value="0.5"/>`), "Volume in a unit other than linear or decibel"],
      [track(`<Volume id="v" unit="linear" value="1"/>`, `<Pan id="p" unit="linear" value="0.5"/>`), "Pan in a unit other than normalized"],
    ] as const) {
      const project = openAndCheckKept(pack(base(structure + master, arrangement(lane("t1", plain)))), warning);
      project.dispose();
    }
  });
});

describe("a slot clip the model does not carry", () => {
  const slot = `<Scenes><Scene id="s1" name="S1"><Lanes id="sl"><ClipSlot id="cs" hasStop="true" track="t1"><Clip time="0" duration="4" enable="false">${notes("ns")}</Clip></ClipSlot></Lanes></Scene></Scenes>`;
  const archive = pack(base(noteTrack("t1", "Keys") + master, arrangement(lane("t1", plain)), slot));

  test("it is kept and not in the slot; saving a clip into that slot is refused with the cause", () => {
    const project = openAndCheckKept(archive, "Disabled clip");
    const session = sessionFor(project);
    expect(session.scenes.map((scene) => scene.name)).toEqual(["S1"]);
    const at = { trackId: project.tracks[0].id, sceneId: session.scenes[0].id };
    expect(session.clipAt(at)).toBeNull();
    session.setMidiClip(at, { duration: 4, notes: [{ id: "n", pitch: 60, velocity: 0.8, start: 0, duration: 1 }] });
    expect(() => saveDawProject(project)).toThrow(
      "Project scene slot holds content the model does not carry; remove it in the other application first.",
    );
    project.dispose();
  });
});

describe("archive entries", () => {
  const entries = {
    "plugins/": new Uint8Array(0),
    "plugins/Synth preset 1.vstpreset": new Uint8Array([86, 83, 84, 51, 0, 255, 128]),
    "extras/two words.txt": strToU8("kept"),
    "extensions/other-app/data.json": strToU8('{"version":3,"data":{"x":[1,2,3]}}'),
  };
  const archive = pack(base(noteTrack("t1", "Keys") + master, arrangement(lane("t1", plain))), entries);

  test("any other file, a name with spaces, and another application's extension data come back byte for byte; folder entries are not written", () => {
    const project = openAndCheckKept(archive, "");
    const saved = unzipSync(saveDawProject(project));
    for (const [path, bytes] of Object.entries(entries)) if (!path.endsWith("/")) expect(saved[path], path).toEqual(bytes);
    expect(Object.keys(saved)).not.toContain("plugins/");
    expect(Object.keys(saved).filter((path) => path.endsWith("/"))).toEqual([]);
    expect(Object.keys(saved).filter((path) => !(path in unzipSync(archive)))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^audiorective\//)]),
    );
    project.dispose();
  });

  test("a file name with non-ASCII letters opens and comes back byte for byte", () => {
    const named = { "extras/Aufnahme \u2713 \u00dcbung.txt": strToU8("kept") };
    const project = openAndCheckKept(pack(base(noteTrack("t1", "Keys") + master, arrangement(lane("t1", plain))), named), "");
    expect(unzipSync(saveDawProject(project))["extras/Aufnahme \u2713 \u00dcbung.txt"]).toEqual(named["extras/Aufnahme \u2713 \u00dcbung.txt"]);
    project.dispose();
  });
});

describe("an audio file with a CJK name", () => {
  const cjk = "audio/\u9332\u97f3 \u30c6\u30b9\u30c8.wav";
  const level = (value: number) => encodeWavBytes({ sampleRate: 48000, channels: [new Float32Array(4800).fill(value)] });
  const clips = (path: string) =>
    `<Clip time="0" duration="0.1" name="Plain audio">${audio("a1", "audio/a.wav")}</Clip><Clip time="1" duration="0.1" name="Named">${audio("a2", path)}</Clip>`;
  const build = (path: string, entries: Record<string, Uint8Array>) =>
    pack(base(noteTrack("t1", "Keys") + audioTrack("a1", "Vox") + master, arrangement(lane("t1", plain) + lane("a1", clips(path)))), entries);
  const archive = build(cjk, { "audio/a.wav": level(0.25), [cjk]: level(0.5) });
  const firstSample = async (project: Project, clipName: string) => {
    const clip = project.tracks
      .find((track) => track.name === "Vox")!
      .clips.find((candidate) => project.clipName(candidate.id) === clipName) as AudioClip;
    const channels = "channels" in clip ? clip.channels : await clip.media.readFrames(clip.startFrame, 1);
    return channels[0][0];
  };

  test("the bytes reader opens it and the clip plays that file's audio", async () => {
    const { project } = openDawProject(archive);
    expect(await firstSample(project, "Named")).toBeCloseTo(0.5, 4);
    expect(await firstSample(project, "Plain audio")).toBeCloseTo(0.25, 4);
    project.dispose();
  });

  test("the Blob reader opens it and the clip plays that file's audio", async () => {
    const { project } = await openDawProjectBlob(new Blob([archive as Uint8Array<ArrayBuffer>]));
    expect(await firstSample(project, "Named")).toBeCloseTo(0.5, 4);
    expect(await firstSample(project, "Plain audio")).toBeCloseTo(0.25, 4);
    project.dispose();
  });

  test("a save with no edit keeps the entry's name bytes and content, and the name is marked UTF-8", () => {
    const { project } = openDawProject(archive);
    const saved = saveDawProject(project);
    const names = (bytes: Uint8Array) => Object.keys(unzipSync(bytes)).filter((name) => name.endsWith(".wav"));
    expect(names(saved).sort()).toEqual(names(archive).sort());
    expect(unzipSync(saved)[cjk]).toEqual(unzipSync(archive)[cjk]);
    const nameBytes = strToU8(cjk);
    const at = saved.findIndex((_, index) => nameBytes.every((byte, offset) => saved[index + offset] === byte));
    expect(at).toBeGreaterThan(0);
    expect(new DataView(saved.buffer, saved.byteOffset).getUint16(at - 30 + 6, true) & 0x800).toBe(0x800);
    project.dispose();
  });

  test("a file saved as a stored zip of its own carries the UTF-8 flag on the name and reads back", async () => {
    const chunks = [level(0.5)];
    const parts: Uint8Array[] = [];
    await writeStoredZip(
      [
        {
          path: cjk,
          size: chunks[0].length,
          async *chunks() {
            yield* chunks;
          },
        },
      ],
      new WritableStream({ write: (chunk) => void parts.push(chunk) }),
    );
    const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    expect(new DataView(bytes.buffer).getUint16(6, true) & 0x800).toBe(0x800);
    expect([...(await zipBlobDirectory(new Blob([bytes as Uint8Array<ArrayBuffer>]))).keys()]).toEqual([cjk]);
    expect([...zipDirectory(bytes).keys()]).toEqual([cjk]);
  });

  test("a name written in code page 437 (bit 11 not set) is read as such", () => {
    const placeholder = "audio/cafXY.wav";
    const real = "audio/caf\u00e9\u00fc.wav";
    const zipped = build(real, { "audio/a.wav": level(0.25), [placeholder]: level(0.5) });
    const bytes = Uint8Array.from(zipped);
    const pattern = strToU8(placeholder);
    let patched = 0;
    for (let i = 0; i + pattern.length <= bytes.length; i++)
      if (pattern.every((byte, offset) => bytes[i + offset] === byte)) {
        bytes[i + pattern.length - 6] = 0x82;
        bytes[i + pattern.length - 5] = 0x81;
        patched++;
      }
    expect(patched).toBe(2);
    const { project } = openDawProject(bytes);
    expect(project.tracks.find((track) => track.name === "Vox")!.clips).toHaveLength(2);
    project.dispose();
  });
});

describe("automation the model has no field for, in files made by dawproject-typescript", () => {
  const sample = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/dawproject/${name}.dawproject`, import.meta.url))));
  const unchanged = (archive: Uint8Array, project: Project) => {
    expect(treeDifferences(tree(archive), tree(saveDawProject(project)))).toEqual([]);
  };

  test("ts-cc1-in-clips: a clip holding a RealPoint (normalized) CC1 lane is kept, not in the model, and a save with no edit changes nothing", () => {
    const archive = sample("ts-cc1-in-clips");
    const { project, warnings } = openDawProject(archive);
    expect(project.tracks.map((track) => [track.name, track.clips.length])).toEqual([["Notes", 0]]);
    expect(warnings.join("\n")).toContain("Clip with Points content");
    unchanged(archive, project);
    project.dispose();
  });

  test("ts-pitchbend-on-track: a pitch-bend lane on a track is kept and a save with no edit changes nothing", () => {
    const archive = sample("ts-pitchbend-on-track");
    const { project, warnings } = openDawProject(archive);
    expect(warnings.join("\n")).toContain("Automation of a parameter or in a unit the model does not carry");
    unchanged(archive, project);
    project.dispose();
  });
});
