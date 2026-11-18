import {
  Project,
  Workspace,
  createOpfsAudioMediaWriter,
  type AudioMedia,
  type AudioMediaWriter,
  type MidiClip,
  type ProjectTrack,
  type TakeAnchor,
} from "@audiorective/workspace";
import { StudioView } from "./studio-view";
import { MidiRecorder } from "@audiorective/midi/web";
import { AudioRecorder } from "@audiorective/blocks";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const context = new AudioContext({ latencyHint: "interactive" });
const options = { destination: context.destination, workletUrl: new URL("../../packages/host/dist/webclap-worklet.js", import.meta.url).href };
const synthBundle = "/plugin/oxo-synth2.wclap";
const addDefaultSynth = (project: Project, trackId: string) =>
  project.addWebClapDevice(trackId, {
    pluginId: "com.oxo.music.oxosynth2",
    name: "Oxo Synth2",
    vendor: "chab (Oxo Music)",
    version: "1.1.1",
    bundleUrl: synthBundle,
  });
let workspace: Workspace;
let studio: StudioView;
let fallbackAbort: AbortController | undefined;
const ownedMedia = new Set<AudioMedia>();
let looping = false;
let loopClipId: string | undefined;
let midiRecording:
  | { recorder: MidiRecorder; input: MIDIInput; monitor: (event: MIDIMessageEvent) => void; trackId: string; anchor: TakeAnchor; latency: number }
  | undefined;
let audioRecording:
  | {
      recorder: AudioRecorder;
      writer: AudioMediaWriter;
      source: MediaStreamAudioSourceNode;
      stream: MediaStream;
      trackId: string;
      anchor: TakeAnchor;
      latency: number;
    }
  | undefined;

function log(message: string): void {
  $("log").textContent = `${new Date().toLocaleTimeString()}  ${message}\n${$("log").textContent?.slice(0, 2500) ?? ""}`;
}
function status(message: string): void {
  $("status").textContent = message;
  log(message);
}
function handleError(error: unknown): void {
  status(error instanceof Error ? error.message : String(error));
}
function inputLatency(): number {
  const milliseconds = Number($<HTMLInputElement>("record-latency").value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 500) throw new RangeError("錄音輸入補償需介於 0–500 ms。");
  return milliseconds / 1000;
}

function rhythm(): Float32Array {
  const sampleRate = 48_000;
  const pcm = new Float32Array(sampleRate * 4);
  let seed = 123456789;
  for (let step = 0; step < 16; step++) {
    const start = Math.round(step * 0.25 * sampleRate);
    const kick = step % 4 === 0;
    const snare = step % 8 === 4;
    for (let i = 0; i < 0.12 * sampleRate; i++) {
      const t = i / sampleRate;
      seed = (1664525 * seed + 1013904223) >>> 0;
      const noise = (seed / 2 ** 32) * 2 - 1;
      pcm[start + i] += kick
        ? Math.sin(2 * Math.PI * (82 - 45 * t) * t) * Math.exp(-30 * t) * 0.5
        : snare
          ? noise * Math.exp(-35 * t) * 0.12
          : noise * Math.exp(-75 * t) * 0.035;
    }
  }
  return pcm;
}

function hats(): Float32Array {
  const sampleRate = 48_000,
    pcm = new Float32Array(sampleRate * 4);
  let seed = 51941;
  for (let step = 0; step < 32; step++) {
    const start = Math.round(step * 0.125 * sampleRate);
    for (let i = 0; i < 0.055 * sampleRate; i++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const noise = ((seed / 2 ** 32) * 2 - 1) * Math.exp((-95 * i) / sampleRate) * (step % 2 ? 0.026 : 0.045);
      pcm[start + i] += noise;
    }
  }
  return pcm;
}

