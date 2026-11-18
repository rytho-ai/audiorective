import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";
import { unzipSync, zipSync, Unzip, UnzipInflate } from "fflate";
import type { MidiNote } from "@audiorective/midi";
import type { RackEffect, RackMacroSettings } from "@audiorective/blocks/effect-rack";
import type { WaveStretchAnchor } from "@audiorective/blocks";
import { MidiClip, Project, audioChannelCount, normalizeClipGainAutomation } from "./model";
import type { AudioClip, AudioClipGainAutomation, AudioClipSource, AudioClipStretch, ProjectMidiEvent, ProjectTrack } from "./model";
import { decodeWav, encodeWav, mediaFromWav, wavMediaEntry } from "./wav";
import { writeStoredZip } from "./stored-zip";
import type { StoredZipEntry } from "./stored-zip";

type StoredEvent = { time: number; data: number[]; noteId?: string };
type StoredClip = {
  track: string;
  index: number;
  id: string;
  fingerprint: string;
  noteIds?: string[];
  events?: StoredEvent[];
  audioGain?: number;
  stretchRatio?: number;
  warpAnchors?: readonly WaveStretchAnchor[];
  gainAutomation?: AudioClipGainAutomation;
};
type PrivateState = { version: 1 | 2; clips: StoredClip[]; rackMacros?: Record<string, readonly RackMacroSettings[]> };
type HostManifest = { version: 1; devices: Record<string, { kind: "webclap"; bundleUrl: string }> };
type ControlPoint = { time: number; channel: number; controller: number; value: number };
type MediaEntry = { blob: Blob; header: Uint8Array };
type ArchiveEntries = Record<string, Uint8Array | MediaEntry>;
export type OpenDawProjectResult = Readonly<{ project: Project; warnings: readonly string[] }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const rackDevicePrefix = "audiorective.insert.";
const rackDeviceNames: Record<RackEffect["type"], string> = { filter: "Filter", delay: "Ping Pong Delay", eq: "Equalizer" };
const sourcePrefix = "audiorective/source/";
const isAudioPath = (path: string) => path.startsWith("audio/") || path.startsWith(sourcePrefix);

function append(parent: Element, name: string, attrs: Record<string, string | number | boolean> = {}): Element {
  const node = parent.ownerDocument!.createElement(name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
}

function direct(parent: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1 && (node as Element).tagName === name) out.push(node as Element);
  return out;
}

function one(parent: Element, name: string, required = true): Element | undefined {
  const children = direct(parent, name);
  if (children.length > 1 || (required && children.length !== 1)) throw new Error(`Project XML needs one ${name} element.`);
  return children[0];
}

function childrenOnly(parent: Element, names: readonly string[]): void {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && !names.includes((node as Element).tagName)) throw new Error(`Project XML has unsupported ${parent.tagName} content.`);
  }
}

function attributesOnly(element: Element, names: readonly string[]): void {
  for (let i = 0; i < element.attributes.length; i++) {
    if (!names.includes(element.attributes.item(i)!.name)) throw new Error(`Project XML has unsupported ${element.tagName} attributes.`);
  }
}

function attr(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (value === null) throw new Error(`Project XML needs ${name} on ${element.tagName}.`);
  return value;
}

function numberAttr(element: Element, name: string, minimum = 0): number {
  const text = attr(element, name);
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value < minimum) throw new Error(`Project XML has invalid ${name} on ${element.tagName}.`);
  return value;
}

function integerAttr(element: Element, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = numberAttr(element, name, minimum);
  if (!Number.isInteger(value) || value > maximum) throw new Error(`Project XML has invalid ${name} on ${element.tagName}.`);
  return value;
}

function parseXml(bytes: Uint8Array, rootName: string): Element {
  const xml = decoder.decode(bytes);
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(`Project XML is invalid: ${message}`);
    },
  }).parseFromString(xml, "application/xml");
  const root = document.documentElement!;
  if (!root || root.tagName !== rootName) throw new Error(`Project XML needs a ${rootName} root.`);
  return root;
}

