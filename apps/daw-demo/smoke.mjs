import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DAW_SMOKE_PORT ?? 18772);
const server = await createServer({
  configFile: false,
  root,
  server: { host: "127.0.0.1", port, strictPort: true },
  plugins: [
    {
      name: "mount-player-in-smoke",
      transformIndexHtml: {
        order: "pre",
        handler: () => [
          {
            tag: "script",
            attrs: { type: "module" },
            children: 'import { mountPlayer } from "@audiorective/widgets/player"; window.mountPlayerForSmoke = mountPlayer;',
          },
        ],
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const page = await browser.newPage({ acceptDownloads: true });
  // Exercise the download fallback; the file picker requires a human chooser.
  await page.addInitScript(() => {
    window.showSaveFilePicker = undefined;
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.__daw?.workspace?.host(window.__daw.project.tracks[0].devices[0].id));
  await page.waitForFunction(() => typeof window.mountPlayerForSmoke === "function");
  assert.match(await page.locator("#status").innerText(), /工程已就緒/);
  assert.equal(await page.locator("#tracks > section").count(), 8);
  assert.equal(await page.locator(".marker-block").count(), 4);
  const overview = page.getByRole("slider", { name: "編曲視窗" });
  assert.equal(await overview.locator(".overview-clip").count(), await page.locator(".clip").count());
  const firstWave = page.locator(".clip.audio").first().locator("canvas");
  await page.waitForFunction(() => Number(document.querySelector(".clip.audio canvas")?.dataset.framesPerPeak) > 0);
  const zoom = page.locator("#timeline-zoom");
  const overviewScale = await zoom.inputValue();
  const windowWidthBefore = (await overview.locator(".overview-window").boundingBox()).width;
  await zoom.fill("800");
  await page.waitForFunction(() => parseFloat(document.querySelector(".clip.audio").style.width) > 1600);
  await overview.press("Home");
  const mapBox = await overview.boundingBox();
  const windowBox = await overview.locator(".overview-window").boundingBox();
  assert.ok(windowBox.width < windowWidthBefore);
  const mapX = windowBox.x + windowBox.width / 2;
  const mapY = mapBox.y + mapBox.height / 2;
  await page.mouse.move(mapX, mapY);
  await page.mouse.down();
  await page.mouse.move(mapX + mapBox.width * 0.15, mapY, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".clip.audio canvas");
    return canvas && !canvas.hidden && parseFloat(canvas.style.left) > 1000;
  });
  const paintedTail = await firstWave.evaluate((canvas) => {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return data.some((value, index) => index % 4 === 3 && value > 0);
  });
  assert.equal(paintedTail, true);
  assert.ok(Number(await overview.getAttribute("aria-valuenow")) > 2);
  await zoom.fill(overviewScale);
  await page.waitForFunction(() => parseFloat(document.querySelector(".clip.audio").style.width) < 300);
  await overview.press("Home");
  assert.equal(await page.evaluate(() => document.querySelector("#tracks").scrollLeft), 0);

  const loopStrip = await page.locator(".loop-strip").boundingBox();
  const secondsScale = await page
    .locator(".ruler-row .ruler-mark")
    .nth(1)
    .evaluate((mark) => parseFloat(mark.style.left) / 2);
  const loopY = loopStrip.y + loopStrip.height / 2;
  await page.mouse.move(loopStrip.x + 5 * secondsScale, loopY);
  await page.mouse.down();
  await page.mouse.move(loopStrip.x + 2 * secondsScale, loopY, { steps: 8 });
  assert.equal(await page.locator(".loop-strip-region.loop-preview").count(), 1);
  assert.equal(await page.locator("#loop").getAttribute("aria-pressed"), "false");
  await page.mouse.up();
  assert.equal(await page.locator("#loop").getAttribute("title"), "循環 2.00–5.00 秒");
  assert.equal(await page.evaluate(() => window.__daw.workspace.position), 2);
  const rangeAudition = page.getByRole("button", { name: "試聽選區", exact: true });
  await rangeAudition.click();
  await page.waitForFunction(() => {
    const { workspace } = window.__daw;
    const range = workspace.auditioningRange.value;
    return range?.start === 2 && range.end === 5 && range.trackIds.length > 1 && workspace.position === 2;
  });
  assert.equal(await rangeAudition.getAttribute("aria-pressed"), "true");
  await rangeAudition.click();
  await page.waitForFunction(() => window.__daw.workspace.auditioningRange.value === null);
  assert.equal(await rangeAudition.getAttribute("aria-pressed"), "false");
  await page.evaluate(() => window.__daw.workspace.seek(4.9));
  await page.locator("#play").click();
  await page.waitForFunction(() => {
    const workspace = window.__daw.workspace;
    return workspace.clock.state.value === "playing" && workspace.position >= 2 && workspace.position < 2.8;
  });
  await page.locator("#stop").click();
  await page.locator("#loop").click();
  assert.equal(await page.locator(".loop-region").count(), 0);
  await page.locator("#loop").click();
  assert.equal(await page.locator("#loop").getAttribute("title"), "循環 2.00–5.00 秒");
  await page.getByRole("button", { name: "清除自訂循環區間" }).click();
  assert.equal(await page.locator("#loop").getAttribute("aria-pressed"), "false");
  await page.locator("#stop").click();
  const workspacePlayer = await page.evaluate(async () => {
    const Workspace = window.__daw.workspace.constructor;
    const Project = window.__daw.project.constructor;
    const context = window.__daw.workspace.context;
    const project = new Project();
    const track = project.addTrack("Player duration", "midi");
    const clip = project.addMidiClip(track.id, { duration: 4, notes: [] }, 0, { timeUnit: "beats" });
    const workspace = await Workspace.create(context, project, { destination: context.destination });
    const container = document.createElement("div");
    document.body.append(container);
    const view = window.mountPlayerForSmoke(container, { player: workspace.player });
    const seek = container.querySelector('[data-testid="seek"]');
    const toggle = container.querySelector('[data-testid="play-toggle"]');
    try {
      const before = Number(seek.max);
      project.setTempoChanges([{ beat: 2, bpm: 60 }]);
      await workspace.flush();
      const afterTempo = Number(seek.max);
      clip.sequence.setData({ duration: 6, notes: [] });
      const afterClip = Number(seek.max);
      await workspace.play();
      const playingLabel = toggle.textContent;
      workspace.pause();
      workspace.seek(3);
      const pausedSeek = seek.valueAsNumber;
      seek.value = "2";
      seek.dispatchEvent(new Event("input"));
      seek.dispatchEvent(new Event("change"));
      const widgetSeek = workspace.position;
      workspace.stop();
      const stoppedSeek = seek.valueAsNumber;
      workspace.seek(1);
      const stoppedExternalSeek = seek.valueAsNumber;
      workspace.stop();
      return {
        before,
        afterTempo,
        afterClip,
        playingLabel,
        pausedSeek,
        widgetSeek,
        stoppedSeek,
        stoppedExternalSeek,
        stoppedAgain: seek.valueAsNumber,
      };
    } finally {
      view.destroy();
      container.remove();
      workspace.destroy();
      project.destroy();
    }
  });
  assert.deepEqual(workspacePlayer, {
    before: 2,
    afterTempo: 3,
    afterClip: 5,
    playingLabel: "Pause",
    pausedSeek: 3,
    widgetSeek: 2,
    stoppedSeek: 0,
    stoppedExternalSeek: 1,
    stoppedAgain: 0,
  });
  const skinBackgrounds = new Set();
  for (const skin of ["midnight", "slate", "canvas", "orchid"]) {
    await page.locator("#skin").selectOption(skin);
    const result = await page.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      background: getComputedStyle(document.querySelector(".studio")).backgroundColor,
      saved: localStorage.getItem("audiorective-studio-skin"),
    }));
    assert.equal(result.skin, skin);
    assert.equal(result.saved, skin);
    skinBackgrounds.add(result.background);
    await page.screenshot({ path: `/tmp/audiorective-${skin}.png`, fullPage: true });
  }
  assert.equal(skinBackgrounds.size, 4);
  await page.locator("#skin").selectOption("slate");
  await page.screenshot({ path: "/tmp/audiorective-studio.png", fullPage: true });

  const playback = await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const synth = workspace.host(workspace.project.tracks[0].devices[0].id);
    const others = workspace.project.tracks.slice(1).map((track) => ({ id: track.id, volume: track.volume }));
    for (const track of others) workspace.setTrackVolume(track.id, 0);
    const analyser = workspace.context.createAnalyser();
    analyser.fftSize = 2048;
    workspace.output.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let peak = 0;
    await workspace.play();
    for (let index = 0; index < 75; index++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    }
    workspace.pause();
    const position = workspace.position;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const frozen = workspace.position;
    workspace.stop();
    for (const track of others) workspace.setTrackVolume(track.id, track.volume);
    analyser.disconnect();
    const [first] = synth.parameterInfo;
    const param = synth.params[String(first.id)];
    const target = first.min + (first.max - first.min) * 0.5;
    param.value = target;
    return {
      peak,
      position,
      frozen,
      id: synth.descriptor.id,
      params: Object.keys(synth.params).length,
      info: synth.parameterInfo.length,
      written: param.value === target,
    };
  });
  assert.equal(playback.id, "com.oxo.music.oxosynth2");
  assert.ok(playback.params >= 99);
  assert.equal(playback.params, playback.info);
  assert.ok(playback.written);
  assert.ok(playback.peak > 0.01, `synth was silent: ${playback.peak}`);
  assert.ok(playback.position > 0.5 && Math.abs(playback.frozen - playback.position) < 0.001);

  const audioClip = page.locator(".clip.audio").first();
  const audioClipId = await audioClip.getAttribute("data-clip-id");
  await page.locator(".clip.audio").filter({ hasText: "Atmosphere" }).first().click();
  const waveformHeight = () => page.locator("#editor-panel [data-testid='wave-path']").evaluate((path) => path.getBBox().height);
  const originalWaveHeight = await waveformHeight();
  const originalWaveWidth = (await page.locator("#editor-panel .wave .ar-track").boundingBox()).width;
  await page.locator("#editor-panel [data-testid='amplitude-zoom-in']").click({ timeout: 2000 });
  assert.ok((await waveformHeight()) > originalWaveHeight * 1.5, "waveform amplitude did not become easier to inspect");
  assert.equal((await page.locator("#editor-panel .wave .ar-track").boundingBox()).width, originalWaveWidth);
  assert.equal(await page.locator("#editor-panel .wave-amplitude-value").textContent(), "4×");
  await page.locator("#editor-panel [data-testid='zoom-in']").click();
  assert.ok((await page.locator("#editor-panel .wave .ar-track").boundingBox()).width > originalWaveWidth * 1.9);
  assert.equal(await page.locator("#editor-panel .wave-amplitude-value").textContent(), "4×");
  await page.locator("#editor-panel [data-testid='zoom-out']").click();
  const lowerPanel = page.locator(".lower-panel");
  const originalPanelHeight = (await lowerPanel.boundingBox()).height;
  const originalWaveSurfaceHeight = (await page.locator("#editor-panel .wave .ar-wave").boundingBox()).height;
  const grip = await page.locator("#lower-resize").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 30, { steps: 5 });
  await page.mouse.up();
  const grownPanelHeight = (await lowerPanel.boundingBox()).height;
  assert.ok(grownPanelHeight > originalPanelHeight + 20, "lower editor did not resize");
  assert.ok(
    (await page.locator("#editor-panel .wave .ar-wave").boundingBox()).height > originalWaveSurfaceHeight + 20,
    "waveform did not fill resized editor",
  );
  await page.locator("#lower-resize").focus();
  await page.keyboard.press("ArrowDown");
  assert.ok((await lowerPanel.boundingBox()).height < grownPanelHeight - 20, "keyboard resize did not shrink editor");
  await page.screenshot({ path: "/tmp/audiorective-amplitude-zoom.png", fullPage: true });
  await page.evaluate(() => (document.querySelector(".lower-panel").style.height = ""));
  await audioClip.click();
  await page.locator(".clip.audio").filter({ hasText: "Atmosphere" }).first().click();
  assert.equal(await page.locator("#editor-panel .wave-amplitude-value").textContent(), "4×");
  await audioClip.click();
  await page.evaluate(() => window.__daw.workspace.seek(1));
  await page.locator("#split").click();
  const clipState = () =>
    page.evaluate((id) => {
      const clips = window.__daw.project.tracks[1].clips;
      return { count: clips.length, left: clips.find((clip) => clip.id === id)?.duration, right: clips.find((clip) => clip.time === 1)?.duration };
    }, audioClipId);
  assert.deepEqual(await clipState(), { count: 5, left: 1, right: 3 });
  await page.locator("#undo").click();
  assert.deepEqual(await clipState(), { count: 4, left: 4, right: undefined });
  await page.locator("#redo").click();
  assert.deepEqual(await clipState(), { count: 5, left: 1, right: 3 });
  await page.locator("#undo").click();
  await page.locator("#trim-start").click();
  assert.deepEqual(await clipState(), { count: 4, left: 3, right: 3 });
  await page.locator("#undo").click();
  assert.deepEqual(await clipState(), { count: 4, left: 4, right: undefined });
  await page.evaluate(() => window.__daw.workspace.stop());

  const ruler = page.locator(".ruler-row .ruler");
  const rulerBox = await ruler.boundingBox();
  const pixelsPerSecond =
    (await ruler
      .locator(".ruler-mark")
      .nth(1)
      .evaluate((mark) => parseFloat(mark.style.left))) / 2;
  const rulerY = rulerBox.y + rulerBox.height / 2;
  await page.mouse.move(rulerBox.x + pixelsPerSecond, rulerY);
  await page.mouse.down();
  await page.mouse.move(rulerBox.x + pixelsPerSecond * 3, rulerY, { steps: 8 });
  await page.mouse.up();
  assert.ok(Math.abs((await page.evaluate(() => window.__daw.workspace.position)) - 3) < 0.26, "ruler drag did not scrub");
  await page.mouse.click(rulerBox.x + pixelsPerSecond * 2, rulerY);
  assert.ok(Math.abs((await page.evaluate(() => window.__daw.workspace.position)) - 2) < 0.26, "ruler click did not seek");
  await page.locator("#play").click();
  await page.waitForFunction(() => window.__daw.workspace.clock.state.value === "playing");
  await page.mouse.move(rulerBox.x + pixelsPerSecond, rulerY);
  await page.mouse.down();
  await page.mouse.move(rulerBox.x + pixelsPerSecond * 3, rulerY, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__daw.workspace.clock.state.value === "playing");
  assert.ok((await page.evaluate(() => window.__daw.workspace.position)) >= 2.75, "ruler drag did not resume at the new position");
  await page.evaluate(() => window.__daw.workspace.stop());

  const firstClip = page.locator(".clip.midi").first();
  const firstClipId = await firstClip.getAttribute("data-clip-id");
  await page.locator("#tracks").evaluate((view) => {
    view.scrollTop = 0;
  });
  const clipBox = await firstClip.boundingBox();
  await page.mouse.move(clipBox.x + 20, clipBox.y + 25);
  await page.mouse.down();
  await page.mouse.move(clipBox.x + 75, clipBox.y + 25, { steps: 8 });
  await page.mouse.up();
  assert.equal(await page.evaluate((id) => window.__daw.project.tracks[0].clips.find((clip) => clip.id === id).time, firstClipId), 1);
  const originalMidiClipCount = await page.locator(".clip.midi").count();
  await page.locator("#duplicate").click();
  assert.equal(await page.locator(".clip.midi").count(), originalMidiClipCount + 1);
  await page.locator("#delete").click();
  assert.equal(await page.locator(".clip.midi").count(), originalMidiClipCount);

  await page.locator(".clip.midi").first().click();
  await page.evaluate(() => window.__daw.workspace.seek(2.5));
  await page.locator("#split").click();
  assert.equal(await page.locator(".clip.midi").count(), originalMidiClipCount + 1);
  await page.locator("#undo").click();
  assert.equal(await page.locator(".clip.midi").count(), originalMidiClipCount);
  await page.evaluate(() => window.__daw.workspace.stop());

  await page.locator(".clip.midi").first().click();
  assert.equal(await page.locator(".studio").getAttribute("data-lower-open"), "true");
  await page.locator("#tab-editor").click();
  await page.locator("#loop").click();
  const loopBand = await page
    .locator(".loop-region")
    .evaluate((band) => ({ left: parseFloat(band.style.left), width: parseFloat(band.style.width) }));
  const selectedClipRange = await page.evaluate((id) => {
    const clip = window.__daw.project.tracks[0].clips.find((item) => item.id === id);
    return { time: clip.time, duration: clip.duration };
  }, firstClipId);
  assert.ok(Math.abs(loopBand.left - selectedClipRange.time * pixelsPerSecond) < 1);
  assert.ok(Math.abs(loopBand.width - selectedClipRange.duration * pixelsPerSecond) < 1);
  await page.screenshot({ path: "/tmp/audiorective-loop-range.png", fullPage: true });
  await page.locator("#loop").click();
  assert.equal(await page.locator(".loop-region").count(), 0);
  await page.locator("#editor-panel [data-testid='piano-zoom-in']").click();
  const zoomedWidth = await page.locator("#editor-panel .ar-pr-surface").evaluate((surface) => surface.style.width);
  await page.locator("#zoom-in").click();
  assert.equal(await page.locator("#editor-panel .ar-pr-surface").evaluate((surface) => surface.style.width), zoomedWidth);
  await page.locator(".track-control[data-track-id]").first().locator("input.track-volume").click();
  assert.equal(await page.locator("#editor-panel .ar-pr-surface").evaluate((surface) => surface.style.width), zoomedWidth);
  assert.equal(await page.locator(".clip.selected").first().getAttribute("data-clip-id"), firstClipId);
  await page.locator("#editor-panel [data-testid='piano-zoom-out']").click();
  assert.equal(await page.locator("#editor-panel .editor-top .ar-toolbar").count(), 1);
  const editorLayout = await page.evaluate(() => {
    const panel = document.querySelector("#editor-panel");
    const widget = panel.querySelector(".ar-widget");
    const surface = panel.querySelector(".ar-pr-surface");
    return {
      widgetBorder: getComputedStyle(widget).borderTopWidth,
      widgetPadding: getComputedStyle(widget).paddingTop,
      surfaceHeight: surface?.getBoundingClientRect().height ?? 0,
      panelHeight: panel.getBoundingClientRect().height,
    };
  });
  assert.equal(editorLayout.widgetBorder, "0px");
  assert.equal(editorLayout.widgetPadding, "0px");
  assert.ok(editorLayout.surfaceHeight > editorLayout.panelHeight * 0.7, JSON.stringify(editorLayout));
  await page.screenshot({ path: "/tmp/audiorective-editor-slate.png", fullPage: true });
  await page.locator("#skin").selectOption("midnight");
  await page.screenshot({ path: "/tmp/audiorective-editor-midnight.png", fullPage: true });
  await page.locator("#skin").selectOption("canvas");
  const canvasNote = await page.evaluate(() => {
    const note = document.querySelector(".ar-pr-note");
    const style = getComputedStyle(note);
    return { height: note.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), color: style.color };
  });
  assert.ok(canvasNote.lineHeight <= canvasNote.height, JSON.stringify(canvasNote));
  assert.notEqual(canvasNote.color, "rgb(255, 255, 255)");
  await page.screenshot({ path: "/tmp/audiorective-editor-canvas.png", fullPage: true });
  await page.locator("#skin").selectOption("slate");
  const [editedNoteId, deletedNoteId] = await page.evaluate((id) => {
    const clip = window.__daw.project.tracks[0].clips.find((item) => item.id === id);
    return clip.sequence
      .getState()
      .notes.slice(0, 2)
      .map((note) => note.id);
  }, firstClipId);
  await page.locator(`.ar-pr-note[data-note-id="${editedNoteId}"]`).click();
  for (const [field, value] of [
    ["音高", "65"],
    ["起點 (秒)", "0.5"],
    ["長度 (秒)", "0.75"],
    ["力度", "80"],
  ]) {
    await page.locator(`#editor-panel input[aria-label="${field}"]`).fill(value);
    await page.keyboard.press("Tab");
  }
  const editedNote = await page.evaluate(
    ({ clipId, noteId }) => {
      const clip = window.__daw.project.tracks[0].clips.find((item) => item.id === clipId);
      return clip.sequence.getState().notes.find((note) => note.id === noteId);
    },
    { clipId: firstClipId, noteId: editedNoteId },
  );
  await page.locator("#arrange-summary").click();
  await page.keyboard.press("Control+z");
  assert.notEqual(
    await page.evaluate(
      ({ clipId, noteId }) =>
        window.__daw.project.tracks[0].clips
          .find((clip) => clip.id === clipId)
          .sequence.getState()
          .notes.find((note) => note.id === noteId).velocity,
      { clipId: firstClipId, noteId: editedNoteId },
    ),
    80,
  );
  await page.keyboard.press("Control+Shift+z");
  assert.equal(
    await page.evaluate(
      ({ clipId, noteId }) =>
        window.__daw.project.tracks[0].clips
          .find((clip) => clip.id === clipId)
          .sequence.getState()
          .notes.find((note) => note.id === noteId).velocity,
      { clipId: firstClipId, noteId: editedNoteId },
    ),
    80,
  );
  assert.deepEqual([editedNote.pitch, editedNote.start, editedNote.end, editedNote.velocity], [65, 0.5, 1.25, 80]);
  await page.locator(`.ar-pr-note[data-note-id="${editedNoteId}"]`).click();
  assert.equal(await page.locator(`.ar-pr-note.selected[data-note-id="${editedNoteId}"]`).count(), 1);
  await page.locator(`.ar-pr-note[data-note-id="${deletedNoteId}"]`).click();
  await page.keyboard.press("Delete");
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].clips.length), 4);
  assert.equal(
    await page.evaluate(
      ({ clipId, noteId }) => {
        const clip = window.__daw.project.tracks[0].clips.find((item) => item.id === clipId);
        return clip.sequence.getState().notes.some((note) => note.id === noteId);
      },
      { clipId: firstClipId, noteId: deletedNoteId },
    ),
    false,
  );
  await page.locator("#tab-mixer").click();
  await page.locator(".mixer-strip").first().locator(".mute").click();
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].muted), true);
  await page.locator(".mixer-strip").first().locator(".mute").click();
  await page.locator(".mixer-strip").first().locator(".solo").click();
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].solo), true);
  await page.locator(".mixer-strip").first().locator(".solo").click();
  await page.locator(".mixer-strip").first().locator('input[aria-label="Keys pan"]').fill("-0.5");
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].pan), -0.5);

  await page.evaluate(() => {
    const input = new EventTarget();
    input.name = "Virtual MIDI";
    window.__fakeMidiInput = input;
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: async () => ({ inputs: { forEach: (visit) => visit(input) } }),
    });
  });
  await page.locator("#record-midi").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("並監聽音源"));
  const monitored = await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const analyser = workspace.context.createAnalyser();
    analyser.fftSize = 2048;
    workspace.output.connect(analyser);
    const samples = new Float32Array(2048);
    const send = (data) => {
      const event = new Event("midimessage");
      Object.defineProperty(event, "data", { value: new Uint8Array(data) });
      window.__fakeMidiInput.dispatchEvent(event);
    };
    send([0x90, 60, 110]);
    let peak = 0;
    for (let index = 0; index < 8; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    }
    send([0x80, 60, 0]);
    analyser.disconnect();
    return peak;
  });
  await page.locator("#record-midi").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("MIDI take：1 個音符"));
  assert.ok(monitored > 0.01, `live MIDI monitor was silent: ${monitored}`);

  await page.locator("#record-audio").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("正在錄製麥克風"));
  await page.waitForTimeout(220);
  await page.locator("#record-audio").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("音訊 take："));
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[1].clips.length), 5);
  const recordedMedia = await page.evaluate(async () => {
    const clip = window.__daw.project.tracks[1].clips.find((item) => item.media);
    window.__recordedClipId = clip.id;
    const channels = await clip.media.readFrames(0, Math.min(1024, clip.frameCount));
    return { frames: clip.frameCount, fileBacked: clip.media.blob instanceof File, peak: Math.max(...channels[0].map(Math.abs)) };
  });
  assert.ok(recordedMedia.frames > 4096 && recordedMedia.fileBacked, JSON.stringify(recordedMedia));

  await page.locator("#tab-device").click();
  await page.locator("#device-panel details summary").first().click();
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.body?.textContent?.includes("Synth2"));
  await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const host = workspace.host(workspace.project.tracks[0].devices[0].id);
    window.__smokeBefore = await host.saveState();
    const port = host.node.port;
    const receive = port.onmessage;
    const send = port.postMessage;
    const readback = { emitted: [], observed: [], echoCount: 0 };
    port.onmessage = (event) => {
      if (event.data.type === "paramOut" && event.data.id === 2) readback.emitted.push(event.data.value);
      receive.call(port, event);
    };
    port.postMessage = (message, transfer) => {
      if (message.type === "param") readback.echoCount++;
      return send.call(port, message, transfer);
    };
    const stop = host.effect(() => void readback.observed.push(host.params["2"].value));
    window.__editorReadback = {
      readback,
      cleanup: () => {
        stop();
        port.onmessage = receive;
        port.postMessage = send;
        delete window.__editorReadback;
      },
    };
  });
  const knob = page.frameLocator("iframe").locator(".knob").nth(3);
  await knob.scrollIntoViewIfNeeded();
  const knobBox = await knob.boundingBox();
  const x = knobBox.x + knobBox.width / 2;
  const y = knobBox.y + knobBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__editorReadback.readback.emitted.length > 1);
  const editorReadback = await page.evaluate(async () => {
    const { readback, cleanup } = window.__editorReadback;
    cleanup();
    const workspace = window.__daw.workspace;
    const host = workspace.host(workspace.project.tracks[0].devices[0].id);
    const edited = host.params["2"].value;
    const patch = await host.saveState();
    host.params["2"].value = 0;
    await host.loadState(patch);
    return { ...readback, edited, restored: host.params["2"].value };
  });
  assert.ok(editorReadback.observed.length > 1);
  assert.notEqual(editorReadback.edited, editorReadback.observed[0]);
  assert.equal(editorReadback.edited, editorReadback.emitted.at(-1));
  assert.equal(editorReadback.edited, editorReadback.observed.at(-1));
  assert.equal(editorReadback.restored, editorReadback.edited);
  assert.equal(editorReadback.echoCount, 0);
  await page.frameLocator("iframe").locator("#next").click();
  await page.frameLocator("iframe").locator("#next").click();
  await page.frameLocator("iframe").locator("#pname").filter({ hasNotText: "INIT" }).waitFor();
  const state = await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const host = workspace.host(workspace.project.tracks[0].devices[0].id);
    const before = window.__smokeBefore;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await host.saveState();
    const bytes = await window.__daw.api.saveWorkspace(workspace);
    const reopened = await window.__daw.api.openWorkspace(workspace.context, bytes, workspace.options);
    const restored = await reopened.host(reopened.project.tracks[0].devices[0].id).saveState();
    const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
    const result = {
      changed: !same(before, after),
      saved: same(after, reopened.project.tracks[0].devices[0].state),
      restored: same(after, restored),
      warnings: reopened.warnings,
      archiveSize: bytes.length,
    };
    reopened.destroy();
    reopened.project.destroy();
    return result;
  });
  assert.ok(state.changed && state.saved && state.restored);
  assert.deepEqual(state.warnings, []);
  assert.ok(state.archiveSize > 100_000);

  // Plug-in editor -> JS readback: a knob dragged in the plug-in's own webview editor reaches host.params through `paramOut`.
  await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const device = workspace.project.tracks[0].devices[0];
    const Host = workspace.host(device.id).constructor;
    const url = (await workspace.options.resolveBundle?.(device)) ?? device.bundleUrl;
    const host = await Host.load(workspace.context, { url, workletUrl: workspace.options.workletUrl });
    const worklet = { paramOut: [], echoed: [] };
    const receive = host.node.port.onmessage;
    host.node.port.onmessage = (event) => {
      if (event.data.type === "paramOut") worklet.paramOut.push({ id: event.data.id, value: event.data.value });
      receive(event);
    };
    const send = host.node.port.postMessage.bind(host.node.port);
    host.node.port.postMessage = (message, transfer) => {
      if (message.type === "param") worklet.echoed.push(message);
      return send(message, transfer);
    };
    const frame = document.createElement("iframe");
    frame.id = "editor-readback";
    frame.style.cssText = "position:fixed;left:0;top:0;width:770px;height:560px;z-index:99999;border:0;background:#fff";
    document.body.append(frame);
    const unmount = await host.mountEditor(frame);
    const seen = [];
    const stop = host.effect(() => void seen.push(host.params["2"].value));
    window.__editorReadback = {
      host,
      worklet,
      seen,
      stop,
      unmount,
      frame,
      before: Object.fromEntries(Object.entries(host.params).map(([id, param]) => [id, param.value])),
    };
  });
  const readbackFrame = await (await page.$("#editor-readback")).contentFrame();
  await readbackFrame.waitForSelector(".knob");
  await page.waitForTimeout(500);
  // Drag the third knob upward the way a user would; the editor sends begin/set/end over postMessage.
  const readbackKnob = await readbackFrame.locator(".knob").nth(3).boundingBox();
  await page.mouse.move(readbackKnob.x + readbackKnob.width / 2, readbackKnob.y + readbackKnob.height / 2);
  await page.mouse.down();
  await page.mouse.move(readbackKnob.x + readbackKnob.width / 2, readbackKnob.y + readbackKnob.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__editorReadback.worklet.paramOut.length > 1 && window.__editorReadback.seen.length > 1);
  await page.waitForTimeout(300);
  const readback = await page.evaluate(() => {
    const { host, worklet, seen, stop, unmount, frame, before } = window.__editorReadback;
    const changed = Object.entries(host.params)
      .filter(([id, param]) => param.value !== before[id])
      .map(([id, param]) => ({ id, before: before[id], after: param.value }));
    const last = worklet.paramOut[worklet.paramOut.length - 1];
    const result = {
      changed,
      lastOut: last,
      paramNow: host.params[String(last.id)].value,
      effectRuns: seen.length,
      effectLast: seen[seen.length - 1],
      echoed: worklet.echoed.length,
    };
    stop();
    unmount();
    frame.remove();
    host.destroy();
    delete window.__editorReadback;
    return result;
  });
  assert.equal(readback.changed.length, 1, JSON.stringify(readback));
  assert.equal(readback.changed[0].id, String(readback.lastOut.id));
  assert.equal(readback.changed[0].id, "2", "the fourth editor knob drives CLAP parameter 2");
  assert.notEqual(readback.changed[0].after, readback.changed[0].before);
  assert.equal(readback.paramNow, readback.lastOut.value);
  assert.equal(readback.effectLast, readback.paramNow);
  assert.ok(readback.effectRuns > 1);
  assert.equal(readback.echoed, 0, "plug-in originated changes must not be echoed back to the worklet");

  const audioPause = await page.evaluate(async () => {
    const current = window.__daw.workspace;
    const Project = current.project.constructor;
    const project = new Project({ bpm: 120 });
    const track = project.addTrack("Sustained audio", "audio");
    const samples = new Float32Array(48_000);
    for (let index = 0; index < samples.length; index++) samples[index] = Math.sin((index * 2 * Math.PI * 440) / 48_000) * 0.4;
    project.addAudioClip(track.id, { sampleRate: 48_000, channels: [samples] }, 0);
    const workspace = await current.constructor.create(current.context, project);
    const analyser = current.context.createAnalyser();
    analyser.fftSize = 2048;
    workspace.output.connect(analyser);
    const frame = new Float32Array(2048);
    await workspace.play();
    await new Promise((resolve) => setTimeout(resolve, 80));
    analyser.getFloatTimeDomainData(frame);
    const before = Math.max(...frame.map(Math.abs));
    workspace.setTrackMuted(track.id, true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    analyser.getFloatTimeDomainData(frame);
    const muted = Math.max(...frame.map(Math.abs));
    workspace.setTrackMuted(track.id, false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    analyser.getFloatTimeDomainData(frame);
    const unmuted = Math.max(...frame.map(Math.abs));
    workspace.pause();
    await new Promise((resolve) => setTimeout(resolve, 80));
    analyser.getFloatTimeDomainData(frame);
    const after = Math.max(...frame.map(Math.abs));
    await workspace.play();
    await new Promise((resolve) => setTimeout(resolve, 40));
    analyser.getFloatTimeDomainData(frame);
    const resumed = Math.max(...frame.map(Math.abs));
    workspace.destroy();
    project.destroy();
    analyser.disconnect();
    return { before, muted, unmuted, after, resumed };
  });
  assert.ok(audioPause.before > 0.1, `audio clip did not play: ${audioPause.before}`);
  assert.ok(audioPause.muted < 0.001, `track mute did not silence audio: ${audioPause.muted}`);
  assert.ok(audioPause.unmuted > 0.1, `track did not unmute audio: ${audioPause.unmuted}`);
  assert.ok(audioPause.after < 0.001, `audio clip continued after pause: ${audioPause.after}`);
  assert.ok(audioPause.resumed > 0.1, `audio clip did not resume promptly: ${audioPause.resumed}`);

  const mediaPlayback = await page.evaluate(async () => {
    const context = window.__daw.workspace.context;
    const project = new window.__daw.project.constructor();
    const track = project.addTrack("File-backed", "audio");
    project.addAudioClip(track.id, { sampleRate: 48000, channels: [new Float32Array(48000).fill(0.25)] }, 0);
    const source = await window.__daw.workspace.constructor.create(context, project);
    const archive = await window.__daw.api.saveWorkspace(source);
    source.destroy();
    const opened = await window.__daw.api.openWorkspaceBlob(context, new Blob([archive]), { destination: context.destination });
    const clip = opened.project.tracks[0].clips[0];
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    opened.output.connect(analyser);
    opened.seek(0.5);
    await opened.play();
    await new Promise((resolve) => setTimeout(resolve, 90));
    const frame = new Float32Array(2048);
    analyser.getFloatTimeDomainData(frame);
    const peak = Math.max(...frame.map(Math.abs));
    opened.destroy();
    opened.project.destroy();
    project.destroy();
    analyser.disconnect();
    return { fileBacked: !!clip.media, peak };
  });
  assert.ok(mediaPlayback.fileBacked && mediaPlayback.peak > 0.1, JSON.stringify(mediaPlayback));

  await page.evaluate(() => {
    const chunks = [];
    window.showSaveFilePicker = async () => ({
      createWritable: async () =>
        new WritableStream({
          write: (chunk) => {
            chunks.push(new Uint8Array(chunk));
          },
          close: () => {
            window.__pickerArchive = new Blob(chunks);
          },
        }),
    });
  });
  await page.locator("#save").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("已串流儲存"));
  assert.ok(await page.evaluate(() => window.__pickerArchive.size > 1000));
  await page.evaluate(() => {
    window.showSaveFilePicker = undefined;
  });

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#save").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.dawproject$/);
  await page.locator("#open-file").setInputFiles(await download.path());
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("已開啟"));
  assert.equal(
    await page.evaluate(() => window.__daw.project.tracks[1].clips.find((clip) => clip.id === window.__recordedClipId).media?.frameCount > 4096),
    true,
  );
  assert.equal(await page.locator("#undo").isDisabled(), true);
  assert.equal(await page.locator("#tracks > section").count(), 8);
  assert.equal(await page.locator(".marker-block").count(), 4);
  assert.equal(await page.evaluate((id) => window.__daw.project.tracks[0].clips.find((clip) => clip.id === id).time, firstClipId), 1);
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].pan), -0.5);
  const reopenedEdit = await page.evaluate(
    ({ clipId, noteId, removedId }) => {
      const clip = window.__daw.project.tracks[0].clips.find((item) => item.id === clipId);
      return {
        note: clip.sequence.getState().notes.find((item) => item.id === noteId),
        deleted: clip.sequence.getState().notes.some((item) => item.id === removedId),
        played: clip.playbackEvents().some((event) => event.data[0] === 0x90 && event.data[1] === 65 && event.data[2] === 80),
      };
    },
    { clipId: firstClipId, noteId: editedNoteId, removedId: deletedNoteId },
  );
  assert.deepEqual([reopenedEdit.note.pitch, reopenedEdit.note.start, reopenedEdit.note.end, reopenedEdit.note.velocity], [65, 0.5, 1.25, 80]);
  assert.equal(reopenedEdit.deleted, false);
  assert.equal(reopenedEdit.played, true);

  await page.evaluate(() => window.__daw.workspace.seek(window.__daw.workspace.duration - 0.1));
  await page.locator("#loop").click();
  await page.locator("#play").click();
  await page.waitForTimeout(350);
  assert.ok((await page.evaluate(() => window.__daw.workspace.position)) < 0.6);
  await page.locator("#pause").click();
  await page.locator("#loop").click();

  await page.locator("#new-midi-track").click();
  await page.waitForFunction(() => document.querySelectorAll("#tracks > section").length === 9);
  assert.ok(await page.evaluate(() => window.__daw.workspace.host(window.__daw.project.tracks[8].devices[0].id)));
  await page.locator("#new-midi-clip").click();
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[8].clips.length), 1);
  assert.equal(await page.locator(".studio").getAttribute("data-lower-open"), "true");
  const trackBox = await page.locator("#tracks > section").last().boundingBox();
  const arrangementBox = await page.locator("#tracks").boundingBox();
  assert.ok(trackBox.y >= arrangementBox.y && trackBox.y + trackBox.height <= arrangementBox.y + arrangementBox.height + 1);
  const surface = page.locator("#editor-panel .ar-pr-surface");
  const surfaceBox = await surface.boundingBox();
  await surface.dblclick({ position: { x: surfaceBox.width * 0.25, y: surfaceBox.height * 0.25 } });
  const placed = await page.evaluate(() => window.__daw.project.tracks[8].clips[0].sequence.getState().notes[0]);
  assert.ok(placed.start > 0 && placed.pitch > 60, JSON.stringify(placed));
  await page.locator("#editor-panel button").filter({ hasText: "加音符" }).click();
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[8].clips[0].sequence.getState().notes.length), 2);
  const newTrackPeak = await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const tracks = workspace.project.tracks;
    const volumes = tracks.slice(0, -1).map((track) => [track.id, track.volume]);
    for (const [id] of volumes) workspace.setTrackVolume(id, 0);
    const analyser = workspace.context.createAnalyser();
    analyser.fftSize = 2048;
    workspace.output.connect(analyser);
    const samples = new Float32Array(2048);
    workspace.seek(tracks.at(-1).clips[0].time);
    await workspace.play();
    let peak = 0;
    for (let index = 0; index < 28; index++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      analyser.getFloatTimeDomainData(samples);
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    }
    workspace.stop();
    for (const [id, volume] of volumes) workspace.setTrackVolume(id, volume);
    analyser.disconnect();
    return peak;
  });
  assert.ok(newTrackPeak > 0.01, `new MIDI track was silent: ${newTrackPeak}`);
  await page.evaluate(() => window.__daw.workspace.seek(1.25));
  await page.locator("#toggle-browser").click();
  await page.locator("#add-audio").click();
  await page.waitForFunction(() => document.querySelectorAll("#tracks > section").length === 10);
  assert.ok(Math.abs((await page.evaluate(() => window.__daw.workspace.position)) - 1.25) < 0.001);
  assert.equal(await page.locator("#tracks > section").count(), 10);
  await page.locator("#skin").selectOption("orchid");
  await page.locator("#record-latency").fill("20");
  await page.locator("#record-latency").dispatchEvent("change");
  await page.reload();
  await page.waitForFunction(() => window.__daw?.workspace?.host(window.__daw.project.tracks[0].devices[0].id));
  assert.equal(await page.locator("#skin").inputValue(), "orchid");
  assert.equal(await page.locator("#record-latency").inputValue(), "20");
  await page.locator("#toggle-browser").click();
  await page.locator("#record-latency").fill("0");
  await page.locator("#record-latency").dispatchEvent("change");
  const runtime = await page.evaluate(async () => {
    const workspace = window.__daw.workspace;
    const project = workspace.project;
    const host = workspace.host(project.tracks[0].devices[0].id);
    workspace.seek(1);
    const stoppedAnchor = workspace.takeAnchor();
    const stoppedPlacement = workspace.takePosition(stoppedAnchor, { startTime: stoppedAnchor.audioTime + 0.2 }, 0.05);
    workspace.seek(0);
    await workspace.play();
    const playingAnchor = workspace.takeAnchor();
    const playingPlacement = workspace.takePosition(playingAnchor, { startTime: playingAnchor.audioTime + 0.2 }, 0.05);
    project.moveClip(project.tracks[0].clips[0].id, project.tracks[0].id, 0.25);
    await workspace.flush();
    const keptHost = workspace.host(project.tracks[0].devices[0].id) === host && workspace.clock.state.value === "playing";
    workspace.stop();

    const track = project.addTrack("Automation check", "audio");
    project.addAudioClip(track.id, { sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.25)] }, 0);
    project.setVolumeAutomation(track.id, [
      { time: 0, value: 0, shape: "hold" },
      { time: 0.25, value: 1, shape: "hold" },
      { time: 0.75, value: 0, shape: "hold" },
    ]);
    await workspace.sync();
    for (const other of project.tracks) if (other.id !== track.id) workspace.setTrackVolume(other.id, 0);
    const analyser = workspace.context.createAnalyser();
    analyser.fftSize = 2048;
    workspace.output.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const sample = () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    };
    const waitUntil = async (seconds) => {
      while (workspace.position < seconds) await new Promise((resolve) => setTimeout(resolve, 8));
    };
    const createBuffer = workspace.context.createBuffer.bind(workspace.context);
    let buffers = 0;
    workspace.context.createBuffer = (...args) => {
      buffers++;
      return createBuffer(...args);
    };
    await workspace.play();
    await waitUntil(0.12);
    const silent = sample();
    await waitUntil(0.4);
    const audible = sample();
    await waitUntil(0.85);
    const silentAgain = sample();
    workspace.stop();
    const firstBuffers = buffers;
    await workspace.play();
    await waitUntil(0.4);
    workspace.stop();
    project.setVolumeAutomation(track.id, [
      { time: 0, value: 0, shape: "linear" },
      { time: 0.5, value: 1, shape: "hold" },
    ]);
    await workspace.flush();
    workspace.seek(0.25);
    await workspace.play();
    await waitUntil(0.4);
    const linear = sample();
    workspace.setTrackMuted(track.id, true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const muted = sample();
    workspace.setTrackMuted(track.id, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const unmuted = sample();
    workspace.stop();
    workspace.context.createBuffer = createBuffer;
    analyser.disconnect();
    return {
      keptHost,
      stoppedPlacement,
      playingPlacement,
      anchorPosition: playingAnchor.projectTime,
      silent,
      audible,
      silentAgain,
      linear,
      muted,
      unmuted,
      firstBuffers,
      replayBuffers: buffers,
    };
  });
  assert.equal(runtime.keptHost, true, "a clip edit reloaded the instrument or stopped playback");
  assert.ok(Math.abs(runtime.stoppedPlacement - 0.95) < 1e-6);
  assert.ok(Math.abs(runtime.playingPlacement - runtime.anchorPosition - 0.15) < 1e-6);
  assert.ok(runtime.silent < 0.005 && runtime.audible > 0.1 && runtime.silentAgain < 0.005, JSON.stringify(runtime));
  assert.ok(runtime.linear > 0.12 && runtime.linear < 0.23 && runtime.muted < 0.005 && runtime.unmuted > 0.1, JSON.stringify(runtime));
  assert.ok(runtime.firstBuffers > 0 && runtime.replayBuffers === runtime.firstBuffers, JSON.stringify(runtime));
  await page.locator(".clip.audio").first().click();
  await page.waitForFunction(() => document.querySelector("#editor-panel [data-testid='wave-path']")?.getBBox().height > 0);
  const tempoRuntime = await page.evaluate(async () => {
    const { workspace, project } = window.__daw;
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    await workspace.flush();
    workspace.seek(0);
    await workspace.play();
    const origin = workspace.timeline.beatToTime(0);
    const step = workspace.timeline.beatToTime(4) - origin;
    const end = workspace.timeline.beatToTime(8) - origin;
    workspace.pause();
    workspace.seek(4);
    await workspace.play();
    const beatAfterSeek = workspace.timeline.timeToBeat(workspace.context.currentTime);
    const positionAfterSeek = workspace.position;
    const host = workspace.host(project.tracks[0].devices[0].id);
    const beforeEdit = workspace.position;
    project.setTempoChanges([{ beat: 4, bpm: 90 }]);
    await workspace.flush();
    const afterEdit = workspace.position;
    const keptHost = workspace.host(project.tracks[0].devices[0].id) === host && workspace.clock.state.value === "playing";
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    await workspace.flush();
    workspace.stop();
    return { step, end, beatAfterSeek, positionAfterSeek, editDrift: afterEdit - beforeEdit, keptHost };
  });
  assert.ok(Math.abs(tempoRuntime.step - 2) < 0.01 && Math.abs(tempoRuntime.end - 6) < 0.01, JSON.stringify(tempoRuntime));
  assert.ok(Math.abs(tempoRuntime.beatAfterSeek - 6) < 0.05 && Math.abs(tempoRuntime.positionAfterSeek - 4) < 0.05, JSON.stringify(tempoRuntime));
  assert.ok(tempoRuntime.keptHost && Math.abs(tempoRuntime.editDrift) < 0.05, JSON.stringify(tempoRuntime));
  const tempoNoteClipId = await page.evaluate(async () => {
    const { project, workspace } = window.__daw;
    const track = project.addTrack("Tempo note", "midi");
    const clip = project.addMidiClip(track.id, { duration: 4, notes: [] }, 3);
    await workspace.sync();
    return clip.id;
  });
  await page.locator("#zoom-in").click(); // Re-render the imported tempo grid through the normal UI.
  await page.waitForFunction(() => document.querySelector(".tempo-grid-segment"));
  const barPositions = await page
    .locator(".ruler-row .ruler-mark")
    .evaluateAll((marks) => marks.slice(0, 3).map((mark) => parseFloat(mark.style.left)));
  assert.ok(Math.abs(barPositions[2] - barPositions[1] * 3) < 1, `tempo ruler ignored the step: ${barPositions}`);
  await page.locator(`.clip[data-clip-id="${tempoNoteClipId}"]`).click();
  await page.evaluate(() => window.__daw.workspace.seek(5));
  await page.locator("#editor-panel button").filter({ hasText: "＋ 加音符" }).click();
  const tempoNote = await page.evaluate((id) => {
    const clip = window.__daw.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id);
    const note = clip.sequence.getState().notes[0];
    return { start: note.start, duration: note.end - note.start };
  }, tempoNoteClipId);
  assert.ok(Math.abs(tempoNote.start - 2) < 0.01 && Math.abs(tempoNote.duration - 1) < 0.01, JSON.stringify(tempoNote));
  const beatClipId = await page.evaluate(async () => {
    const { project, workspace } = window.__daw;
    const track = project.tracks.find((item) => item.kind === "midi");
    const clip = project.addMidiClip(
      track.id,
      {
        duration: 2,
        notes: [{ id: "beat-smoke", start: 0, end: 1, pitch: 109, velocity: 90, channel: 0, track: 0 }],
        events: [{ time: 1, data: new Uint8Array([0xb0, 64, 127]) }],
      },
      6,
      { timeUnit: "beats" },
    );
    await workspace.flush();
    return clip.id;
  });
  const beatGeometry = async () =>
    page.evaluate((id) => {
      const { project } = window.__daw;
      const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === id);
      const element = document.querySelector(`.clip[data-clip-id="${id}"]`);
      const scale = parseFloat(document.querySelectorAll(".ruler-row .ruler-mark")[1].style.left) / 2;
      return {
        unit: clip.timeUnit,
        start: project.clipTimeSeconds(clip),
        end: project.clipTimeSeconds(clip, clip.duration),
        left: parseFloat(element.style.left) / scale,
        width: parseFloat(element.style.width) / scale,
      };
    }, beatClipId);
  const awaitBeatGeometry = async () => {
    await page.waitForFunction((id) => {
      const { project } = window.__daw;
      const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === id);
      const element = document.querySelector(`.clip[data-clip-id="${id}"]`);
      const mark = document.querySelectorAll(".ruler-row .ruler-mark")[1];
      if (!clip || !element || !mark) return false;
      const scale = parseFloat(mark.style.left) / 2;
      return Math.abs(parseFloat(element.style.left) / scale - project.clipTimeSeconds(clip)) < 0.02;
    }, beatClipId);
    return beatGeometry();
  };
  await page.locator("#zoom-in").click();
  const beforeStretch = await awaitBeatGeometry();
  assert.ok(
    beforeStretch.unit === "beats" && Math.abs(beforeStretch.left - 4) < 0.02 && Math.abs(beforeStretch.width - 2) < 0.02,
    JSON.stringify(beforeStretch),
  );
  await page.locator(`.clip[data-clip-id="${beatClipId}"]`).click();
  assert.match(await page.locator('#editor-panel .ar-pr-note[data-note-id="beat-smoke"]').getAttribute("aria-label"), /beats/);
  await page.locator("#loop").click();
  assert.equal(await page.locator("#loop").getAttribute("title"), "循環 4.0–6.0 秒");
  await page.evaluate(() => window.__daw.workspace.seek(5.9));
  await page.locator("#play").click();
  await page.waitForFunction(() => {
    const workspace = window.__daw.workspace;
    return workspace.clock.state.value === "playing" && workspace.position >= 4 && workspace.position < 4.7;
  });
  await page.locator("#stop").click();
  await page.locator("#loop").click();
  await page.evaluate(async () => {
    const { project, workspace } = window.__daw;
    project.setTempoChanges([{ beat: 4, bpm: 120 }]);
    await workspace.flush();
  });
  await page.locator("#zoom-in").click();
  const afterStretch = await awaitBeatGeometry();
  assert.ok(Math.abs(afterStretch.left - 3) < 0.02 && Math.abs(afterStretch.width - 1) < 0.02, JSON.stringify(afterStretch));
  const beatSchedule = await page.evaluate(async () => {
    const { project, workspace } = window.__daw;
    const host = workspace.host(project.tracks[0].devices[0].id);
    const original = host.scheduleMidi;
    const captured = [];
    host.scheduleMidi = function (data, when) {
      if ((data[0] & 0xf0) === 0x90 && data[1] === 109) captured.push(when);
      return original.call(this, data, when);
    };
    try {
      workspace.seek(2.9);
      await workspace.play();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const expected = workspace.timeline.beatToTime(6);
      workspace.pause();
      return { captured, expected };
    } finally {
      host.scheduleMidi = original;
      workspace.stop();
    }
  });
  assert.equal(beatSchedule.captured.length, 1, JSON.stringify(beatSchedule));
  assert.ok(Math.abs(beatSchedule.captured[0] - beatSchedule.expected) < 0.01, JSON.stringify(beatSchedule));
  await page.locator('#editor-panel .ar-pr-note[data-note-id="beat-smoke"]').click();
  await page.locator('#editor-panel input[aria-label="起點 (拍)"]').fill("0.25");
  await page.locator('#editor-panel input[aria-label="起點 (拍)"]').press("Tab");
  const editedBeat = await page.evaluate((id) => {
    const clip = window.__daw.project.tracks.flatMap((track) => track.clips).find((item) => item.id === id);
    return clip.sequence.getState().notes[0].start;
  }, beatClipId);
  assert.equal(editedBeat, 0.25);
  await page.locator(`.clip[data-clip-id="${beatClipId}"]`).focus();
  await page.locator(`.clip[data-clip-id="${beatClipId}"]`).press("ArrowRight");
  await page.waitForFunction(
    (id) => window.__daw.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)?.time === 7,
    beatClipId,
  );
  await page.locator("#undo").click();
  await page.waitForFunction((id) => {
    const clip = window.__daw.project.tracks.flatMap((track) => track.clips).find((item) => item.id === id);
    return clip?.time === 6 && clip?.timeUnit === "beats";
  }, beatClipId);
  await page.evaluate(async () => {
    const { project, workspace } = window.__daw;
    project.setTempoChanges([{ beat: 4, bpm: 60 }]);
    await workspace.flush();
  });
  await page.locator("#zoom-in").click();
  const zoomAnchor = await page.evaluate(() => {
    const root = document.querySelector("#tracks");
    const ruler = root.querySelector(".ruler-row .ruler");
    const x = root.getBoundingClientRect().left + root.clientWidth / 2;
    const pixelsPerSecond = parseFloat(root.querySelectorAll(".ruler-mark")[1].style.left) / 2;
    return {
      x,
      y: ruler.getBoundingClientRect().top + ruler.clientHeight / 2,
      time: (x - ruler.getBoundingClientRect().left) / pixelsPerSecond,
      pixelsPerSecond,
    };
  });
  await page.locator("#timeline-zoom").evaluate((input) => {
    input.value = "800";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(
    (old) => document.querySelector("#timeline-zoom").getAttribute("aria-valuetext") !== old,
    `${Math.round(zoomAnchor.pixelsPerSecond)} 像素／秒`,
  );
  const sliderAnchor = await page.evaluate((x) => {
    const root = document.querySelector("#tracks");
    const ruler = root.querySelector(".ruler-row .ruler");
    const pixelsPerSecond = parseFloat(root.querySelectorAll(".ruler-mark")[1].style.left) / 2;
    return { time: (x - ruler.getBoundingClientRect().left) / pixelsPerSecond, pixelsPerSecond };
  }, zoomAnchor.x);
  assert.ok(
    Math.abs(sliderAnchor.time - zoomAnchor.time) < 0.04,
    JSON.stringify({
      zoomAnchor,
      sliderAnchor,
      layout: await page.evaluate(() => ({
        scrollLeft: document.querySelector("#tracks").scrollLeft,
        scrollWidth: document.querySelector("#tracks").scrollWidth,
        clientWidth: document.querySelector("#tracks").clientWidth,
        rulerLeft: document.querySelector(".ruler-row .ruler").getBoundingClientRect().left,
      })),
    }),
  );
  await page.mouse.move(zoomAnchor.x, zoomAnchor.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -180);
  await page.keyboard.up("Control");
  await page.waitForFunction(
    (old) => Number(document.querySelector("#timeline-zoom").getAttribute("aria-valuetext").split(" ")[0]) > old,
    sliderAnchor.pixelsPerSecond,
  );
  const wheelAnchor = await page.evaluate((x) => {
    const root = document.querySelector("#tracks");
    const ruler = root.querySelector(".ruler-row .ruler");
    const pixelsPerSecond = parseFloat(root.querySelectorAll(".ruler-mark")[1].style.left) / 2;
    return (x - ruler.getBoundingClientRect().left) / pixelsPerSecond;
  }, zoomAnchor.x);
  assert.ok(Math.abs(wheelAnchor - sliderAnchor.time) < 0.04, JSON.stringify({ sliderAnchor, wheelAnchor }));
  await page.locator("#timeline-zoom").evaluate((input) => {
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector("#timeline-zoom").getAttribute("aria-valuetext") === "2 像素／秒");
  assert.ok((await page.locator(".ruler-row .ruler-mark").count()) <= 2, "bar labels overlap in the overview zoom");
  await page.locator("#tab-device").click();
  await page.evaluate(async () => {
    const { workspace, project } = window.__daw;
    const device = project.tracks.flatMap((track) => track.devices)[0];
    window.rackHost = { id: device.id, host: workspace.host(device.id) };
    workspace.seek(0);
    await workspace.play();
  });
  const rack = page.getByRole("region", { name: "效果鏈" });
  await rack.getByRole("button", { name: "加入 Filter" }).click();
  await rack.getByRole("button", { name: "加入 Delay" }).click();
  await rack.getByRole("combobox", { name: "Filter 模式" }).selectOption("highpass");
  const cutoff = rack.getByRole("slider", { name: "Filter 頻率" });
  const spectrum = rack.getByRole("img", { name: "效果鏈輸出頻譜" });
  assert.ok((await spectrum.locator(".ar-frequency-curve").getAttribute("d"))?.startsWith("M"));
  const response = rack.getByRole("group", { name: "Filter 頻率響應" });
  const curve = response.locator(".ar-frequency-curve");
  const initialCurve = await curve.getAttribute("d");
  const handle = response.getByRole("button", { name: "截止頻率" });
  await handle.press("ArrowRight");
  assert.notEqual(await curve.getAttribute("d"), initialCurve);
  assert.notEqual(await cutoff.getAttribute("aria-valuetext"), "1200 Hz");
  await cutoff.press("Home");
  assert.equal(await cutoff.getAttribute("aria-valuetext"), "20 Hz");
  const filterBypass = rack.getByRole("button", { name: "Filter 旁通" });
  await filterBypass.click();
  assert.equal(await filterBypass.getAttribute("aria-pressed"), "true");
  await rack.getByRole("button", { name: "Delay 往前" }).click();
  const slotTypes = () => rack.locator(".effect-slot").evaluateAll((slots) => slots.map((slot) => slot.dataset.effectType));
  assert.deepEqual(await slotTypes(), ["delay", "filter"]);
  await rack.getByRole("button", { name: "移除 Delay" }).click();
  assert.deepEqual(await slotTypes(), ["filter"]);
  assert.equal(await cutoff.getAttribute("aria-valuetext"), "20 Hz");
  await rack.getByRole("button", { name: "加入 EQ" }).click();
  assert.deepEqual(await slotTypes(), ["filter", "eq"]);
  const eq = rack.getByRole("group", { name: "EQ 頻率響應" });
  assert.equal(await eq.locator(".ar-eq-band").count(), 3);
  const eqCurve = eq.locator(".ar-frequency-curve");
  const flat = await eqCurve.getAttribute("d");
  const mid = eq.getByRole("button", { name: "中頻", exact: true });
  await mid.press("ArrowUp");
  assert.notEqual(await eqCurve.getAttribute("d"), flat);
  await rack.getByRole("button", { name: "EQ 旁通" }).click();
  assert.equal(await eqCurve.getAttribute("d"), flat);
  await rack.getByRole("button", { name: "EQ 往前" }).click();
  assert.deepEqual(await slotTypes(), ["eq", "filter"]);
  const keptRackTransport = await page.evaluate(() => {
    const workspace = window.__daw.workspace;
    const { id, host } = window.rackHost;
    const kept = workspace.clock.state.value === "playing" && !!host && workspace.host(id) === host;
    workspace.stop();
    return kept;
  });
  assert.equal(keptRackTransport, true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      playback,
      monitored,
      state,
      audioPause,
      runtime,
      tempoRuntime,
      zoom: { sliderAnchor, wheelAnchor },
      reopenedTracks: 8,
      addedTracks: 2,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