function percussion(): Float32Array {
  const sampleRate = 48_000,
    pcm = new Float32Array(sampleRate * 4);
  for (const startTime of [0.5, 1.5, 2.75, 3.25]) {
    const start = Math.round(startTime * sampleRate);
    for (let i = 0; i < 0.18 * sampleRate; i++) {
      const t = i / sampleRate;
      pcm[start + i] += Math.sin(2 * Math.PI * (210 - 90 * t) * t) * Math.exp(-30 * t) * 0.17;
    }
  }
  return pcm;
}

function pad(root: number): Float32Array {
  const sampleRate = 48_000,
    pcm = new Float32Array(sampleRate * 4);
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.28, (4 - t) / 0.35);
    const tones = [root, root + 4, root + 7].reduce((sum, pitch) => {
      const frequency = 440 * 2 ** ((pitch - 69) / 12);
      return sum + Math.sin(2 * Math.PI * frequency * t) + 0.15 * Math.sin(2 * Math.PI * frequency * 2.01 * t);
    }, 0);
    pcm[i] = tones * envelope * 0.016;
  }
  return pcm;
}

function transition(): Float32Array {
  const sampleRate = 48_000,
    pcm = new Float32Array(sampleRate * 0.8);
  let seed = 9913;
  for (let i = 0; i < pcm.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const t = i / pcm.length,
      noise = (seed / 2 ** 32) * 2 - 1;
    pcm[i] = noise * t * t * 0.055 + Math.sin((2 * Math.PI * (110 + 380 * t) * i) / sampleRate) * t * 0.05;
  }
  return pcm;
}

function demoProject(): Project {
  const project = new Project({ title: "Audiorective Session", bpm: 120, signature: [4, 4] });
  project.setMarkers([
    { time: 0, name: "Intro" },
    { time: 4, name: "Verse" },
    { time: 8, name: "Chorus" },
    { time: 12, name: "Outro" },
  ]);
  const sections = [0, 4, 8, 12];
  const instrument = (trackId: string) => addDefaultSynth(project, trackId);
  const audioClips = (trackId: string, samples: Float32Array, times: readonly number[]) =>
    times.forEach((time) => project.addAudioClip(trackId, { sampleRate: 48_000, channels: [samples] }, time));

  const keys = project.addTrack("Keys", "midi", { volume: 0.48 });
  sections.forEach((time, section) => {
    const pitches = [60, 64, 67, 72, 67].map((pitch) => pitch + [0, 2, 5, 0][section]);
    project.addMidiClip(
      keys.id,
      {
        duration: 4,
        notes: pitches.map((pitch, index) => ({
          id: `keys${section}_${index}`,
          start: [0.25, 0.75, 1.25, 1.75, 2.5][index],
          end: [0.6, 1.1, 1.6, 2.1, 3.4][index],
          pitch,
          velocity: [110, 105, 105, 115, 100][index],
          channel: 0,
          track: 0,
        })),
      },
      time,
    );
  });
  instrument(keys.id);

  const drums = project.addTrack("Drums", "audio", { volume: 0.52 });
  audioClips(drums.id, rhythm(), sections);
  const hatTrack = project.addTrack("Hats", "audio", { volume: 0.43 });
  audioClips(hatTrack.id, hats(), [4, 8, 12]);
  const percTrack = project.addTrack("Percussion", "audio", { volume: 0.38 });
  audioClips(percTrack.id, percussion(), [4, 8, 12]);

  const bass = project.addTrack("Bass", "midi", { volume: 0.35 });
  [4, 8, 12].forEach((time, section) => {
    const root = [36, 41, 43][section];
    project.addMidiClip(
      bass.id,
      {
        duration: 4,
        notes: [0, 1, 2, 3].map((index) => ({
          id: `bass${section}_${index}`,
          start: index,
          end: index + 0.8,
          pitch: root + (index === 2 ? 7 : 0),
          velocity: 90,
          channel: 0,
          track: 0,
        })),
      },
      time,
    );
  });
  instrument(bass.id);

  const padTrack = project.addTrack("Atmosphere", "audio", { volume: 0.26 });
  sections.forEach((time, index) => audioClips(padTrack.id, pad([48, 50, 53, 55][index]), [time]));

  const lead = project.addTrack("Lead", "midi", { volume: 0.32 });
  [8, 12].forEach((time, section) =>
    project.addMidiClip(
      lead.id,
      {
        duration: 4,
        notes: [72, 76, 79, 84, 79].map((pitch, index) => ({
          id: `lead${section}_${index}`,
          start: index * 0.65,
          end: index * 0.65 + 0.47,
          pitch: pitch - section * 2,
          velocity: 98,
          channel: 0,
          track: 0,
        })),
      },
      time,
    ),
  );
  instrument(lead.id);

  const fx = project.addTrack("Transitions", "audio", { volume: 0.45 });
  audioClips(fx.id, transition(), [3.2, 7.2, 11.2]);
  return project;
}

