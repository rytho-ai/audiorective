import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: dirname(fileURLToPath(import.meta.url)),
  server: { host: "127.0.0.1", port: 18780, strictPort: true },
  plugins: [
    {
      name: "fade-fixture",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          {
            tag: "script",
            attrs: { type: "module" },
            children: 'import { AudioMedia, Project, Workspace } from "@audiorective/daw"; window.fadeFixture = { AudioMedia, Project, Workspace };',
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
  await page.goto("http://127.0.0.1:18780/");
  await page.waitForFunction(() => window.__daw?.workspace && window.fadeFixture);
  const trackId = await page.evaluate(() => window.__daw.project.tracks.find(({ kind }) => kind === "audio").id);
  await page.locator(`.timeline-row[data-track-id="${trackId}"] .clip`).first().click();
  if ((await page.locator("#toggle-lower").getAttribute("aria-pressed")) !== "true") await page.locator("#toggle-lower").click();
  const fade = page.getByRole("spinbutton", { name: "淡入 (s)", exact: true });
  await fade.fill("0.25");
  await fade.press("Tab");
  assert.equal(await fade.inputValue(), "0.25");
  await page.locator("#undo").click();
  assert.equal(await fade.inputValue(), "0");
  await page.locator("#redo").click();
  assert.equal(await fade.inputValue(), "0.25");
  const auditionButton = page.getByRole("button", { name: "試聽片段", exact: true });
  await auditionButton.click();
  await page.getByRole("button", { name: "停止片段試聽", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__daw.workspace.clock.state.value), "stopped");
  await page.getByRole("button", { name: "停止片段試聽", exact: true }).click();
  await auditionButton.waitFor();

  const automationButton = page.getByRole("button", { name: "片段自動化", exact: true });
  await automationButton.click();
  const waveform = page.locator("#editor-panel [data-testid=waveform]");
  const bounds = await waveform.boundingBox();
  await waveform.dblclick({ position: { x: bounds.width / 3, y: bounds.height / 3 } });
  const gainPoint = page.getByRole("slider", { name: "片段增益點 2", exact: true });
  await gainPoint.waitFor();
  const envelope = () =>
    page.evaluate(() => {
      const track = window.__daw.project.tracks.find(({ kind }) => kind === "audio");
      return track.clips[0].gainAutomation?.points;
    });
  const beforeDrag = await envelope();
  const pointBox = await gainPoint.boundingBox();
  const pointX = pointBox.x + pointBox.width / 2;
  const pointY = pointBox.y + pointBox.height / 2;
  await page.mouse.move(pointX, pointY);
  await page.mouse.down();
  await page.mouse.move(pointX + 20, pointY + 15, { steps: 4 });
  assert.deepEqual(await envelope(), beforeDrag, "a drag should commit only after release");
  await page.mouse.up();
  assert.notDeepEqual(await envelope(), beforeDrag, "drag took effect");
  await gainPoint.press("Enter");
  assert.equal(await gainPoint.getAttribute("title"), "hold");
  await page.getByRole("button", { name: "放大時間", exact: true }).click();
  const beforeUndo = await waveform.boundingBox();
  await page.locator("#undo").click();
  assert.equal(await gainPoint.getAttribute("title"), "linear");
  assert.equal(Math.round((await waveform.boundingBox()).width), Math.round(beforeUndo.width));
  await page.locator("#redo").click();
  assert.equal(await gainPoint.getAttribute("title"), "hold");
  await automationButton.click();
  await gainPoint.waitFor({ state: "detached" });

  const automated = await page.evaluate(async () => {
    const { AudioMedia, Project, Workspace } = window.fadeFixture;
    const rate = 48000;
    const points = [
      { time: 0, value: 0.25, shape: "hold" },
      { time: 0.5, value: 0.75, shape: "linear" },
      { time: 1, value: 0.5, shape: "hold" },
    ];
    const atTimes = (data, times) => times.map((time) => data[Math.round(time * rate)]);
    async function liveEdit() {
      const context = new OfflineAudioContext(2, Math.round(rate * 1.1), rate);
      context.resume = async () => {};
      const project = new Project();
      const track = project.addTrack("Live gain", "audio", { pan: -1 });
      const clip = project.addAudioClip(track.id, { sampleRate: rate, channels: [new Float32Array(rate * 1.2).fill(1)] }, 0);
      const workspace = await Workspace.create(context, project, { destination: context.destination });
      const create = context.createBufferSource.bind(context);
      let starts = 0;
      context.createBufferSource = () => {
        starts++;
        return create();
      };
      await workspace.play();
      const change = context.suspend(0.2);
      const replace = context.suspend(0.66);
      const clear = context.suspend(0.85);
      const rendering = context.startRendering();
      await change;
      project.setAudioClipGainAutomation(clip.id, points);
      await workspace.flush();
      await OfflineAudioContext.prototype.resume.call(context);
      await replace;
      project.setAudioClipGainAutomation(clip.id, [
        { time: 0, value: 0.4, shape: "hold" },
        { time: 0.8, value: 0.6, shape: "hold" },
      ]);
      await workspace.flush();
      await OfflineAudioContext.prototype.resume.call(context);
      await clear;
      project.setAudioClipGainAutomation(clip.id, []);
      await workspace.flush();
      await OfflineAudioContext.prototype.resume.call(context);
      const data = (await rendering).getChannelData(0);
      workspace.dispose();
      project.dispose();
      return { starts, values: atTimes(data, [0.1, 0.3, 0.55, 0.75, 0.82, 0.95]) };
    }
    async function renderStored(kind) {
      const context = new OfflineAudioContext(2, rate, rate);
      context.resume = async () => {};
      const project = new Project();
      const track = project.addTrack("Original source automation", "audio", { pan: -1 });
      const frames = new Float32Array(rate * 3).fill(1);
      const source = new AudioMedia(new Blob([frames]), rate, 1, frames.length);
      const fade = { gain: 0.5, fadeIn: 0, fadeOut: 0 };
      const gainAutomation = { sourceStart: kind === "file" ? 0 : 0.5, points };
      const clip =
        kind === "file"
          ? project.addAudioMediaClip(track.id, source, 0, { envelope: fade, gainAutomation })
          : project.addAudioClip(track.id, { sampleRate: rate, channels: [new Float32Array(rate).fill(1)] }, 2, {
              stretch: { ratio: 2, source: { sampleRate: rate, channels: [new Float32Array(rate / 2).fill(1)] } },
              envelope: fade,
              gainAutomation,
            });
      const workspace = await Workspace.create(context, project, { destination: context.destination });
      const create = context.createBufferSource.bind(context);
      let starts = 0;
      context.createBufferSource = () => {
        starts++;
        return create();
      };
      if (kind === "file") workspace.seek(1.75);
      await workspace.play();
      // The render outruns a media read: let the first window schedule and its chunk load before starting.
      await new Promise((resolve) => setTimeout(resolve));
      await workspace.renderSettled();
      // A launch exactly on a boundary starts at once, and the Workspace clock ticks on wall-clock time, which an accelerated offline render outruns:
      // launch just after beat 0 (the first beat starts the clip) and tick the clock between the suspends.
      const sessionPumps = [];
      if (kind === "session") {
        const sessionClip = workspace.sessionClip(track.id, clip.id);
        const seconds = context.length / context.sampleRate;
        for (let index = 0; index < 12; index++) {
          const time = index === 0 ? 0.05 : 0.063 + index * 0.1;
          if (time > seconds - 0.05) break;
          sessionPumps.push(
            (async () => {
              await context.suspend(time);
              workspace.refresh();
              await Promise.resolve();
              if (index === 0) sessionClip.launch({ quantize: "4n" });
              await OfflineAudioContext.prototype.resume.call(context);
            })(),
          );
        }
      }
      const boundary = kind === "file" ? context.suspend(0.18) : undefined;
      const rendering = context.startRendering();
      if (boundary) {
        await boundary;
        workspace.refresh();
        const deadline = performance.now() + 1000;
        while (starts < 2 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        if (starts < 2) throw new Error("File-backed gain fixture did not schedule the second chunk.");
        await OfflineAudioContext.prototype.resume.call(context);
      }
      const data = (await rendering).getChannelData(0);
      await Promise.all(sessionPumps);
      workspace.dispose();
      project.dispose();
      return atTimes(data, kind === "file" ? [0.1, 0.35] : [0.25, 0.55, 0.75]);
    }
    return { live: await liveEdit(), file: await renderStored("file"), session: await renderStored("session") };
  });
  assert.equal(automated.live.starts, 1, "gain edits should preserve the original voice");
  for (const [mode, actual, expected] of [
    ["live", automated.live.values, [1, 0.25, 0.725, 0.4, 0.6, 1]],
    ["file", automated.file, [0.25, 0.25]],
    ["session", automated.session, [0, 0.36875, 0.34375]],
  ])
    actual.forEach((sample, index) =>
      assert.ok(Math.abs(sample - expected[index]) < 0.004, `clip automation ${mode} sample ${index}: ${sample} vs ${expected[index]}`),
    );

  const audible = await page.evaluate(async () => {
    const { AudioMedia, Project, Workspace } = window.fadeFixture;
    const rate = 48000;
    async function render(kind) {
      const context = new OfflineAudioContext(2, rate, rate);
      context.resume = async () => {};
      const project = new Project();
      const track = project.addTrack("Faded", "audio", { pan: -1 });
      const blob = kind === "media";
      const length = blob ? rate * 3 : rate * 0.8;
      const samples = new Float32Array(length).fill(1);
      const envelope = { gain: 0.8, fadeIn: 0.4, fadeOut: blob ? 1.2 : 0.2 };
      const source = blob ? new AudioMedia(new Blob([samples]), rate, 1, length) : { sampleRate: rate, channels: [samples] };
      const clip = blob
        ? project.addAudioMediaClip(track.id, source, 0, { envelope })
        : project.addAudioClip(track.id, source, kind === "session" ? 3 : 0, { envelope });
      const runtime = await Workspace.create(context, project, { destination: context.destination });
      if (kind !== "session") runtime.seek(blob ? 2.2 : 0.2);
      await runtime.play();
      // The render outruns a media read: let the first window schedule and its chunk load before starting.
      await new Promise((resolve) => setTimeout(resolve));
      await runtime.renderSettled();
      // A launch exactly on a boundary starts at once, and the Workspace clock ticks on wall-clock time, which an accelerated offline render outruns:
      // launch just after beat 0 (the first beat starts the clip) and tick the clock between the suspends.
      const sessionPumps = [];
      if (kind === "session") {
        const sessionClip = runtime.sessionClip(track.id, clip.id);
        const seconds = context.length / context.sampleRate;
        for (let index = 0; index < 12; index++) {
          const time = index === 0 ? 0.05 : 0.063 + index * 0.1;
          if (time > seconds - 0.05) break;
          sessionPumps.push(
            (async () => {
              await context.suspend(time);
              runtime.refresh();
              await Promise.resolve();
              if (index === 0) sessionClip.launch({ quantize: "4n" });
              await OfflineAudioContext.prototype.resume.call(context);
            })(),
          );
        }
      }
      const data = (await context.startRendering()).getChannelData(0);
      await Promise.all(sessionPumps);
      runtime.dispose();
      project.dispose();
      if (blob) await source.dispose();
      const times = kind === "session" ? [0.49, 0.55, 0.7] : [0.005, 0.1, 0.3, 0.5, 0.85];
      return times.map((time) => data[Math.round(time * rate)]);
    }
    return { pcm: await render("pcm"), media: await render("media"), session: await render("session") };
  });
  const expected = { pcm: [0.41, 0.6, 0.8, 0.4, 0], media: [0.53, 0.4667, 0.3333, 0.2, 0], session: [0, 0.1, 0.4] };
  for (const [source, values] of Object.entries(audible)) {
    values.forEach((value, index) => assert.ok(Math.abs(value - expected[source][index]) < 0.003, `${source} sample ${index}: ${value}`));
  }
  const auditioned = await page.evaluate(async () => {
    const { AudioMedia, Project, Workspace } = window.fadeFixture;
    const context = new AudioContext({ sampleRate: 48000 });
    const rate = context.sampleRate;
    const project = new Project();
    const track = project.addTrack("Muted audition track", "audio", { muted: true });
    const pcm = new Float32Array(rate).fill(0.5);
    const memoryClip = project.addAudioClip(track.id, { sampleRate: rate, channels: [pcm] }, 4);
    const frames = new Float32Array(rate * 3);
    frames.fill(0.3, rate * 0.25, rate * 2.25);
    frames.fill(0.6, rate * 2.25);
    const media = new AudioMedia(new Blob([frames]), rate, 1, frames.length);
    const reads = [];
    const readFrames = media.readFrames.bind(media);
    media.readFrames = (start, count) => {
      reads.push([start, count]);
      return readFrames(start, count);
    };
    const fileClip = project.addAudioMediaClip(track.id, media, 8, {
      startFrame: rate * 0.25,
      frameCount: rate * 2.5,
      envelope: { gain: 0.5, fadeIn: 0, fadeOut: 0.25 },
    });
    const meter = context.createAnalyser();
    meter.fftSize = 128;
    const sink = context.createGain();
    sink.gain.value = 0;
    meter.connect(sink).connect(context.destination);
    const workspace = await Workspace.create(context, project, { destination: meter });
    const segment = new Float32Array(meter.fftSize);
    const mean = () => {
      meter.getFloatTimeDomainData(segment);
      return segment.reduce((sum, value) => sum + value, 0) / segment.length;
    };
    const waitFor = async (condition) => {
      const deadline = performance.now() + 1500;
      while (!condition()) {
        if (performance.now() > deadline) throw new Error("Waited for audio audition evidence.");
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    };
    try {
      const realResume = context.resume.bind(context);
      let unblock;
      context.resume = () =>
        new Promise((resolve) => {
          unblock = resolve;
        });
      const cancelled = workspace.auditionAudioClip(memoryClip.id);
      workspace.stopClipAudition();
      unblock();
      await cancelled;
      context.resume = realResume;
      await context.resume();
      const cancelledState = [workspace.auditioningClip.value, mean()];

      await workspace.auditionAudioClip(memoryClip.id);
      await waitFor(() => mean() > 0.49);
      const pcmValue = mean();
      workspace.stopClipAudition();
      await waitFor(() => Math.abs(mean()) < 0.001);
      workspace.seek(1.25);
      await workspace.auditionAudioClip(fileClip.id);
      await waitFor(() => mean() > 0.14 && mean() < 0.16);
      const first = mean();
      // The 0.3 plateau lasts 250 ms before the fade, so keep the reading that met it instead of reading again.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      let second = NaN;
      await waitFor(() => {
        const value = mean();
        if (value <= 0.29) return false;
        second = value;
        return true;
      });
      await waitFor(() => workspace.auditioningClip.value === null && Math.abs(mean()) < 0.001);
      await workspace.auditionAudioClip(memoryClip.id);
      await waitFor(() => mean() > 0.49);
      project.removeTrack(track.id);
      await workspace.sync();
      await waitFor(() => Math.abs(mean()) < 0.001);
      if (workspace.auditioningClip.value !== null) throw new Error("Removing the audition track left it active.");
      const result = { cancelledState, pcmValue, first, second, reads, position: workspace.position, clock: workspace.clock.state.value };
      return result;
    } finally {
      workspace.dispose();
      project.dispose();
      await media.dispose();
      await context.close();
    }
  });
  assert.deepEqual(auditioned.cancelledState, [null, 0]);
  assert.ok(Math.abs(auditioned.pcmValue - 0.5) < 0.002);
  assert.ok(Math.abs(auditioned.first - 0.15) < 0.01);
  assert.ok(Math.abs(auditioned.second - 0.3) < 0.01);
  assert.deepEqual(auditioned.reads, [
    [12000, 96000],
    [108000, 24000],
  ]);
  assert.deepEqual([auditioned.position, auditioned.clock], [1.25, "stopped"]);

  const rangeMix = await page.evaluate(async () => {
    const { AudioMedia, Project, Workspace } = window.fadeFixture;
    const rate = 48000;
    const context = new OfflineAudioContext(2, rate, rate);
    const resume = context.resume.bind(context);
    context.resume = async () => {};
    const createSource = context.createBufferSource.bind(context);
    const buffers = new Set();
    context.createBufferSource = () => {
      const voice = createSource();
      const start = voice.start.bind(voice);
      voice.start = (...args) => {
        buffers.add(voice.buffer);
        return start(...args);
      };
      return voice;
    };
    const project = new Project();
    const short = project.addTrack("Short", "audio");
    const long = project.addTrack("Long", "audio");
    const excluded = project.addTrack("Excluded", "audio");
    project.addAudioClip(short.id, { channels: [new Float32Array(12000).fill(0.5), new Float32Array(12000)], sampleRate: rate }, 0);
    project.addAudioClip(excluded.id, { channels: [new Float32Array(26400).fill(0.9), new Float32Array(26400)], sampleRate: rate }, 0);
    const source = new Float32Array(28800 * 2);
    for (let frame = 2400; frame < 28800; frame++) source[frame * 2 + 1] = 0.25;
    const media = new AudioMedia(new File([source], "long-source.pcm"), rate, 2, 28800);
    const mediaReads = [];
    const read = media.readFrames.bind(media);
    media.readFrames = (start, count) => {
      mediaReads.push([start, count]);
      return read(start, count);
    };
    project.addAudioMediaClip(long.id, media, 0, { startFrame: 2400, frameCount: 26400 });
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    try {
      workspace.seek(0.7);
      await workspace.auditionRange({ start: 0.1, end: 0.45 }, { trackIds: [short.id, long.id] });
      await new Promise((resolve) => setTimeout(resolve));
      await workspace.renderSettled();
      // Offline rendering advances faster than a wall-clock worker. Drive the preview's real tick path.
      const clock = workspace.audition.current.clock;
      const pump = async (at, stop = false) => {
        await context.suspend(at);
        if (stop) workspace.stopRangeAudition();
        else {
          clock.refresh();
          await Promise.resolve(); // the refill tick runs in a microtask
          await workspace.renderSettled();
        }
        await resume();
      };
      const steps = [pump(0.1), pump(0.24), pump(0.36), pump(0.5), pump(0.6), pump(0.71), pump(0.85, true)];
      const output = await context.startRendering();
      await Promise.all(steps);
      const times = [0.0249, 0.0251, 0.1749, 0.1751, 0.3749, 0.3751, 0.7249, 0.7251, 0.9];
      const samples = times.map((time) => [0, 1].map((channel) => output.getChannelData(channel)[Math.round(time * rate)]));
      return { samples, allocatedBuffers: buffers.size, mediaReads, position: workspace.position, clock: workspace.clock.state.value };
    } finally {
      workspace.dispose();
      project.dispose();
      await media.dispose();
    }
  });
  assert.equal(rangeMix.allocatedBuffers, 2);
  assert.deepEqual(rangeMix.mediaReads, [[2400, 26400]]);
  assert.deepEqual([rangeMix.position, rangeMix.clock], [0.7, "stopped"]);
  const rangeExpected = [
    [0, 0],
    [0.5, 0.25],
    [0.5, 0.25],
    [0, 0.25],
    [0, 0.25],
    [0.5, 0.25],
    [0, 0.25],
    [0.5, 0.25],
    [0, 0],
  ];
  rangeMix.samples.forEach((pair, index) =>
    pair.forEach((value, channel) => {
      assert.ok(Math.abs(value - rangeExpected[index][channel]) < 0.002, JSON.stringify(rangeMix));
    }),
  );
  assert.deepEqual(errors, []);
  console.log("Clip gain automation passed waveform editing, live voice reuse, file chunks and stretched Session PCM", automated);
  console.log("Clip fades passed DAW edits and undo, PCM seek, file-backed chunk seek and Session launch", audible);
  console.log("Audition passed independent PCM and file-backed playback, cancellation and source window", auditioned);
  console.log("Range audition passed shared repeat boundaries, short stem silence and cached file playback", rangeMix);
} finally {
  await browser?.close();
  await server.close();
}
