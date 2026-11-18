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
      await workspace.commit();
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
