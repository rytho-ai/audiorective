import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MidiClip, Project, encodeWavBytes, openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo, sessionFor } from "../src";
import type { ProjectClip } from "../src";
import { xsdViolations, xsdViolationsOfXml } from "./helpers/xsd";

/**
 * Real and independently generated .dawproject files (sources in tests/fixtures/dawproject/SOURCES.md): each is opened, saved untouched,
 * edited in one clip and saved again. Everything outside the edited clip has to come back as the other application wrote it.
 */
const dir = new URL("./fixtures/dawproject/", import.meta.url);
const file = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(name, dir))));

/** The README's project.xml is only XML: give it an archive, with the 2.8235 s stereo recording its stretched clip names (silence). */
const archiveOf = (name: string): Uint8Array =>
  name.endsWith(".xml")
    ? zipSync({
        "project.xml": file(name),
        "metadata.xml": strToU8("<MetaData><Title>Bitwig README</Title></MetaData>"),
        "audio/Drumfunk3 170bpm.wav": encodeWavBytes({ sampleRate: 48000, channels: [new Float32Array(135530), new Float32Array(135530)] }),
      })
    : file(name);

type Tree = { tag: string; attrs: Record<string, string>; text: string; children: Tree[] };
function parse(xml: string): Tree {
  const tree = (element: Element): Tree => {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < element.attributes.length; i++) attrs[element.attributes.item(i)!.name] = element.attributes.item(i)!.value;
    const children: Tree[] = [];
    let text = "";
    for (let node = element.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1) children.push(tree(node as Element));
      else if (node.nodeType === 3) text += (node.nodeValue ?? "").trim();
    }
    return { tag: element.tagName, attrs, text, children };
  };
  return tree(new DOMParser().parseFromString(xml, "application/xml").documentElement!);
}
/** Where two trees differ, as `Project/Arrangement/Lanes[0]/...` paths (attributes as `path@name`). */
function differences(a: Tree | undefined, b: Tree | undefined, path = "Project", out: string[] = []): string[] {
  if (!a || !b) {
    out.push(path + (a ? " (removed)" : " (added)"));
    return out;
  }
  for (const name of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) if (a.attrs[name] !== b.attrs[name]) out.push(`${path}@${name}`);
  if (a.text !== b.text) out.push(`${path} (text)`);
  const seen = new Map<string, number>();
  const label = (tree: Tree) => {
    const n = seen.get(tree.tag) ?? 0;
    seen.set(tree.tag, n + 1);
    return `${tree.tag}[${n}]`;
  };
  const aLabels = a.children.map(label);
  seen.clear();
  const bLabels = b.children.map(label);
  for (let i = 0; i < Math.max(a.children.length, b.children.length); i++) {
    const labelA = aLabels[i],
      labelB = bLabels[i];
    differences(a.children[i], b.children[i], `${path}/${labelA ?? labelB}`, out);
    if (labelA !== labelB && a.children[i] && b.children[i]) out.push(`${path}/${labelA} (reordered)`);
  }
  return out;
}
const xmlOf = (archive: Uint8Array) => strFromU8(unzipSync(archive)["project.xml"]);
const midiClips = (project: Project) => project.tracks.flatMap((track) => track.clips).filter((clip): clip is MidiClip => clip.kind === "midi");
const messages = (violations: string[]) => new Set(violations.map((line) => line.replace(/^[^ ]+ /, "")));

type Sample = {
  name: string;
  /** What the source itself does against the official XSD: other applications' files are not always valid. */
  valid: boolean;
  /** Parts of the open warning: what the file keeps beyond the model. */
  kept: string[];
  tracks: number;
  /** Edit one clip. Returns the path of its Clip element and the paths outside it that follow from the edit. */
  edit(project: Project): { clip: string; also?: string[]; verify(reopened: Project): void };
};

