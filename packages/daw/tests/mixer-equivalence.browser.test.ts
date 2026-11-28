import { expect, test } from "vitest";
import { server } from "vitest/browser";
import { Project, Workspace } from "../src";
import reference from "./fixtures/mixer-reference.json";

/**
 * Offline PCM equivalence for the Workspace mixer strips.
 *
 * `fixtures/mixer-reference.json` was recorded from the hand-built GainNode/StereoPannerNode strips at c6a2f57,
 * before the strips moved to `@audiorective/effects` `Channel`. Set RECORD to true to regenerate it deliberately.
 * The render must match the recorded samples to a maximum absolute difference below TOLERANCE.
 */
const RECORD = false;
const TOLERANCE = 1e-6;
const SAMPLE_RATE = 48_000;
const FRAMES = 1024;

function buffer(context: BaseAudioContext, channels: number, frequencies: number[], amplitude: number): AudioBuffer {
  const result = context.createBuffer(channels, FRAMES, SAMPLE_RATE);
  for (let channel = 0; channel < channels; channel++) {
    const data = result.getChannelData(channel);
    for (let index = 0; index < FRAMES; index++) data[index] = amplitude * Math.sin((2 * Math.PI * frequencies[channel] * index) / SAMPLE_RATE);
  }
  return result;
}

function buildProject(solo: string | null): Project {
  const project = new Project({ bpm: 120 });
  const submix = project.addTrack("Submix", "bus", { id: "submix", volume: 0.9, pan: -0.3, busRole: "submix" });
  const fx = project.addTrack("FX", "bus", { id: "fx", volume: 1, busRole: "effect" });
  project.addTrack("Left", "audio", { id: "left", volume: 0.8, pan: -1 });
  project.addTrack("Centre", "audio", { id: "centre", volume: 0.6, pan: 0 });
  project.addTrack("Right", "audio", { id: "right", volume: 1, pan: 0.35 });
  project.addTrack("Stereo", "audio", { id: "stereo", volume: 0.7, pan: 0.2 });
  project.addTrack("Muted", "audio", { id: "muted", volume: 1, muted: true });
  project.setTrackRouting("centre", { outputBusId: null, sends: [{ busId: fx.id, gain: 0.5 }] });
  project.setTrackRouting("right", { outputBusId: submix.id, sends: [] });
  project.setTrackRouting("stereo", { outputBusId: submix.id, sends: [{ busId: fx.id, gain: 0.25 }] });
  project.setMasterVolume(0.75);
  if (solo) project.setTrackSolo(solo, true);
  return project;
}

async function render(solo: string | null): Promise<Float32Array[]> {
  const context = new OfflineAudioContext(2, FRAMES, SAMPLE_RATE);
  const model = buildProject(solo);
  const workspace = await Workspace.create(context as unknown as AudioContext, model);
  workspace.output.connect(context.destination);
  const tracks = (workspace as unknown as { tracks: Map<string, { input: AudioNode }> }).tracks;
  const feed = (id: string, channels: number, frequencies: number[], amplitude: number) => {
    const source = new AudioBufferSourceNode(context, { buffer: buffer(context, channels, frequencies, amplitude) });
    source.connect(tracks.get(id)!.input);
    source.start();
  };
  feed("left", 1, [440], 0.5);
  feed("centre", 1, [660], 0.5);
  feed("right", 1, [880], 0.5);
  feed("stereo", 2, [330, 550], 0.4);
  feed("muted", 1, [990], 0.5);
  const rendered = await context.startRendering();
  workspace.dispose();
  model.dispose();
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}

const scenarios = [null, "centre", "right", "submix", "fx"] as const;
const decode = (encoded: string[]) =>
  encoded.map((text) => {
    const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
    return new Float32Array(bytes.buffer);
  });

test("track and bus strips render the recorded reference PCM", async () => {
  const rendered: Record<string, Float32Array[]> = {};
  for (const solo of scenarios) rendered[String(solo)] = await render(solo);
  if (RECORD) {
    const body = Object.fromEntries(Object.entries(rendered).map(([key, channels]) => [key, encodeBrowser(channels)]));
    await server.commands.writeFile("tests/fixtures/mixer-reference.json", JSON.stringify(body));
    return;
  }
  let worst = 0;
  for (const solo of scenarios) {
    const expected = decode((reference as Record<string, string[]>)[String(solo)]);
    let peak = 0;
    for (let channel = 0; channel < 2; channel++) {
      for (let index = 0; index < FRAMES; index++) {
        worst = Math.max(worst, Math.abs(rendered[String(solo)][channel][index] - expected[channel][index]));
        peak = Math.max(peak, Math.abs(expected[channel][index]));
      }
    }
    expect(peak, `scenario ${solo} is audible`).toBeGreaterThan(0.01);
  }
  console.log(`mixer equivalence max abs diff: ${worst}`);
  expect(worst).toBeLessThan(TOLERANCE);
});

function encodeBrowser(channels: Float32Array[]): string[] {
  return channels.map((data) => {
    let text = "";
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
}
