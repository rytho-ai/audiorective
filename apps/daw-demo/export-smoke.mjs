import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ configFile: false, root, server: { host: "127.0.0.1", port: 18773, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:18773/");
  await page.waitForFunction(() => window.__daw?.workspace);
  await page.locator("#portability").click();
  assert.match(await page.locator("#portability-details").innerText(), /matching CLAP/);
  await page.locator("#portability-dialog button").click();

  const result = await page.evaluate(async () => {
    const Project = window.__daw.project.constructor;
    const Workspace = window.__daw.workspace.constructor;
    const project = new Project({ title: "Export probe" });
    const track = project.addTrack("Sine", "audio");
    const samples = new Float32Array(4800);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((i * Math.PI * 2 * 440) / 48000) * 0.25;
    const clip = project.addAudioClip(track.id, { sampleRate: 48000, channels: [samples] }, 0);
    const context = new AudioContext({ sampleRate: 48000 });
    const workspace = await Workspace.create(context, project);
    workspace.setMasterVolume(0.3);
    project.setAudioClipGainAutomation(clip.id, [
      { time: 0, value: 0.25, shape: "hold" },
      { time: 0.05, value: 1, shape: "hold" },
    ]);
    const report = workspace.portabilityReport();
    const parts = [];
    await workspace.exportAudioFallbackTo(new WritableStream({ write: (chunk) => parts.push(chunk) }), { tailSeconds: 0.1 });
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const entries = [];
    let at = 0;
    while (view.getUint32(at, true) === 0x04034b50) {
      const flags = view.getUint16(at + 6, true);
      const size = view.getUint32(at + 18, true);
      const nameSize = view.getUint16(at + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameSize));
      const dataAt = at + 30 + nameSize;
      let peak = 0;
      let earlyPeak = 0;
      if (name.endsWith(".wav"))
        for (let offset = dataAt + 44; offset < dataAt + size; offset += 4) {
          const sample = Math.abs(view.getFloat32(offset, true));
          peak = Math.max(peak, sample);
          if (offset < dataAt + 44 + 0.04 * 48000 * 8) earlyPeak = Math.max(earlyPeak, sample);
        }
      entries.push({ name, flags, crc: view.getUint32(at + 14, true), peak, earlyPeak, size });
      at = dataAt + size;
    }
    const aborted = new AbortController();
    aborted.abort();
    let cancellation;
    try {
      await workspace.exportAudioFallbackTo(new WritableStream(), { signal: aborted.signal });
    } catch (error) {
      cancellation = error.name;
    }
    const effects = [
      { id: "filter", type: "filter", enabled: true, wet: 1, mode: "lowpass", frequency: 100, q: 0.7 },
      { id: "delay", type: "delay", enabled: true, wet: 1, delayTime: 0.25, feedback: 0 },
    ];
    workspace.setTrackEffects(track.id, effects);
    const restored = await Workspace.open(context, await workspace.save());
    const reopenedMaster = restored.project.masterVolume;
    let effectOutput;
    try {
      const parts = [];
      await restored.exportAudioFallbackTo(new WritableStream({ write: (chunk) => parts.push(chunk) }), { tailSeconds: 0.45 });
      const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
      const view = new DataView(bytes.buffer);
      const pcm = 30 + view.getUint16(26, true) + view.getUint16(28, true) + 44;
      const peakBetween = (start, end) => {
        let peak = 0;
        for (let frame = start * 48000; frame < end * 48000; frame++)
          peak = Math.max(peak, Math.abs(view.getFloat32(pcm + frame * 8, true)), Math.abs(view.getFloat32(pcm + frame * 8 + 4, true)));
        return peak;
      };
      effectOutput = {
        effects: restored.project.tracks[0].effects,
        early: peakBetween(0.01, 0.18),
        echo: peakBetween(0.23, 0.4),
      };
    } finally {
      restored.destroy();
      restored.project.destroy();
    }
    workspace.destroy();
    project.destroy();
    await context.close();
    return { entries, report, cancellation, effectOutput, reopenedMaster };
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["mix.wav", "tracks/track1.wav", "manifest.json"],
  );
  assert.ok(result.entries.every((entry) => entry.flags === 0 && entry.crc !== 0));
  assert.equal(result.reopenedMaster, 0.3);
  assert.ok(result.entries[1].peak > 0.15, `stem is silent: ${JSON.stringify(result.entries)}`);
  assert.ok(Math.abs(result.entries[0].peak / result.entries[1].peak - 0.3) < 0.002);
  assert.ok(Math.abs(result.entries[1].earlyPeak / result.entries[1].peak - 0.25) < 0.01, JSON.stringify(result.entries[1]));
  assert.equal(result.cancellation, "AbortError");
  assert.equal(result.report.pluginDependencies.length, 0);
  assert.ok(result.report.limitations.some((line) => line.startsWith("Audio clip gain automation")));
  assert.deepEqual(result.effectOutput.effects.map(({ type }) => type), ["filter", "delay"]);
  assert.equal(result.effectOutput.effects[0].frequency, 100);
  assert.equal(result.effectOutput.effects[1].delayTime, 0.25);
  assert.ok(result.effectOutput.early < 0.001 && result.effectOutput.echo > 0.002 && result.effectOutput.echo < 0.025, JSON.stringify(result.effectOutput));
  const pluginResult = await page.evaluate(async () => {
    const original = window.__daw.workspace;
    const project = new original.project.constructor({ title: "Plugin export probe" });
    const track = project.addTrack("Synth", "midi");
    const device = original.project.tracks[0].devices[0];
    project.addWebClapDevice(track.id, {
      pluginId: device.pluginId,
      name: device.name,
      vendor: device.vendor,
      version: device.version,
      bundleUrl: device.bundleUrl,
      state: device.state,
    });
    project.addMidiClip(
      track.id,
      {
        duration: 0.5,
        notes: [{ id: "note1", start: 0, end: 0.4, pitch: 60, velocity: 100, channel: 0, track: 0 }],
      },
      0,
    );
    const context = new AudioContext({ sampleRate: 48000 });
    const workspace = await original.constructor.create(context, project, { workletUrl: original.options.workletUrl });
    const parts = [];
    await workspace.exportAudioFallbackTo(new WritableStream({ write: (chunk) => parts.push(chunk) }), { tailSeconds: 0.2 });
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const nameSize = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    const dataAt = 30 + nameSize;
    let peak = 0;
    for (let at = dataAt + 44; at < dataAt + size; at += 4) peak = Math.max(peak, Math.abs(view.getFloat32(at, true)));
    workspace.destroy();
    project.destroy();
    await context.close();
    return { peak };
  });
  assert.ok(pluginResult.peak > 0.01, `WebCLAP fallback is silent: ${JSON.stringify(pluginResult)}`);
  const largeResult = await page.evaluate(async () => {
    const original = window.__daw.workspace;
    const project = new original.project.constructor({ title: "Wide export probe" });
    for (let i = 0; i < 16; i++) project.addTrack(`Track ${i}`, "audio");
    project.addAudioClip(project.tracks[0].id, { sampleRate: 48000, channels: [new Float32Array(4800).fill(0.1)] }, 0);
    const context = new AudioContext({ sampleRate: 48000 });
    const workspace = await original.constructor.create(context, project);
    const parts = [];
    await workspace.exportAudioFallbackTo(new WritableStream({ write: (chunk) => parts.push(chunk) }), { tailSeconds: 0 });
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const names = [];
    let manifest;
    for (let at = 0; view.getUint32(at, true) === 0x04034b50; ) {
      const size = view.getUint32(at + 18, true);
      const length = view.getUint16(at + 26, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + length));
      const dataAt = at + 30 + length;
      names.push(name);
      if (name === "manifest.json") manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(dataAt, dataAt + size)));
      at = dataAt + size;
    }
    workspace.destroy();
    project.destroy();
    await context.close();
    return { names, omitted: manifest.stemsOmitted };
  });
  assert.deepEqual(largeResult.names, ["mix.wav", "manifest.json"]);
  assert.equal(largeResult.omitted, true);
  assert.deepEqual(errors, []);
  console.log("Audio fallback mix/stem ZIP, WebCLAP rendering, portability report and cancellation passed");
  console.log("Reopened Filter → Delay", JSON.stringify(result.effectOutput));
} finally {
  await browser?.close();
  await server.close();
}