const samples: Sample[] = [
  {
    name: "bitwig-readme/project.xml",
    valid: true,
    kept: ["CLAP plug-in that is bypassed, has no state file or does not fit its track"],
    tracks: 2,
    edit(project) {
      const clip = midiClips(project)[0];
      clip.midi.edit((notes) => {
        notes[0].velocity = 0.5;
      });
      return {
        clip: "Project/Arrangement[0]/Lanes[0]/Lanes[0]/Clips[0]/Clip[0]",
        verify: (reopened) => expect(midiClips(reopened)[0].midi.notes.value.some((note) => note.velocity === 0.5)).toBe(true),
      };
    },
  },
  {
    name: "bitwig-5.3-canon-in-d.dawproject",
    valid: true,
    kept: ["Device Vst3Plugin", "Disabled send"],
    tracks: 3,
    edit(project) {
      const clip = midiClips(project)[0];
      project.moveClip(clip.id, project.tracks[0].id, clip.time + 4);
      return {
        clip: "Project/Arrangement[0]/Lanes[0]/Lanes[0]/Clips[0]/Clip[0]",
        verify: (reopened) => expect(midiClips(reopened)[0].time).toBe(4),
      };
    },
  },
  {
    name: "bitwig-5.3-sugar-plum-celesta.dawproject",
    valid: true,
    kept: ["Device BuiltinDevice"],
    tracks: 2,
    edit(project) {
      project.setClipName(midiClips(project)[0].id, "Celesta take 2");
      return {
        clip: "Project/Arrangement[0]/Lanes[0]/Lanes[0]/Clips[0]/Clip[0]",
        verify: (reopened) => expect(project.clipName(midiClips(reopened)[0].id) ?? "").toBeDefined(),
      };
    },
  },
  {
    name: "ts-features.dawproject",
    valid: true,
    kept: ["Master channel devices"],
    tracks: 2,
    edit(project) {
      // The second clip of the first track is an alias of the first: moving it changes only its own position.
      const clips = project.tracks[0].clips;
      const time = clips[1].time;
      project.moveClip(clips[1].id, project.tracks[0].id, time + 8);
      return {
        clip: "Project/Arrangement[0]/Lanes[0]/Lanes[0]/Clips[0]/Clip[1]",
        verify: (reopened) => {
          expect(reopened.tracks[0].clips[1].time).toBe(time + 8);
          expect(reopened.linkedClips(reopened.tracks[0].clips[0].id)).toHaveLength(1);
        },
      };
    },
  },
  {
    name: "ts-audio-mixer.dawproject",
    valid: false,
    kept: ["Device Equalizer", "Device Compressor"],
    tracks: 4,
    edit(project) {
      const clip = project.tracks[1].clips[0];
      project.moveClip(clip.id, project.tracks[1].id, clip.time + 1);
      return {
        clip: "Project/Arrangement[0]/Lanes[0]/Lanes[1]/Clips[0]/Clip[0]",
        verify: (reopened) => expect(reopened.tracks[1].clips[0].time).toBe(clip.time + 1),
      };
    },
  },
];

describe.each(samples)("sample $name", (sample) => {
  const source = archiveOf(sample.name);

  test("is judged by the official schema as expected", async () => {
    const violations = await xsdViolations([{ name: sample.name, bytes: source }]);
    expect(violations.length === 0).toBe(sample.valid);
  });

  test("opens, reports what it keeps, and saves untouched with nothing changed", () => {
    const { project, warnings } = openDawProject(source);
    expect(project.tracks).toHaveLength(sample.tracks);
    for (const part of sample.kept) expect(warnings.join("\n")).toContain(part);
    const saved = saveDawProject(project);
    expect(differences(parse(xmlOf(source)), parse(xmlOf(saved)))).toEqual([]);
    // Every other archive entry of the source is still there, byte for byte; the codec adds only its own sidecar.
    const before = unzipSync(source);
    const after = unzipSync(saved);
    for (const [path, bytes] of Object.entries(before)) {
      if (path === "project.xml" || path === "metadata.xml" || path.endsWith("/")) continue;
      expect(after[path], path).toEqual(bytes);
    }
    for (const path of Object.keys(after)) if (!(path in before)) expect(path.startsWith("audiorective/")).toBe(true);
    project.dispose();
  });

  test("an edit to one clip changes that clip and nothing else, and reopens", async () => {
    const { project } = openDawProject(source);
    const { clip, also = [], verify } = sample.edit(project);
    const saved = saveDawProject(project);
    const changed = differences(parse(xmlOf(source)), parse(xmlOf(saved)));
    expect(changed.length).toBeGreaterThan(0);
    for (const path of changed) expect(path.startsWith(clip) || also.some((prefix) => path.startsWith(prefix)), path).toBe(true);
    // The edit does not make the file worse against the schema.
    const after = messages(await xsdViolations([{ name: "after", bytes: saved }]));
    const before = messages(await xsdViolations([{ name: "before", bytes: source }]));
    for (const message of after) expect(before.has(message), message).toBe(true);
    const reopened = openDawProject(saved);
    verify(reopened.project);
    // A second save of the reopened file keeps the edit and still changes nothing else.
    expect(differences(parse(xmlOf(saved)), parse(xmlOf(saveDawProject(reopened.project))))).toEqual([]);
    reopened.project.dispose();
    project.dispose();
  });
});

