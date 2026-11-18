import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: 18778, strictPort: true },
});
function wav(amplitude) {
  const rate = 48_000;
  const frames = rate;
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 44; i < data.length; i += 2) data.writeInt16LE(Math.round(amplitude * 32767), i);
  return data;
}
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const decode = BaseAudioContext.prototype.decodeAudioData;
    window.decodeCalls = 0;
    BaseAudioContext.prototype.decodeAudioData = function (...args) {
      window.decodeCalls++;
      return Reflect.apply(decode, this, args);
    };
  });
  await page.goto("http://127.0.0.1:18778/");
  await page.waitForFunction(() => window.__daw?.workspace);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#new").click();
  await page.waitForFunction(() => window.__daw.project.tracks.length === 0);
  if ((await page.locator("#toggle-browser").getAttribute("aria-pressed")) !== "true") await page.locator("#toggle-browser").click();
  await page.locator("#add-audio").click();
  await page.waitForFunction(() => window.__daw.project.tracks[0]?.kind === "audio");
  const data = wav(0.3);
  await page.locator("#audio-file").setInputFiles([
    { name: "pulse.wav", mimeType: "audio/wav", buffer: data },
    { name: "copy.wav", mimeType: "audio/wav", buffer: data },
  ]);
  await page.waitForFunction(() => window.__daw.samples.state.value.rows.length === 1 && window.__daw.samples.state.value.rows[0].status === "ready");
  assert.equal(await page.evaluate(() => window.decodeCalls), 1);
  await page.evaluate(() => {
    const { samples, workspace } = window.__daw;
    window.samplePeak = (node) => {
      const analyser = workspace.context.createAnalyser();
      analyser.fftSize = 128;
      node.connect(analyser);
      return () => {
        const pcm = new Float32Array(128);
        analyser.getFloatTimeDomainData(pcm);
        return Math.max(...pcm.map(Math.abs));
      };
    };
    window.previewPeak = window.samplePeak(samples.output);
    window.timelinePeak = window.samplePeak(workspace.output);
  });
  await page.getByRole("button", { name: "試聽 pulse.wav", exact: true }).click();
  await page.waitForFunction(() => window.previewPeak() > 0.2);
  assert.equal(await page.evaluate(() => window.__daw.workspace.player.isPlaying.value), false);
  await page.getByRole("button", { name: "放入音軌 pulse.wav", exact: true }).click();
  await page.waitForFunction(() => window.__daw.project.tracks[0].clips.length === 1);
  if (process.env.DAW_SAMPLE_SCREENSHOT) await page.screenshot({ path: process.env.DAW_SAMPLE_SCREENSHOT });
  await page.locator(".rhythm-panel summary").click();
  const sampleId = await page.evaluate(() => window.__daw.samples.state.value.rows[0].id);
  await page.getByLabel("Kick 素材", { exact: true }).selectOption(sampleId);
  await page.getByRole("button", { name: "移除 pulse.wav", exact: true }).click();
  assert.ok(await page.evaluate(() => window.__daw.samples.state.value.decodedBytes > 0));
  await page.locator(".ar-pad-grid").getByRole("button", { name: "Kick", exact: true }).click();
  await page.waitForFunction(() => window.timelinePeak() > 0.15);
  await page.getByLabel("Kick 素材", { exact: true }).selectOption("");
  await page.waitForFunction(() => window.__daw.samples.state.value.decodedBytes === 0 && window.timelinePeak() < 0.01);
  await page.locator("#play").click();
  await page.waitForFunction(() => window.timelinePeak() > 0.15);
  const lease = await page.evaluate(
    async (encoded) => {
      const { samples: previous, workspace } = window.__daw;
      const library = new previous.constructor(workspace.context, { maxDecodedBytes: 192000 });
      const file = new File([new Uint8Array(encoded)], "lease.wav");
      const [id] = await library.importFiles([file]);
      const handle = library.acquire(id);
      library.remove(id);
      const retained = library.state.value.decodedBytes;
      library.destroy();
      const sample = handle.buffer.getChannelData(0)[400];
      handle.release();
      return { retained, sample, after: library.state.value.decodedBytes };
    },
    [...data],
  );
  assert.equal(lease.retained, 192000);
  assert.ok(Math.abs(lease.sample - 0.3) < 0.001);
  assert.equal(lease.after, 0);
  assert.deepEqual(errors, []);
  console.log("Sample Library passed content deduplication, independent audition, DAW placement, removal and retained leases.");
} finally {
  await browser?.close();
  await server.close();
}
