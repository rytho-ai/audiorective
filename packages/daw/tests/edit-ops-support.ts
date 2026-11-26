import { expect } from "vitest";
import { MidiClip, Project, sessionFor, type ProjectEditOperation, type ProjectEditReceipt, type ProjectVersion } from "../src/project";

const SAMPLE_RATE = 100;
export const pcm = (seconds: number, value = 0.5) => ({
  sampleRate: SAMPLE_RATE,
  channels: [new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(value)],
});

/** A song with every kind of target: audio, MIDI and bus tracks, two plug-in devices, two scenes and a slot clip. */
export function world() {
  const project = new Project({ bpm: 120, title: "Song" });
  const drums = project.addTrack("Drums", "audio");
  const keys = project.addTrack("Keys", "midi");
  const bass = project.addTrack("Bass", "midi");
  const reverb = project.addTrack("Reverb", "bus", { busRole: "effect" });
  const aux = project.addTrack("Aux", "bus");
  const take = project.addAudioClip(drums.id, pcm(4), 2, { name: "Take" });
  const pattern = project.addMidiClip(
    keys.id,
    {
      duration: 8,
      notes: [
        { id: "n1", pitch: 60, velocity: 0.5, start: 0, duration: 1 },
        { id: "n2", pitch: 64, velocity: 0.5, start: 2, duration: 1 },
      ],
    },
    8,
    { name: "Pattern" },
  );
  const synth = project.addWebClapDevice(keys.id, { pluginId: "a", name: "A", vendor: "v", version: "1", bundleUrl: "/a.wclap" });
  const other = project.addWebClapDevice(keys.id, { pluginId: "b", name: "B", vendor: "v", version: "1", bundleUrl: "/b.wclap" });
  project.setTrackEffects(drums.id, [{ id: "f1", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 1000, q: 1 }]);
  const session = sessionFor(project);
  const verse = session.addScene({ name: "Verse" });
  const chorus = session.addScene({ name: "Chorus" });
  const hook = session.setMidiClip(
    { sceneId: verse.id, trackId: keys.id },
    { duration: 4, notes: [{ pitch: 62, start: 0, duration: 1, velocity: 0.7 }] },
  );
  return { project, session, drums, keys, bass, reverb, aux, take, pattern, synth, other, verse, chorus, hook };
}
export type World = ReturnType<typeof world>;

/** Everything an edit can change, as one string, so Undo can be compared with the state before. */
export function fingerprint(project: Project): string {
  const session = sessionFor(project);
  const clip = (c: ReturnType<typeof session.clipAt> & object) => ({
    id: c.id,
    kind: c.kind,
    time: c.time,
    duration: c.duration,
    sourceOffset: c.sourceOffset,
    loop: c.loop,
    name: project.clipName(c.id),
    envelope: c.kind === "audio" ? c.envelope : undefined,
    gain: c.kind === "audio" ? c.gainAutomation : undefined,
    notes: c instanceof MidiClip ? c.midi.notes.value : undefined,
    linked: project.linkedClips(c.id).map(({ id }) => id),
  });
  return JSON.stringify({
    title: project.title,
    master: project.masterVolume,
    tempo: [project.bpm, project.tempoMap.changes],
    meter: [project.signature, project.meterMap.changes],
    markers: project.markers,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind,
      busRole: track.busRole,
      volume: track.volume,
      muted: track.muted,
      solo: track.solo,
      pan: track.pan,
      routing: track.routing,
      effects: track.effects,
      macros: track.effectMacros,
      automation: track.volumeAutomation,
      devices: track.devices.map((device) => device.id),
      clips: track.clips.map(clip),
    })),
    scenes: session.scenes.map((scene) => ({
      ...scene,
      slots: project.tracks.map((track) => {
        const slot = session.clipAt({ sceneId: scene.id, trackId: track.id });
        return slot ? clip(slot) : null;
      }),
    })),
  });
}

export const version = (project: Project): ProjectVersion => project.cells.version.value;

export function apply(project: Project, ops: readonly ProjectEditOperation[], label = "Test"): Extract<ProjectEditReceipt, { status: "applied" }> {
  const receipt = project.applyEdits({ expectedVersion: version(project), label, ops });
  if (receipt.status !== "applied") throw new Error(`${receipt.status}: ${"reason" in receipt ? receipt.reason : ""}`);
  return receipt;
}

export function reject(project: Project, op: unknown): Extract<ProjectEditReceipt, { status: "rejected" }> {
  const before = fingerprint(project);
  const v = version(project);
  const receipt = project.applyEdits({ expectedVersion: v, label: "Bad", ops: [op as ProjectEditOperation] });
  if (receipt.status !== "rejected") throw new Error(`expected a rejection, got ${receipt.status}`);
  expect(receipt.opIndex).toBe(0);
  expect(fingerprint(project)).toBe(before);
  expect(version(project)).toBe(v);
  return receipt;
}

/**
 * Applies the operations and checks the shared contract: a new version, one Undo step that restores the exact earlier state, and Redo that
 * restores the edited state. Returns the receipt so the caller can check the effect.
 */
export function applyAndUndo(project: Project, ops: readonly ProjectEditOperation[]): Extract<ProjectEditReceipt, { status: "applied" }> {
  const before = fingerprint(project);
  const v = version(project);
  const receipt = apply(project, ops);
  const after = fingerprint(project);
  expect(after).not.toBe(before);
  expect(receipt.version).not.toBe(v);
  expect(project.cells.history.value.undo).toBe("Test");
  expect(project.undo().status).toBe("applied");
  expect(fingerprint(project)).toBe(before);
  expect(project.redo().status).toBe("applied");
  expect(fingerprint(project)).toBe(after);
  expect(project.undo().status).toBe("applied");
  expect(fingerprint(project)).toBe(before);
  // Leave the project edited, as a caller expects.
  expect(project.redo().status).toBe("applied");
  return receipt;
}