describe("what a file from another application does to the model", () => {
  const withProject = (xml: string, extra: Record<string, Uint8Array> = {}) =>
    zipSync({ "project.xml": strToU8(xml), "metadata.xml": strToU8("<MetaData><Title>Foreign</Title></MetaData>"), ...extra });
  const base = (structure: string, arrangement = "", scenes = "") =>
    `<?xml version="1.0" encoding="UTF-8"?><Project version="1.0"><Application name="Other DAW" version="1"/><Transport><Tempo unit="bpm" value="120"/></Transport>` +
    `<Structure>${structure}</Structure>${arrangement}${scenes}</Project>`;
  const master = `<Channel role="master" id="m"><Volume id="mv" unit="linear" value="1"/></Channel>`;

  test("a top-level master Channel, a folder Track and a Track without a Channel open and are kept", () => {
    const xml = base(
      `<Track id="f" contentType="tracks" name="Folder"><Channel id="fc" role="regular" destination="m"><Volume id="fv" unit="linear" value="1"/></Channel><Track id="a" contentType="audio" name="In folder"><Channel id="ac" role="regular" destination="fc"><Volume id="av" unit="linear" value="0.5"/></Channel></Track></Track>` +
        `<Track id="io" contentType="tracks" name="Input/Output"/>${master}`,
    );
    const { project, warnings } = openDawProject(withProject(xml));
    expect(project.tracks.map((track) => track.name)).toEqual(["In folder"]);
    expect(project.tracks[0].routing.outputBusId).toBeNull();
    expect(warnings.join()).toContain("Track folder");
    expect(warnings.join()).toContain("Track without a Channel");
    const out = xmlOf(saveDawProject(project));
    expect(out).toContain('name="Input/Output"');
    expect(differences(parse(xml), parse(out))).toEqual([]);
    project.dispose();
  });

  test("a decibel Volume and a -1..1 Pan read as linear gain and position, and an edit is written back in the file's own units", () => {
    const xml = base(
      `<Track id="t" contentType="audio" name="T" color="#ff0000"><Channel id="tc" role="regular" destination="m"><Pan id="p" unit="normalized" min="-1" max="1" value="-0.5"/><Volume id="v" unit="decibel" value="-6.0206"/></Channel></Track>${master}`,
    );
    const { project } = openDawProject(withProject(xml));
    expect(project.tracks[0].volume).toBeCloseTo(0.5, 4);
    expect(project.tracks[0].pan).toBeCloseTo(-0.5, 6);
    project.setTrackVolume(project.tracks[0].id, 1);
    project.setTrackPan(project.tracks[0].id, 0.5);
    const tree = parse(xmlOf(saveDawProject(project)));
    const structure = tree.children.find((child) => child.tag === "Structure")!;
    const channel = structure.children[0].children[0];
    expect(channel.children.find((child) => child.tag === "Volume")!.attrs).toMatchObject({ unit: "decibel", value: "0" });
    expect(channel.children.find((child) => child.tag === "Pan")!.attrs).toMatchObject({ min: "-1", max: "1", value: "0.5" });
    expect(structure.children[0].attrs.color).toBe("#ff0000");
    project.dispose();
  });

  test("a disabled or pre-fader send is kept and the enabled one drives the model", () => {
    const xml = base(
      `<Track id="a" contentType="audio" name="A"><Channel id="ac" role="regular" destination="m"><Sends>` +
        `<Send id="s1" type="post" destination="bc"><Volume id="s1v" unit="linear" value="0.3"/></Send>` +
        `<Send id="s2" type="post" destination="bc"><Enable value="false"/><Volume id="s2v" unit="linear" value="0.9"/></Send>` +
        `<Send id="s3" type="pre" destination="bc"><Volume id="s3v" unit="linear" value="0.8"/></Send></Sends><Volume id="av" unit="linear" value="1"/></Channel></Track>` +
        `<Track id="b" contentType="audio" name="B"><Channel id="bc" role="effect" destination="m"><Volume id="bv" unit="linear" value="1"/></Channel></Track>${master}`,
    );
    const { project, warnings } = openDawProject(withProject(xml));
    expect(project.tracks[0].routing.sends).toEqual([{ busId: "b", gain: 0.3 }]);
    expect(warnings.join()).toContain("Disabled send");
    project.setTrackRouting("a", { outputBusId: null, sends: [{ busId: "b", gain: 0.6 }] });
    const sends = parse(xmlOf(saveDawProject(project)))
      .children.find((child) => child.tag === "Structure")!
      .children[0].children[0].children.find((child) => child.tag === "Sends")!;
    expect(sends.children.map((send) => send.attrs.id + ":" + (send.children.find((c) => c.tag === "Volume")!.attrs.value ?? ""))).toEqual([
      "s1:0.6",
      "s2:0.9",
      "s3:0.8",
    ]);
    project.dispose();
  });

  test("a track, a clip and a marker added to a foreign file arrive beside its own content and the result is schema-valid", async () => {
    const xml = base(
      `<Track id="a" contentType="notes" name="A" color="#00ff00"><Channel id="ac" role="regular" destination="m"><Volume id="av" unit="linear" value="1"/></Channel></Track>${master}`,
      `<Arrangement id="arr"><Lanes timeUnit="beats" id="outer"><Lanes track="a" id="la"><Clips id="ca"/></Lanes></Lanes></Arrangement>`,
    );
    const { project } = openDawProject(withProject(xml));
    const added = project.addTrack("New", "audio");
    project.addAudioClip(added.id, { sampleRate: 48_000, channels: [new Float32Array(480)] }, 1);
    project.addMidiClip(project.tracks[0].id, { duration: 4, notes: [{ id: "n", pitch: 60, velocity: 0.8, start: 0, duration: 1 }] }, 2);
    project.setMarkers([{ time: 1, name: "M" }]);
    const saved = saveDawProject(project);
    expect(await xsdViolations([{ name: "added", bytes: saved }])).toEqual([]);
    const reopened = openDawProject(saved);
    expect(reopened.project.tracks.map((track) => track.name)).toEqual(["A", "New"]);
    expect(reopened.project.tracks[1].clips).toHaveLength(1);
    expect(midiClips(reopened.project)).toHaveLength(1);
    expect(reopened.project.markers).toEqual([{ time: 1, name: "M" }]);
    expect(strFromU8(unzipSync(saved)["project.xml"])).toContain('color="#00ff00"');
    reopened.project.dispose();
    project.removeTrack(added.id);
    expect(await xsdViolations([{ name: "removed", bytes: saveDawProject(project) }])).toEqual([]);
    project.dispose();
  });

  test("16-bit and 24-bit PCM WAV audio decodes", () => {
    const wav = (bits: 16 | 24) => {
      const frames = 4;
      const width = bits / 8;
      const bytes = new Uint8Array(44 + frames * width);
      const view = new DataView(bytes.buffer);
      bytes.set(strToU8("RIFF"), 0);
      view.setUint32(4, 36 + frames * width, true);
      bytes.set(strToU8("WAVEfmt "), 8);
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true);
      view.setUint32(28, 8000 * width, true);
      view.setUint16(32, width, true);
      view.setUint16(34, bits, true);
      bytes.set(strToU8("data"), 36);
      view.setUint32(40, frames * width, true);
      const values = [0, 0.5, -0.5, -1];
      values.forEach((value, i) => {
        if (bits === 16) view.setInt16(44 + i * 2, Math.round(value * 32767), true);
        else {
          const int = Math.round(value * 8388607);
          view.setUint8(44 + i * 3, int & 255);
          view.setUint8(45 + i * 3, (int >> 8) & 255);
          view.setUint8(46 + i * 3, (int >> 16) & 255);
        }
      });
      return bytes;
    };
    for (const bits of [16, 24] as const) {
      const xml = base(
        `<Track id="a" contentType="audio" name="A"><Channel id="ac" role="regular" destination="m"><Volume id="av" unit="linear" value="1"/></Channel></Track>${master}`,
        `<Arrangement id="arr"><Lanes timeUnit="seconds" id="outer"><Lanes track="a" id="la"><Clips id="ca"><Clip time="0" duration="0.0005" playStart="0" playStop="0.0005"><Audio id="au" channels="1" sampleRate="8000" duration="0.0005"><File path="audio/Take ${bits}.wav"/></Audio></Clip></Clips></Lanes></Lanes></Arrangement>`,
      );
      const { project } = openDawProject(withProject(xml, { [`audio/Take ${bits}.wav`]: wav(bits) }));
      const clip = project.tracks[0].clips[0];
      expect(clip.kind).toBe("audio");
      const channel = (clip as Extract<ProjectClip, { kind: "audio" }>).channels[0];
      expect(Array.from(channel).map((value) => Math.round(value * 100) / 100)).toEqual([0, 0.5, -0.5, -1]);
      // The untouched clip keeps the file's own bytes, spaces in the name and all.
      expect(unzipSync(saveDawProject(project))[`audio/Take ${bits}.wav`]).toEqual(wav(bits));
      project.dispose();
    }
  });

  test("reordering WebCLAP devices and scenes reorders the file's own elements and leaves the plug-ins it cannot host where they are", () => {
    const device = (id: string) =>
      `<ClapPlugin id="${id}" deviceID="com.example.${id}" deviceName="${id}" deviceRole="audioFX"><Enabled value="true"/><State path="plugins/${id}.clap-preset"/></ClapPlugin>`;
    const xml = base(
      `<Track id="a" contentType="audio" name="A"><Channel id="ac" role="regular" destination="m"><Devices>${device("one")}<Vst3Plugin id="vst" deviceID="X" deviceName="Hosted elsewhere" deviceRole="audioFX"/>${device("two")}</Devices><Volume id="av" unit="linear" value="1"/></Channel></Track>${master}`,
      "",
      `<Scenes><Scene id="s1" name="One"/><Scene id="s2" name="Two"/><Scene id="s3" name="Three"/></Scenes>`,
    );
    const { project } = openDawProject(
      withProject(xml, { "plugins/one.clap-preset": new Uint8Array([1]), "plugins/two.clap-preset": new Uint8Array([2]) }),
    );
    expect(project.tracks[0].devices.map((item) => item.id)).toEqual(["one", "two"]);
    project.moveDevice("two", 0);
    sessionFor(project).moveScene("s3", 0);
    const tree = parse(xmlOf(saveDawProject(project)));
    const devices = tree.children.find((child) => child.tag === "Structure")!.children[0].children[0].children[0];
    expect(devices.children.map((child) => child.attrs.id)).toEqual(["two", "vst", "one"]);
    const scenes = tree.children.find((child) => child.tag === "Scenes")!;
    expect(scenes.children.map((child) => child.attrs.id)).toEqual(["s3", "s1", "s2"]);
    project.dispose();
  });

  test("the schema validator really rejects a document that breaks it", async () => {
    expect(
      (await xsdViolationsOfXml([{ fileName: "bad.xml", contents: '<Project version="1.0"><Structure/></Project>' }], "Project.xsd")).length,
    ).toBeGreaterThan(0);
  });
});

