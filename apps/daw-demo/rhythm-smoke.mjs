import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: 18779, strictPort: true },
  plugins: [
    {
      name: "rhythm-fixture",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          {
            tag: "script",
            attrs: { type: "module" },
            children:
              'import { PadBank } from "@audiorective/pads"; import { StepSequencer } from "@audiorective/sequencer"; window.rhythmFixture = { PadBank, StepSequencer };',
          },
        ],
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1380, height: 860 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:18779/");
  await page.waitForFunction(() => window.__daw?.workspace && window.rhythmFixture);
  await page.locator(".rhythm-panel summary").click();
  const secondKick = page.locator('.ar-sg-cell[data-lane="kick"][data-step="1"]');
  assert.equal(await secondKick.getAttribute("aria-pressed"), "false");
  await secondKick.click();
  assert.equal(await secondKick.getAttribute("aria-pressed"), "true");
  await secondKick.focus();
  for (let press = 0; press < 9; press++) await page.keyboard.press("ArrowDown");
  assert.equal(await secondKick.getAttribute("aria-label"), "Kick 第 2 格, 力度 55%");
  const kickHeader = page.locator('.ar-sg-lane[data-lane="kick"]');
  await kickHeader.getByRole("button", { name: "Kick 靜音", exact: true }).click();
  assert.equal(await kickHeader.getByRole("button", { name: "Kick 靜音", exact: true }).getAttribute("aria-pressed"), "true");
  await kickHeader.getByRole("button", { name: "Kick 靜音", exact: true }).click();
  await page.getByRole("button", { name: "啟用鼓機", exact: true }).click();
  await page.waitForFunction(() => window.__daw.workspace.player.isPlaying.value && document.querySelector(".ar-sg-cell[data-current=true]"));
  if (process.env.DAW_RHYTHM_SCREENSHOT) await page.screenshot({ path: process.env.DAW_RHYTHM_SCREENSHOT });
  await page.getByRole("button", { name: "停止鼓機", exact: true }).click();
  assert.equal(await page.locator(".ar-sg-cell[data-current=true]").count(), 0);

  const levels = await page.evaluate(async () => {
    const { PadBank, StepSequencer } = window.rhythmFixture;
    const Workspace = window.__daw.workspace.constructor;
    const Project = window.__daw.project.constructor;
    async function run(cancelled) {
      const rate = 48000;
      const context = new OfflineAudioContext(1, rate * 0.55, rate);
      const resume = context.resume.bind(context);
      context.resume = async () => {};
      const project = new Project();
      const workspace = await Workspace.create(context, project, { destination: context.destination });
      function sample(amplitude, seconds) {
        const buffer = context.createBuffer(1, rate * seconds, rate);
        buffer.getChannelData(0).fill(amplitude);
        return buffer;
      }
      const kit = new PadBank(context, [
        { id: "open", buffer: sample(0.3, 0.1), gate: true, group: "hat" },
        { id: "closed", buffer: sample(0.1, 0.05), group: "hat" },
        { id: "manual", buffer: sample(0.05, 0.1), gate: true },
      ]);
      kit.output.connect(workspace.output);
      kit.trigger("open", 1, 0);
      kit.trigger("manual", 1, 0.1);
      let scheduled = 0;
      const sequencer = new StepSequencer(
        { closed: { pattern: ".X..", rate: "1/8" } },
        {
          onHit: ({ lane, velocity, when }) => {
            scheduled++;
            const hit = kit.trigger(lane, velocity, when);
            return hit ? () => hit.cancel() : undefined;
          },
        },
      );
      const detach = workspace.transport.attach(sequencer);
      await workspace.play();
      const planned = context.suspend(0.14).then(async () => {
        workspace.refresh();
        await Promise.resolve(); // the refill tick runs in a microtask
        return resume();
      });
      const changed = context.suspend(0.18).then(() => {
        if (scheduled < 1) throw new Error("Step was not queued before the edit");
        if (cancelled) sequencer.lanes.closed.steps[1].velocity = 0;
        return resume();
      });
      const [rendered] = await Promise.all([context.startRendering(), planned, changed]);
      detach();
      if (sequencer.lanes.closed.playhead !== null) throw new Error("Detached sequencer retained its playhead");
      const frames = rendered.getChannelData(0);
      const result = [frames[9600], frames[16800]];
      workspace.dispose();
      kit.dispose();
      project.dispose();
      sequencer.dispose();
      return result;
    }
    return { cancelled: await run(true), kept: await run(false) };
  });
  assert.ok(Math.abs(levels.cancelled[0] - 0.35) < 0.001);
  assert.ok(Math.abs(levels.cancelled[1] - 0.35) < 0.001);
  assert.ok(Math.abs(levels.kept[1] - 0.05) < 0.001);
  assert.deepEqual(errors, []);
  console.log("Rhythm UI and Workspace audio passed", levels);
} finally {
  await browser?.close();
  await server.close();
}
