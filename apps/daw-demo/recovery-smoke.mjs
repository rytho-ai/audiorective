import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const port = 18775;
const url = `http://127.0.0.1:${port}/`;
const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ configFile: false, root, server: { host: "127.0.0.1", port, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const newPage = async () => {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.__daw?.workspace);
    return page;
  };
  const page = await newPage();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#new").click();
  await page.waitForFunction(() => window.__daw.project.tracks.length === 0);
  await page.locator("#add-audio").click();
  await page.evaluate(() => window.__daw.workspace.seek(0.5));
  await page.locator("#record-audio").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("正在錄製麥克風"));
  await page.waitForTimeout(700);
  await page.locator("#record-audio").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("已建立復原點"));
  const take = (page) =>
    page.evaluate(async () => {
      const track = window.__daw.project.tracks[0];
      const clip = track.clips[0];
      const [samples] = await clip.media.readFrames(clip.startFrame, 256);
      return {
        project: window.__daw.project.title,
        track: track.id,
        clip: clip.id,
        position: clip.time,
        frames: clip.frameCount,
        samples: [...samples],
      };
    });
  const before = await take(page);
  assert.equal(before.position, 0.5);
  assert.ok(before.frames > 16384);
  const session = await context.newCDPSession(page);
  const crashed = page.waitForEvent("crash");
  void session.send("Page.crash").catch(() => undefined);
  await crashed;

  const reopened = await newPage();
  await reopened.locator("#recover-take").click();
  assert.equal(await reopened.locator("#recovery-files option").count(), 1);
  reopened.once("dialog", (dialog) => dialog.accept());
  await reopened.locator("#restore-take").click();
  await reopened.waitForFunction(() => document.querySelector("#status").textContent.startsWith("已復原"));
  assert.deepEqual(await take(reopened), before);
  console.log(`Recovered ${before.frames} frames at ${before.position}s on ${before.track} after a renderer crash`);
} finally {
  await browser?.close();
  await server.close();
}