describe("edits beyond one clip in a file another application wrote", () => {
  const canon = () => openDawProject(file("bitwig-5.3-canon-in-d.dawproject"));
  const canonXml = () => xmlOf(file("bitwig-5.3-canon-in-d.dawproject"));

  test("an edited clip keeps the release velocity of every note it still has", () => {
    const { project } = openDawProject(archiveOf("bitwig-readme/project.xml"));
    midiClips(project)[0].midi.edit((notes) => {
      notes[0].velocity = 0.5;
    });
    const out = xmlOf(saveDawProject(project));
    expect(out.match(/rel="0.787402"/g)).toHaveLength(9);
    expect(out).toContain('vel="0.5"');
    project.dispose();
  });

  test("a mixer change, a title and a removed clip reach the file and leave its own content alone", async () => {
    const { project } = canon();
    project.setTrackVolume(project.tracks[0].id, 1.5);
    project.setTrackMuted(project.tracks[1].id, true);
    project.setTrackPan(project.tracks[1].id, -1);
    project.setTitle("Canon, second take");
    project.removeClip(midiClips(project)[1].id);
    const saved = saveDawProject(project);
    const changed = differences(parse(canonXml()), parse(xmlOf(saved)));
    expect(changed.some((path) => path.endsWith("/Clips[0]/Clip[0] (removed)"))).toBe(true);
    expect(changed).toContain("Project/Structure[0]/Track[0]/Channel[0]/Volume[0]@value");
    expect(changed).toContain("Project/Structure[0]/Track[1]/Channel[0]/Mute[0]@value");
    expect(changed).toContain("Project/Structure[0]/Track[1]/Channel[0]/Pan[0]@value");
    // The Vst3 plug-in, its preset, the CC lanes, the scenes and the other application's name are all still there.
    const out = xmlOf(saved);
    expect(out).toContain("<Vst3Plugin");
    expect(out).toContain('<Application name="Bitwig Studio"');
    expect(out.match(/<Scene /g)).toHaveLength(8);
    expect(unzipSync(saved)["plugins/9ff5aebf-00ac-4f1b-ae2f-f4a599b76c20.vstpreset"]).toEqual(
      unzipSync(file("bitwig-5.3-canon-in-d.dawproject"))["plugins/9ff5aebf-00ac-4f1b-ae2f-f4a599b76c20.vstpreset"],
    );
    expect(await xsdViolations([{ name: "mixer", bytes: saved }])).toEqual([]);
    const reopened = openDawProject(saved);
    expect(reopened.project.title).toBe("Canon, second take");
    expect(reopened.project.tracks[0].volume).toBe(1.5);
    expect(reopened.project.tracks[1].muted).toBe(true);
    expect(midiClips(reopened.project)).toHaveLength(1);
    reopened.project.dispose();
    project.dispose();
  });

  test("a Session clip goes into the file's empty slot, and a scene can be renamed and removed", async () => {
    const { project } = canon();
    const session = sessionFor(project);
    expect(session.scenes).toHaveLength(8);
    session.setMidiClip(
      { trackId: project.tracks[0].id, sceneId: session.scenes[0].id },
      { duration: 4, notes: [{ id: "n", pitch: 60, velocity: 0.8, start: 0, duration: 1 }] },
    );
    session.renameScene(session.scenes[1].id, "Bridge");
    session.removeScene(session.scenes[7].id);
    const saved = saveDawProject(project);
    const out = xmlOf(saved);
    expect(out.match(/<Scene /g)).toHaveLength(7);
    expect(out).toContain('name="Bridge"');
    expect(await xsdViolations([{ name: "scenes", bytes: saved }])).toEqual([]);
    const reopened = openDawProject(saved);
    const again = sessionFor(reopened.project);
    expect(again.scenes.map((scene) => scene.name)[1]).toBe("Bridge");
    expect(again.clipAt({ trackId: reopened.project.tracks[0].id, sceneId: again.scenes[0].id })?.kind).toBe("midi");
    reopened.project.dispose();
    project.dispose();
  });

  test("a change the file cannot take is refused, not dropped", () => {
    const { project } = openDawProject(
      zipSync({
        ...unzipSync(file("bitwig-5.3-canon-in-d.dawproject")),
        "project.xml": strToU8(
          canonXml().replace('value="50.000083" interpolation="linear" time="400.997916"', 'value="75" interpolation="linear" time="400.997916"'),
        ),
      }),
    );
    // A real ramp in the file's tempo automation: the model has steps only.
    project.setTempoChanges([{ beat: 16, bpm: 90 }]);
    expect(() => saveDawProject(project)).toThrow("Project tempo changes cannot be saved");
    project.dispose();
  });

  test.each(samples.map((sample) => sample.name))("%s opens from a Blob and streams back the same file", async (name) => {
    const bytes = archiveOf(name);
    const { project } = await openDawProjectBlob(new Blob([bytes as BlobPart]));
    const chunks: Uint8Array[] = [];
    await saveDawProjectTo(project, new WritableStream({ write: (chunk) => void chunks.push(chunk) }));
    const out = new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
    expect(differences(parse(xmlOf(bytes)), parse(xmlOf(out)))).toEqual([]);
    for (const [path, content] of Object.entries(unzipSync(bytes)))
      if (!path.endsWith("/") && path !== "project.xml" && path !== "metadata.xml") expect(unzipSync(out)[path], path).toEqual(content);
    project.dispose();
  });
});
