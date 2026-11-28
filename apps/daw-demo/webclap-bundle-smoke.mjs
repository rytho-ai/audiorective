import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const input = process.env.DAW_WEBCLAP_EFFECT_WASM;
if (!input) throw new Error("Set DAW_WEBCLAP_EFFECT_WASM to module.wasm from the WebCLAP examples Signalsmith Basics bundle.");
const wasm = resolve(input);
await access(wasm);
const port = Number(process.env.DAW_WEBCLAP_PORT ?? 18808);
const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/fixtures/signalsmith.wclap/module.wasm", (route) => route.fulfill({ path: wasm, contentType: "application/wasm" }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__daw?.workspace);
  const uiTrack = await page.evaluate(() => window.__daw.project.tracks.find(({ kind }) => kind === "audio").id);
  await page.locator(`.timeline-row[data-track-id="${uiTrack}"] .clip`).first().click();
  await page.locator("#tab-device").click();
  const openPicker = page.getByText("加入 WebCLAP", { exact: true });
  await openPicker.click();
  await page.getByLabel("Bundle URL", { exact: true }).fill("/fixtures/signalsmith.wclap");
  const idField = page.getByLabel("CLAP ID", { exact: true });
  const submit = page.getByRole("button", { name: "加入裝置", exact: true });
  await idField.fill("missing.descriptor");
  await submit.click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("no plug-in with ID"));
  assert.equal(await page.evaluate((id) => window.__daw.project.tracks.find((track) => track.id === id).devices.length, uiTrack), 0);
  await idField.fill("uk.co.signalsmith.basics.freq-shifter");
  await submit.click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("已加入"));
  const effectCard = page.locator("#device-panel > details.device-card").filter({ has: page.locator('button[aria-label*="Frequency Shifter" i]') });
  await effectCard.locator(":scope > summary").click();
  await effectCard.getByText("參數", { exact: true }).click();
  await effectCard.getByRole("slider", { name: "mix", exact: true }).fill("1");
  await page.waitForFunction((id) => {
    const { project, workspace } = window.__daw;
    const device = project.tracks.find((track) => track.id === id).devices[0];
    const host = workspace.host(device.id);
    const mix = host.parameterInfo.find(({ name }) => name === "mix");
    return host.params[String(mix.id)].value === 1;
  }, uiTrack);
  await effectCard.getByRole("button", { name: /^移除 .*Frequency Shifter/i }).click();
  await page.waitForFunction((id) => {
    const { project, workspace } = window.__daw;
    const synth = project.tracks[0]?.devices[0];
    return (
      project.tracks.find((track) => track.id === id).devices.length === 0 && synth && workspace.host(synth.id) && !workspace.cells.needsSync.value
    );
  }, uiTrack);
  const report = await page.evaluate(async () => {
    const { workspace: studio } = window.__daw;
    const Workspace = studio.constructor;
    const Project = studio.project.constructor;
    const Host = studio.host(studio.project.tracks[0].devices[0].id).constructor;
    const context = new AudioContext({ sampleRate: 48000 });
    const project = new Project();
    const bundleUrl = "/fixtures/signalsmith.wclap";
    const workletUrl = studio.options.workletUrl;
    const pluginId = "uk.co.signalsmith.basics.freq-shifter";
    const input = project.addTrack("Sine", "audio");
    const result = project.addTrack("Frequency return", "bus", { busRole: "effect", solo: true });
    project.setTrackRouting(input.id, { outputBusId: null, sends: [{ busId: result.id, gain: 1 }] });
    const device = project.addDevice(result.id, { kind: "webclap", pluginId, name: "Signalsmith Frequency Shifter", bundleUrl });
    const sampleRate = context.sampleRate;
    const channel = Float32Array.from({ length: sampleRate * 5 }, (_, frame) => 0.15 * Math.sin((frame * 2 * Math.PI * 440) / sampleRate));
    project.addAudioClip(input.id, { sampleRate, channels: [channel, channel] }, 0);
    const analyser = context.createAnalyser();
    analyser.fftSize = 16384;
    const sink = context.createGain();
    sink.gain.value = 0;
    analyser.connect(sink).connect(context.destination);
    const peak = async () => {
      await new Promise((resolve) => setTimeout(resolve, 440));
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const waveform = new Float32Array(analyser.fftSize);
      analyser.getFloatFrequencyData(spectrum);
      analyser.getFloatTimeDomainData(waveform);
      let bin = 0;
      for (let i = 1; i < spectrum.length; i++) if (spectrum[i] > spectrum[bin]) bin = i;
      const rms = Math.sqrt(waveform.reduce((energy, value) => energy + value * value, 0) / waveform.length);
      return { hz: (bin * sampleRate) / analyser.fftSize, rms };
    };
    const failedLoad = async (selection) => {
      try {
        const invalid = await Host.load(context, { url: bundleUrl, workletUrl, ...selection });
        invalid.dispose();
        return "";
      } catch (error) {
        return String(error);
      }
    };
    let workspace, reopened;
    try {
      await context.resume();
      const first = await Host.load(context, { url: bundleUrl, workletUrl, pluginIndex: 0 });
      const firstId = first.descriptor.id;
      first.dispose();
      const missingId = await failedLoad({ pluginId: "missing.descriptor" });
      const missingIndex = await failedLoad({ pluginIndex: 99 });
      workspace = await Workspace.create(context, project, { destination: analyser, workletUrl });
      const host = workspace.host(device.id);
      if (!host) throw new Error(workspace.cells.warnings.value.join(" "));
      const { id: mixId } = host.parameterInfo.find(({ name }) => name === "mix");
      const mix = host.params[String(mixId)];
      await workspace.play();
      mix.value = 0;
      const dry = await peak();
      mix.value = 1;
      const wet = await peak();
      const deviceState = () => [...project.tracks.find(({ id }) => id === result.id).devices[0].state].join();
      mix.value = 0;
      await window.__daw.api.saveWorkspace(workspace);
      const immediateState = deviceState();
      await peak();
      await window.__daw.api.saveWorkspace(workspace);
      const settledState = deviceState();
      mix.value = 1;
      await peak();
      const saved = await window.__daw.api.saveWorkspace(workspace);
      const stateBytes = project.tracks.find(({ id }) => id === result.id).devices[0].state.byteLength;
      workspace.dispose();
      reopened = await window.__daw.api.openWorkspace(context, saved, {
        destination: analyser,
        workletUrl,
        resolveBundle: (device) => (device.pluginId === pluginId ? bundleUrl : undefined),
      });
      await reopened.play();
      const replay = await peak();
      const restoredHost = reopened.host(device.id);
      return {
        parameterSavedImmediately: immediateState === settledState && immediateState !== deviceState(),
        firstId,
        missingId,
        missingIndex,
        deviceId: restoredHost.descriptor.id,
        dry,
        wet,
        replay,
        wetMixRestored: restoredHost.params[String(mixId)].value,
        stateBytes,
        warnings: reopened.cells.warnings.value,
      };
    } finally {
      reopened?.dispose();
      reopened?.project.dispose();
      workspace?.dispose();
      project.dispose();
      await context.close();
    }
  });
  assert.equal(report.firstId, "uk.co.signalsmith.basics.chorus");
  assert.equal(report.deviceId, "uk.co.signalsmith.basics.freq-shifter");
  assert.match(report.missingId, /WebCLAP bundle has no plug-in with ID missing\.descriptor/);
  assert.match(report.missingIndex, /WebCLAP bundle has no plug-in at index 99/);
  assert.ok(report.stateBytes > 0);
  assert.equal(report.parameterSavedImmediately, true);
  assert.equal(report.wetMixRestored, 1);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(errors, []);
  for (const [value, expected] of [
    [report.dry, 440],
    [report.wet, 490],
    [report.replay, 490],
  ]) {
    assert.ok(Math.abs(value.hz - expected) < 5 && value.rms > 0.03, JSON.stringify(report));
  }
  console.log("WebCLAP multi-device loading and state round trip passed", report);
} finally {
  await browser?.close();
  await server.close();
}