function addNote(clip: MidiClip, placement?: { start: number; pitch: number }): string {
  const state = clip.sequence.getState();
  const map = workspace.project.tempoMap;
  const position = clip.timeUnit === "beats" ? map.secondsToBeat(workspace.position) : workspace.position;
  const proposedStart = placement?.start ?? (clip.timeUnit === "beats"
    ? Math.max(0, Math.floor(Math.max(clip.time, position)) - clip.time)
    : Math.max(0, map.beatToSeconds(Math.floor(map.secondsToBeat(Math.max(clip.time, position)))) - clip.time));
  const start = Math.max(0, Math.min(Math.max(0, state.duration - 0.01), proposedStart));
  const beatAtNote = clip.timeUnit === "beats" ? clip.time + start : map.secondsToBeat(clip.time + start);
  const length = Math.min(state.duration - start, clip.timeUnit === "beats" ? 1 : map.beatToSeconds(beatAtNote + 1) - (clip.time + start));
  const pitch = placement?.pitch ?? state.notes[Math.floor(state.notes.length / 2)]?.pitch ?? 60;
  const note = { id: `note${crypto.randomUUID().replace(/-/g, "")}`, start, end: start + length, pitch, velocity: 100, channel: 0, track: 0 };
  clip.sequence.setData({ duration: state.duration, notes: [...state.notes, note] });
  status(`已新增 ${pitch} 音符 · ${start.toFixed(2)} ${clip.timeUnit === "beats" ? "拍" : "s"}`);
  return note.id;
}

async function addSynth(track: ProjectTrack): Promise<void> {
  addDefaultSynth(workspace.project, track.id);
  await workspace.commit();
  renderTracks();
  status("已加入 Oxo Synth2");
}

async function uploadAudio(trackId: string, file: File): Promise<void> {
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => new Float32Array(decoded.getChannelData(index)));
  studio.recordClipEdit("匯入音訊", () => workspace.project.addAudioClip(trackId, { sampleRate: decoded.sampleRate, channels }, workspace.position));
  await workspace.commit();
  renderTracks();
  status(`已加入音訊 ${file.name}`);
}

function renderTracks(): void {
  studio.render();
}

async function save(): Promise<void> {
  const hasMedia = workspace.project.tracks.some((track) => track.clips.some((clip) => clip.kind === "audio" && !!clip.media));
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
    }
  ).showSaveFilePicker;
  if (hasMedia && picker) {
    const file = await picker({ suggestedName: "audiorective-daw.dawproject" });
    await workspace.saveTo(await file.createWritable());
    status(`已串流儲存 ${workspace.project.tracks.length} 軌 · 插件音色需收件者安裝相同 CLAP；可另匯出音訊`);
    return;
  }
  let archive: Blob;
  if (hasMedia) {
    const parts: Uint8Array[] = [];
    await workspace.saveTo(
      new WritableStream({
        write: (chunk) => {
          parts.push(chunk);
        },
      }),
    );
    archive = new Blob(parts as BlobPart[], { type: "application/zip" });
  } else {
    const bytes = await workspace.save();
    archive = new Blob([new Uint8Array(bytes).buffer], { type: "application/zip" });
  }
  const url = URL.createObjectURL(archive);
  const link = document.createElement("a");
  link.href = url;
  link.download = "audiorective-daw.dawproject";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  status(`已儲存 ${workspace.project.tracks.length} 軌 · ${archive.size} bytes · 插件音色需收件者安裝相同 CLAP；可另匯出音訊`);
}

