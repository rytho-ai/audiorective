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
            children:
              'import { Workspace, Project, sessionFor } from "@audiorective/daw"; window.sessionFixture = { Workspace, Project, sessionFor };',
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
  // A launch exactly on a boundary starts at once, so let the transport leave beat 0 before queueing a scene.
  await page.locator("#play").click();
  await page.waitForFunction(() => window.__daw.workspace.clock.state.value === "playing" && window.__daw.workspace.position > 0.1);
  const intro = page.getByRole("button", { name: "場景 Intro" });
  await intro.click();
  await page.waitForFunction(() => window.__daw.workspace.session.value.queued.value[0]?.beat === 4);
  assert.equal(await intro.getAttribute("data-clip-state"), "queued");
  await page.getByRole("button", { name: "取消排隊" }).click();
  assert.equal(await intro.getAttribute("data-clip-state"), "idle");
  await page.locator("#launch-quantum").selectOption("beat");
  await intro.click();
  await page.waitForFunction(() => window.__daw.workspace.session.value.playing.value.length > 1);
  assert.equal(await intro.getAttribute("aria-pressed"), "true");
  if (process.env.DAW_SESSION_SCREENSHOT) await page.screenshot({ path: process.env.DAW_SESSION_SCREENSHOT });
  const returns = page.getByRole("button", { name: "回到編曲", exact: true });
  await returns.click();
  await page.waitForFunction(
    () => !window.__daw.workspace.session.value.playing.value.length && !window.__daw.workspace.session.value.queued.value.length,
  );
  assert.equal(await intro.getAttribute("aria-pressed"), "false");
  await page.locator("#launch-mode").selectOption("one-shot");
  await intro.click();
  await page.waitForFunction(() => {
    const session = window.__daw.workspace.session.value;
    const clips = session.queued.value.length ? session.queued.value.map(({ clip }) => clip) : session.playing.value;
    return clips.length > 1 && clips.every((clip) => clip.options.value.loop === false);
  });

  const verification = await page.evaluate(async () => {
    const { Workspace, Project, sessionFor } = window.sessionFixture;
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
    // The arrangement plays the long clips; the Session holds the loops: scene 0 has both tracks, scene 1 only the bass.
    clip(drums, 0, 6, 0.18);
    clip(bass, 0, 6, 0.2);
    const grid = sessionFor(project);
    const [first, second] = [grid.addScene(), grid.addScene()];
    function slot(track, scene, duration, amplitude) {
      return grid.setAudioClip(
        { trackId: track.id, sceneId: scene.id },
        { sampleRate, channels: [new Float32Array(Math.round(sampleRate * duration)).fill(amplitude)] },
      );
    }
    const drumsLoop = slot(drums, first, 0.21, 0.35);
    const bassA = slot(bass, first, 0.17, 0.3);
    const bassB = slot(bass, second, 0.13, 0.45);
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    const session = () => workspace.session.value;
    const clipOf = (track, slot) => workspace.sessionClip(track.id, slot.id);
    session().quantize.value = "4n"; // one beat
    const whenOf = (track) => session().queued.value.find((change) => change.track.name === track.id)?.when;
    const deadlines = [];
    const becameActive = [];
    let cancelled;
    let queuedAfterSeek;
    await workspace.play();
    async function step(time, act) {
      await context.suspend(time);
      // Explicitly pump the existing Workspace clock during accelerated offline rendering.
      // Clock.refresh() cancels at once but refills in a microtask, so wait for that tick before act().
      workspace.refresh();
      await Promise.resolve();
      act();
      await offlineResume();
    }
    const steps = [
      // A launch exactly on a boundary starts at once, so the first scene is launched just after beat 0.
      step(0.05, () => {
        session().launchScene([clipOf(drums, drumsLoop), clipOf(bass, bassA)]);
        deadlines.push(whenOf(drums));
      }),
      step(0.72, () => {
        becameActive.push(session().playing.value.map((clip) => clip.name));
        clipOf(bass, bassB).launch();
        deadlines.push(whenOf(bass));
      }),
      step(0.82, () => {
        cancelled = session().cancelQueued();
      }),
      step(1.13, () => {
        clipOf(bass, bassB).launch();
        deadlines.push(whenOf(bass));
      }),
      step(1.62, () => {
        becameActive.push(session().playing.value.map((clip) => clip.name));
        session().tracks[bass.id].stop();
        deadlines.push(whenOf(bass));
      }),
      // The Workspace clock ticks on wall-clock time, which an accelerated offline render outruns: tick it between the actions, inside the look-ahead.
      ...Array.from({ length: 39 }, (_, index) => step(0.113 + index * 0.1, () => {})),
      step(2.16, () => {
        clipOf(bass, bassB).launch({ quantize: "2n" }); // two beats: beat 6, which the tempo change at beat 5 puts at 3.5 s
        deadlines.push(whenOf(bass));
        workspace.seek(0);
        queuedAfterSeek = { playing: session().playing.value.length, queued: session().queued.value.length };
      }),
    ];
    const rendered = await context.startRendering();
    await Promise.all(steps);
    const sample = (time) => [0, 1].map((channel) => rendered.getChannelData(channel)[Math.round(time * sampleRate)]);
    const evidence = [0.4999, 0.5001, 1.1, 1.4999, 1.5001, 1.9999, 2.0001, 3.6].map(sample);
    workspace.dispose();
    project.dispose();
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
  assert.deepEqual(queuedAfterSeek, { playing: 0, queued: 0 });
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
    const { Workspace, Project, sessionFor } = window.sessionFixture;
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
    const grid = sessionFor(project);
    const scene = grid.addScene();
    const slot = (track, duration, value) =>
      grid.setAudioClip(
        { trackId: track.id, sceneId: scene.id },
        { sampleRate: rate, channels: [new Float32Array(Math.round(rate * duration)).fill(value)] },
      );
    const finite = slot(left, 0.625, 0.6);
    const loop = slot(right, 0.33, 0.3);
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    await workspace.play();
    const session = () => workspace.session.value;
    session().quantize.value = "4n";
    const finiteClip = workspace.sessionClip(left.id, finite.id);
    finiteClip.configure({ loop: false });
    const step = async (time, fn) => {
      await context.suspend(time);
      workspace.refresh();
      await Promise.resolve(); // the refill tick runs in a microtask
      const value = fn();
      await resume();
      return value;
    };
    const first = step(0.05, () => session().launchScene([finiteClip, workspace.sessionClip(right.id, loop.id)]));
    const pumps = Array.from({ length: 19 }, (_, index) => step(0.113 + index * 0.1, () => {}));
    const overlap = step(0.61, () => {
      finiteClip.launch();
      return session().queued.value.find((change) => change.track.name === left.id)?.when;
    });
    const cancel = step(0.81, () => session().cancelQueued());
    const ended = step(1.3, () => session().playing.value.map((clip) => clip.track.name));
    const output = await context.startRendering();
    await Promise.all([first, ...pumps]);
    const at = (time, ch) => output.getChannelData(ch)[Math.round(time * rate)];
    const frame = (time) => [at(time, 0), at(time, 1)];
    const active = await ended;
    const result = {
      overlap: await overlap,
      cancel: await cancel,
      onlyLoopLeft: active.length === 1 && active[0] === right.id,
      audio: [0.4999, 0.5001, 0.9999, 1.0001, 1.1249, 1.1251, 1.49].map(frame),
    };
    workspace.dispose();
    project.dispose();
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
    const { Workspace, Project, sessionFor } = window.sessionFixture;
    const rate = 48000;
    const context = new OfflineAudioContext(2, rate * 2, rate);
    const resume = context.resume.bind(context);
    context.resume = async () => {};
    const project = new Project({ bpm: 120 });
    const left = project.addTrack("Left", "audio", { pan: -1 });
    const right = project.addTrack("Right", "audio", { pan: 1 });
    const grid = sessionFor(project);
    const scene = grid.addScene();
    const clip = (track, value) =>
      grid.setAudioClip({ trackId: track.id, sceneId: scene.id }, { sampleRate: rate, channels: [new Float32Array(rate * 3).fill(value)] });
    const a = clip(left, 0.4);
    const b = clip(right, 0.3);
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    await workspace.play();
    const step = async (time, fn) => {
      await context.suspend(time);
      workspace.refresh();
      await Promise.resolve(); // the refill tick runs in a microtask
      const value = fn();
      await resume();
      return value;
    };
    const session = workspace.session.value;
    const clipA = workspace.sessionClip(left.id, a.id);
    const clipB = workspace.sessionClip(right.id, b.id);
    // Two independent queues coexist; withdrawing one leaves the other.
    const queue = step(0.05, () => {
      clipA.launch({ quantize: "1m" });
      clipB.launch({ quantize: "4n" });
      const both = session.queued.value.map(({ track }) => track.name);
      const withdrew = session.tracks[left.id].cancelQueued();
      const remaining = session.queued.value.map(({ track }) => track.name);
      return { both, withdrew, remaining };
    });
    const immediate = step(0.7, () => {
      clipA.launch({ quantize: "none" });
      return { when: session.queued.value.find(({ track }) => track.name === left.id)?.when };
    });
    const pumps = Array.from({ length: 19 }, (_, index) => step(0.113 + index * 0.1, () => {}));
    const output = await context.startRendering();
    await Promise.all(pumps);
    const at = (time, ch) => output.getChannelData(ch)[Math.round(time * rate)];
    const launched = await immediate;
    const { both, withdrew, remaining } = await queue;
    workspace.dispose();
    project.dispose();
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
  assert.deepEqual(perTrack.both, [perTrack.ids[1], perTrack.ids[0]]); // soonest first
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
