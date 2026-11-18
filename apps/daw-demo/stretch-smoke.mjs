import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const enginePath = process.env.DAW_STRETCH_WASM;
if (!enginePath) throw new Error("Set DAW_STRETCH_WASM to a compatible Rubber Band 3.3 WASM file.");
const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: Number(process.env.DAW_STRETCH_PORT ?? 18795), strictPort: true },
  plugins: [
    {
      name: "stretch-fixture",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          {
            tag: "script",
            attrs: { type: "module" },
            children:
              'import { Project, Workspace, openDawProject } from "@audiorective/workspace"; import { TimeStretch } from "@audiorective/effects/time-stretch"; window.stretchFixture = { Project, Workspace, TimeStretch, openDawProject };',
          },
        ],
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const { port } = server.httpServer.address();
  browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__daw?.workspace && window.stretchFixture);
  const target = await page.evaluate(() => {
    const track = window.__daw.project.tracks.find(({ kind }) => kind === "audio");
    return { trackId: track.id, id: track.clips[0].id, duration: track.clips[0].duration };
  });
  await page.locator(`.timeline-row[data-track-id="${target.trackId}"] .clip`).first().click();
  if ((await page.locator("#toggle-lower").getAttribute("aria-pressed")) !== "true") await page.locator("#toggle-lower").click();
  const row = page.locator(".clip-stretch");
  await row.locator('input[type="file"]').setInputFiles(enginePath);
  await row.getByRole("button", { name: "更換伸縮引擎" }).waitFor();
  const ratio = row.getByRole("spinbutton", { name: "長度倍率" });
  await ratio.fill("1.5");
  await row.getByRole("button", { name: "套用倍率" }).click();
  const changed = ({ id, duration, scale }) => {
    const clip = window.__daw.project.tracks.flatMap(({ clips }) => clips).find((item) => item.id === id);
    return clip?.duration === duration * scale && (clip.stretch?.ratio ?? 1) === scale;
  };
  await page.waitForFunction(changed, { ...target, scale: 1.5 });
  await page.locator("#undo").click();
  await page.waitForFunction(changed, { ...target, scale: 1 });
  await page.locator("#redo").click();
  await page.waitForFunction(changed, { ...target, scale: 1.5 });
  if (process.env.DAW_STRETCH_SCREENSHOT) await page.screenshot({ path: process.env.DAW_STRETCH_SCREENSHOT });
  await row.getByRole("button", { name: "還原原始長度" }).click();
  await page.waitForFunction(changed, { ...target, scale: 1 });
  await row.getByRole("button", { name: "Warp 標記", exact: true }).click();
  const wave = page.locator("#editor-panel [data-testid=waveform]");
  const box = await wave.boundingBox();
  await wave.dblclick({ position: { x: box.width * 0.35, y: box.height * 0.35 } });
  const marker = page.getByRole("slider", { name: "Warp 標記 1", exact: true });
  await marker.waitFor({ state: "visible" });
  const firstPosition = Number(await marker.getAttribute("aria-valuenow"));
  const grip = await marker.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 9);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + box.width * 0.15, grip.y + 9, { steps: 4 });
  await page.mouse.up();
  const warpState = ({ id, value }) => {
    const clip = window.__daw.project.tracks.flatMap(({ clips }) => clips).find((item) => item.id === id);
    return Math.abs((clip.stretch?.anchors?.[0]?.outputFrame ?? NaN) / clip.sampleRate - value) < 0.015;
  };
  await page.waitForFunction(warpState, { id: target.id, value: firstPosition + target.duration * 0.15 });
  await page.locator("#undo").click();
  await page.waitForFunction(warpState, { id: target.id, value: firstPosition });
  await page.locator("#redo").click();
  await page.waitForFunction(warpState, { id: target.id, value: firstPosition + target.duration * 0.15 });
  const beforeNudge = Number(await marker.getAttribute("aria-valuenow"));
  await marker.press("ArrowRight");
  await page.waitForFunction(
    ({ id, value }) => {
      const clip = window.__daw.project.tracks.flatMap(({ clips }) => clips).find((item) => item.id === id);
      return (
        Math.abs((clip.stretch?.anchors?.[0]?.outputFrame ?? NaN) / clip.sampleRate - value) < 0.001 &&
        document.activeElement?.classList.contains("ar-warp-marker")
      );
    },
    { id: target.id, value: beforeNudge + 0.01 },
  );
  await page.getByRole("button", { name: "片段自動化", exact: true }).click();
  await marker.waitFor({ state: "detached" });
  await row.getByRole("button", { name: "Warp 標記", exact: true }).click();
  await marker.waitFor({ state: "visible" });

  const warped = await page.evaluate(
    async (wasm) => {
      const { Project, Workspace, TimeStretch, openDawProject } = window.stretchFixture;
      const rate = 48000;
      const source = Float32Array.from({ length: 2 * rate }, (_, i) => {
        const time = i / rate;
        return (0.125 + 0.65 * Math.exp(-0.5 * ((time - 1) / 0.012) ** 2)) * Math.sin(2 * Math.PI * 440 * time);
      });
      const project = new Project();
      const track = project.addTrack("Warped transient", "audio", { pan: -1 });
      const clip = project.addAudioClip(track.id, { sampleRate: rate, channels: [source] }, 0);
      const workspace = await Workspace.create(window.__daw.workspace.context, project);
      const engine = new TimeStretch(await WebAssembly.compile(Uint8Array.from(wasm)));
      const point = { sourceFrame: rate, outputFrame: 1.3 * rate };
      const prepared = await workspace.prepareAudioClipStretch(clip.id, 1, engine, { anchors: [point] });
      const committed = prepared.apply();
      const automated = project.addTrack("Same PCM with source gain", "audio", { pan: 1 });
      project.duplicateClip(clip.id, 0, automated.id);
      project.setAudioClipGainAutomation(project.tracks[1].clips[0].id, [
        { time: 0, value: 0.25, shape: "linear" },
        { time: 2, value: 1, shape: "hold" },
      ]);
      const archive = await workspace.save();
      const saved = openDawProject(archive).project;
      const reopened = saved.tracks[0].clips[0];
      const same = (left, right) => left.length === right.length && left.every((value, i) => value === right[i]);

      const context = new OfflineAudioContext(2, rate * 2, rate);
      context.resume = async () => {};
      const restored = await Workspace.open(context, archive, { destination: context.destination });
      await restored.play();
      const buffer = await context.startRendering();
      const samples = buffer.getChannelData(0);
      const withGain = buffer.getChannelData(1);
      let gainError = 0;
      for (let i = rate * 0.1; i < rate * 1.9; i++) {
        const outputTime = i / rate;
        const sourceTime = outputTime < 1.3 ? outputTime / 1.3 : 1 + (outputTime - 1.3) / 0.7;
        gainError = Math.max(gainError, Math.abs(withGain[i] - samples[i] * (0.25 + (0.75 * sourceTime) / 2)));
      }
      let max = 0,
        time = 0;
      for (let i = Math.round(0.85 * rate); i < Math.round(1.6 * rate); i += 24) {
        let energy = 0;
        for (let j = -128; j < 128; j++) energy += samples[i + j] ** 2;
        if (energy > max) {
          max = energy;
          time = i / rate;
        }
      }
      const answer = {
        time,
        gainError,
        duration: reopened.duration,
        anchor: reopened.stretch.anchors[0],
        original: same(reopened.stretch.source.channels[0], source),
        rendered: same(reopened.channels[0], committed.channels[0]),
      };
      restored.destroy();
      restored.project.destroy();
      workspace.destroy();
      saved.destroy();
      project.destroy();
      engine.destroy();
      return answer;
    },
    [...(await readFile(enginePath))],
  );
  assert.ok(Math.abs(warped.time - 1.3) < 0.06, JSON.stringify(warped));
  assert.ok(warped.gainError < 0.001, JSON.stringify(warped));
  assert.deepEqual(
    { ...warped, time: undefined, gainError: undefined },
    { time: undefined, gainError: undefined, duration: 2, anchor: { sourceFrame: 48000, outputFrame: 62400 }, original: true, rendered: true },
  );
  console.log("Warp markers passed drag, undo/redo and reopened PCM timing", warped);

  const proof = await page.evaluate(
    async (wasm) => {
      const { Project, Workspace, TimeStretch, openDawProject } = window.stretchFixture;
      const host = window.__daw.workspace.context;
      const rate = 48000;
      const original = Float32Array.from({ length: rate * 0.4 }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / rate));
      const project = new Project();
      const track = project.addTrack("Original tone", "audio");
      const clip = project.addAudioClip(track.id, { sampleRate: rate, channels: [original] }, 0.5);
      const workspace = await Workspace.create(host, project);
      const stretch = new TimeStretch(await WebAssembly.compile(new Uint8Array(wasm)));
      const prepared = await workspace.prepareAudioClipStretch(clip.id, 2, stretch);
      if (project.tracks[0].clips[0] !== clip) throw new Error("Preparation modified project.");
      const first = prepared.apply();
      await workspace.flush();
      const slice = first.channels[0].subarray(Math.round(rate * 0.2), Math.round(rate * 0.6));
      let crossings = 0;
      for (let index = 1; index < slice.length; index++) {
        if (slice[index - 1] <= 0 && slice[index] > 0) crossings++;
      }
      const pitch = crossings / 0.4;
      const archive = await workspace.save();
      const reopened = openDawProject(archive).project;
      const saved = reopened.tracks[0].clips[0];
      const sameSource = saved.stretch.source.channels[0].every((value, index) => value === original[index]);
      const sameOutput = saved.channels[0].every((value, index) => value === first.channels[0][index]);
      const halve = await workspace.prepareAudioClipStretch(clip.id, 0.5, stretch);
      const second = halve.apply();

      const pending = await workspace.prepareAudioClipStretch(clip.id, 1);
      project.moveClip(clip.id, track.id, 2);
      let stale = false;
      try {
        pending.apply();
      } catch (error) {
        stale = error.message.includes("changed");
      }

      let unblock;
      const delayed = new Promise((resolve) => {
        unblock = resolve;
      });
      let borrowedSignal;
      const older = workspace
        .prepareAudioClipStretch(clip.id, 1.5, {
          process(input, { signal }) {
            borrowedSignal = signal;
            return delayed.then(() => input);
          },
        })
        .then(
          () => false,
          (error) => error.name === "AbortError",
        );
      const newest = await workspace.prepareAudioClipStretch(clip.id, 1);
      unblock();
      const superseded = borrowedSignal.aborted && (await older);
      const restored = newest.apply();
      workspace.destroy();
      project.destroy();
      reopened.destroy();
      stretch.destroy();
      return {
        pitch,
        sameSource,
        sameOutput,
        stale,
        superseded,
        first: first.duration,
        second: second.duration,
        restored: restored.duration,
        time: restored.time,
      };
    },
    [...(await readFile(enginePath))],
  );
  assert.ok(Math.abs(proof.pitch - 440) <= 5, JSON.stringify(proof));
  assert.deepEqual(
    { ...proof, pitch: undefined },
    {
      pitch: undefined,
      sameSource: true,
      sameOutput: true,
      stale: true,
      superseded: true,
      first: 0.8,
      second: 0.2,
      restored: 0.4,
      time: 2,
    },
  );
  assert.deepEqual(errors, []);
  console.log("Clip stretch passed WASM, UI undo/redo, retained source, rendered round trip and stale-result handling", proof);
} finally {
  await browser?.close();
  await server.close();
}