async function exportAudioFallback(): Promise<void> {
  if (fallbackAbort) {
    fallbackAbort.abort();
    return;
  }
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
    }
  ).showSaveFilePicker;
  // Acquire the file handle while the click still counts as a user gesture.
  const file = picker ? await picker({ suggestedName: "audiorective-audio.zip" }) : undefined;
  const controller = new AbortController();
  fallbackAbort = controller;
  const button = $<HTMLButtonElement>("export-audio");
  $<HTMLButtonElement>("open").disabled = true;
  $<HTMLButtonElement>("new").disabled = true;
  button.textContent = "取消匯出";
  try {
    const parts: Uint8Array[] = [];
    const destination = file
      ? await file.createWritable()
      : new WritableStream<Uint8Array>({
          write: (chunk) => {
            parts.push(chunk);
          },
        });
    await workspace.exportAudioFallbackTo(destination, {
      signal: controller.signal,
      onProgress: (fraction) => status(`正在即時匯出音訊 ${Math.round(fraction * 100)}%`),
    });
    if (!file) {
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "audiorective-audio.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    status(
      workspace.project.tracks.length > 15
        ? "已匯出混音 WAV；超過 15 軌的工程暫不含各軌 WAV"
        : `已匯出混音與 ${workspace.project.tracks.length} 軌 WAV`,
    );
  } finally {
    fallbackAbort = undefined;
    $<HTMLButtonElement>("open").disabled = false;
    $<HTMLButtonElement>("new").disabled = false;
    button.textContent = "匯出音訊";
  }
}

function canReplaceProject(): boolean {
  if (fallbackAbort || midiRecording || audioRecording) {
    status("請先結束錄製或音訊匯出，再切換工程。");
    return false;
  }
  return true;
}

async function replaceProject(next: Workspace): Promise<void> {
  const previous = workspace;
  studio.resetProject();
  workspace = next;
  looping = false;
  loopClipId = undefined;
  studio.setLoopTarget(undefined);
  $("loop").classList.remove("on");
  $("loop").setAttribute("aria-pressed", "false");
  $("loop").title = "循環";
  previous.destroy();
  previous.project.destroy();
  await Promise.all([...ownedMedia].map((media) => media.dispose()));
  ownedMedia.clear();
  renderTracks();
}

async function open(file: File): Promise<void> {
  if (!canReplaceProject()) return;
  const next = await Workspace.openBlob(context, file, options);
  if (!canReplaceProject()) {
    next.destroy();
    next.project.destroy();
    return;
  }
  await replaceProject(next);
  status(
    `已開啟 ${workspace.project.title} · ${workspace.project.tracks.length} 軌${workspace.warnings.length ? ` · ${workspace.warnings.join(" ")}` : ""}`,
  );
}

async function newProject(): Promise<void> {
  if (!canReplaceProject() || !confirm("建立空白工程？尚未儲存的變更會遺失。")) return;
  const next = await Workspace.create(context, new Project({ title: "Untitled", bpm: 120, signature: [4, 4] }), options);
  if (!canReplaceProject()) {
    next.destroy();
    next.project.destroy();
    return;
  }
  await replaceProject(next);
  document.querySelector<HTMLElement>(".studio")!.dataset.browserOpen = "true";
  $("toggle-browser").setAttribute("aria-pressed", "true");
  status("空白工程已就緒");
}

