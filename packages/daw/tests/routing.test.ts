import { describe, expect, test } from "vitest";
import { unzipSync } from "fflate";
import { Project, openDawProject, saveDawProject } from "../src";

describe("project mixer routing", () => {
  test("preserves both output destinations and post-fader sends in standard XML", async () => {
    const project = new Project();
    const keys = project.addTrack("Keys", "midi", { id: "keys" });
    const drums = project.addTrack("Drums", "audio", { id: "drums" });
    const group = project.addTrack("Drum group", "bus", { id: "group" });
    const effect = project.addTrack("Delay return", "bus", { id: "wet", busRole: "effect" });
    project.setTrackRouting(keys.id, { outputBusId: null, sends: [{ busId: effect.id, gain: 0.25 }] });
    project.setTrackRouting(drums.id, { outputBusId: group.id, sends: [{ busId: effect.id, gain: 0.45 }] });
    project.setTrackEffects(effect.id, [{ id: "delay", type: "delay", delayTime: 0.3, feedback: 0.2, wet: 1, enabled: true }]);
    const saved = await saveDawProject(project);
    const entries = unzipSync(saved);
    const xml = new TextDecoder().decode(entries["project.xml"]);
    expect(xml).toContain('id="drums-channel" role="regular" destination="group-channel"');
    expect(xml.match(/<Send destination="wet-channel" type="post">/g)).toHaveLength(2);
    expect(xml).toContain('id="wet-channel" role="effect"');
    const { project: reopened, warnings } = openDawProject(saved);
    expect(warnings).toEqual([]);
    expect(reopened.tracks).toEqual(project.tracks);
    reopened.dispose();
    project.dispose();
  });

  test("validates destinations and cycles atomically, and clears incoming edges when a bus is removed", () => {
    const project = new Project();
    const source = project.addTrack("Source", "audio");
    const first = project.addTrack("First", "bus");
    const second = project.addTrack("Second", "bus");
    project.setTrackRouting(source.id, { outputBusId: first.id, sends: [{ busId: second.id, gain: 0.5 }] });
    project.setTrackRouting(second.id, { outputBusId: first.id, sends: [] });
    expect(() => project.setTrackRouting(first.id, { outputBusId: null, sends: [{ busId: second.id, gain: 0 }] })).toThrow(/cycle/);
    expect(() => project.setTrackRouting(second.id, { outputBusId: source.id, sends: [] })).toThrow(/existing buses/);
    expect(project.tracks[1].routing).toEqual({ outputBusId: null, sends: [] });
    expect(project.tracks[2].routing.outputBusId).toBe(first.id);
    project.removeTrack(first.id);
    expect(project.tracks[0].routing).toEqual({ outputBusId: null, sends: [{ busId: second.id, gain: 0.5 }] });
    expect(project.tracks[1].routing).toEqual({ outputBusId: null, sends: [] });
    project.dispose();
  });
});
