import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ configFile: false, root, server: { host: "127.0.0.1", port: 18774, strictPort: true } });
let browser;
const pageErrors = [];

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  for (let at = 0; at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50; ) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extraLength;
    assert.ok(start + size <= bytes.length, `ZIP entry ${name} is truncated`);
    entries.set(name, bytes.subarray(start, start + size));
    at = start + size;
  }
  return entries;
}

function wavPeak(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "RIFF");
  let peak = 0;
  for (let at = 44; at + 4 <= bytes.length; at += 4) peak = Math.max(peak, Math.abs(view.getFloat32(at, true)));
  return peak;
}

try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const freshPage = async () => {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.addInitScript(() => {
      window.showSaveFilePicker = undefined;
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("http://127.0.0.1:18774/");
    await page.waitForFunction(() => window.__daw?.workspace?.host(window.__daw.project.tracks[0].devices[0].id));
    return page;
  };

  const page = await freshPage();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#new").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "空白工程已就緒");
  assert.equal(await page.locator("#tracks > section").count(), 0);
  assert.equal(await page.evaluate(() => window.__daw.project.tracks.length), 0);
  assert.equal(await page.locator(".studio").getAttribute("data-browser-open"), "true");

  await page.locator("#add-midi").click();
  await page.waitForFunction(
    () => window.__daw.project.tracks[0]?.devices.length === 1 && window.__daw.workspace.host(window.__daw.project.tracks[0].devices[0].id),
  );
  await page.evaluate(() => {
    const input = new EventTarget();
    input.name = "Reference MIDI";
    window.__referenceMidi = input;
    Object.defineProperty(navigator, "requestMIDIAccess", {
      configurable: true,
      value: async () => ({ inputs: { forEach: (visit) => visit(input) } }),
    });
  });
  await page.locator("#record-midi").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("並監聽音源"));
  await page.locator("#new").click();
  assert.match(await page.locator("#status").innerText(), /請先結束錄製/);
  assert.equal(await page.evaluate(() => window.__daw.project.tracks.length), 1);
  await page.evaluate(async () => {
    const send = (data) => {
      const event = new Event("midimessage");
      Object.defineProperty(event, "data", { value: new Uint8Array(data) });
      window.__referenceMidi.dispatchEvent(event);
    };
    send([0x90, 60, 115]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    send([0x80, 60, 0]);
  });
  await page.locator("#record-midi").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("MIDI take：1 個音符"));
  assert.equal(await page.locator(".clip.midi").count(), 1);
  await page.locator(".clip.midi").click();
  const recordedNote = await page.evaluate(() => window.__daw.project.tracks[0].clips[0].sequence.getState().notes[0]);
  await page.locator(`.ar-pr-note[data-note-id="${recordedNote.id}"]`).click();
  await page.locator('#editor-panel input[aria-label="音高"]').fill("64");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].clips[0].sequence.getState().notes[0].pitch), 64);

  await page.locator("#add-audio").click();
  await page.locator("#record-audio").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("正在錄製麥克風"));
  await page.waitForTimeout(1100);
  await page.locator("#record-audio").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("音訊 take："));
  assert.equal(await page.locator(".clip.audio").count(), 1);
  const audioFrames = await page.evaluate(() => window.__daw.project.tracks[1].clips[0].frameCount);
  assert.ok(audioFrames > 24_000, `audio take was too short: ${audioFrames}`);
  const scale = await page.locator("#timeline-zoom").inputValue();
  await page.waitForFunction(() => Number(document.querySelector(".clip.audio canvas")?.dataset.framesPerPeak) >= 100);
  const coarse = await page.locator(".clip.audio canvas").getAttribute("data-frames-per-peak");
  const overview = page.getByRole("slider", { name: "編曲視窗" });
  await page.locator("#timeline-zoom").fill("800");
  await page.waitForFunction(() => parseFloat(document.querySelector(".clip.audio").style.width) > 240);
  await overview.press("Home");
  await page.waitForFunction(() => {
    const bin = Number(document.querySelector(".clip.audio canvas")?.dataset.framesPerPeak);
    return bin > 0 && bin < 64;
  });
  const fine = await page.locator(".clip.audio canvas").getAttribute("data-frames-per-peak");
  assert.ok(Number(fine) < Number(coarse));
  await page.locator("#timeline-zoom").fill(scale);
  await page.waitForFunction(() => parseFloat(document.querySelector(".clip.audio").style.width) < 240);
  await overview.press("Home");
  await page.waitForFunction(() => Number(document.querySelector(".clip.audio canvas")?.dataset.framesPerPeak) >= 100);
  await page.locator(".clip.audio").click();
  await page.evaluate(() => window.__daw.workspace.seek(0.5));
  await page.locator("#split").click();
  assert.equal(await page.locator(".clip.audio").count(), 2);
  await page.locator("#undo").click();
  assert.equal(await page.locator(".clip.audio").count(), 1);
  await page.locator("#redo").click();
  assert.equal(await page.locator(".clip.audio").count(), 2);

  await page.locator("#tab-mixer").click();
  await page.locator('.mixer-strip input[aria-label="MIDI 1 mixer 音量"]').fill("0.6");
  await page.locator('.mixer-strip input[aria-label="Audio 2 pan"]').fill("-0.25");
  await page.getByRole("slider", { name: "Master 音量" }).fill("0.3");
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[0].volume), 0.6);
  assert.equal(await page.evaluate(() => window.__daw.project.tracks[1].pan), -0.25);
  const readCurve = (page) => page.evaluate(() => window.__daw.project.tracks[1].volumeAutomation);
  await page.locator("#tab-automation").click();
  const graph = await page.locator(".ar-automation-graph").boundingBox();
  assert.ok(graph);
  await page.mouse.move(graph.x + graph.width * 0.45, graph.y + graph.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(graph.x + graph.width * 0.5, graph.y + graph.height * 0.95, { steps: 8 });
  assert.deepEqual(await readCurve(page), [], "drag preview must keep the Project unchanged");
  await page.mouse.up();
  const curve = await readCurve(page);
  assert.equal(curve.length, 2);
  assert.equal(curve[0].value, 1);
  assert.ok(curve[1].value < 0.15);
  await page.locator("#undo").click();
  assert.deepEqual(await readCurve(page), []);
  await page.locator("#redo").click();
  assert.deepEqual(await readCurve(page), curve);
  await page.getByRole("combobox", { name: "插值" }).selectOption("hold");
  assert.equal((await readCurve(page))[0].shape, "hold");
  const before = await page.evaluate(() => ({
    title: window.__daw.project.title,
    bpm: window.__daw.project.bpm,
    masterVolume: window.__daw.project.masterVolume,
    tracks: window.__daw.project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      clips: track.clips.length,
      volume: track.volume,
      pan: track.pan,
      automation: track.volumeAutomation,
      notes: track.kind === "midi" ? track.clips[0].sequence.getState().notes.map(({ pitch, velocity }) => ({ pitch, velocity })) : [],
      frames: track.kind === "audio" ? track.clips.reduce((sum, clip) => sum + clip.frameCount, 0) : 0,
    })),
  }));
  assert.equal(before.tracks[1].frames, audioFrames);
  assert.equal(before.masterVolume, 0.3);
  const saved = page.waitForEvent("download");
  await page.locator("#save").click();
  const projectFile = await saved;
  const projectBytes = await readFile(await projectFile.path());
  assert.ok(zipEntries(projectBytes).has("project.xml"));
  await page.close();

  const reopened = await freshPage();
  await reopened.locator("#open-file").setInputFiles({ name: "reference-song.dawproject", mimeType: "application/zip", buffer: projectBytes });
  await reopened.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("已開啟"));
  const after = await reopened.evaluate(() => ({
    title: window.__daw.project.title,
    bpm: window.__daw.project.bpm,
    masterVolume: window.__daw.project.masterVolume,
    tracks: window.__daw.project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      clips: track.clips.length,
      volume: track.volume,
      pan: track.pan,
      automation: track.volumeAutomation,
      notes: track.kind === "midi" ? track.clips[0].sequence.getState().notes.map(({ pitch, velocity }) => ({ pitch, velocity })) : [],
      frames: track.kind === "audio" ? track.clips.reduce((sum, clip) => sum + clip.frameCount, 0) : 0,
    })),
  }));
  assert.deepEqual(after, before);
  assert.equal(await reopened.locator("#undo").isDisabled(), true);
  assert.equal(await reopened.locator("#tracks > section").count(), 2);

  const exportDownload = reopened.waitForEvent("download", { timeout: 60_000 });
  await reopened.locator("#export-audio").click();
  const audioFile = await exportDownload;
  const audioEntries = zipEntries(await readFile(await audioFile.path()));
  assert.deepEqual([...audioEntries.keys()], ["mix.wav", ...after.tracks.map((track) => `tracks/${track.id}.wav`), "manifest.json"]);
  const mixPeak = wavPeak(audioEntries.get("mix.wav"));
  const midiPeak = wavPeak(audioEntries.get(`tracks/${after.tracks[0].id}.wav`));
  const audioPeak = wavPeak(audioEntries.get(`tracks/${after.tracks[1].id}.wav`));
  assert.ok(mixPeak > 0.001 && midiPeak > 0.001 && audioPeak > 0.001, `silent export: ${JSON.stringify({ mixPeak, midiPeak, audioPeak })}`);
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify(
      {
        result: "reference song passed",
        recordedMidiNotes: 1,
        recordedAudioFrames: audioFrames,
        reopenedTracks: after.tracks.length,
        mixPeak,
        midiPeak,
        audioPeak,
        unsupported: ["ongoing take recovery"],
        waveformFramesPerPeak: { coarse: Number(coarse), fine: Number(fine) },
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
