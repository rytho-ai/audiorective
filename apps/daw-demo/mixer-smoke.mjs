import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: 18777, strictPort: true },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:18777/");
  await page.waitForFunction(() => window.__daw?.workspace);
  await page.locator("#play").click();
  await page.waitForFunction(() => window.__daw.workspace.player.isPlaying.value);
  const clockGeneration = await page.evaluate(() => window.__daw.workspace.timeline.generation);
  await page.locator("#toggle-lower").click();
  await page.locator("#tab-mixer").click();
  await page.getByRole("button", { name: "＋ 效果回送" }).click();
  await page.getByRole("button", { name: "效果回送 1", exact: true }).waitFor();
  const busId = await page.evaluate(() => window.__daw.project.tracks.find((track) => track.kind === "bus").id);
  await page.getByLabel("Drums 新增 send", { exact: true }).selectOption(busId);
  await page.getByLabel("Atmosphere 新增 send", { exact: true }).selectOption(busId);
  await page.getByLabel("Drums 送往 效果回送 1", { exact: true }).fill("0.31");
  await page.getByLabel("Atmosphere 輸出", { exact: true }).selectOption(busId);
  const live = await page.evaluate(() => {
    const { workspace, project } = window.__daw;
    const drums = project.tracks.find((track) => track.name === "Drums");
    const atmosphere = project.tracks.find((track) => track.name === "Atmosphere");
    return {
      generation: workspace.timeline.generation,
      playing: workspace.player.isPlaying.value,
      drumGain: drums.routing.sends[0].gain,
      output: atmosphere.routing.outputBusId,
    };
  });
  assert.deepEqual(live, { generation: clockGeneration, playing: true, drumGain: 0.31, output: busId });
  if (process.env.DAW_MIXER_SCREENSHOT) await page.screenshot({ path: process.env.DAW_MIXER_SCREENSHOT });
  await page.getByRole("button", { name: "編輯裝置", exact: true }).click();
  await page.locator("#device-panel").getByText("效果回送 1").waitFor();
  await page.getByRole("button", { name: "加入 Filter", exact: true }).click();
  await page.getByRole("button", { name: "加入 Delay", exact: true }).click();
  await page.getByRole("button", { name: "加入巨集", exact: true }).click();
  const macroTargets = page.getByRole("combobox", { name: "巨集 1 的目標", exact: true });
  await macroTargets.selectOption({ label: "1. Filter 頻率" });
  await page.getByRole("button", { name: "解除 巨集 1 的 1. Filter 頻率", exact: true }).waitFor();
  await macroTargets.selectOption({ label: "2. Delay 回授" });
  await page.getByRole("button", { name: "解除 巨集 1 的 2. Delay 回授", exact: true }).waitFor();
  assert.equal(await page.getByRole("slider", { name: "Filter 頻率", exact: true }).count(), 0);
  const macroControl = page.getByRole("slider", { name: "巨集 1", exact: true });
  await macroControl.press("Home");
  await page.getByRole("button", { name: "Filter 往後", exact: true }).click();
  const measure = () =>
    page.evaluate((id) => {
      const { workspace, project } = window.__daw;
      const track = project.tracks.find((item) => item.id === id);
      const magnitudes = new Float32Array(1);
      const filter = track.effects.find((effect) => effect.type === "filter");
      workspace.trackFilterResponse(id, filter.id, new Float32Array([1500]), magnitudes, new Float32Array(1));
      return magnitudes[0];
    }, busId);
  const closed = await measure();
  await macroControl.press("End");
  const opened = await measure();
  assert.ok(closed < 0.01 && opened > 0.98, JSON.stringify({ closed, opened }));
  const macroRoundTrip = await page.evaluate(async (id) => {
    const { workspace, project } = window.__daw;
    const track = project.tracks.find((item) => item.id === id);
    const snapshot = { generation: workspace.timeline.generation, playing: workspace.player.isPlaying.value };
    const archive = await workspace.save();
    const reopened = await workspace.constructor.open(workspace.context, archive, workspace.options);
    try {
      const restored = reopened.project.tracks.find((item) => item.id === id);
      const magnitudes = new Float32Array(1);
      reopened.trackFilterResponse(
        id,
        track.effects.find((effect) => effect.type === "filter").id,
        new Float32Array([1500]),
        magnitudes,
        new Float32Array(1),
      );
      return {
        same: JSON.stringify(restored.effectMacros) === JSON.stringify(track.effectMacros),
        value: reopened.trackMacroValue(id, restored.effectMacros[0].id).value,
        magnitude: magnitudes[0],
        ...snapshot,
      };
    } finally {
      reopened.destroy();
      reopened.project.destroy();
    }
  }, busId);
  assert.deepEqual(macroRoundTrip, { same: true, value: 1, magnitude: opened, generation: clockGeneration, playing: true });
  await page.getByRole("button", { name: "移除 Delay", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: /解除 巨集 1 的 .*Delay/ }).count(), 0);
  assert.equal(await macroControl.getAttribute("aria-valuenow"), "1");

  const values = await page.evaluate(async () => {
    const { workspace: current, project: original } = window.__daw;
    const Workspace = current.constructor;
    const Project = original.constructor;
    const rate = 48_000;
    const context = new OfflineAudioContext(2, rate * 2, rate);
    const resume = context.resume.bind(context);
    context.resume = async () => {};
    const project = new Project();
    const drums = project.addTrack("Drums", "audio", { pan: -1 });
    const keys = project.addTrack("Keys", "audio", { pan: 1 });
    const wet = project.addTrack("Wet", "bus", { volume: 0.5, busRole: "effect" });
    project.addAudioClip(drums.id, { sampleRate: rate, channels: [new Float32Array(rate * 2).fill(0.16)] }, 0);
    project.addAudioClip(keys.id, { sampleRate: rate, channels: [new Float32Array(rate * 2).fill(0.24)] }, 0);
    project.setTrackRouting(drums.id, { outputBusId: null, sends: [{ busId: wet.id, gain: 0.5 }] });
    project.setTrackRouting(keys.id, { outputBusId: null, sends: [{ busId: wet.id, gain: 0.25 }] });
    project.setTrackEffects(wet.id, [{ id: "filter", type: "filter", mode: "lowpass", frequency: 1800, q: 0.7, wet: 1, enabled: true }]);
    const originalWorkspace = await Workspace.create(context, project);
    const saved = await originalWorkspace.save();
    originalWorkspace.destroy();
    const render = await Workspace.open(context, saved, { destination: context.destination });
    const active = render.project;
    await render.play();
    const generation = render.timeline.generation;
    const dryNode = render.trackMixerOutput(drums.id);
    const checkpoints = [];
    function step(time, action) {
      return context.suspend(time).then(async () => {
        await action();
        checkpoints.push({
          generation: render.timeline.generation,
          sameNode: render.trackMixerOutput(drums.id) === dryNode,
          playing: render.player.isPlaying.value,
        });
        await resume();
      });
    }
    const steps = [
      step(0.4, () => render.setTrackSolo(wet.id, true)),
      step(0.8, () => render.setTrackRouting(drums.id, { outputBusId: null, sends: [{ busId: wet.id, gain: 0.25 }] })),
      step(1.2, () => {
        active.removeTrack(wet.id);
        return render.flush();
      }),
    ];
    const output = await context.startRendering();
    await Promise.all(steps);
    const samples = [0.3, 0.65, 1.05, 1.5].map((time) => [0, 1].map((channel) => output.getChannelData(channel)[Math.round(time * rate)]));
    render.destroy();
    active.destroy();
    project.destroy();
    return { samples, generation, checkpoints };
  });
  const expected = [
    [0.2, 0.27],
    [0.04, 0.03],
    [0.02, 0.03],
    [0.16, 0.24],
  ];
  values.samples.forEach((pair, index) =>
    pair.forEach((sample, channel) =>
      assert.ok(Math.abs(sample - expected[index][channel]) < 0.003, `checkpoint ${index}, channel ${channel}: ${sample}`),
    ),
  );
  for (const mark of values.checkpoints) assert.deepEqual(mark, { generation: values.generation, sameNode: true, playing: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "Mixer UI, routed PCM, wet-only solo and live removal passed", ...values }));
  console.log("Rack macro UI and archive recall passed", { closed, opened, ...macroRoundTrip });
} finally {
  await browser?.close();
  await server.close();
}
