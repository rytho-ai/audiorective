import { afterEach, describe, expect, test } from "vitest";
import type { SoundFactory } from "@audiorective/core";
import { Project, Workspace, renderStems } from "../src";
import { mcpTools } from "../src/mcp";

const RATE = 48_000;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const click: SoundFactory = (context) => {
  const osc = new OscillatorNode(context, { frequency: 1000 });
  const gain = new GainNode(context, { gain: 0.5 });
  osc.connect(gain);
  return { output: gain, sources: [osc], duration: 0.02 };
};

async function open(setup: (project: Project) => void, instruments?: (id: string) => boolean) {
  const project = new Project({ bpm: 120 });
  setup(project);
  const context = new AudioContext({ sampleRate: RATE });
  const workspace = await Workspace.create(context, project, {
    instruments: (track) => (instruments?.(track.id) ? { sound: click } : undefined),
  });
  cleanups.push(async () => {
    workspace.dispose();
    project.dispose();
    await context.close();
  });
  await workspace.sync();
  return { project, workspace };
}

const notes = [{ pitch: 60, velocity: 1, start: 0, duration: 1 }];

describe("renderStems warnings", () => {
  test("a MIDI track with no device and no instrument, and a muted track, each get one warning; a sounding MIDI track gets none", async () => {
    let playing = "";
    const { workspace } = await open(
      (project) => {
        const keys = project.addTrack("Keys", "midi");
        project.addMidiClip(keys.id, { notes, duration: 2 }, 0);
        const lead = project.addTrack("Lead", "midi");
        project.addMidiClip(lead.id, { notes, duration: 2 }, 0);
        playing = lead.id;
        const pad = project.addTrack("Pad", "audio", { muted: true });
        project.addAudioClip(pad.id, { sampleRate: RATE, channels: [new Float32Array(RATE / 2).fill(0.1)] }, 0);
      },
      (id) => id === playing,
    );
    const result = await renderStems(workspace, { tailSeconds: 0, includeMix: false });
    if (result.status !== "rendered") throw new Error("expected a render");
    expect(result.warnings).toEqual([
      'Track "Keys" has no instrument or plug-in, so its stem is silent.',
      'Track "Pad" is muted, so its stem is silent.',
    ]);
    const peak = (index: number) => Math.max(...result.stems[index].audio.channels[0].map(Math.abs));
    expect(peak(0)).toBe(0);
    expect(peak(1)).toBeGreaterThan(0.01);
  });

  test("a project whose stems can all sound has an empty warnings list", async () => {
    const { workspace } = await open((project) => {
      const drums = project.addTrack("Drums", "audio");
      project.addAudioClip(drums.id, { sampleRate: RATE, channels: [new Float32Array(RATE / 2).fill(0.1)] }, 0);
    });
    const result = await renderStems(workspace, { tailSeconds: 0 });
    if (result.status !== "rendered") throw new Error("expected a render");
    expect(result.warnings).toEqual([]);
  });

  test("export_stems repeats the warnings in its result", async () => {
    const { workspace } = await open((project) => {
      const keys = project.addTrack("Keys", "midi");
      project.addMidiClip(keys.id, { notes, duration: 2 }, 0);
    });
    const saved: string[] = [];
    const tool = mcpTools(workspace, { save: (_bytes, name) => void saved.push(name) }).find((candidate) => candidate.name === "export_stems")!;
    const body = JSON.parse((await tool.call({ name: "song", tailSeconds: 0 })).content);
    expect(body.status).toBe("saved");
    expect(body.warnings).toEqual(['Track "Keys" has no instrument or plug-in, so its stem is silent.']);
    expect(saved).toEqual(["song-Keys.wav", "song-mix.wav"]);
  });
});