/** A cheap change detector for sidecar alignment, not a security hash. */
function fingerprint(notes: readonly MidiNote[], controls: readonly ControlPoint[], time: number, duration: number, unit?: "seconds" | "beats"): string {
  const ordered = [...controls].sort((a, b) => a.time - b.time || a.channel - b.channel || a.controller - b.controller || a.value - b.value);
  const plain = JSON.stringify({
    time,
    duration,
    ...(unit ? { unit } : {}),
    notes: notes.map(({ start, end, pitch, velocity, channel }) => [start, end, pitch, velocity, channel]),
    controls: ordered,
  });
  let hash = 2166136261;
  for (let i = 0; i < plain.length; i++) hash = Math.imul(hash ^ plain.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function controlsFromEvents(events: readonly ProjectMidiEvent[]): ControlPoint[] {
  return events.flatMap(({ time, data }) => {
    if (data.length !== 3 || data[0] < 0x80 || data[0] >= 0xf0 || data[1] > 127 || data[2] > 127)
      throw new Error("Project MIDI has events outside supported portable content.");
    if ((data[0] & 0xf0) === 0x80 || (data[0] & 0xf0) === 0x90) return [];
    if ((data[0] & 0xf0) !== 0xb0) throw new Error("Project MIDI has events outside supported portable content.");
    return [{ time, channel: data[0] & 15, controller: data[1], value: data[2] }];
  });
}

function writeAudioSource(path: string, source: AudioClipSource, entries: Record<string, Uint8Array>, mediaEntries: Map<string, AudioClipSource>): void {
  if (source.media) mediaEntries.set(path, source);
  else entries[path] = encodeWav(source);
}

function readAudioSource(asset: Uint8Array | MediaEntry): AudioClipSource {
  if (asset instanceof Uint8Array) return decodeWav(asset);
  const media = mediaFromWav(asset.blob, asset.header);
  return { media, sampleRate: media.sampleRate, startFrame: 0, frameCount: media.frameCount };
}

function writeClip(
  clip: AudioClip | MidiClip,
  clips: Element,
  entries: Record<string, Uint8Array>,
  mediaEntries: Map<string, AudioClipSource>,
  state: PrivateState,
  track: ProjectTrack,
  index: number,
): void {
  const unit = clip.kind === "midi" ? clip.timeUnit : "seconds";
  const element = append(clips, "Clip", { time: clip.time, duration: clip.duration, contentTimeUnit: unit });
  if (clip.kind === "audio") {
    const path = `audio/${clip.id}.wav`;
    const { gain = 1, fadeIn = 0, fadeOut = 0 } = clip.envelope ?? {};
    if (fadeIn || fadeOut) {
      element.setAttribute("fadeTimeUnit", "seconds");
      if (fadeIn) element.setAttribute("fadeInTime", String(fadeIn));
      if (fadeOut) element.setAttribute("fadeOutTime", String(fadeOut));
    }
    const audio = append(element, "Audio", {
      id: `${clip.id}-audio`,
      timeUnit: "seconds",
      channels: audioChannelCount(clip),
      sampleRate: clip.sampleRate,
      duration: clip.duration,
    });
    append(audio, "File", { path });
    writeAudioSource(path, clip, entries, mediaEntries);
    if (clip.stretch) writeAudioSource(sourcePrefix + `${clip.id}.wav`, clip.stretch.source, entries, mediaEntries);
    state.clips.push({
      track: track.id,
      index,
      id: clip.id,
      fingerprint: clip.stretch || clip.gainAutomation || gain !== 1 ? path : "",
      ...(gain === 1 ? {} : { audioGain: gain }),
      ...(clip.stretch ? { stretchRatio: clip.stretch.ratio } : {}),
      ...(clip.stretch?.anchors?.length ? { warpAnchors: clip.stretch.anchors } : {}),
      ...(clip.gainAutomation ? { gainAutomation: clip.gainAutomation } : {}),
    });
    return;
  }
  const content = append(element, "Lanes", { id: `${clip.id}-content`, timeUnit: unit });
  const notes = clip.sequence.getState().notes;
  const notesNode = append(content, "Notes", { id: `${clip.id}-notes`, timeUnit: unit });
  for (const note of notes)
    append(notesNode, "Note", {
      time: note.start,
      duration: note.end - note.start,
      channel: note.channel,
      key: note.pitch,
      vel: note.velocity / 127,
    });
  const controls = controlsFromEvents(clip.events);
  const groups = new Map<string, ControlPoint[]>();
  for (const control of controls) {
    const key = `${control.channel}:${control.controller}`;
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  let groupIndex = 0;
  for (const group of groups.values()) {
    const points = append(content, "Points", { id: `${clip.id}-control${groupIndex++}`, timeUnit: unit });
    append(points, "Target", { expression: "channelController", channel: group[0].channel, controller: group[0].controller });
    for (const point of group) append(points, "IntegerPoint", { time: point.time, value: point.value });
  }
  state.clips.push({
    track: track.id,
    index,
    id: clip.id,
    fingerprint: fingerprint(notes, controls, clip.time, clip.duration, unit),
    noteIds: notes.map((note) => note.id),
    events: clip.events.map(({ time, data, noteId }) => ({ time, data: [...data], ...(noteId ? { noteId } : {}) })),
  });
}

function prepareDawProject(project: Project): { entries: Record<string, Uint8Array>; mediaEntries: Map<string, AudioClipSource> } {
  const document = new DOMImplementation().createDocument(null, "Project", null);
  const root = document.documentElement!;
  root.setAttribute("version", "1.0");
  append(root, "Application", { name: "Audiorective", version: "2.3.2" });
  const transport = append(root, "Transport");
  append(transport, "Tempo", { id: "transportTempo", unit: "bpm", value: project.bpm });
  append(transport, "TimeSignature", { id: "transportSignature", numerator: project.signature[0], denominator: project.signature[1] });
  const structure = append(root, "Structure");
  const entries: Record<string, Uint8Array> = {};
  const mediaEntries = new Map<string, AudioClipSource>();
  const manifest: HostManifest = { version: 1, devices: {} };
  let insertIndex = 0;
  for (const track of project.tracks) {
    const element = append(structure, "Track", { id: track.id, name: track.name, contentType: track.kind === "midi" ? "notes" : "audio" });
    const channel = append(element, "Channel", {
      id: `${track.id}-channel`,
      role: track.busRole ?? "regular",
      destination: track.routing.outputBusId === null ? "masterChannel" : `${track.routing.outputBusId}-channel`,
      solo: track.solo,
      audioChannels: track.kind === "audio" && track.clips[0]?.kind === "audio" ? audioChannelCount(track.clips[0]) : 2,
    });
    if (track.devices.length || track.effects.length) {
      const devices = append(channel, "Devices");
      for (const device of track.devices) {
        const plugin = append(devices, "ClapPlugin", {
          id: device.id,
          deviceID: device.pluginId,
          deviceName: device.name,
          deviceVendor: device.vendor,
          pluginVersion: device.version,
          deviceRole: track.kind === "midi" ? "instrument" : "audioFX",
          loaded: true,
        });
        if (device.state.length) {
          const path = `plugins/${device.id}.bin`;
          append(plugin, "State", { path });
          entries[path] = new Uint8Array(device.state);
        }
        manifest.devices[device.id] = { kind: "webclap", bundleUrl: device.bundleUrl };
      }
      for (const effect of track.effects) {
        const device = append(devices, "BuiltinDevice", {
          deviceID: rackDevicePrefix + effect.type,
          deviceName: rackDeviceNames[effect.type],
          deviceVendor: "Audiorective",
          deviceRole: "audioFX",
          loaded: true,
        });
        const path = `plugins/ar-insert-${++insertIndex}.json`;
        append(device, "State", { path });
        entries[path] = encoder.encode(JSON.stringify({ version: 1, effect }));
      }
    }
    append(channel, "Mute", { id: `${track.id}-mute`, value: track.muted });
    append(channel, "Pan", { id: `${track.id}-pan`, unit: "normalized", value: (track.pan + 1) / 2, min: 0, max: 1 });
    if (track.routing.sends.length) {
      const sends = append(channel, "Sends");
      for (const { busId, gain } of track.routing.sends) {
        const send = append(sends, "Send", { destination: `${busId}-channel`, type: "post" });
        append(send, "Volume", { unit: "linear", value: gain });
      }
    }
    append(channel, "Volume", { id: `${track.id}-volume`, unit: "linear", value: track.volume });
  }
  const master = append(structure, "Track", { id: "masterTrack", name: "Master", contentType: "audio" });
  const masterChannel = append(master, "Channel", { id: "masterChannel", role: "master", audioChannels: 2 });
  append(masterChannel, "Volume", { id: "masterVolume", unit: "linear", value: project.masterVolume });
  const arrangement = append(root, "Arrangement", { id: "arrangement" });
  const lanes = append(arrangement, "Lanes", { id: "projectLanes", timeUnit: "seconds" });
  const state: PrivateState = { version: 2, clips: [] };
  const racks = project.tracks.filter((track) => track.effectMacros.length);
  if (racks.length) state.rackMacros = Object.fromEntries(racks.map((track) => [track.id, track.effectMacros]));
  for (const track of project.tracks) {
    const lane = append(lanes, "Lanes", { id: `${track.id}-lane`, track: track.id, timeUnit: "seconds" });
    let index = 0;
    for (const unit of ["seconds", "beats"] as const) {
      const group = track.clips.filter((clip) => clip.kind === "audio" ? unit === "seconds" : clip.timeUnit === unit);
      if (!group.length && (unit === "beats" || track.clips.length)) continue;
      const clips = append(lane, "Clips", { id: `${track.id}-clips${unit === "beats" ? "-beats" : ""}`, timeUnit: unit });
      for (const clip of group) writeClip(clip, clips, entries, mediaEntries, state, track, index++);
    }
    if (track.volumeAutomation.length) {
      const points = append(lane, "Points", { id: `${track.id}-automation`, timeUnit: "seconds" });
      append(points, "Target", { parameter: `${track.id}-volume` });
      for (const point of track.volumeAutomation) append(points, "RealPoint", { time: point.time, value: point.value, interpolation: point.shape });
    }
  }
  if (project.markers.length) {
    const markers = append(arrangement, "Markers", { id: "projectMarkers", timeUnit: "seconds" });
    for (const marker of project.markers) append(markers, "Marker", { time: marker.time, name: marker.name });
  }
  if (project.tempoMap.changes.length) {
    const points = append(arrangement, "TempoAutomation", { id: "projectTempo", timeUnit: "beats", unit: "bpm" });
    append(points, "Target", { parameter: "transportTempo" });
    for (const step of [{ beat: 0, bpm: project.bpm }, ...project.tempoMap.changes])
      append(points, "RealPoint", { time: step.beat, value: step.bpm, interpolation: "hold" });
  }
  const metadata = new DOMImplementation().createDocument(null, "MetaData", null);
  append(metadata.documentElement!, "Title").textContent = project.title;
  const serialize = (node: Document) => encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(node)}`);
  entries["project.xml"] = serialize(document);
  entries["metadata.xml"] = serialize(metadata);
  entries["audiorective/state.json"] = encoder.encode(JSON.stringify(state));
  if (Object.keys(manifest.devices).length) entries["audiorective/host.json"] = encoder.encode(JSON.stringify(manifest));
  const ids = new Set<string>();
  for (const element of [root, ...Array.from(root.getElementsByTagName("*"))]) {
    const id = element.getAttribute("id");
    if (id !== null) {
      if (ids.has(id)) throw new Error("Project has duplicate DAWproject XML IDs.");
      ids.add(id);
    }
  }
  return { entries, mediaEntries };
}

/** Save the in-memory project slice as a standards-shaped .dawproject ZIP. */
export function saveDawProject(project: Project): Uint8Array {
  const { entries, mediaEntries } = prepareDawProject(project);
  if (mediaEntries.size) throw new Error("Project file-backed audio needs saveDawProjectTo().");
  return zipSync(entries, { level: 6 });
}

/** Write a portable archive incrementally with CRC and size in each local ZIP header. */
export async function saveDawProjectTo(project: Project, destination: WritableStream<Uint8Array>): Promise<void> {
  const { entries, mediaEntries } = prepareDawProject(project);
  const files: StoredZipEntry[] = Object.entries(entries).map(([path, bytes]) => ({
    path,
    size: bytes.length,
    async *chunks() {
      yield bytes;
    },
  }));
  for (const [path, clip] of mediaEntries) {
    if (!clip.media) throw new Error("Project media asset is missing.");
    files.push(wavMediaEntry(path, clip.media, clip.startFrame, clip.frameCount));
  }
  await writeStoredZip(files, destination);
}

function readPrivate(bytes: Uint8Array | undefined, warnings: string[]): PrivateState | undefined {
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== "object" || ![1, 2].includes((value as PrivateState).version) || !Array.isArray((value as PrivateState).clips))
      throw new Error();
    return value as PrivateState;
  } catch {
    warnings.push("Audiorective project details are invalid; standard project data was used.");
    return undefined;
  }
}

function readHostManifest(bytes: Uint8Array | undefined, warnings: string[]): HostManifest | undefined {
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      (value as HostManifest).version !== 1 ||
      !(value as HostManifest).devices ||
      typeof (value as HostManifest).devices !== "object"
    )
      throw new Error();
    return value as HostManifest;
  } catch {
    warnings.push("Audiorective WebCLAP bundle locations are invalid; devices need manual resolution.");
    return undefined;
  }
}

function readMidi(clip: Element, trackId: string, index: number, unit: "seconds" | "beats", stored: PrivateState | undefined, warnings: string[]) {
  attributesOnly(clip, ["time", "duration", "contentTimeUnit"]);
  if (direct(clip, "Audio").length) throw new Error("Project MIDI clip has unsupported audio content.");
  const time = numberAttr(clip, "time");
  const duration = numberAttr(clip, "duration");
  if (attr(clip, "contentTimeUnit") !== unit) throw new Error("Project MIDI clip content time must match its clip lane.");
  const content = one(clip, "Lanes")!;
  attributesOnly(content, ["id", "timeUnit"]);
  if (attr(content, "timeUnit") !== unit) throw new Error("Project MIDI clip content time must match its clip lane.");
  childrenOnly(content, ["Notes", "Points"]);
  const notesNode = one(content, "Notes")!;
  attributesOnly(notesNode, ["id", "timeUnit"]);
  if (attr(notesNode, "timeUnit") !== unit) throw new Error("Project MIDI clip content time must match its clip lane.");
  childrenOnly(notesNode, ["Note"]);
  const notes = direct(notesNode, "Note").map((element, noteIndex) => {
    attributesOnly(element, ["time", "duration", "channel", "key", "vel"]);
    childrenOnly(element, []);
    const start = numberAttr(element, "time"),
      end = start + numberAttr(element, "duration");
    const velocity = Math.round(numberAttr(element, "vel") * 127);
    return {
      id: `imported-${trackId}-${index}-${noteIndex}`,
      start,
      end,
      pitch: integerAttr(element, "key", 0, 127),
      velocity,
      channel: integerAttr(element, "channel", 0, 15),
      track: 0,
    };
  });
  const controls: ControlPoint[] = [];
  for (const points of direct(content, "Points")) {
    attributesOnly(points, ["id", "timeUnit"]);
    if (attr(points, "timeUnit") !== unit) throw new Error("Project MIDI clip content time must match its clip lane.");
    const target = one(points, "Target")!;
    attributesOnly(target, ["expression", "channel", "controller"]);
    childrenOnly(target, []);
    if (attr(target, "expression") !== "channelController") throw new Error("Project MIDI has unsupported control automation.");
    const channel = integerAttr(target, "channel", 0, 15),
      controller = integerAttr(target, "controller", 0, 127);
    childrenOnly(points, ["Target", "IntegerPoint"]);
    for (const point of direct(points, "IntegerPoint")) {
      attributesOnly(point, ["time", "value"]);
      childrenOnly(point, []);
      controls.push({ time: numberAttr(point, "time"), channel, controller, value: integerAttr(point, "value", 0, 127) });
    }
  }
  const match = stored?.clips.find((item) => item.track === trackId && item.index === index);
  const expected = fingerprint(notes, controls, time, duration, stored?.version === 2 ? unit : undefined);
  const usable =
    match &&
    (stored?.version === 2 || unit === "seconds") && match.fingerprint === expected &&
    Array.isArray(match.noteIds) &&
    match.noteIds.length === notes.length &&
    Array.isArray(match.events) &&
    match.noteIds.every((id) => typeof id === "string" && !!id) &&
    new Set(match.noteIds).size === match.noteIds.length &&
    match.events.every(
      (event) =>
        event &&
        Number.isFinite(event.time) &&
        event.time >= 0 &&
        Array.isArray(event.data) &&
        event.data.length > 0 &&
        event.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) &&
        (event.noteId === undefined || (typeof event.noteId === "string" && match.noteIds!.includes(event.noteId))),
    );
  if (!usable) warnings.push(`MIDI clip on ${trackId} has no matching Audiorective event details; original same-time order is unavailable.`);
  if (usable)
    notes.forEach((note, i) => {
      note.id = match.noteIds![i];
    });
  const events: ProjectMidiEvent[] = usable
    ? match.events!.map((event) => ({ time: event.time, data: new Uint8Array(event.data), noteId: event.noteId }))
    : controls.map(({ time, channel, controller, value }) => ({ time, data: new Uint8Array([0xb0 | channel, controller, value]) }));
  return { time, duration, notes, events, id: usable ? match.id : undefined, timeUnit: unit };
}

/** Open the supported slice. Unknown structural content fails instead of disappearing. */
export function openDawProject(bytes: Uint8Array): OpenDawProjectResult {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024) throw new Error("Project archive is missing or too large.");
  let total = 0;
  const entries = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      if (file.originalSize > 128 * 1024 * 1024 || total > 512 * 1024 * 1024) throw new Error("Project archive is too large.");
      return true;
    },
  });
  return parseDawProjectEntries(entries);
}

/** Open a Blob incrementally so embedded WAVs can stay file-backed. */
export async function openDawProjectBlob(blob: Blob): Promise<OpenDawProjectResult> {
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > 4 * 1024 * 1024 * 1024) throw new Error("Project archive is missing or too large.");
  const entries: ArchiveEntries = Object.create(null) as ArchiveEntries;
  const files = new Map<string, { chunks: (Uint8Array | Blob)[]; size: number; media: boolean }>();
  let failure: unknown;
  let total = 0;
  let nonMediaTotal = 0;
  const unzip = new Unzip((file) => {
    if (files.size >= 10_000 || files.has(file.name) || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.name)) {
      failure = new Error("Project archive has duplicate or unsafe paths.");
      return;
    }
    const media = isAudioPath(file.name);
    const record = { chunks: [] as (Uint8Array | Blob)[], size: 0, media };
    files.set(file.name, record);
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = error;
        return;
      }
      if (failure) return;
      record.size += chunk?.length ?? 0;
      total += chunk?.length ?? 0;
      if (!media) nonMediaTotal += chunk?.length ?? 0;
      if (record.size > (media ? 0xffffffff : 8 * 1024 * 1024) || nonMediaTotal > 32 * 1024 * 1024 || total > 8 * 1024 * 1024 * 1024) {
        failure = new Error("Project archive is too large.");
        return;
      }
      if (chunk?.length) record.chunks.push(media ? new Blob([chunk as Uint8Array<ArrayBuffer>]) : chunk);
      if (final) {
        if (media) {
          const mediaBlob = new Blob(record.chunks as BlobPart[]);
          entries[file.name] = { blob: mediaBlob, header: new Uint8Array() };
        } else {
          const bytes = new Uint8Array(record.size);
          let at = 0;
          for (const part of record.chunks) {
            if (!(part instanceof Uint8Array)) throw new Error("Project archive has invalid entry data.");
            bytes.set(part, at);
            at += part.length;
          }
          entries[file.name] = bytes;
        }
        record.chunks.length = 0;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let at = 0; at < blob.size; at += 1024 * 1024) {
    const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + 1024 * 1024)).arrayBuffer());
    unzip.push(bytes, at + bytes.length === blob.size);
    if (failure) throw failure;
  }
  if ([...files.keys()].some((path) => !entries[path])) throw new Error("Project archive is incomplete.");
  for (const entry of Object.values(entries))
    if (!(entry instanceof Uint8Array)) entry.header = new Uint8Array(await entry.blob.slice(0, 44).arrayBuffer());
  return parseDawProjectEntries(entries);
}

function entryBytes(entries: ArchiveEntries, path: string): Uint8Array | undefined {
  const entry = entries[path];
  if (entry && !(entry instanceof Uint8Array)) throw new Error("Project archive has unsupported media path.");
  return entry;
}

function parseDawProjectEntries(entries: ArchiveEntries): OpenDawProjectResult {
  if (!entries["project.xml"] || !entries["metadata.xml"]) throw new Error("Project archive needs project.xml and metadata.xml.");
  const root = parseXml(entryBytes(entries, "project.xml")!, "Project");
  attributesOnly(root, ["version"]);
  if (attr(root, "version") !== "1.0") throw new Error("Project needs DAWproject version 1.0.");
  childrenOnly(root, ["Application", "Transport", "Structure", "Arrangement"]);
  const application = one(root, "Application")!;
  attributesOnly(application, ["name", "version"]);
  childrenOnly(application, []);
  const meta = parseXml(entryBytes(entries, "metadata.xml")!, "MetaData");
  const metadataFields = ["Title", "Artist", "Album", "OriginalArtist", "Songwriter", "Producer", "Year", "Genre", "Copyright", "Comment"];
  childrenOnly(meta, metadataFields);
  for (const field of metadataFields) {
    const element = one(meta, field, false);
    if (!element) continue;
    attributesOnly(element, []);
    childrenOnly(element, []);
    if (field !== "Title" && element.textContent?.trim()) throw new Error(`Project has unsupported ${field} metadata.`);
  }
  const title = one(meta, "Title", false)?.textContent?.trim() || "Untitled";
  const transport = one(root, "Transport")!;
  childrenOnly(transport, ["Tempo", "TimeSignature"]);
  const tempo = one(transport, "Tempo")!;
  attributesOnly(tempo, ["id", "unit", "value"]);
  childrenOnly(tempo, []);
  if (attr(tempo, "unit") !== "bpm") throw new Error("Project transport needs BPM tempo.");
  const bpm = numberAttr(tempo, "value", Number.EPSILON);
  const sig = one(transport, "TimeSignature")!;
  attributesOnly(sig, ["id", "numerator", "denominator"]);
  childrenOnly(sig, []);
  const signature = [integerAttr(sig, "numerator", 1), integerAttr(sig, "denominator", 1)] as const;
  const warnings: string[] = [];
  const stored = readPrivate(entryBytes(entries, "audiorective/state.json"), warnings);
  const hostManifest = readHostManifest(entryBytes(entries, "audiorective/host.json"), warnings);
  const project = new Project({ title, bpm, signature });
  try {
    const usedPaths = new Set(["project.xml", "metadata.xml"]);
    if (entries["audiorective/state.json"]) usedPaths.add("audiorective/state.json");
    if (entries["audiorective/host.json"]) usedPaths.add("audiorective/host.json");
    const structure = one(root, "Structure")!;
    childrenOnly(structure, ["Track"]);
    let masterChannelId: string | undefined;
    const channelTracks = new Map<string, string>();
    const routes: Array<{ trackId: string; destination: string | null; sends: Array<{ destination: string; gain: number }> }> = [];
    for (const element of direct(structure, "Track")) {
      attributesOnly(element, ["id", "name", "contentType"]);
      childrenOnly(element, ["Channel"]);
      const channel = one(element, "Channel")!;
      attributesOnly(channel, ["id", "role", "destination", "audioChannels", "solo"]);
      childrenOnly(channel, ["Devices", "Mute", "Pan", "Sends", "Volume"]);
      const channelId = attr(channel, "id");
      const destination = channel.getAttribute("destination");
      if (channelTracks.has(channelId) || channelId === masterChannelId) throw new Error("Project has duplicate channel IDs.");
      const volumeElement = one(channel, "Volume")!;
      attributesOnly(volumeElement, ["id", "unit", "value"]);
      childrenOnly(volumeElement, []);
      if (attr(volumeElement, "unit") !== "linear") throw new Error("Project has unsupported track volume units.");
      const role = attr(channel, "role");
      if (role === "master") {
        if (masterChannelId || destination || one(channel, "Sends", false)) throw new Error("Project has unsupported master routing.");
        masterChannelId = channelId;
        project.setMasterVolume(numberAttr(volumeElement, "value"));
        continue;
      }
      const busRole = role === "submix" || role === "effect" ? role : undefined;
      if (role !== "regular" && !busRole) throw new Error("Project has unsupported track routing.");
      const content = attr(element, "contentType");
      const kind = content === "audio" ? (busRole ? "bus" : "audio") : content === "notes" && !busRole ? "midi" : null;
      if (!kind) throw new Error("Project has an unsupported track kind.");
      const volume = numberAttr(volumeElement, "value");
      const muteElement = one(channel, "Mute", false);
      const panElement = one(channel, "Pan", false);
      const boolean = (value: string | null) => (value === "true" ? true : value === "false" || value === null ? false : null);
      const muted = muteElement ? boolean(muteElement.getAttribute("value")) : false;
      const solo = boolean(channel.getAttribute("solo"));
      if (muted === null || solo === null) throw new Error("Project has invalid channel mute or solo.");
      if (muteElement) {
        attributesOnly(muteElement, ["id", "value"]);
        childrenOnly(muteElement, []);
      }
      let pan = 0;
      if (panElement) {
        attributesOnly(panElement, ["id", "unit", "value", "min", "max"]);
        childrenOnly(panElement, []);
        if (attr(panElement, "unit") !== "normalized") throw new Error("Project has unsupported track pan units.");
        const normalized = numberAttr(panElement, "value");
        if (normalized > 1) throw new Error("Project has invalid track pan.");
        pan = normalized * 2 - 1;
      }
      const track = project.addTrack(attr(element, "name"), kind, { id: attr(element, "id"), volume, muted, solo, pan, busRole });
      channelTracks.set(channelId, track.id);
      const sends = one(channel, "Sends", false);
      const route = { trackId: track.id, destination, sends: [] as Array<{ destination: string; gain: number }> };
      if (sends) {
        attributesOnly(sends, []);
        childrenOnly(sends, ["Send"]);
        for (const send of direct(sends, "Send")) {
          attributesOnly(send, ["id", "type", "destination"]);
          childrenOnly(send, ["Volume"]);
          const level = one(send, "Volume")!;
          attributesOnly(level, ["id", "unit", "value", "min", "max"]);
          childrenOnly(level, []);
          if (attr(send, "type") !== "post" || attr(level, "unit") !== "linear") throw new Error("Project has unsupported send settings.");
          route.sends.push({ destination: attr(send, "destination"), gain: numberAttr(level, "value") });
        }
      }
      routes.push(route);
      const devices = one(channel, "Devices", false);
      if (devices) {
        childrenOnly(devices, ["ClapPlugin", "BuiltinDevice"]);
        const effects: RackEffect[] = [];
        for (let node = devices.firstChild; node; node = node.nextSibling) {
          if (node.nodeType !== 1) continue;
          const plugin = node as Element;
          if (plugin.tagName === "BuiltinDevice") {
            attributesOnly(plugin, ["id", "deviceID", "deviceName", "deviceVendor", "deviceRole", "loaded"]);
            childrenOnly(plugin, ["State"]);
            const deviceId = attr(plugin, "deviceID");
            if (attr(plugin, "deviceRole") !== "audioFX" ||
                !Object.keys(rackDeviceNames).some((type) => deviceId === rackDevicePrefix + type))
              throw new Error("Project has an unsupported built-in effect.");
            const stateRef = one(plugin, "State")!;
            attributesOnly(stateRef, ["path"]);
            childrenOnly(stateRef, []);
            const path = attr(stateRef, "path");
            const bytes = path.startsWith("plugins/") ? entryBytes(entries, path) : undefined;
            if (!bytes || usedPaths.has(path)) throw new Error("Project built-in effect state is missing or reused.");
            let data: { version?: number; effect?: RackEffect } | null;
            try {
              data = JSON.parse(decoder.decode(bytes));
            } catch {
              throw new Error("Project built-in effect state is invalid.");
            }
            if (data?.version !== 1 || !data.effect || rackDevicePrefix + data.effect.type !== deviceId)
              throw new Error("Project built-in effect state is invalid.");
            effects.push(data.effect);
            usedPaths.add(path);
            continue;
          }
          if (effects.length) throw new Error("Project built-in effects must follow WebCLAP devices.");
          attributesOnly(plugin, ["id", "deviceID", "deviceName", "deviceVendor", "deviceRole", "pluginVersion", "loaded"]);
          childrenOnly(plugin, ["State"]);
          const id = attr(plugin, "id"),
            role = attr(plugin, "deviceRole");
          if (role !== (kind === "midi" ? "instrument" : "audioFX")) throw new Error("Project has an unsupported device role.");
          const stateRef = one(plugin, "State", false);
          let state: Uint8Array = new Uint8Array();
          if (stateRef) {
            attributesOnly(stateRef, ["path"]);
            childrenOnly(stateRef, []);
            const path = attr(stateRef, "path");
            if (!path.startsWith("plugins/") || !entries[path]) throw new Error("Project device state asset is missing.");
            usedPaths.add(path);
            state = entryBytes(entries, path)!;
          }
          const location = hostManifest?.devices[id];
          if (!location || location.kind !== "webclap" || typeof location.bundleUrl !== "string")
            warnings.push(`WebCLAP device ${id} needs a bundle location.`);
          project.addWebClapDevice(track.id, {
            id,
            pluginId: attr(plugin, "deviceID"),
            name: attr(plugin, "deviceName"),
            vendor: plugin.getAttribute("deviceVendor") ?? "",
            version: plugin.getAttribute("pluginVersion") ?? "",
            bundleUrl: location?.kind === "webclap" && typeof location.bundleUrl === "string" ? location.bundleUrl : "",
            state,
          });
        }
        if (effects.length) project.setTrackEffects(track.id, effects);
      }
      if (stored?.rackMacros && Object.hasOwn(stored.rackMacros, track.id)) {
        try {
          const macros = stored.rackMacros[track.id];
          if (!Array.isArray(macros)) throw new Error();
          const effects = project.tracks.find(({ id }) => id === track.id)!.effects;
          project.setTrackRackPreset(track.id, { effects, macros });
        } catch {
          warnings.push(`Invalid Audiorective rack macros on ${track.name} were skipped.`);
        }
      }
    }
    if (!masterChannelId) throw new Error("Project has unsupported master routing.");
    const busFor = (destination: string): string => {
      const trackId = channelTracks.get(destination);
      const track = trackId && project.tracks.find((item) => item.id === trackId);
      if (!track || track.kind !== "bus") throw new Error("Project has unsupported track routing.");
      return track.id;
    };
    for (const route of routes) {
      const outputBusId = route.destination && route.destination !== masterChannelId ? busFor(route.destination) : null;
      const sends = route.sends.map(({ destination, gain }) => ({ busId: busFor(destination), gain }));
      if (outputBusId !== null || sends.length) project.setTrackRouting(route.trackId, { outputBusId, sends });
    }
    const arrangement = one(root, "Arrangement")!;
    attributesOnly(arrangement, ["id"]);
    childrenOnly(arrangement, ["Lanes", "Markers", "TempoAutomation"]);
    const lanes = one(arrangement, "Lanes")!;
    attributesOnly(lanes, ["id", "timeUnit"]);
    if (attr(lanes, "timeUnit") !== "seconds") throw new Error("Project arrangement needs seconds time.");
    childrenOnly(lanes, ["Lanes"]);
    for (const lane of direct(lanes, "Lanes")) {
      attributesOnly(lane, ["id", "track", "timeUnit"]);
      if (attr(lane, "timeUnit") !== "seconds") throw new Error("Project track lanes need seconds time.");
      const trackId = attr(lane, "track"),
        track = project.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error("Project arrangement refers to an unknown track.");
      childrenOnly(lane, ["Clips", "Points"]);
      const clipGroups = direct(lane, "Clips");
      if (!clipGroups.length) throw new Error("Project XML needs one Clips element.");
      let index = 0;
      for (const clips of clipGroups) {
        attributesOnly(clips, ["id", "timeUnit"]);
        const unit = attr(clips, "timeUnit");
        if (unit !== "seconds" && unit !== "beats") throw new Error("Project clip lane needs seconds or beats time.");
        if (track.kind === "bus" && direct(clips, "Clip").length) throw new Error("Project bus tracks cannot contain clips.");
        if (unit === "beats" && track.kind !== "midi") throw new Error("Project audio clip has unsupported time unit.");
        childrenOnly(clips, ["Clip"]);
        for (const clip of direct(clips, "Clip")) {
          childrenOnly(clip, ["Lanes", "Audio"]);
          if (track.kind === "midi") {
            const midi = readMidi(clip, trackId, index, unit, stored, warnings);
            project.addMidiClip(trackId, midi, midi.time, { id: midi.id, timeUnit: midi.timeUnit });
          } else {
            attributesOnly(clip, ["time", "duration", "contentTimeUnit", "fadeTimeUnit", "fadeInTime", "fadeOutTime"]);
            if (clip.hasAttribute("fadeTimeUnit") && attr(clip, "fadeTimeUnit") !== "seconds")
              throw new Error("Project audio fades need seconds.");
            if (attr(clip, "contentTimeUnit") !== "seconds" || direct(clip, "Lanes").length)
              throw new Error("Project audio clip has unsupported content.");
            const audio = one(clip, "Audio")!;
            attributesOnly(audio, ["id", "timeUnit", "channels", "sampleRate", "duration"]);
            if (attr(audio, "timeUnit") !== "seconds") throw new Error("Project audio clip has unsupported content.");
            childrenOnly(audio, ["File"]);
            const file = one(audio, "File")!;
            attributesOnly(file, ["path"]);
            childrenOnly(file, []);
            const path = attr(file, "path"),
              asset = entries[path];
            if (!path.startsWith("audio/") || !asset) throw new Error("Project audio asset is missing.");
            usedPaths.add(path);
            const decoded = readAudioSource(asset);
            const channels = audioChannelCount(decoded);
            const frames = decoded.media ? decoded.frameCount : decoded.channels[0].length;
            if (
              decoded.sampleRate !== integerAttr(audio, "sampleRate", 1) ||
              channels !== integerAttr(audio, "channels", 1) ||
              Math.abs(frames / decoded.sampleRate - numberAttr(audio, "duration")) > 1e-9 ||
              Math.abs(frames / decoded.sampleRate - numberAttr(clip, "duration")) > 1e-9
            )
              throw new Error("Project audio asset does not match its XML metadata.");
            const match = stored?.clips.find((item) => item.track === trackId && item.index === index);
            const aligned = match?.fingerprint === path;
            const storedGain = aligned ? match.audioGain : undefined;
            const gain = typeof storedGain === "number" && Number.isFinite(storedGain) && storedGain >= 0 ? storedGain : 1;
            const fadeIn = clip.hasAttribute("fadeInTime") ? numberAttr(clip, "fadeInTime") : 0;
            const fadeOut = clip.hasAttribute("fadeOutTime") ? numberAttr(clip, "fadeOutTime") : 0;
            const originalPath = sourcePrefix + path.slice("audio/".length);
            const original = entries[originalPath];
            let stretch: AudioClipStretch | undefined;
            if (aligned && match.stretchRatio !== undefined) {
              if (!original) throw new Error("Project clip stretch source is missing.");
              stretch = { ratio: match.stretchRatio, source: readAudioSource(original), anchors: match.warpAnchors };
            } else if (original) {
              warnings.push("A rendered audio clip was opened without its Audiorective stretch settings.");
            }
            if (original) usedPaths.add(originalPath);
            let gainAutomation: AudioClipGainAutomation | undefined;
            if (aligned && match.gainAutomation !== undefined) {
              try {
                gainAutomation = normalizeClipGainAutomation(match.gainAutomation);
              } catch {
                warnings.push("Invalid Audiorective clip gain automation was skipped.");
              }
            }
            const options = { id: match?.id, envelope: { gain, fadeIn, fadeOut }, stretch, gainAutomation };
            const time = numberAttr(clip, "time");
            if (decoded.media) project.addAudioMediaClip(trackId, decoded.media, time, options);
            else project.addAudioClip(trackId, decoded, time, options);
          }
          index++;
        }
      }
      const automation = one(lane, "Points", false);
      if (automation) {
        attributesOnly(automation, ["id", "timeUnit"]);
        if (attr(automation, "timeUnit") !== "seconds") throw new Error("Project track lanes need seconds time.");
        childrenOnly(automation, ["Target", "RealPoint"]);
        const target = one(automation, "Target")!;
        attributesOnly(target, ["parameter"]);
        childrenOnly(target, []);
        if (attr(target, "parameter") !== `${trackId}-volume`) throw new Error("Project has unsupported automation target.");
        project.setVolumeAutomation(
          trackId,
          direct(automation, "RealPoint").map((point) => {
            attributesOnly(point, ["time", "value", "interpolation"]);
            childrenOnly(point, []);
            const shape = attr(point, "interpolation");
            if (shape !== "hold" && shape !== "linear") throw new Error("Project has unsupported automation interpolation.");
            return { time: numberAttr(point, "time"), value: numberAttr(point, "value"), shape };
          }),
        );
      }
    }
    const markers = one(arrangement, "Markers", false);
    if (markers) {
      attributesOnly(markers, ["id", "timeUnit"]);
      if (attr(markers, "timeUnit") !== "seconds") throw new Error("Project markers need seconds time.");
      childrenOnly(markers, ["Marker"]);
      project.setMarkers(
        direct(markers, "Marker").map((marker) => {
          attributesOnly(marker, ["time", "name"]);
          childrenOnly(marker, []);
          return { time: numberAttr(marker, "time"), name: attr(marker, "name") };
        }),
      );
    }
    const tempoAutomation = one(arrangement, "TempoAutomation", false);
    if (tempoAutomation) {
      attributesOnly(tempoAutomation, ["id", "timeUnit", "unit"]);
      if (attr(tempoAutomation, "timeUnit") !== "beats" || attr(tempoAutomation, "unit") !== "bpm")
        throw new Error("Project tempo automation needs beat positions and BPM.");
      childrenOnly(tempoAutomation, ["Target", "RealPoint"]);
      const target = one(tempoAutomation, "Target")!;
      attributesOnly(target, ["parameter"]);
      childrenOnly(target, []);
      if (attr(target, "parameter") !== attr(tempo, "id")) throw new Error("Project has unsupported tempo automation target.");
      const changes = direct(tempoAutomation, "RealPoint").map((point) => {
        attributesOnly(point, ["time", "value", "interpolation"]);
        childrenOnly(point, []);
        if (attr(point, "interpolation") !== "hold") throw new Error("Project has unsupported tempo interpolation.");
        return { beat: numberAttr(point, "time"), bpm: numberAttr(point, "value", Number.EPSILON) };
      });
      const initial = changes.find((point) => point.beat === 0);
      if (initial && initial.bpm !== bpm) throw new Error("Project tempo automation disagrees with transport BPM.");
      project.setTempoChanges(changes.filter((point) => point.beat !== 0));
    }
    if (Object.keys(entries).some((path) => !usedPaths.has(path))) throw new Error("Project archive has unsupported files.");
    return { project, warnings: Object.freeze(warnings) };
  } catch (error) {
    project.destroy();
    throw error;
  }
}
