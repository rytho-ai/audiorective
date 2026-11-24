import { unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { Project, defineExtension, defineOperation, openDawProject, openDawProjectBlob, saveDawProject, saveDawProjectTo } from "../src";
import { keepsFileBackedEntries } from "../src/dawproject";

const chainDef = defineExtension({ id: "groovebox.chain", defaultValue: (): number[] => [] });

function song() {
  const project = new Project({ bpm: 120 });
  const track = project.addTrack("Drums", "midi");
  project.addMidiClip(track.id, { duration: 4, notes: [] }, 0);
  return { project, track };
}

describe("extension data", () => {
  test("starts at its default, joins an edit as one Undo step and changes the version", () => {
    const { project } = song();
    const chain = project.extension(chainDef);
    expect(project.extension(chainDef)).toBe(chain);
    expect(chain.value).toEqual([]);
    const seen: number[][] = [];
    const stop = chain.subscribe((value) => seen.push([...value]));
    const version = project.cells.version.value;
    project.edit("Add A twice", () => {
      chain.update((scenes) => {
        scenes.push(0);
      });
      chain.update((scenes) => {
        scenes.push(0);
      });
    });
    expect(chain.value).toEqual([0, 0]);
    expect(Object.isFrozen(chain.value)).toBe(true);
    expect(project.cells.version.value).not.toBe(version);
    expect(project.cells.history.value).toEqual({ undo: "Add A twice" });
    project.undo();
    expect(chain.value).toEqual([]);
    project.redo();
    expect(chain.value).toEqual([0, 0]);
    expect(seen).toEqual([[0, 0], [], [0, 0]]);
    stop();
    // On its own a change is a song change but not an Undo step, like other Project methods.
    const before = project.cells.version.value;
    chain.set([1]);
    expect(project.cells.version.value).not.toBe(before);
    expect(project.cells.history.value).toEqual({ undo: "Add A twice" });
    expect(() => chain.set([Number.NaN] as never)).toThrow('Extension "groovebox.chain" data must be JSON: numbers must be finite.');
    project.dispose();
  });

  test("is saved in the file, comes back on open and survives an app that does not define it", () => {
    const { project, track } = song();
    project.extension(chainDef).set([0, 0, 1]);
    const bytes = saveDawProject(project);
    expect(JSON.parse(new TextDecoder().decode(unzipSync(bytes)["extensions/groovebox.chain/data.json"]))).toEqual({ version: 1, data: [0, 0, 1] });
    // An app without the definition opens it, edits the music and saves.
    const other = openDawProject(bytes).project;
    other.edit("Move", () => other.moveClip(other.tracks[0].clips[0].id, track.id, 4));
    const resaved = saveDawProject(other);
    const again = openDawProject(resaved).project;
    expect(again.extension(chainDef).value).toEqual([0, 0, 1]);
    expect(again.tracks[0].clips[0].time).toBe(4);
    for (const p of [project, other, again]) p.dispose();
  });

  test("validate migrates older data; data it rejects falls back to the default and stays in the file", () => {
    const v2 = defineExtension({
      id: "groovebox.chain",
      version: 2,
      defaultValue: () => ({ scenes: [] as number[] }),
      validate: (data, version) => {
        if (version === 1 && Array.isArray(data)) return { scenes: data as number[] };
        if (data && typeof data === "object" && Array.isArray((data as { scenes?: unknown }).scenes)) return data as { scenes: number[] };
        throw new Error("not a chain");
      },
    });
    const { project } = song();
    project.extension(chainDef).set([2, 1]);
    const opened = openDawProject(saveDawProject(project)).project;
    expect(opened.extension(v2).value).toEqual({ scenes: [2, 1] });
    opened.extension(v2).update((value) => {
      value.scenes.push(3);
    });
    expect(JSON.parse(new TextDecoder().decode(unzipSync(saveDawProject(opened))["extensions/groovebox.chain/data.json"]))).toEqual({
      version: 2,
      data: { scenes: [2, 1, 3] },
    });
    const bad = unzipSync(saveDawProject(project));
    bad["extensions/groovebox.chain/data.json"] = new TextEncoder().encode(JSON.stringify({ version: 1, data: "nonsense" }));
    const rejected = openDawProject(zipSync(bad)).project;
    expect(rejected.extension(v2).value).toEqual({ scenes: [] });
    expect(new TextDecoder().decode(unzipSync(saveDawProject(rejected))["extensions/groovebox.chain/data.json"])).toContain("nonsense");
    for (const p of [project, opened, rejected]) p.dispose();
  });

  test("files the codec does not use are kept and written back unchanged; unreadable extension data warns and is kept", () => {
    const { project } = song();
    const entries = unzipSync(saveDawProject(project));
    entries["bitwig/notes.txt"] = new TextEncoder().encode("from another app");
    entries["extensions/broken/data.json"] = new TextEncoder().encode("{not json");
    const { project: opened, warnings } = openDawProject(zipSync(entries));
    expect(warnings).toEqual(["Extension data in extensions/broken/data.json could not be read and is kept unchanged."]);
    const out = unzipSync(saveDawProject(opened.snapshot()));
    expect(new TextDecoder().decode(out["bitwig/notes.txt"])).toBe("from another app");
    expect(new TextDecoder().decode(out["extensions/broken/data.json"])).toBe("{not json");
    project.dispose();
    opened.dispose();
  });

  test("defineExtension rejects ids that cannot name a folder", () => {
    expect(() => defineExtension({ id: "../x", defaultValue: () => 1 })).toThrow(
      'Extension id must be letters, digits, dots and dashes, such as "groovebox.chain".',
    );
    expect(() => defineExtension({ id: "ok", version: 0, defaultValue: () => 1 })).toThrow("Extension version must be a positive integer.");
  });
});

describe("operations", () => {
  const shift = defineOperation({
    name: "test.shift-clips",
    description: "Move every clip later by some beats.",
    input: { type: "object", properties: { beats: { type: "number", minimum: 0 } }, required: ["beats"] },
    run(project, args: { beats: number }) {
      let moved = 0;
      for (const track of project.tracks)
        for (const clip of track.clips) {
          project.moveClip(clip.id, track.id, clip.time + args.beats);
          moved++;
        }
      if (args.beats > 100) throw new Error("too far");
      return { moved };
    },
  });

  test("register, list and call by name; one call is one Undo step", () => {
    const { project } = song();
    const remove = project.operations.register(shift);
    expect(project.operations.list()).toEqual([
      { name: "test.shift-clips", description: "Move every clip later by some beats.", input: shift.input },
    ]);
    expect(() => project.operations.register(shift)).toThrow('Project already has an operation named "test.shift-clips".');
    const version = project.cells.version.value;
    expect(project.operations.call("test.shift-clips", { beats: 4 })).toEqual({ moved: 1 });
    expect(project.tracks[0].clips[0].time).toBe(4);
    expect(project.cells.version.value).not.toBe(version);
    expect(project.cells.history.value).toEqual({ undo: "Move every clip later by some beats." });
    project.undo();
    expect(project.tracks[0].clips[0].time).toBe(0);
    remove();
    expect(project.operations.list()).toEqual([]);
    expect(() => project.operations.call("test.shift-clips", { beats: 1 })).toThrow('Project has no operation named "test.shift-clips".');
    project.dispose();
  });

  test("invalid arguments and a throwing run change nothing", () => {
    const { project } = song();
    project.operations.register(shift);
    const version = project.cells.version.value;
    expect(() => project.operations.call("test.shift-clips", {})).toThrow('Operation "test.shift-clips": args needs "beats".');
    expect(() => project.operations.call("test.shift-clips", { beats: -1 })).toThrow('Operation "test.shift-clips": args.beats must be at least 0.');
    expect(() => project.operations.call("test.shift-clips", { beats: "2" })).toThrow(
      'Operation "test.shift-clips": args.beats must be a finite number.',
    );
    expect(() => project.operations.call("test.shift-clips", { beats: 200 })).toThrow("too far");
    expect(project.tracks[0].clips[0].time).toBe(0);
    expect(project.cells.version.value).toBe(version);
    expect(project.cells.history.value).toEqual({});
    project.dispose();
  });

  test("an operation can change extension data in the same Undo step", () => {
    const { project } = song();
    project.operations.register(
      defineOperation({
        name: "test.append",
        description: "Append a scene to the chain.",
        input: { type: "object", properties: { scene: { type: "integer", minimum: 0 } }, required: ["scene"] },
        run: (p, args: { scene: number }) =>
          p.extension(chainDef).update((scenes) => {
            scenes.push(args.scene);
          }),
      }),
    );
    project.operations.call("test.append", { scene: 2 });
    expect(project.extension(chainDef).value).toEqual([2]);
    project.undo();
    expect(project.extension(chainDef).value).toEqual([]);
    project.dispose();
  });
});

describe("extension and operation edge cases", () => {
  test("update takes a returned value; an unchanged value is no change", () => {
    const { project } = song();
    const count = project.extension(defineExtension({ id: "test.count", defaultValue: () => 0 }));
    count.update((n) => n + 1);
    expect(count.value).toBe(1);
    const version = project.cells.version.value;
    project.extension(chainDef).update((scenes) => [...scenes]);
    count.set(1);
    expect(project.cells.version.value).toBe(version);
    const holey: number[] = [1];
    holey[2] = 3; // index 1 is a hole
    expect(() => project.extension(chainDef).set(holey)).toThrow("must be JSON");
    project.dispose();
  });

  test("data from a newer version reads as the default and cannot be overwritten by an older app", () => {
    const { project } = song();
    const v2 = defineExtension({ id: "groovebox.chain", version: 2, defaultValue: () => ({ scenes: [] as number[] }) });
    project.extension(v2).set({ scenes: [5] });
    const older = openDawProject(saveDawProject(project)).project;
    expect(older.extension(chainDef).value).toEqual([]);
    expect(() => older.extension(chainDef).set([1])).toThrow(
      'Extension "groovebox.chain" data was saved by its version 2; this app has version 1 and cannot change it.',
    );
    expect(openDawProject(saveDawProject(older)).project.extension(v2).value).toEqual({ scenes: [5] });
    project.dispose();
    older.dispose();
  });

  test("an operation may use project.edit and applyEdits; they join its one Undo step", () => {
    const { project, track } = song();
    project.operations.register(
      defineOperation({
        name: "test.nested",
        description: "Move with edit, then rename with applyEdits.",
        input: { type: "object", properties: {} },
        run(p) {
          p.edit("inner", () => p.moveClip(p.tracks[0].clips[0].id, track.id, 8));
          const receipt = p.applyEdits({
            expectedVersion: p.cells.version.value,
            label: "inner",
            ops: [{ type: "renameClip", clip: { clipId: p.tracks[0].clips[0].id }, name: "Verse" }],
          });
          return receipt.status;
        },
      }),
    );
    expect(project.operations.call("test.nested")).toBe("applied");
    expect(project.tracks[0].clips[0].time).toBe(8);
    expect(project.clipName(project.tracks[0].clips[0].id)).toBe("Verse");
    expect(project.cells.history.value).toEqual({ undo: "Move with edit, then rename with applyEdits." });
    project.undo();
    expect(project.tracks[0].clips[0].time).toBe(0);
    expect(project.clipName(project.tracks[0].clips[0].id)).toBeUndefined();
    project.dispose();
  });

  test("required names are the arguments' own; interfaces type-check as data and arguments", () => {
    interface Chain {
      scenes: number[];
    }
    interface Args {
      scene: number;
    }
    const typed = defineExtension({ id: "test.typed", defaultValue: (): Chain => ({ scenes: [] }) });
    const op = defineOperation({
      name: "test.own",
      description: "Needs constructor.",
      input: { type: "object", properties: { scene: { type: "integer" } }, required: ["constructor"] },
      run: (_p, args: Args) => args.scene,
    });
    const { project } = song();
    project.extension(typed).update((value) => {
      value.scenes.push(1);
    });
    project.operations.register(op);
    expect(() => project.operations.call("test.own", {})).toThrow('Operation "test.own": args needs "constructor".');
    project.dispose();
  });
  test("an unused audio file kept from a Blob-opened archive is streamed back on save", async () => {
    const { project } = song();
    const entries = unzipSync(saveDawProject(project));
    entries["audio/extra.wav"] = new Uint8Array(64).fill(7);
    const { project: opened } = await openDawProjectBlob(new Blob([zipSync(entries)]));
    expect(keepsFileBackedEntries(opened)).toBe(true);
    expect(() => saveDawProject(opened)).toThrow("Project file-backed audio needs saveDawProjectTo().");
    const chunks: Uint8Array[] = [];
    await saveDawProjectTo(opened, new WritableStream({ write: (chunk) => void chunks.push(chunk) }));
    const out = unzipSync(new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()));
    expect(out["audio/extra.wav"]).toEqual(new Uint8Array(64).fill(7));
    project.dispose();
    opened.dispose();
  });
});