async function recordMidi(): Promise<void> {
  if (midiRecording) {
    const { recorder, input, monitor, trackId, anchor, latency } = midiRecording;
    midiRecording = undefined;
    input.removeEventListener("midimessage", monitor);
    let take;
    try {
      take = recorder.stop();
    } finally {
      recorder.destroy();
      for (const device of workspace.project.tracks.find((item) => item.id === trackId)?.devices ?? []) workspace.host(device.id)?.panic();
      $("record-midi").textContent = "錄 MIDI";
    }
    studio.recordClipEdit("錄製 MIDI", () => workspace.project.addMidiTake(trackId, take, workspace.takePosition(anchor, take, latency), { timeUnit: "beats" }));
    await workspace.commit();
    renderTracks();
    status(`MIDI take：${take.notes.length} 個音符`);
    return;
  }
  const latency = inputLatency();
  if (!navigator.requestMIDIAccess) throw new Error("此瀏覽器不支援 Web MIDI。");
  const access = await navigator.requestMIDIAccess();
  let input: MIDIInput | undefined;
  access.inputs.forEach((candidate) => {
    input ??= candidate;
  });
  if (!input) throw new Error("沒有可用的 MIDI 輸入裝置。");
  await context.resume();
  const track =
    workspace.project.tracks.find((item) => item.id === studio.selectedTrackId && item.kind === "midi") ??
    workspace.project.tracks.find((item) => item.kind === "midi") ??
    workspace.project.addTrack("Recorded MIDI", "midi");
  const recorder = new MidiRecorder(context, input);
  const deviceId = track.devices[0]?.id;
  const monitor = (event: MIDIMessageEvent) => {
    if (event.data && deviceId) workspace.host(deviceId)?.scheduleMidi(event.data, context.currentTime);
  };
  const anchor = workspace.takeAnchor(recorder.start());
  input.addEventListener("midimessage", monitor);
  midiRecording = { recorder, input, monitor, trackId: track.id, anchor, latency };
  $("record-midi").textContent = "停止 MIDI 錄製";
  status(`正在從 ${input.name ?? "MIDI input"} 錄製${deviceId ? "並監聽音源" : "（軌道尚無音源）"}…`);
}

