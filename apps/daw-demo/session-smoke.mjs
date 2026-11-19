import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: 18776, strictPort: true },
  plugins: [
    {
      name: "session-workspace-test",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          {
            tag: "script",
            attrs: { type: "module" },
            children: 'import { Workspace, Project } from "@audiorective/daw"; window.sessionFixture = { Workspace, Project };',
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:18776/");
  await page.waitForFunction(() => window.sessionFixture && window.__daw?.workspace);
  await page.locator("#session-panel summary").click();
  await page.locator("#launch-quantum").selectOption("bar");
  const intro = page.getByRole("button", { name: "場景 Intro" });
  await intro.click();
  await page.waitForFunction(() => window.__daw.workspace.session.value.queued[0]?.beat === 4);
  assert.equal(await intro.getAttribute("data-clip-state"), "queued");
  await page.getByRole("button", { name: "取消排隊" }).click();
  assert.equal(await intro.getAttribute("data-clip-state"), "idle");
  await page.locator("#launch-quantum").selectOption("beat");
  await intro.click();
  await page.waitForFunction(() => window.__daw.workspace.session.value.active.length > 1);
  assert.equal(await intro.getAttribute("aria-pressed"), "true");
  if (process.env.DAW_SESSION_SCREENSHOT) await page.screenshot({ path: process.env.DAW_SESSION_SCREENSHOT });
  const returns = page.getByRole("button", { name: "回到編曲", exact: true });
  await returns.click();
  await page.waitForFunction(() => !window.__daw.workspace.session.value.active.length && !window.__daw.workspace.session.value.queued.length);
  assert.equal(await intro.getAttribute("aria-pressed"), "false");
  await page.locator("#launch-mode").selectOption("one-shot");
  await intro.click();
  await page.waitForFunction(() => {
    const state = window.__daw.workspace.session.value;
    const changes = state.queued.length ? state.queued : state.active;
    return changes.length > 1 && changes.every(({ mode }) => mode === "one-shot");
  });

  const verification = await page.evaluate(async () => {
    const { Workspace, Project } = window.sessionFixture;
    const sampleRate = 48_000;
    const context = new OfflineAudioContext(2, sampleRate * 4, sampleRate);
    // Workspace's realtime resume is a no-op before starting an offline render.
    const offlineResume = context.resume.bind(context);
    context.resume = async () => {};
    const project = new Project({ bpm: 120 });
    project.setTempoChanges([{ beat: 5, bpm: 60 }]);
    const drums = project.addTrack("Drums", "audio", { pan: -1 });
    const bass = project.addTrack("Bass", "audio", { pan: 1 });
    function clip(track, time, duration, amplitude) {
      return project.addAudioClip(track.id, { sampleRate, channels: [new Float32Array(Math.round(sampleRate * duration)).fill(amplitude)] }, time);
    }
    clip(drums, 0, 6, 0.18);
    clip(bass, 0, 6, 0.2);
    const drumsLoop = clip(drums, 8, 0.21, 0.35);
    const bassA = clip(bass, 8, 0.17, 0.3);
    const bassB = clip(bass, 9, 0.13, 0.45);
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    const launch = (track, slot) => ({ trackId: track.id, clipId: slot?.id ?? null });
    const deadlines = [];
    const becameActive = [];
    let cancelled;
    let queuedAfterSeek;
    await workspace.play();
    deadlines.push(workspace.launchClips([launch(drums, drumsLoop), launch(bass, bassA)])[0].when);
    async function step(time, act) {
      await context.suspend(time);
      // Explicitly pump the existing Workspace clock during accelerated offline rendering.
      workspace.refresh();
      act();
      await offlineResume();
    }
    const steps = [
      step(0.72, () => {
        becameActive.push(workspace.session.value.active.map((item) => item.clipId));
        deadlines.push(workspace.launchClips([launch(bass, bassB)])[0].when);
      }),
      step(0.82, () => {
        cancelled = workspace.cancelClipLaunch();
      }),
      step(1.13, () => {
        deadlines.push(workspace.launchClips([launch(bass, bassB)])[0].when);
      }),
      step(1.62, () => {
        becameActive.push(workspace.session.value.active.map((item) => item.clipId));
        deadlines.push(workspace.launchClips([launch(bass, null)])[0].when);
      }),
      step(2.16, () => {
        deadlines.push(workspace.launchClips([launch(bass, bassB)], 6)[0].when);
        workspace.seek(0);
        queuedAfterSeek = workspace.session.value;
      }),
    ];
    const rendered = await context.startRendering();
    await Promise.all(steps);
    const sample = (time) => [0, 1].map((channel) => rendered.getChannelData(channel)[Math.round(time * sampleRate)]);
    const evidence = [0.4999, 0.5001, 1.1, 1.4999, 1.5001, 1.9999, 2.0001, 3.6].map(sample);
    workspace.destroy();
    project.destroy();
    return { evidence, deadlines, cancelled, queuedAfterSeek, becameActive, clips: [drumsLoop.id, bassA.id, bassB.id] };
  });
  const {
    evidence,
    deadlines,
    cancelled,
    queuedAfterSeek,
    becameActive,
    clips: [drums, bassA, bassB],
  } = verification;
  const expectedDeadlines = [0.5, 1, 1.5, 2, 3.5];
  assert.equal(deadlines.length, expectedDeadlines.length);
  deadlines.forEach((when, index) => assert.ok(Math.abs(when - expectedDeadlines[index]) < 1e-8, `deadline ${index}: ${when}`));
  assert.deepEqual(becameActive, [
    [drums, bassA],
    [drums, bassB],
  ]);
  assert.equal(cancelled, true);
  assert.deepEqual(queuedAfterSeek, { active: [], queued: [] });
  const expected = [
    [0.18, 0.2],
    [0.35, 0.3],
    [0.35, 0.3],
    [0.35, 0.3],
    [0.35, 0.45],
    [0.35, 0.45],
    [0.35, 0.2],
    [0.18, 0.2],
  ];
  for (const [index, frame] of evidence.entries()) {
    for (const [channel, sample] of frame.entries()) {
      assert.ok(
        Math.abs(sample - expected[index][channel]) < 0.002,
        `frame ${index} channel ${channel} expected ${expected[index][channel]}, heard ${sample}`,
      );
    }
  }
  const oneShot = await page.evaluate(async () => {
    const { Workspace, Project } = window.sessionFixture;
    const rate = 48000;
    const context = new OfflineAudioContext(2, rate * 2, rate);
    const resume = context.resume.bind(context);
    context.resume = async () => {};
    const project = new Project();
    const left = project.addTrack("One-shot", "audio", { pan: -1 });
    const right = project.addTrack("Persistent loop", "audio", { pan: 1 });
    const clip = (track, time, duration, value) =>
      project.addAudioClip(track.id, { sampleRate: rate, channels: [new Float32Array(Math.round(rate * duration)).fill(value)] }, time);
    clip(left, 0, 3, 0.2);
    clip(right, 0, 3, 0.1);
    const finite = clip(left, 5, 0.625, 0.6);
    const loop = clip(right, 6, 0.33, 0.3);
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    await workspace.play();
    workspace.launchClips([
      { trackId: left.id, clipId: finite.id, mode: "one-shot" },
      { trackId: right.id, clipId: loop.id },
    ]);
    const step = async (time, fn) => {
      await context.suspend(time);
      workspace.refresh();
      const value = fn();
      await resume();
      return value;
    };
    const overlap = step(0.61, () => workspace.launchClips([{ trackId: left.id, clipId: finite.id }])[0].when);
    const cancel = step(0.81, () => workspace.cancelClipLaunch());
    const ended = step(1.3, () => workspace.session.value.active.map(({ trackId }) => trackId));
    const output = await context.startRendering();
    const at = (time, ch) => output.getChannelData(ch)[Math.round(time * rate)];
    const frame = (time) => [at(time, 0), at(time, 1)];
    const active = await ended;
    const result = {
      overlap: await overlap,
      cancel: await cancel,
      onlyLoopLeft: active.length === 1 && active[0] === right.id,
      audio: [0.4999, 0.5001, 0.9999, 1.0001, 1.1249, 1.1251, 1.49].map(frame),
    };
    workspace.destroy();
    project.destroy();
    return result;
  });
  assert.equal(oneShot.overlap, 1);
  assert.ok(oneShot.cancel && oneShot.onlyLoopLeft);
  const expectedOneShot = [
    [0.2, 0.1],
    [0.6, 0.3],
    [0.6, 0.3],
    [0.6, 0.3],
    [0.6, 0.3],
    [0.2, 0.3],
    [0.2, 0.3],
  ];
  oneShot.audio.forEach((pair, index) =>
    pair.forEach((sample, ch) => {
      assert.ok(Math.abs(sample - expectedOneShot[index][ch]) < 0.002, JSON.stringify(oneShot));
    }),
  );
  const perTrack = await page.evaluate(async () => {
    const { Workspace, Project } = window.sessionFixture;
    const rate = 48000;
    const context = new OfflineAudioContext(2, rate * 2, rate);
    const resume = context.resume.bind(context);
    context.resume = async () => {};
    const project = new Project({ bpm: 120 });
    const left = project.addTrack("Left", "audio", { pan: -1 });
    const right = project.addTrack("Right", "audio", { pan: 1 });
    const clip = (track, value) => project.addAudioClip(track.id, { sampleRate: rate, channels: [new Float32Array(rate * 3).fill(value)] }, 10);
    const a = clip(left, 0.4);
    const b = clip(right, 0.3);
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    await workspace.play();
    const step = async (time, fn) => {
      await context.suspend(time);
      workspace.refresh();
      const value = fn();
      await resume();
      return value;
    };
    // Two independent queues coexist; withdrawing one leaves the other.
    workspace.launchClips([{ trackId: left.id, clipId: a.id }], 4);
    workspace.launchClips([{ trackId: right.id, clipId: b.id }], 1);
    const both = workspace.session.value.queued.map(({ trackId }) => trackId);
    const withdrew = workspace.cancelClipLaunch(left.id);
    const remaining = workspace.session.value.queued.map(({ trackId }) => trackId);
    const immediate = step(0.7, () => workspace.launchClips([{ trackId: left.id, clipId: a.id }], 0)[0]);
    const output = await context.startRendering();
    const at = (time, ch) => output.getChannelData(ch)[Math.round(time * rate)];
    const launched = await immediate;
    workspace.destroy();
    project.destroy();
    return {
      both,
      withdrew,
      remaining,
      launched,
      right: [at(0.45, 1), at(0.6, 1)],
      left: [at(0.45, 0), at(0.69, 0), at(0.8, 0)],
      ids: [left.id, right.id],
    };
  });
  assert.deepEqual(perTrack.both, perTrack.ids);
  assert.ok(perTrack.withdrew);
  assert.deepEqual(perTrack.remaining, [perTrack.ids[1]]);
  assert.ok(Math.abs(perTrack.launched.when - 0.7) < 0.01, JSON.stringify(perTrack));
  assert.ok(Math.abs(perTrack.right[0]) < 0.002 && Math.abs(perTrack.right[1] - 0.3) < 0.002, JSON.stringify(perTrack));
  assert.ok(
    perTrack.left.slice(0, 2).every((value) => Math.abs(value) < 0.002) && Math.abs(perTrack.left[2] - 0.4) < 0.002,
    JSON.stringify(perTrack),
  );
  assert.deepEqual(errors, []);
  console.log("Session UI and PCM passed: quantized scenes, independent loops, cancellation, seek and sample-timed one-shot return.");
} finally {
  await browser?.close();
  await server.close();
}