async function recordAudio(): Promise<void> {
  if (audioRecording) {
    const { recorder, writer, source, stream, trackId, anchor, latency } = audioRecording;
    audioRecording = undefined;
    try {
      const take = await recorder.stopStream();
      const media = await writer.finish(take);
      try {
        studio.recordClipEdit("錄製音訊", () => workspace.project.addAudioMediaClip(trackId, media, workspace.takePosition(anchor, take, latency)));
      } catch (error) {
        await media.dispose();
        throw error;
      }
      ownedMedia.add(media);
      await workspace.commit();
      renderTracks();
      const lostFrames = take.dropouts?.reduce((sum, gap) => sum + gap.endFrame - gap.startFrame, 0) ?? 0;
      status(
        `音訊 take：${(take.endTime - take.startTime).toFixed(2)} 秒${lostFrames ? ` · 錄音中斷 ${(lostFrames / take.sampleRate).toFixed(3)} 秒，請檢查後重錄` : ""}`,
      );
    } finally {
      await writer.abort().catch(() => undefined);
      source.disconnect();
      recorder.destroy();
      stream.getTracks().forEach((track) => track.stop());
      $("record-audio").textContent = "錄麥克風";
    }
    return;
  }
  const latency = inputLatency();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let source: MediaStreamAudioSourceNode | undefined;
  let recorder: AudioRecorder | undefined;
  let writer: AudioMediaWriter | undefined;
  try {
    await context.resume();
    source = context.createMediaStreamSource(stream);
    recorder = new AudioRecorder(context, { channels: 1 });
    writer = await createOpfsAudioMediaWriter(context.sampleRate, 1);
    source.connect(recorder.input);
    const anchor = workspace.takeAnchor();
    const activeWriter = writer;
    await recorder.startStream((chunk) => activeWriter.writeChunk(chunk));
    const track =
      workspace.project.tracks.find((item) => item.id === studio.selectedTrackId && item.kind === "audio") ??
      workspace.project.tracks.find((item) => item.kind === "audio") ??
      workspace.project.addTrack("Recorded audio", "audio");
    audioRecording = { recorder, writer, source, stream, trackId: track.id, anchor, latency };
    $("record-audio").textContent = "停止音訊錄製";
    status("正在錄製麥克風…");
  } catch (error) {
    recorder?.cancel();
    await writer?.abort().catch(() => undefined);
    source?.disconnect();
    recorder?.destroy();
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

$("play").addEventListener("click", () =>
  workspace
    .play()
    .then(() => status("播放中"))
    .catch(handleError),
);
$("pause").addEventListener("click", () => {
  workspace.pause();
  status("已暫停");
});
$("stop").addEventListener("click", () => {
  workspace.stop();
  status("已停止");
});
$("loop").addEventListener("click", () => {
  looping = !looping;
  loopClipId = looping ? studio.selectedClipId : undefined;
  studio.setLoopTarget(looping ? (loopClipId ?? null) : undefined);
  $("loop").classList.toggle("on", looping);
  $("loop").setAttribute("aria-pressed", String(looping));
  const loopClip = loopClipId ? workspace.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === loopClipId) : undefined;
  const start = loopClip?.time ?? 0;
  const end = loopClip ? loopClip.time + loopClip.duration : workspace.duration;
  $("loop").title = looping ? `循環 ${start.toFixed(1)}–${end.toFixed(1)} 秒` : "循環";
  status(looping ? `循環 ${start.toFixed(1)}–${end.toFixed(1)} 秒` : "已關閉循環");
});
$("save").addEventListener("click", () => save().catch(handleError));
$("export-audio").addEventListener("click", () =>
  exportAudioFallback().catch((error) => {
    if (error instanceof DOMException && error.name === "AbortError") status("已取消音訊匯出");
    else handleError(error);
  }),
);
$("portability").addEventListener("click", () => {
  const report = workspace.portabilityReport();
  $("portability-details").textContent =
    `標準資料：${report.standardContent.join("、")}。${report.pluginDependencies.length ? `插件依賴：${report.pluginDependencies.join("；")}。` : ""}${report.limitations.join(" ")}`;
  $<HTMLDialogElement>("portability-dialog").showModal();
});
$("open").addEventListener("click", () => $<HTMLInputElement>("open-file").click());
$("new").addEventListener("click", () => newProject().catch(handleError));
$<HTMLInputElement>("open-file").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  if (input.files?.[0]) open(input.files[0]).catch(handleError);
  input.value = "";
});
async function addMidiTrack(): Promise<void> {
  const track = workspace.project.addTrack(`MIDI ${workspace.project.tracks.length + 1}`, "midi");
  addDefaultSynth(workspace.project, track.id);
  await workspace.commit();
  studio.selectTrack(track.id);
  status("已新增 MIDI 軌 · Oxo Synth2 已就緒");
}
$("add-midi").addEventListener("click", () => addMidiTrack().catch(handleError));
$("new-midi-track").addEventListener("click", () => addMidiTrack().catch(handleError));
$("add-audio").addEventListener("click", async () => {
  workspace.project.addTrack(`Audio ${workspace.project.tracks.length + 1}`, "audio");
  await workspace.commit();
  studio.selectTrack(workspace.project.tracks.at(-1)!.id);
  status("已新增音訊軌");
});
$("record-midi").addEventListener("click", () => recordMidi().catch(handleError));
$("record-audio").addEventListener("click", () => recordAudio().catch(handleError));
$("browser-synth").addEventListener("click", () => {
  const track = workspace.project.tracks.find((item) => item.id === studio.selectedTrackId && item.kind === "midi");
  if (!track) {
    status("請先選取 MIDI 軌。");
    return;
  }
  addSynth(track).catch(handleError);
});
$("browser-import").addEventListener("click", () => {
  const track = workspace.project.tracks.find((item) => item.id === studio.selectedTrackId && item.kind === "audio");
  if (!track) {
    status("請先選取音訊軌。");
    return;
  }
  $<HTMLInputElement>("audio-file").click();
});
$<HTMLInputElement>("audio-file").addEventListener("change", (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const track = workspace.project.tracks.find((item) => item.id === studio.selectedTrackId && item.kind === "audio");
  if (input.files?.[0] && track) uploadAudio(track.id, input.files[0]).catch(handleError);
  input.value = "";
});
studio = new StudioView({ workspace: () => workspace, context, status, error: handleError, addNote });
const latencyInput = $<HTMLInputElement>("record-latency");
try {
  const saved = localStorage.getItem("audiorective-record-latency-ms");
  if (saved !== null && Number.isFinite(Number(saved)) && Number(saved) >= 0 && Number(saved) <= 500) latencyInput.value = saved;
} catch {
  /* Keep the session default. */
}
latencyInput.addEventListener("change", () => {
  try {
    inputLatency();
    localStorage.setItem("audiorective-record-latency-ms", latencyInput.value);
  } catch (error) {
    handleError(error);
  }
});
const skinSelect = $<HTMLSelectElement>("skin");
const skinNames = new Set(["midnight", "slate", "canvas", "orchid"]);
try {
  const saved = localStorage.getItem("audiorective-studio-skin");
  if (saved && skinNames.has(saved)) {
    skinSelect.value = saved;
    document.documentElement.dataset.skin = saved;
  }
} catch {
  /* Storage can be disabled by the browser. */
}
skinSelect.addEventListener("change", () => {
  if (!skinNames.has(skinSelect.value)) return;
  document.documentElement.dataset.skin = skinSelect.value;
  try {
    localStorage.setItem("audiorective-studio-skin", skinSelect.value);
  } catch {
    /* Use session-only skin. */
  }
});

function animate(): void {
  if (workspace) {
    const position = workspace.position;
    $("time").textContent = `${Math.floor(position / 60)}:${(position % 60).toFixed(1).padStart(4, "0")}`;
    studio.setPlayhead(position);
    if (workspace.clock.state.value === "playing") {
      const loopClip = loopClipId ? workspace.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === loopClipId) : undefined;
      if (loopClipId && !loopClip) {
        looping = false;
        loopClipId = undefined;
        studio.setLoopTarget(undefined);
        $("loop").classList.remove("on");
        $("loop").setAttribute("aria-pressed", "false");
        $("loop").title = "循環";
      }
      const loopStart = loopClip?.time ?? 0;
      const loopEnd = loopClip ? loopClip.time + loopClip.duration : workspace.duration;
      if (looping && loopEnd > loopStart && position >= loopEnd) workspace.seek(loopStart);
      else if (position >= workspace.duration) workspace.stop();
    }
  }
  requestAnimationFrame(animate);
}

Workspace.create(context, demoProject(), options)
  .then((created) => {
    workspace = created;
    studio.selectedTrackId = created.project.tracks[0]?.id;
    studio.selectedClipId = created.project.tracks[0]?.clips[0]?.id;
    renderTracks();
    animate();
    status(created.warnings.length ? `工程已載入，但有裝置問題：${created.warnings.join(" ")}` : "工程已就緒 · 試著播放、編輯、存檔並重開");
  })
  .catch(handleError);

window.addEventListener("pagehide", () => {
  if (midiRecording) {
    midiRecording.input.removeEventListener("midimessage", midiRecording.monitor);
    midiRecording.recorder.cancel();
    midiRecording.recorder.destroy();
  }
  if (audioRecording) {
    audioRecording.recorder.cancel();
    audioRecording.recorder.destroy();
    void audioRecording.writer.abort();
    audioRecording.source.disconnect();
    audioRecording.stream.getTracks().forEach((track) => track.stop());
  }
  studio.destroy();
  workspace?.destroy();
  workspace?.project.destroy();
  for (const media of ownedMedia) void media.dispose();
  void context.close();
});

Object.assign(window, {
  __daw: {
    get workspace() {
      return workspace;
    },
    get project() {
      return workspace?.project;
    },
  },
});
