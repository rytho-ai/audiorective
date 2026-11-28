import {
  assertProjectActive,
  importedBundles,
  nextProjectId,
  preservedEntries,
  registerKeptContent,
  validProjectId,
  validateXmlText,
} from "./project-persistence";
import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document, Element } from "@xmldom/xmldom";
import { zipSync, Unzip, UnzipInflate } from "fflate";
import { untracked } from "@audiorective/core";
import {
  controllerEvents,
  controllerExpressions,
  controllerFromNormalized,
  controllerLaneKey,
  controllerMax,
  controllerToNormalized,
  type ControllerLane,
  type ControllerPoint,
} from "./controller-lane";
import type { NoteInit } from "@audiorective/midi";
import type { RackEffect, RackMacroSettings } from "./rack-preset";
import type { DeviceParameterRecord } from "./device-parameters";
import {
  MidiClip,
  Project,
  audioChannelCount,
  audioClipTimeMap,
  audioFrameCount,
  adoptSlotClip,
  audioRecording,
  extensionRecords,
  markVarispeed,
  normalizeClipGainAutomation,
  restoreScenes,
  windowOfRecording,
  type ExtensionRecord,
} from "./model";
import type { TempoMap } from "./tempo-map";
import { EXTENSION_ID } from "./extensions";
import { sessionFor } from "./session";
import { readSession, splitSlotKey } from "./session-state";
import type { ClipStretchAnchor } from "./clip-time-map";
import type {
  AudioClip,
  AudioClipGainAutomation,
  AudioClipSource,
  AudioClipStretchInit,
  ProjectAudio,
  ProjectClip,
  ProjectMidiEvent,
  ProjectTrack,
} from "./model";
import { collectKeptTimed, commitKeptShifts, discardKeptShifts, keptClipSpans, shiftKeptContent, stepKeptShifts } from "./internal/kept-timeline";
import { decodeWav, encodeWav, mediaFromWav, wavMediaEntry } from "./internal/wav";
import { sourceXml, unmodeledPoints } from "./internal/source-xml";
import { pendingAudioFiles, registerArchiveReaders, wavPcmFiles } from "./internal/decoded-audio";
import type { DecodedAudioFiles } from "./internal/decoded-audio";
import { encodedAudioMedia } from "./media";
import { applySourcePatch, snapshot } from "./internal/patch-source";
import type { FreshIndex } from "./internal/patch-source";
import type { GainCurveLink, SourceXml, TrackLink } from "./internal/source-xml";
import { exactWarpRatio, readWarpPoints, warpKnots, warpTolerance, warpVerdict } from "./internal/nested-audio";
import type { NestedAudioLink, WarpKnot } from "./internal/nested-audio";
import { noteOpenedStretch } from "./internal/open-stretch";
import { RenderCollector, hashPcm, readStoredRender, renderMatches, renderPrefix } from "./internal/stretch-render";
import type { StoredRender } from "./internal/stretch-render";
import { varispeedAudio } from "./internal/varispeed";
import { crc32, writeStoredZip } from "./internal/stored-zip";
import type { StoredZipEntry } from "./internal/stored-zip";
import { zipDirectory, zipBlobDirectory, readZipEntry, safeArchivePath } from "./internal/zip-directory";
import { arrivalShapes, foldSteps, leavingShapes } from "./internal/point-shape";
import { ARRIVAL_STATE_VERSION, migrateLeavingToArrival, writesLeavingShapes } from "./internal/legacy-interpolation";

/** A gain curve's points as model points: the time in the curve's own unit, the shape how the value leaves the point. */
type GainCurveValues = Array<{ time: number; value: number; shape: "linear" | "hold" }>;
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
  warpAnchors?: readonly ClipStretchAnchor[];
  /** A stretched clip's pitch-correct audio and what it was rendered from; a reader uses it only while it matches the standard XML. */
  render?: StoredRender;
  gainAutomation?: AudioClipGainAutomation;
};
type PrivateState = { version: 1 | 2 | 3 | 4; nextId?: number; clips: StoredClip[]; rackMacros?: Record<string, readonly RackMacroSettings[]> };
type HostManifest = {
  version: 1;
  devices: Record<
    string,
    {
      kind: "webclap";
      bundleUrl: string;
      /** What `RealParameter` has no place for: a parameter's default and whole-number step, by CLAP parameter ID. */
      parameters?: Record<string, { default: number; step?: 1 }>;
    }
  >;
};
const midiExpressions = {
  0xa0: "polyPressure",
  0xb0: "channelController",
  0xc0: "programChange",
  0xd0: "channelPressure",
  0xe0: "pitchBend",
} as const;
type Expression = (typeof midiExpressions)[keyof typeof midiExpressions];
type ControlPoint = { time: number; channel: number; controller: number; value: number; expression?: Expression };

/** The `Target` attributes of a controller lane: the expression, the channel, and the controller number or key. */
function controllerTarget({ expression, channel, controller }: ControllerLane): Record<string, string | number> {
  return {
    expression,
    channel,
    ...(expression === "channelController" ? { controller } : expression === "polyPressure" ? { key: controller } : {}),
  };
}

function eventFromControl({ time, channel, controller, value, expression }: ControlPoint): ProjectMidiEvent {
  const bytes =
    expression === "pitchBend"
      ? [0xe0 | channel, value & 127, value >> 7]
      : expression === "channelPressure"
        ? [0xd0 | channel, value]
        : expression === "programChange"
          ? [0xc0 | channel, value]
          : expression === "polyPressure"
            ? [0xa0 | channel, controller, value]
            : [0xb0 | channel, controller, value];
  return { time, data: new Uint8Array(bytes) };
}
type MediaEntry = { blob: Blob; header: Uint8Array };
type ArchiveEntries = Record<string, Uint8Array | MediaEntry>;
export type PortabilityReport = Readonly<{
  /** Descriptions of content represented by the standard DAWproject elements. */
  standardContent: readonly string[];
  /** Descriptions of plug-ins another host must provide to reproduce the song. */
  pluginDependencies: readonly string[];
  /** Interoperability limits and caller warnings, including baseline host-compatibility caveats. */
  limitations: readonly string[];
}>;
export type OpenDawProjectResult = Readonly<{
  /** Opened project owned by the caller, including preserved content from the archive. */
  project: Project;
  /** Non-fatal file-reading or playback limitations in plain sentences; empty when none were found. */
  warnings: readonly string[];
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const rackDevicePrefix = "audiorective.insert.";
const rackDeviceNames: Record<RackEffect["type"], string> = { filter: "Filter", delay: "Ping Pong Delay", eq: "Equalizer" };
const sourcePrefix = "audiorective/source/";
/** XML and JSON entries (project.xml, metadata.xml, `audiorective/*.json`): parsed whole, so the Blob reader holds each to 8 MiB and all of them to 32 MiB. */
const isTextPath = (path: string) => /\.(?:xml|json)$/i.test(path);
const isAudioPath = (path: string) => path.startsWith("audio/") || path.startsWith(sourcePrefix) || path.startsWith(renderPrefix);

function append(parent: Element, name: string, attrs: Record<string, string | number | boolean> = {}): Element {
  const node = parent.ownerDocument!.createElement(name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
}

const kids = (element: Element): Element[] => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);

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

/** While a file is read: what it holds beyond the model, one entry per kind. A save writes all of it back. */
let keptSink: string[] | undefined;
function note(what: string): void {
  if (keptSink && !keptSink.includes(what)) keptSink.push(what);
}

/** Content the model does not carry is kept in the file, not rejected: it is listed in the open warnings. */
function childrenOnly(parent: Element, names: readonly string[]): void {
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && !names.includes((node as Element).tagName)) note(`${parent.tagName}/${(node as Element).tagName}`);
  }
}

function attributesOnly(element: Element, names: readonly string[]): void {
  for (let i = 0; i < element.attributes.length; i++) {
    const name = element.attributes.item(i)!.name;
    if (!names.includes(name)) note(`${element.tagName}@${name}`);
  }
}

function attr(element: Element, name: string): string {
  const value = element.getAttribute(name);
  if (value === null) throw new Error(`Project XML needs ${name} on ${element.tagName}.`);
  return value;
}

function numberAttr(element: Element, name: string, minimum = 0, maximum = Infinity): number {
  const text = attr(element, name);
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`Project XML has invalid ${name} on ${element.tagName}.`);
  return value;
}

function integerAttr(element: Element, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = numberAttr(element, name, minimum);
  if (!Number.isInteger(value) || value > maximum) throw new Error(`Project XML has invalid ${name} on ${element.tagName}.`);
  return value;
}

/**
 * The HTML named entities metadata.xml may use besides XML's five (Studio One writes `PreSonus &copy; 2024`). XML itself defines none of them, so a
 * parser rejects the file; the fixed table below is read as the characters they name. Any other entity name stays an error.
 */
const htmlEntities: Readonly<Record<string, string>> = {
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  plusmn: "\u00b1",
  middot: "\u00b7",
  times: "\u00d7",
  divide: "\u00f7",
  laquo: "\u00ab",
  raquo: "\u00bb",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  hellip: "\u2026",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  sect: "\u00a7",
  para: "\u00b6",
};

function parseXml(bytes: Uint8Array, rootName: string, file = "project.xml"): Element {
  let xml = decoder.decode(bytes);
  validateXmlText(xml);
  if (file === "metadata.xml") xml = xml.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (whole, name: string) => htmlEntities[name] ?? whole);
  const label = file === "project.xml" ? "Project XML" : `Project ${file}`;
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === "warning" && message.startsWith("Unicode replacement character detected")) return;
      throw new Error(`${label} is invalid: ${message}`);
    },
  }).parseFromString(xml, "application/xml");
  const root = document.documentElement!;
  if (!root || root.tagName !== rootName) throw new Error(`${label} needs a ${rootName} root.`);
  return root;
}

/** A cheap change detector for sidecar alignment, not a security hash. */
function fingerprint(
  notes: readonly NoteInit[],
  controls: readonly ControlPoint[],
  time: number,
  duration: number,
  unit: "seconds" | "beats",
): string {
  const ordered = [...controls].sort(
    (a, b) =>
      a.time - b.time ||
      a.channel - b.channel ||
      (a.expression ?? "").localeCompare(b.expression ?? "") ||
      a.controller - b.controller ||
      a.value - b.value,
  );
  const plain = JSON.stringify({
    time,
    duration,
    unit,
    notes: notes.map(({ start, duration, pitch, velocity, channel }) => [start, duration, pitch, velocity, channel]),
    controls: ordered,
  });
  let hash = 2166136261;
  for (let i = 0; i < plain.length; i++) hash = Math.imul(hash ^ plain.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function controlsFromEvents(events: readonly ProjectMidiEvent[]): ControlPoint[] {
  return events.flatMap(({ time, data }) => {
    const status = data[0] & 0xf0;
    const expression = midiExpressions[status as keyof typeof midiExpressions];
    if (
      data[0] < 0x80 ||
      data[0] >= 0xf0 ||
      data.length !== (status === 0xc0 || status === 0xd0 ? 2 : 3) ||
      data.subarray(1).some((byte) => byte > 127)
    )
      throw new Error("Project MIDI has events outside supported portable content.");
    if (!expression) return [];
    const channel = data[0] & 15;
    if (status === 0xb0) return [{ time, channel, controller: data[1], value: data[2] }];
    const controller = status === 0xa0 ? data[1] : 0;
    const value = status === 0xe0 ? data[1] + (data[2] << 7) : status === 0xa0 ? data[2] : data[1];
    return [{ time, channel, controller, value, expression }];
  });
}

function writeAudioSource(
  path: string,
  source: AudioClipSource,
  entries: Record<string, Uint8Array>,
  mediaEntries: Map<string, AudioClipSource>,
): void {
  if (source.media) mediaEntries.set(path, source);
  else entries[path] = encodeWav(source);
}

function readAudioSource(asset: Uint8Array | MediaEntry): AudioClipSource {
  if (asset instanceof Uint8Array) return decodeWav(asset);
  const media = mediaFromWav(asset.blob, asset.header);
  return { media, sampleRate: media.sampleRate, startFrame: 0, frameCount: media.frameCount };
}

type StretchWrite = {
  entries: Record<string, Uint8Array>;
  mediaEntries: Map<string, AudioClipSource>;
  recordingPaths: Map<object, string>;
  state: PrivateState;
  track: ProjectTrack;
  index: number;
  source: SourceXml | undefined;
  /** Set for a timeline in beats (the clip's place, warp times and nested clips are then in beats). */
  toBeat: ((seconds: number) => number) | undefined;
  tempo: TempoMap;
  renders: RenderCollector;
};

/**
 * The time map of a stretched clip in the form it is written: each place where the speed changes (the model's anchors, and a tempo change of
 * the song inside the clip, where a warp that is steady in beats is not steady in seconds) as clip-local seconds and the audio second of the
 * original recording that plays there. Both ends are included.
 */
function stretchWarpPoints(clip: AudioClip, tempo: TempoMap): Array<{ local: number; content: number }> {
  const stretch = clip.stretch!;
  const map = audioClipTimeMap(clip);
  const rate = clip.sampleRate;
  const locals = new Set<number>([0, clip.duration]);
  for (const anchor of stretch.anchors ?? []) locals.add(anchor.outputFrame / rate);
  const near = (at: number) => [...locals].some((local) => Math.abs(local - at) < 1.5 / rate);
  for (const change of tempo.changes) {
    const at = tempo.beatToSeconds(change.beat) - clip.time;
    // A tempo change that falls on a point already there adds nothing.
    if (at > 0 && at < clip.duration && !near(at)) locals.add(at);
  }
  const points = [...locals]
    .sort((a, b) => a - b)
    .map((local) => ({ local, content: stretch.source.sourceOffset + (local === clip.duration ? map.sourceDuration : map.outputToSource(local)) }));
  // One speed all along: the end point is where the exact ratio puts the end of the window, a fraction of a frame from the clip's end, so a reader
  // gets back the ratio and not the quotient of two rounded frame counts (which would drift with every save).
  if (points.length === 2 && Number.isFinite(stretch.ratio) && stretch.ratio > 0)
    points[1] = { ...points[1], local: map.sourceDuration * stretch.ratio };
  return points;
}

/**
 * A stretched audio clip in the form Bitwig Studio writes and reads: the clip's place on the outside, and inside it one nested clip whose `Warps`
 * play the original recording through the clip's time map (`algorithm="stretch"`). The recording is the original file, written once.
 */
function writeStretchedAudio(clip: AudioClip, stretch: NonNullable<AudioClip["stretch"]>, outer: Element, write: StretchWrite): void {
  const { entries, mediaEntries, recordingPaths, state, track, index, source, toBeat, tempo, renders } = write;
  const unit = toBeat ? "beats" : "seconds";
  const recording = audioRecording(stretch.source);
  const path = recordingPaths.get(recording.key) ?? source?.recordings.get(recording.key) ?? `audio/${clip.id}.wav`;
  if (!recordingPaths.has(recording.key)) {
    recordingPaths.set(recording.key, path);
    // A recording that came from the opened file keeps the file's own bytes under its own path.
    if (!source?.recordings.has(recording.key)) writeAudioSource(path, recording.source, entries, mediaEntries);
  }
  const { gain = 1 } = clip.envelope ?? {};
  const length = toBeat ? snap12(toBeat(clip.time + clip.duration) - toBeat(clip.time)) : clip.duration;
  outer.setAttribute("contentTimeUnit", unit);
  const clips = append(outer, "Clips", { id: `${clip.id}-nested`, timeUnit: unit });
  const inner = append(clips, "Clip", { time: 0, duration: length, contentTimeUnit: unit });
  const warps = append(inner, "Warps", { id: `${clip.id}-warps`, contentTimeUnit: "seconds", timeUnit: unit });
  // The standard form of clip gain: content lanes hold the audio and a flat gain curve; a moving curve stays in Audiorective's details.
  const flat = gain !== 1 && clip.gainAutomation === undefined;
  const content = flat ? append(warps, "Lanes", { id: `${clip.id}-content`, timeUnit: unit }) : warps;
  const stated = source?.encodedAudio.get(path);
  const audio = append(content, "Audio", {
    id: `${clip.id}-audio`,
    algorithm: "stretch",
    channels: stated?.channels ?? audioChannelCount(recording.source),
    sampleRate: stated?.sampleRate ?? clip.sampleRate,
    duration: stated?.duration ?? recording.frames / clip.sampleRate,
  });
  append(audio, "File", { path });
  if (flat) {
    const points = append(content, "Points", { id: `${clip.id}-gain`, timeUnit: unit, unit: "linear" });
    append(points, "Target", { expression: "gain" });
    for (const time of [0, length]) append(points, "RealPoint", { time, value: gain, interpolation: "linear" });
  }
  const startBeat = toBeat?.(clip.time) ?? 0;
  for (const point of stretchWarpPoints(clip, tempo))
    append(warps, "Warp", {
      time: toBeat ? snap12(toBeat(clip.time + point.local) - startBeat) : point.local,
      contentTime: snap12(point.content),
    });
  const stored: StoredClip = {
    track: track.id,
    index,
    id: clip.id,
    fingerprint: path,
    ...(gain === 1 ? {} : { audioGain: gain }),
    ...(clip.gainAutomation ? { gainAutomation: clip.gainAutomation } : {}),
  };
  state.clips.push(stored);
  // The standard form holds the original and the warp; the render, when the clip has one, goes in the sidecar for a reader that has no engine.
  renders.add(clip, path, stored);
}

function writeClip(
  clip: AudioClip | MidiClip,
  clips: Element,
  entries: Record<string, Uint8Array>,
  mediaEntries: Map<string, AudioClipSource>,
  recordingPaths: Map<object, string>,
  state: PrivateState,
  track: ProjectTrack,
  index: number,
  name: string | undefined,
  linkOwners: Map<object, { id: string; events: boolean }>,
  source: SourceXml | undefined,
  toBeat: ((seconds: number) => number) | undefined,
  inBeats: boolean,
  tempo: TempoMap,
  renders: RenderCollector,
): void {
  const unit = clip.kind === "midi" ? "beats" : "seconds";
  // An audio clip on a beats timeline keeps its content in seconds: only its place and length move to beats.
  const start = inBeats && clip.kind === "audio" && toBeat ? toBeat(clip.time) : clip.time;
  const length = inBeats && clip.kind === "audio" && toBeat ? snap12(toBeat(clip.time + clip.duration) - start) : clip.duration;
  const element = append(clips, "Clip", { ...(name === undefined ? {} : { name }), time: start, duration: length, contentTimeUnit: unit });
  if (clip.kind === "audio") {
    // A clip writes its whole recording once, named after the first clip that uses it.
    const recording = audioRecording(clip);
    const path = (recording && (recordingPaths.get(recording.key) ?? source?.recordings.get(recording.key))) ?? `audio/${clip.id}.wav`;
    const { gain = 1, fadeIn = 0, fadeOut = 0 } = clip.envelope ?? {};
    if (fadeIn || fadeOut) {
      // Bitwig reads a fade as beats whatever `fadeTimeUnit` says, so a freshly written file states fades in beats, converted through the tempo
      // map from the edge each one grows from. A file patched from another application keeps its own seconds.
      if (toBeat) {
        element.setAttribute("fadeTimeUnit", "beats");
        const first = toBeat(clip.time);
        const last = toBeat(clip.time + clip.duration);
        if (fadeIn) element.setAttribute("fadeInTime", String(snap12(toBeat(clip.time + fadeIn) - first)));
        if (fadeOut) element.setAttribute("fadeOutTime", String(snap12(last - toBeat(clip.time + clip.duration - fadeOut))));
      } else {
        element.setAttribute("fadeTimeUnit", "seconds");
        if (fadeIn) element.setAttribute("fadeInTime", String(fadeIn));
        if (fadeOut) element.setAttribute("fadeOutTime", String(fadeOut));
      }
    }
    if (clip.stretch) {
      writeStretchedAudio(clip, clip.stretch, element, {
        entries,
        mediaEntries,
        recordingPaths,
        state,
        track,
        index,
        source,
        toBeat: inBeats ? toBeat : undefined,
        tempo,
        renders,
      });
      return;
    }
    // Gain in the standard form: the clip's content lanes hold the audio and a gain curve, which Bitwig shows as the clip's Gain. The same values
    // stay in Audiorective's own details, which stay the authority on reading; a stretched or looped clip keeps them there only.
    const writeGain = (gain !== 1 || clip.gainAutomation !== undefined) && !clip.loop;
    const gainSpan = recording.frames / clip.sampleRate;
    // The standard form has one gain curve: each automation value is scaled by the clip gain, and without automation the gain is flat over the content.
    const gainPoints = clip.gainAutomation
      ? clip.gainAutomation.points.map((point) => ({ time: point.time, value: gain * point.value, shape: point.shape }))
      : [
          { time: 0, value: gain, shape: "linear" as const },
          { time: gainSpan, value: gain, shape: "linear" as const },
        ];
    const content = writeGain ? append(element, "Lanes", { id: `${clip.id}-content`, timeUnit: "seconds" }) : element;
    // A compressed file the model plays at the Workspace's rate is still described by what its own Audio element states.
    const stated = source?.encodedAudio.get(path);
    const audio = append(content, "Audio", {
      id: `${clip.id}-audio`,
      timeUnit: "seconds",
      channels: stated?.channels ?? audioChannelCount(clip),
      sampleRate: stated?.sampleRate ?? clip.sampleRate,
      duration: stated?.duration ?? (recording ? recording.frames / clip.sampleRate : clip.duration),
    });
    append(audio, "File", { path });
    if (writeGain) {
      const points = append(content, "Points", { id: `${clip.id}-gain`, timeUnit: "seconds", unit: "linear" });
      append(points, "Target", { expression: "gain" });
      const arrival = arrivalShapes(gainPoints);
      for (const [i, point] of gainPoints.entries()) append(points, "RealPoint", { time: point.time, value: point.value, interpolation: arrival[i] });
    }
    if (recording) {
      const frames = audioFrameCount(clip);
      if (clip.loop) {
        // playStart is where the clip's first pass begins in the recording. playStop is where the same audio would stop without the loop, so a
        // reader that ignores loops still ends the clip at its length; this reader takes the window from playStart to the end of the recording.
        const start = recording.offset / clip.sampleRate;
        element.setAttribute("playStart", String(start));
        element.setAttribute("playStop", String(Math.min(start + clip.duration, recording.frames / clip.sampleRate)));
      } else if (recording.offset !== 0 || frames !== recording.frames) {
        element.setAttribute("playStart", String(recording.offset / clip.sampleRate));
        element.setAttribute("playStop", String((recording.offset + frames) / clip.sampleRate));
      }
      if (!recordingPaths.has(recording.key)) {
        recordingPaths.set(recording.key, path);
        // A recording that came from the opened file keeps the file's own bytes under its own path.
        if (!source?.recordings.has(recording.key)) writeAudioSource(path, recording.source, entries, mediaEntries);
      }
    } else writeAudioSource(path, clip, entries, mediaEntries);
    if (clip.loop) {
      element.setAttribute("loopStart", String(clip.loop.startSeconds));
      element.setAttribute("loopEnd", String(clip.loop.endSeconds));
    }
    state.clips.push({
      track: track.id,
      index,
      id: clip.id,
      fingerprint: path,
      ...(gain === 1 ? {} : { audioGain: gain }),
      ...(clip.gainAutomation ? { gainAutomation: clip.gainAutomation } : {}),
    });
    return;
  }
  if (clip.loop) {
    element.setAttribute("loopStart", String(clip.loop.startBeat));
    element.setAttribute("loopEnd", String(clip.loop.endBeat));
  }
  // A window that does not start at the content's start: playStart is the content beat where the clip begins, playStop where it would end without a loop.
  if (clip.sourceOffset !== 0) {
    element.setAttribute("playStart", String(clip.sourceOffset));
    element.setAttribute("playStop", String(clip.sourceOffset + clip.duration));
  }
  // Clips that share notes write them once, with the first clip; each later one points at that timeline.
  const owner = linkOwners.get(clip.midi);
  if (owner) {
    // A Clip has no `id` in the schema, so the linked clip's identity travels in the private details, keyed by its place and target.
    const reference = owner.events ? `${owner.id}-content` : `${owner.id}-notes`;
    element.setAttribute("reference", reference);
    state.clips.push({ track: track.id, index, id: clip.id, fingerprint: `reference:${reference}`, noteIds: [] });
    return;
  }
  linkOwners.set(clip.midi, { id: clip.id, events: clip.events.length > 0 });
  const content = append(element, "Lanes", { id: `${clip.id}-content`, timeUnit: unit });
  const notes = untracked(() => clip.midi.notes.value);
  const notesNode = append(content, "Notes", { id: `${clip.id}-notes`, timeUnit: unit });
  for (const note of notes)
    append(notesNode, "Note", {
      time: note.start,
      duration: note.duration,
      channel: note.channel,
      key: note.pitch,
      vel: note.velocity,
    });
  const controls = controlsFromEvents(clip.events);
  const groups = new Map<string, ControlPoint[]>();
  for (const control of controls) {
    const key = `${control.expression ?? ""}:${control.channel}:${control.controller}`;
    const group = groups.get(key) ?? [];
    group.push(control);
    groups.set(key, group);
  }
  let groupIndex = 0;
  for (const group of groups.values()) {
    const { expression, channel, controller } = group[0];
    const kind = expression ?? "channelController";
    const points = append(content, "Points", { id: `${clip.id}-control${groupIndex++}`, timeUnit: unit, unit: "normalized" });
    append(points, "Target", {
      expression: kind,
      channel,
      ...(!expression ? { controller } : expression === "polyPressure" ? { key: controller } : {}),
    });
    // Each event holds its value until the next one: a step, which `hold` says and Bitwig Studio keeps (it ignores IntegerPoint).
    for (const point of group)
      append(points, "RealPoint", { time: point.time, value: controllerToNormalized(kind, point.value), interpolation: "hold" });
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

/** The clips in a track's Session slots, in no particular order. */
function slotClipsOf(project: Project, trackId: string) {
  return [...readSession(project).slots].filter(([key]) => splitSlotKey(key).trackId === trackId).map(([, clip]) => clip);
}

function prepareDawProject(
  project: Project,
  patch = true,
  /** The arrangement's time unit: beats for a file written fresh (what Bitwig writes and reads exactly), seconds for one patched from another application. */
  timeline?: "seconds" | "beats",
): {
  entries: Record<string, Uint8Array>;
  mediaEntries: Map<string, AudioClipSource>;
  preserved: Array<[string, Uint8Array | Blob]>;
  index: FreshIndex;
} {
  assertProjectActive(project);
  const source = sourceXml.get(project);
  const inBeats = (timeline ?? (patch && source?.overlay ? "seconds" : "beats")) === "beats";
  const map = project.tempoMap;
  const toBeat = (seconds: number) => snap12(seconds >= 0 ? map.secondsToBeat(seconds) : (seconds * map.initialBpm) / 60);
  const index: FreshIndex = new Map();
  const document = new DOMImplementation().createDocument(null, "Project", null);
  const root = document.documentElement!;
  root.setAttribute("version", "1.0");
  append(root, "Application", { name: "Audiorective", version: "3.0.0-beta.0" });
  const transport = append(root, "Transport");
  index.set("tempo", append(transport, "Tempo", { id: "transportTempo", unit: "bpm", value: project.bpm }));
  index.set(
    "signature",
    append(transport, "TimeSignature", { id: "transportSignature", numerator: project.signature[0], denominator: project.signature[1] }),
  );
  const structure = append(root, "Structure");
  const entries: Record<string, Uint8Array> = {};
  const mediaEntries = new Map<string, AudioClipSource>();
  const recordingPaths = new Map<object, string>();
  const manifest: HostManifest = { version: 1, devices: {} };
  let insertIndex = 0;
  for (const track of project.tracks) {
    const element = append(structure, "Track", { id: track.id, name: track.name, contentType: track.kind === "midi" ? "notes" : "audio" });
    index.set(`track:${track.id}`, element);
    // The channel count follows the track's first audio clip, on the timeline or else in a Session slot.
    const firstAudio = [...track.clips, ...slotClipsOf(project, track.id)].find((clip) => clip.kind === "audio");
    const channel = append(element, "Channel", {
      id: `${track.id}-channel`,
      role: track.busRole ?? "regular",
      destination: track.routing.outputBusId === null ? "masterChannel" : `${track.routing.outputBusId}-channel`,
      solo: track.solo,
      audioChannels: track.kind === "audio" && firstAudio ? audioChannelCount(firstAudio) : 2,
    });
    index.set(`channel:${track.id}`, channel);
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
        // The parameter table is the song's own values for the plug-in's parameters (other applications can read them); `parameterID` is the CLAP parameter ID.
        if (device.parameters.length) {
          const parameters = append(plugin, "Parameters");
          for (const record of device.parameters)
            append(parameters, "RealParameter", {
              id: `${device.id}-param-${record.id}`,
              parameterID: record.id,
              name: record.name,
              unit: record.normalized ? "normalized" : "linear",
              min: record.min,
              max: record.max,
              value: record.value,
            });
        }
        if (device.state.length) {
          const path = `plugins/${device.id}.bin`;
          append(plugin, "State", { path });
          entries[path] = new Uint8Array(device.state);
        }
        manifest.devices[device.id] = {
          kind: "webclap",
          bundleUrl: device.bundleUrl,
          ...(device.parameters.length
            ? {
                parameters: Object.fromEntries(
                  device.parameters.map((record) => [
                    record.id,
                    { default: record.default, ...(record.step === undefined ? {} : { step: record.step }) },
                  ]),
                ),
              }
            : {}),
        };
        index.set(`device:${track.id}:${device.id}`, plugin);
      }
      for (const effect of track.effects) {
        const device = append(devices, "BuiltinDevice", {
          deviceID: rackDevicePrefix + effect.type,
          deviceName: rackDeviceNames[effect.type],
          deviceVendor: "Audiorective",
          deviceRole: "audioFX",
          loaded: true,
        });
        index.set(`fx:${track.id}:${insertIndex}`, device);
        const path = `plugins/ar-insert-${++insertIndex}.json`;
        append(device, "State", { path });
        entries[path] = encoder.encode(JSON.stringify({ version: 1, effect }));
      }
    }
    index.set(`mute:${track.id}`, append(channel, "Mute", { id: `${track.id}-mute`, value: track.muted }));
    index.set(`pan:${track.id}`, append(channel, "Pan", { id: `${track.id}-pan`, unit: "normalized", value: (track.pan + 1) / 2, min: 0, max: 1 }));
    if (track.routing.sends.length) {
      const sends = append(channel, "Sends");
      index.set(`sends:${track.id}`, sends);
      for (const { busId, gain } of track.routing.sends) {
        const send = append(sends, "Send", { destination: `${busId}-channel`, type: "post" });
        append(send, "Volume", { unit: "linear", value: gain });
      }
    }
    index.set(`volume:${track.id}`, append(channel, "Volume", { id: `${track.id}-volume`, unit: "linear", value: track.volume }));
  }
  const master = append(structure, "Track", { id: "masterTrack", name: "Master", contentType: "audio" });
  const masterChannel = append(master, "Channel", { id: "masterChannel", role: "master", audioChannels: 2 });
  index.set("master", append(masterChannel, "Volume", { id: "masterVolume", unit: "linear", value: project.masterVolume }));
  const arrangement = append(root, "Arrangement", { id: "arrangement" });
  const lanes = append(arrangement, "Lanes", { id: "projectLanes", timeUnit: inBeats ? "beats" : "seconds" });
  const state: PrivateState = { version: ARRIVAL_STATE_VERSION, nextId: nextProjectId.get(project) ?? 1, clips: [] };
  const racks = project.tracks.filter((track) => track.effectMacros.length);
  if (racks.length) state.rackMacros = Object.fromEntries(racks.map((track) => [track.id, track.effectMacros]));
  const renders = new RenderCollector();
  const nextIndex = new Map<string, number>();
  const linkOwners = new Map<object, { id: string; events: boolean }>();
  for (const track of project.tracks) {
    const lane = append(lanes, "Lanes", { id: `${track.id}-lane`, track: track.id, timeUnit: inBeats ? "beats" : "seconds" });
    index.set(`lane:${track.id}`, lane);
    let clipIndex = 0;
    for (const unit of inBeats ? (["beats"] as const) : (["seconds", "beats"] as const)) {
      const group = inBeats ? track.clips : track.clips.filter((clip) => (clip.kind === "audio" ? unit === "seconds" : unit === "beats"));
      if (!group.length && (inBeats ? track.clips.length : unit === "beats" || track.clips.length)) continue;
      const clips = append(lane, "Clips", { id: `${track.id}-clips${unit === "beats" ? "-beats" : ""}`, timeUnit: unit });
      for (const clip of group) {
        writeClip(
          clip,
          clips,
          entries,
          mediaEntries,
          recordingPaths,
          state,
          track,
          clipIndex++,
          untracked(() => project.clipName(clip.id)),
          linkOwners,
          source,
          inBeats ? toBeat : undefined,
          inBeats,
          map,
          renders,
        );
        index.set(`clip:${clip.id}`, clips.lastChild as Element);
      }
    }
    nextIndex.set(track.id, clipIndex);
    for (const controllerLane of track.controllerLanes) {
      const key = controllerLaneKey(controllerLane);
      const points = append(lane, "Points", { id: `${track.id}-ctl-${key.replaceAll(":", "-")}`, timeUnit: "beats", unit: "normalized" });
      index.set(`ctl:${track.id}:${key}`, points);
      append(points, "Target", controllerTarget(controllerLane));
      const arrival = arrivalShapes(controllerLane.points);
      for (const [i, point] of controllerLane.points.entries())
        append(points, "RealPoint", {
          time: point.time,
          value: controllerToNormalized(controllerLane.expression, point.value),
          interpolation: arrival[i],
        });
    }
    if (track.volumeAutomation.length) {
      const points = append(lane, "Points", { id: `${track.id}-automation`, timeUnit: inBeats ? "beats" : "seconds" });
      index.set(`auto:${track.id}`, points);
      append(points, "Target", { parameter: `${track.id}-volume` });
      const arrival = arrivalShapes(track.volumeAutomation);
      for (const [i, point] of track.volumeAutomation.entries())
        append(points, "RealPoint", { time: inBeats ? toBeat(point.time) : point.time, value: point.value, interpolation: arrival[i] });
    }
  }
  if (project.markers.length) {
    const markers = append(arrangement, "Markers", { id: "projectMarkers", timeUnit: inBeats ? "beats" : "seconds" });
    index.set("markers", markers);
    for (const marker of project.markers) append(markers, "Marker", { time: inBeats ? toBeat(marker.time) : marker.time, name: marker.name });
  }
  if (project.tempoMap.changes.length) {
    const points = append(arrangement, "TempoAutomation", { id: "projectTempo", timeUnit: "beats", unit: "bpm" });
    index.set("tempoauto", points);
    append(points, "Target", { parameter: "transportTempo" });
    for (const step of [{ beat: 0, bpm: project.bpm }, ...project.tempoMap.changes])
      append(points, "RealPoint", { time: step.beat, value: step.bpm, interpolation: "hold" });
  }
  if (project.meterMap.changes.length) {
    const points = append(arrangement, "TimeSignatureAutomation", { id: "projectMeter", timeUnit: "beats" });
    index.set("meterauto", points);
    append(points, "Target", { parameter: "transportSignature" });
    const [numerator, denominator] = project.signature;
    for (const step of [{ beat: 0, numerator, denominator }, ...project.meterMap.changes])
      append(points, "TimeSignaturePoint", { time: step.beat, numerator: step.numerator, denominator: step.denominator });
  }
  const session = sessionFor(project);
  if (session.scenes.length) {
    // A scene lists only the slots that hold a clip: an empty slot is the absence of a ClipSlot.
    const scenes = append(root, "Scenes");
    for (const scene of session.scenes) {
      const sceneElement = append(scenes, "Scene", { id: scene.id, name: scene.name });
      index.set(`scene:${scene.id}`, sceneElement);
      const element = append(sceneElement, "Lanes", { timeUnit: "seconds" });
      for (const track of project.tracks) {
        const clip = session.clipAt({ trackId: track.id, sceneId: scene.id });
        if (!clip) continue;
        const slot = append(element, "ClipSlot", { track: track.id, timeUnit: clip.kind === "midi" ? "beats" : "seconds" });
        const slotIndex = nextIndex.get(track.id) ?? 0;
        nextIndex.set(track.id, slotIndex + 1);
        writeClip(
          clip,
          slot,
          entries,
          mediaEntries,
          recordingPaths,
          state,
          track,
          slotIndex,
          untracked(() => project.clipName(clip.id)),
          linkOwners,
          source,
          inBeats ? toBeat : undefined,
          false,
          map,
          renders,
        );
        index.set(`clip:${clip.id}`, slot.lastChild as Element);
      }
    }
  }
  const metadata = new DOMImplementation().createDocument(null, "MetaData", null);
  const titleElement = append(metadata.documentElement!, "Title");
  titleElement.textContent = project.title;
  index.set("title", titleElement);
  const serialize = (node: Document) =>
    encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(node).replaceAll("\r", "&#13;")}`);
  entries["project.xml"] = serialize(document);
  entries["metadata.xml"] = serialize(metadata);
  renders.finish(entries);
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
  for (const [id, record] of extensionRecords(project))
    entries[extensionPath(id)] = encoder.encode(JSON.stringify({ version: record.version, data: record.data }));
  // Files kept from the opened archive go back unchanged; a path this save writes itself takes precedence.
  const preserved: Array<[string, Uint8Array | Blob]> = [];
  if (patch && source?.overlay) {
    // The file keeps its own XML: only what the project changed since it was opened is written into it.
    const patched = applySourcePatch({
      source,
      index,
      entries,
      mediaEntries,
      preserved,
      secondsToBeat: (seconds) => project.tempoMap.secondsToBeat(seconds),
      tempoMap: project.tempoMap,
    });
    entries["project.xml"] = encoder.encode(patched.projectXml);
    entries["metadata.xml"] = encoder.encode(patched.metadataXml);
  }
  for (const [path, bytes] of preservedEntries.get(project) ?? [])
    if (!entries[path] && !mediaEntries.has(path) && !preserved.some(([kept]) => kept === path)) preserved.push([path, bytes]);
  return { entries, mediaEntries, preserved, index };
}

/** What the model writes for the project, by entity: the baseline a later save compares with to find what changed. */
function freshKeys(project: Project) {
  // The baseline is compared with what a patch writes, which keeps the source's seconds.
  return snapshot(prepareDawProject(project, false, "seconds").index);
}

const extensionPath = (id: string) => `extensions/${id}/data.json`;
const EXTENSION_PATH = /^extensions\/([^/]+)\/data\.json$/;

/** Turn a Project into `.dawproject` file bytes you can download or store. Use it for a song held in memory, in Node or the browser; a song with file-backed audio throws, use `saveDawProjectTo`. */
export function saveDawProject(project: Project): Uint8Array<ArrayBuffer> {
  const { entries, mediaEntries, preserved } = prepareDawProject(project);
  if (mediaEntries.size || preserved.some(([, bytes]) => !(bytes instanceof Uint8Array)))
    throw new Error("Project file-backed audio needs saveDawProjectTo().");
  for (const [path, bytes] of preserved) entries[path] = bytes as Uint8Array;
  return zipSync(entries, { level: 6 }) as Uint8Array<ArrayBuffer>;
}

/** Write a Project as a `.dawproject` file into a stream (a file you picked, a download) without holding the whole file in memory. Use it for large songs and any song with file-backed audio. */
export async function saveDawProjectTo(project: Project, destination: WritableStream<Uint8Array>): Promise<void> {
  const { entries, mediaEntries, preserved } = prepareDawProject(project);
  for (const [path, bytes] of preserved) if (bytes instanceof Uint8Array) entries[path] = bytes;
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
  for (const [path, blob] of preserved)
    if (blob instanceof Blob)
      files.push({
        path,
        size: blob.size,
        async *chunks() {
          for (let at = 0; at < blob.size; at += 1024 * 1024)
            yield new Uint8Array(await blob.slice(at, Math.min(blob.size, at + 1024 * 1024)).arrayBuffer());
        },
      });
  await writeStoredZip(files, destination);
}

/** The one level a gain curve holds from its first point to its last (linear values), or undefined when it moves or is not plain. */
function flatGainOf(points: Element): number | undefined {
  if ((points.getAttribute("unit") ?? "linear") !== "linear") return;
  const values = direct(points, "RealPoint").map((point) => Number(point.getAttribute("value")));
  return values.length && values.every((value) => Number.isFinite(value) && value >= 0 && value === values[0]) ? values[0] : undefined;
}

/**
 * The audio of a clip in Bitwig's nested form (see `NestedAudioLink`): the audio element, the part of the file it plays and a flat gain. A form
 * the model cannot carry is skipped with the exact reason, so the clip stays in the file as it is and the open warning says why.
 *
 * Units: `start` and `length` are the outer clip's, in `unit`; the window is in seconds of the file. The warp counts as unstretched when audio
 * seconds advance as timeline seconds do (`warpVerdict`, tolerance `warpTolerance`), which is where a clip written in beats at the song's own
 * tempo lands; a loop that spans the whole clip is the same as no loop, any other loop is not read.
 */
function readNestedAudio(input: {
  outer: Element;
  clips: Element;
  unit: "seconds" | "beats";
  start: number;
  length: number;
  toSeconds: (position: number) => number;
  tempoBreaks: readonly number[];
}): {
  audio: Element;
  startSeconds: number;
  stopSeconds: number;
  gain?: number;
  /** A moving gain curve of the clip's content lanes (Bitwig's form), read in the curve's own time unit; the window starts at the file's start. */
  curve?: { points: Element; unit: "seconds" | "beats"; values: GainCurveValues };
  link: NestedAudioLink;
  /** Set when the warp stretches the audio: its time map, and whether the file asks for a pitch-preserving stretch. */
  stretch?: { knots: WarpKnot[]; pitchPreserving: boolean; exactRatio?: number };
} {
  const { outer, clips, unit, start, length, tempoBreaks } = input;
  const elapsed = unit === "beats" ? input.toSeconds : (position: number) => position;
  if ((outer.getAttribute("contentTimeUnit") ?? unit) !== unit) skip("Audio clip whose nested clips use another time unit");
  attributesOnly(clips, ["id", "track", "timeUnit", "name", "color", "comment"]);
  childrenOnly(clips, ["Clip"]);
  if ((clips.getAttribute("timeUnit") ?? unit) !== unit) skip("Audio clip whose nested clips use another time unit");
  const inners = direct(clips, "Clip");
  if (inners.length !== 1) skip("Audio clip with several nested clips");
  const inner = inners[0];
  attributesOnly(inner, [
    "name",
    "color",
    "comment",
    "time",
    "duration",
    "contentTimeUnit",
    "playStart",
    "playStop",
    "fadeTimeUnit",
    "fadeInTime",
    "fadeOutTime",
    "enable",
  ]);
  if (inner.hasAttribute("loopStart") || inner.hasAttribute("loopEnd") || inner.hasAttribute("reference") || inner.getAttribute("enable") === "false")
    skip("Audio clip with a loop or a reference in its nested clip");
  // Both clips are the same stretch of the timeline: the nested one starts with the outer one and is as long.
  const innerTime = inner.hasAttribute("time") ? numberAttr(inner, "time", -Infinity) : 0;
  const innerLength = inner.hasAttribute("duration") ? numberAttr(inner, "duration") : length;
  const total = elapsed(start + length) - elapsed(start);
  const contentUnit = inner.getAttribute("contentTimeUnit") ?? "seconds";
  const inside = direct(inner, "Audio").length + direct(inner, "Lanes").length + direct(inner, "Warps").length;
  const found = direct(inner, "Warps")[0];
  childrenOnly(inner, ["Audio", "Lanes", "Warps"]);
  if (inside !== 1 || kids(inner).length !== 1) skip("Audio clip without audio content");
  const holder = found ?? inner;
  if (found) {
    attributesOnly(found, ["id", "timeUnit", "contentTimeUnit", "track", "name", "color", "comment"]);
    childrenOnly(found, ["Audio", "Lanes", "Warp"]);
    if (found.getAttribute("contentTimeUnit") !== "seconds" || (found.getAttribute("timeUnit") ?? contentUnit) !== unit || contentUnit !== unit)
      skip("Audio clip with warps in a time unit other than its timeline's");
    if (direct(found, "Audio").length + direct(found, "Lanes").length !== 1) skip("Audio clip without audio content");
  } else if (contentUnit !== "seconds") skip("Audio clip with content in a time unit other than seconds");
  // The gain: a content Lanes holding the audio and, at most, one flat gain Points.
  let audio = direct(holder, "Audio")[0];
  let gain: number | undefined;
  let moving: { points: Element; unit: "seconds" | "beats"; values: GainCurveValues } | undefined;
  let gainPoints: Element | undefined;
  const lanes = direct(holder, "Lanes")[0];
  if (lanes) {
    attributesOnly(lanes, ["id", "timeUnit", "name", "color", "comment"]);
    childrenOnly(lanes, ["Audio", "Points"]);
    audio = direct(lanes, "Audio")[0];
    const curves = direct(lanes, "Points");
    if (direct(lanes, "Audio").length !== 1) skip("Audio clip without audio content");
    if (curves.length > 1 || !curves.every((points) => one(points, "Target", false)?.getAttribute("expression") === "gain"))
      skip("Audio clip with a gain curve or other automation");
    if (curves.length === 1) {
      gain = flatGainOf(curves[0]);
      if (gain === undefined) {
        // Bitwig writes a curve with no `timeUnit` in the unit of the file's timeline.
        const read = readGainCurve(curves[0], lanes, unit);
        if (!read) skip("Audio clip with a gain curve or other automation");
        moving = { points: curves[0], ...read! };
      }
      gainPoints = curves[0];
    }
  }
  const rate = integerAttr(audio, "sampleRate", 1);
  const tolerance = warpTolerance(rate);
  // The nested clip starts with the outer one and runs at least as far: the outer clip's length cuts what the inner one holds.
  const innerTotal = elapsed(start + innerLength) - elapsed(start);
  if (Math.abs(elapsed(start + innerTime) - elapsed(start)) > tolerance || innerTotal < total - tolerance)
    skip("Audio clip whose nested clip does not cover it");
  // A loop as long as the clip repeats nothing; any other one is a different playback the model does not read from this form.
  if (outer.hasAttribute("loopStart") || outer.hasAttribute("loopEnd")) {
    const at = outer.hasAttribute("playStart") ? numberAttr(outer, "playStart", -Infinity) : 0;
    const loop = readLoop(outer);
    if (loop && (loop.start > at + 1e-6 || loop.end < at + length - 1e-6)) skip("Audio clip with a loop inside nested clips");
  }
  let startSeconds: number;
  let stopSeconds: number;
  let stretch: { knots: WarpKnot[]; pitchPreserving: boolean; exactRatio?: number } | undefined;
  if (found) {
    const points = readWarpPoints(found);
    const from = inner.hasAttribute("playStart") ? numberAttr(inner, "playStart", -Infinity) : 0;
    const verdict = warpVerdict({ points, from, length: innerLength, start, elapsed, tempoBreaks, tolerance });
    if (!verdict.identity && verdict.reason === "outside") throw new Unmodeled("Audio clip whose warp markers do not cover it");
    if (verdict.identity) {
      startSeconds = verdict.contentStart;
      stopSeconds = startSeconds + total;
    } else {
      // The warp stretches the audio: the model keeps the file's window, the ratio and a knot wherever the speed changes.
      const knots = warpKnots({
        points,
        from,
        length,
        start,
        elapsed,
        tempoBreaks: unit === "beats" ? tempoBreaks : [],
        tolerance: 0.5 / rate,
      });
      if (!knots) throw new Unmodeled("Audio clip whose warp markers run backwards or stand still");
      const algorithm = audio.getAttribute("algorithm");
      // One speed over the window: its ratio is the warp's own, not the quotient of the clip's rounded frame counts (see `exactWarpRatio`).
      const exactRatio = knots.length === 2 ? exactWarpRatio({ points, from, length, start, elapsed }) : undefined;
      stretch = { knots, pitchPreserving: algorithm === null || algorithm === "stretch", ...(exactRatio === undefined ? {} : { exactRatio }) };
      startSeconds = knots[0].content;
      stopSeconds = knots[knots.length - 1].content;
    }
  } else {
    startSeconds = inner.hasAttribute("playStart") ? numberAttr(inner, "playStart", -Infinity) : 0;
    stopSeconds = inner.hasAttribute("playStop") ? numberAttr(inner, "playStop", -Infinity) : startSeconds + innerTotal;
    if (Math.abs(stopSeconds - startSeconds - innerTotal) > tolerance)
      skip(
        `Audio clip whose audio window (${(stopSeconds - startSeconds).toFixed(3)} s) is not as long as its place on the timeline (${innerTotal.toFixed(3)} s) ` +
          "and has no warp markers that say how it is stretched",
      );
    stopSeconds = startSeconds + total;
  }
  // A moving curve is read where it is certain: unstretched audio from the file's start, where the curve's time 0 is the clip's first sample whichever
  // clip's timeline it counts on. For a trimmed or stretched clip Bitwig's own origin was not verified, so the clip stays in the file as it is.
  if (moving?.values.some((point) => point.time < 0)) skip("Audio clip with a gain curve that starts before its audio");
  if (moving && stretch) skip("Audio clip with a moving gain curve inside a stretched nested clip");
  if (moving && Math.abs(startSeconds) > tolerance) skip("Audio clip with a moving gain curve inside a trimmed nested clip");
  return {
    audio,
    startSeconds,
    stopSeconds,
    gain,
    ...(moving ? { curve: moving } : {}),
    link: { inner, audio, ...(found ? { warps: found } : {}), ...(gainPoints ? { gain: gainPoints } : {}) },
    ...(stretch ? { stretch } : {}),
  };
}

/**
 * A moving gain curve (`Points` with `expression="gain"`, linear values) as model points in the curve's own time unit; undefined for any other
 * unit, a point the model cannot hold, or fewer than two points. Two points at one time are a step: the later one wins.
 */
function readGainCurve(points: Element, lanes: Element, fallbackUnit: "seconds" | "beats" = "seconds") {
  if ((points.getAttribute("unit") ?? "linear") !== "linear") return;
  const unit = gainCurveUnit(points, lanes, fallbackUnit);
  if (!unit) return;
  const raw = direct(points, "RealPoint");
  const values: Array<{ time: number; value: number; shape: "linear" | "hold" }> = [];
  for (const point of raw) {
    const time = Number(point.getAttribute("time"));
    const value = Number(point.getAttribute("value"));
    const shape = point.getAttribute("interpolation") ?? "linear";
    if (!Number.isFinite(time) || !Number.isFinite(value) || value < 0 || (shape !== "linear" && shape !== "hold")) return;
    values.push({ time, value, shape });
  }
  values.sort((a, b) => a.time - b.time);
  // A pair at one time is a step: a hold when the earlier point repeats the value before it (how Bitwig writes one), else the later one wins.
  const unique = foldSteps(values) ?? values.filter((point, i) => values[i + 1]?.time !== point.time);
  if (unique.length < 2) return undefined;
  // The file's `interpolation` is how a value arrives at its point; the model's `shape` is how it leaves.
  const leaving = leavingShapes(unique.map((point) => point.shape));
  return { unit, values: unique.map((point, i) => ({ ...point, shape: leaving[i] })) };
}

function gainCurveUnit(points: Element, lanes: Element, fallback: "seconds" | "beats" = "seconds"): "seconds" | "beats" | undefined {
  const unit = points.getAttribute("timeUnit") ?? lanes.getAttribute("timeUnit") ?? fallback;
  return unit === "seconds" || unit === "beats" ? unit : undefined;
}

/** Times converted through the tempo map, in either direction, are exact to 1e-12 (seconds or beats): finer float noise is dropped. */
const snap12 = (seconds: number) => Math.round(seconds * 1e12) / 1e12;

function readPrivate(bytes: Uint8Array | undefined, warnings: string[]): PrivateState | undefined {
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (
      !value ||
      typeof value !== "object" ||
      ![1, 2, 3, 4].includes((value as PrivateState).version) ||
      !Array.isArray((value as PrivateState).clips)
    )
      throw new Error();
    const state = value as PrivateState;
    const ids = new Set<string>();
    for (const clip of state.clips) {
      if (!clip || typeof clip.id !== "string" || !validProjectId(clip.id) || ids.has(clip.id)) throw new Error();
      ids.add(clip.id);
    }
    return state;
  } catch {
    warnings.push("Audiorective project details are invalid; standard project data was used.");
    return undefined;
  }
}

/**
 * A ClapPlugin's `Parameters` as a device parameter table: a `RealParameter`, `IntegerParameter` or `BoolParameter` with a whole-number `parameterID` (the CLAP ID), a finite `value`
 * and, for the number kinds, a finite `min` and `max` around it. `defaults` (the sidecar's `parameters`) gives each one's default and step; without it the default is the value.
 * Anything else is skipped with a warning, and the plug-in's own report replaces the table when it loads.
 */
function readDeviceParameters(
  element: Element | undefined,
  defaults: Readonly<Record<string, { default?: unknown; step?: unknown }>> | undefined,
  warn: (message: string) => void,
): DeviceParameterRecord[] {
  const table: DeviceParameterRecord[] = [];
  if (!element) return table;
  const seen = new Set<string>();
  let skipped = 0;
  const foreign = new Set<string>();
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const item = node as Element;
    const id = item.getAttribute("parameterID") ?? "";
    const bool = item.tagName === "BoolParameter";
    const flag = boolText(item.getAttribute("value"));
    const value = bool ? (flag === null ? Number.NaN : Number(flag)) : Number(item.getAttribute("value"));
    const min = bool ? 0 : Number(item.getAttribute("min"));
    const max = bool ? 1 : Number(item.getAttribute("max"));
    const unit = item.getAttribute("unit");
    // `normalized` is a 0..1 fraction of the plug-in's range, mapped when the plug-in loads; `linear` or no unit is the plug-in's own value. Any other unit has no mapping here.
    if (item.tagName === "RealParameter" && unit !== null && unit !== "linear" && unit !== "normalized") {
      foreign.add(unit);
      continue;
    }
    const known = defaults && Object.hasOwn(defaults, id) ? defaults[id] : undefined;
    const fallback = typeof known?.default === "number" && Number.isFinite(known.default) ? known.default : value;
    if (
      !["RealParameter", "IntegerParameter", "BoolParameter"].includes(item.tagName) ||
      !/^(?:0|[1-9]\d{0,9})$/.test(id) ||
      seen.has(id) ||
      ![min, max, value].every(Number.isFinite) ||
      min > max ||
      value < min ||
      value > max ||
      (item.getAttribute("value") ?? "") === ""
    ) {
      skipped++;
      continue;
    }
    seen.add(id);
    if (item.tagName === "RealParameter" && unit === "normalized" && max > min) {
      // Whatever `min` and `max` say, the value is a fraction of the plug-in's range.
      table.push({
        id,
        name: item.getAttribute("name") ?? id,
        min: 0,
        max: 1,
        default: Math.min(1, Math.max(0, (fallback - min) / (max - min))),
        value: (value - min) / (max - min),
        normalized: true,
      });
      continue;
    }
    table.push({
      id,
      name: item.getAttribute("name") ?? id,
      min,
      max,
      default: Math.min(max, Math.max(min, fallback)),
      value,
      ...(known?.step === 1 || bool || item.tagName === "IntegerParameter" ? { step: 1 as const } : {}),
    });
  }
  if (foreign.size)
    warn(
      `parameters with the unit ${[...foreign].map((unit) => `"${unit}"`).join(", ")} cannot be mapped to the plug-in's values and were skipped; the plug-in's saved state sets them.`,
    );
  if (skipped) warn(`${skipped} parameter${skipped === 1 ? "" : "s"} in the file could not be read and were skipped.`);
  return table;
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

/** The clip's loop in its content time, or undefined. `loopStart` and `loopEnd` come together and `loopStart < loopEnd`. */
function readLoop(clip: Element): { start: number; end: number } | undefined {
  const has = clip.hasAttribute("loopStart");
  if (has !== clip.hasAttribute("loopEnd")) throw new Error("Project clip loop needs both loopStart and loopEnd.");
  if (!has) return;
  const start = numberAttr(clip, "loopStart");
  const end = numberAttr(clip, "loopEnd");
  if (!(start < end)) throw new Error("Project clip loop needs loopStart before loopEnd.");
  return { start, end };
}

/** A MIDI clip's `playStart`: the content position where the clip begins (0 without one). `playStop` only has to lie after it. */
/**
 * The controller lane a `Points` holds, or a short reason it holds something the model cannot carry (an expression other than the MIDI ones, a unit
 * it cannot scale, a value outside the range). `IntegerPoint` values are the raw MIDI values and always hold; `RealPoint` values are `normalized` (0 to 1,
 * also when `unit` is absent: Bitwig Studio 5's files) and scale by the expression's range, rounded to the nearest integer. Times are as written.
 * A controller number above `maxController` is a reason too.
 */
function readControllerPoints(points: Element, maxController: number): ControllerLane | string {
  attributesOnly(points, ["id", "track", "timeUnit", "unit", "name", "color", "comment"]);
  const target = one(points, "Target", false);
  if (!target) return "no Target";
  attributesOnly(target, ["expression", "channel", "controller", "key"]);
  childrenOnly(target, []);
  const mode = target.getAttribute("expression");
  const expression = controllerExpressions.find((item) => item === mode);
  if (!expression) return `expression ${mode === null ? "(none)" : `"${mode}"`}`;
  const channelText = target.getAttribute("channel");
  const channel = Number(channelText);
  if (channelText === null || !channelText.trim() || !Number.isInteger(channel) || channel < 0 || channel > 15)
    return `${expression} without a channel from 0 to 15`;
  let controller = 0;
  if (expression === "channelController" || expression === "polyPressure") {
    const name = expression === "channelController" ? "controller" : "key";
    const text = target.getAttribute(name);
    controller = Number(text);
    if (text === null || !text.trim() || !Number.isInteger(controller) || controller < 0 || controller > (name === "key" ? 127 : maxController))
      return `${expression} ${name} ${text === null ? "(none)" : `"${text}"`}`;
  }
  const unit = points.getAttribute("unit");
  const max = controllerMax(expression);
  const out: ControllerPoint[] = [];
  for (let node = points.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const point = node as Element;
    if (point.tagName === "Target") continue;
    if (point.tagName !== "IntegerPoint" && point.tagName !== "RealPoint") return `${point.tagName} points`;
    attributesOnly(point, point.tagName === "RealPoint" ? ["time", "value", "interpolation"] : ["time", "value"]);
    childrenOnly(point, []);
    const time = numberAttr(point, "time", -Infinity);
    if (time < 0) return "a negative time";
    const raw = numberAttr(point, "value", -Infinity);
    if (point.tagName === "IntegerPoint") {
      if (!Number.isInteger(raw) || raw < 0 || raw > max) return `${expression} value ${raw} outside 0 to ${max}`;
      out.push({ time, value: raw, shape: "hold" });
      continue;
    }
    if (unit !== null && unit !== "normalized") return `${expression} in unit "${unit}"`;
    if (!(raw >= -1e-9 && raw <= 1 + 1e-9)) return `${expression} value ${raw} outside 0 to 1`;
    const interpolation = point.getAttribute("interpolation") ?? "linear";
    if (interpolation !== "linear" && interpolation !== "hold") return `interpolation "${interpolation}"`;
    out.push({ time, value: controllerFromNormalized(expression, raw), shape: interpolation });
  }
  if (!out.length) return `${expression} without points`;
  // Stable by time: a step may be two points at one time, in file order.
  const ordered = out.map((point, index) => ({ point, index })).sort((a, b) => a.point.time - b.point.time || a.index - b.index);
  const shapes = leavingShapes(ordered.map(({ point }) => point.shape));
  const leaving = ordered.map(({ point }, i) => ({ ...point, shape: shapes[i] }));
  return Object.freeze({ expression, channel, controller, points: Object.freeze(leaving) });
}

function readMidiWindow(clip: Element): number {
  const start = clip.hasAttribute("playStart") ? numberAttr(clip, "playStart", -Infinity) : 0;
  if (clip.hasAttribute("playStop") && !(numberAttr(clip, "playStop", -Infinity) > start))
    throw new Error("Project MIDI clip needs playStart before playStop.");
  return start;
}

function readMidi(
  clip: Element,
  trackId: string,
  index: number,
  unit: "seconds" | "beats",
  stored: PrivateState | undefined,
  fail: (error: Error) => never,
  warn: (message: string) => void,
) {
  if (direct(clip, "Audio").length) fail(new Error("Project MIDI clip has unsupported audio content."));
  const time = numberAttr(clip, "time");
  const duration = numberAttr(clip, "duration");
  const contentUnit = clip.getAttribute("contentTimeUnit") ?? unit;
  if (contentUnit !== unit) fail(new Error("Project MIDI clip content time must match its clip lane."));
  // The notes sit in a Lanes (this package's files, which can also hold controller points) or directly in the Clip (Bitwig's).
  const content = one(clip, "Lanes", false);
  const holder = content ?? clip;
  if (content) {
    attributesOnly(content, ["id", "timeUnit", "name", "color", "comment"]);
    if ((content.getAttribute("timeUnit") ?? unit) !== unit) fail(new Error("Project MIDI clip content time must match its clip lane."));
    childrenOnly(content, ["Notes", "Points"]);
  } else childrenOnly(clip, ["Notes"]);
  for (const other of Array.from(clip.childNodes))
    if (other.nodeType === 1 && !["Lanes", "Notes"].includes((other as Element).tagName)) skip(`Clip with ${(other as Element).tagName} content`);
  const notesNode = one(holder, "Notes", false);
  if (notesNode) {
    attributesOnly(notesNode, ["id", "timeUnit", "name", "color", "comment"]);
    if ((notesNode.getAttribute("timeUnit") ?? unit) !== unit) fail(new Error("Project MIDI clip content time must match its clip lane."));
    childrenOnly(notesNode, ["Note"]);
  }
  const notes = notesNode
    ? direct(notesNode, "Note").map((element, noteIndex) => {
        attributesOnly(element, ["time", "duration", "channel", "key", "vel", "rel"]);
        childrenOnly(element, []);
        const start = numberAttr(element, "time", -Infinity),
          duration = numberAttr(element, "duration");
        // The model's notes start at content beat 0 or later and the clip window (sourceOffset) cannot reach back past a note: a clip whose content
        // begins before beat 0 would have to move its origin, which a save could not undo for the source's own timelines. It stays in the file.
        if (start < 0) fail(new Error("Clip with a note before the start of its content (a negative time)"));
        // The schema requires `channel` and gives no default; Studio One leaves it out and its notes play on the first channel.
        if (!element.hasAttribute("channel"))
          warn("Notes without a channel attribute were read as channel 0 (the schema requires it and has no default).");
        return {
          id: `imported-${trackId}-${index}-${noteIndex}`,
          start,
          duration,
          pitch: integerAttr(element, "key", 0, 127),
          velocity: element.hasAttribute("vel") ? numberAttr(element, "vel", 0, 1) : 1,
          channel: element.hasAttribute("channel") ? integerAttr(element, "channel", 0, 15) : 0,
        };
      })
    : [];
  const controls: ControlPoint[] = [];
  for (const points of content ? direct(content, "Points") : []) {
    if ((points.getAttribute("timeUnit") ?? unit) !== unit) fail(new Error("Project MIDI clip content time must match its clip lane."));
    const lane = readControllerPoints(points, 127);
    if (typeof lane === "string") {
      note(`MIDI clip Points with ${lane}`);
      unmodeledPoints.add(points);
      continue;
    }
    // A linear segment becomes the events a lane plays; a clip in seconds is read at its points, because its beats are not known yet.
    const read =
      unit === "beats" ? controllerEvents(lane.expression, lane.points) : lane.points.map((point) => ({ beat: point.time, value: point.value }));
    if (unit === "seconds" && lane.points.some((point) => point.shape === "linear"))
      warn("A linear MIDI controller lane in a clip in seconds was read at its points.");
    for (const event of read)
      controls.push({
        time: event.beat,
        channel: lane.channel,
        controller: lane.controller,
        value: event.value,
        ...(lane.expression === "channelController" ? {} : { expression: lane.expression as Expression }),
      });
  }
  const lanesId = content?.getAttribute("id") ?? null;
  const match = stored?.clips.find(
    (item) =>
      item.track === trackId &&
      ((lanesId !== null && lanesId === `${item.id}-content`) || (item.index === index && !String(item.fingerprint).startsWith("reference:"))),
  );
  const expected = fingerprint(notes, controls, time, duration, unit);
  const usable =
    match &&
    stored !== undefined &&
    stored.version >= 3 &&
    match.fingerprint === expected &&
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
  if (usable)
    notes.forEach((note, i) => {
      note.id = match.noteIds![i];
    });
  const events: ProjectMidiEvent[] = usable
    ? match.events!.map((event) => ({ time: event.time, data: new Uint8Array(event.data), noteId: event.noteId }))
    : controls.map(eventFromControl);
  return {
    name: clip.getAttribute("name") || undefined,
    time,
    duration,
    notes,
    events,
    id: usable ? match.id : undefined,
    unmatched: !usable,
    sourceOffset: readMidiWindow(clip),
    loop: readLoop(clip),
    timelines: [content?.getAttribute("id") ?? null, notesNode?.getAttribute("id") ?? null] as const,
  };
}

/** Read `.dawproject` file bytes into a Project, without a Workspace, so it also runs in Node. Use it to inspect or edit a song; use `openWorkspace` to play it. Returns the Project and the warnings for what it kept but cannot play. */
export function openDawProject(bytes: Uint8Array): OpenDawProjectResult {
  return readDawProjectBytes(bytes);
}

/** The most one entry, and all entries together, may hold once unpacked from an archive in memory; each entry is also held to the size its directory declares. */
/** Frames a decoded compressed file may fall short of the end a clip window asks for (MP3 and AAC decoders drop up to 1105 priming frames and pad the last block). */
const DECODER_PADDING_FRAMES = 2048;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
/** The Blob reader's limits for XML and JSON entries; every other entry that is not audio (plug-in state, sampler presets) gets `MAX_ENTRY_BYTES` and `MAX_UNPACKED_BYTES`, as in the bytes reader. */
const MAX_TEXT_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
/** Compressed bytes pushed to the inflater at once. */
const INFLATE_SLICE = 16 * 1024;

function readDawProjectBytes(bytes: Uint8Array, decoded?: DecodedAudioFiles): OpenDawProjectResult {
  if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024 * 1024) throw new Error("Project archive is missing or too large.");
  const directory = zipDirectory(bytes);
  // The directory's sizes bound the work before any entry is inflated; each entry is then held to its own declared size while it inflates.
  let total = 0;
  for (const entry of directory.values()) {
    total += entry.size;
    if (entry.size > MAX_ENTRY_BYTES || total > MAX_UNPACKED_BYTES) throw new Error("Project archive is too large.");
  }
  const entries: ArchiveEntries = Object.create(null) as ArchiveEntries;
  for (const [name, entry] of directory) {
    const data = readZipEntry(bytes, entry);
    verifyZipEntry(name, entry, data.length, crc32(0xffffffff, data));
    entries[name] = data;
  }
  return parseDawProjectEntries(entries, decoded);
}

function verifyZipEntry(name: string, entry: { size: number; crc: number }, size: number, crc: number): void {
  if (size !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) throw new Error(`Project archive entry is corrupt: ${name}.`);
}

/** Read a `.dawproject` Blob or File into a Project, without a Workspace. Use it for a file you picked: large WAV audio stays on disk instead of being copied into memory. */
export async function openDawProjectBlob(blob: Blob): Promise<OpenDawProjectResult> {
  return readDawProjectBlob(blob);
}

async function readDawProjectBlob(blob: Blob, decoded?: DecodedAudioFiles): Promise<OpenDawProjectResult> {
  if (!(blob instanceof Blob) || blob.size < 1 || blob.size > 4 * 1024 * 1024 * 1024) throw new Error("Project archive is missing or too large.");
  const directory = await zipBlobDirectory(blob);
  const entries: ArchiveEntries = Object.create(null) as ArchiveEntries;
  const files = new Map<string, { chunks: (Uint8Array | Blob)[]; size: number; media: boolean }>();
  let failure: unknown;
  let total = 0;
  let textTotal = 0;
  let binaryTotal = 0;
  const byReaderName = new Map([...directory.values()].map((entry) => [entry.zipName, entry] as const));
  const unzip = new Unzip((file) => {
    if (file.name.endsWith("/")) return;
    const declared = byReaderName.get(file.name);
    if (!declared) {
      failure = new Error("Project archive is incomplete or corrupt.");
      return;
    }
    // The directory decides what an entry is called; `file.name` is the unpacker's reading of the same bytes.
    const name = declared.name;
    if (files.size >= 10_000 || files.has(name) || !safeArchivePath(name)) {
      failure = new Error("Project archive has duplicate or unsafe paths.");
      return;
    }
    let crc = 0xffffffff;
    const media = isAudioPath(name);
    const text = !media && isTextPath(name);
    const record = { chunks: [] as (Uint8Array | Blob)[], size: 0, media };
    files.set(name, record);
    file.ondata = (error, chunk, final) => {
      if (error) {
        failure = error;
        return;
      }
      if (failure) return;
      record.size += chunk?.length ?? 0;
      total += chunk?.length ?? 0;
      if (text) textTotal += chunk?.length ?? 0;
      else if (!media) binaryTotal += chunk?.length ?? 0;
      if (
        record.size > (media ? 0xffffffff : text ? MAX_TEXT_ENTRY_BYTES : MAX_ENTRY_BYTES) ||
        textTotal > MAX_TEXT_BYTES ||
        binaryTotal > MAX_UNPACKED_BYTES ||
        total > 8 * 1024 * 1024 * 1024
      ) {
        failure = new Error("Project archive is too large.");
        return;
      }
      if (record.size > declared.size) {
        failure = new Error(`Project archive entry is larger than its directory declares: ${name}.`);
        return;
      }
      if (chunk?.length) {
        crc = crc32(crc, chunk);
        record.chunks.push(media ? new Blob([chunk as Uint8Array<ArrayBuffer>]) : chunk);
      }
      if (final) {
        verifyZipEntry(name, declared, record.size, crc);
        if (media) {
          const mediaBlob = new Blob(record.chunks as BlobPart[]);
          entries[name] = { blob: mediaBlob, header: new Uint8Array() };
        } else {
          const bytes = new Uint8Array(record.size);
          let at = 0;
          for (const part of record.chunks) {
            if (!(part instanceof Uint8Array)) throw new Error("Project archive has invalid entry data.");
            bytes.set(part, at);
            at += part.length;
          }
          entries[name] = bytes;
        }
        record.chunks.length = 0;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let at = 0; at < blob.size; at += 1024 * 1024) {
    const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + 1024 * 1024)).arrayBuffer());
    // A slice of compressed data expands to at most about 1000 times its length: small pushes keep an entry that lies about its size from filling memory in one step.
    for (let part = 0; part < bytes.length; part += INFLATE_SLICE) {
      const last = part + INFLATE_SLICE >= bytes.length;
      unzip.push(bytes.subarray(part, part + INFLATE_SLICE), last && at + bytes.length === blob.size);
      if (failure) throw failure;
    }
  }
  if ([...directory.keys()].some((path) => !entries[path])) throw new Error("Project archive is incomplete.");
  const projectXml = entries["project.xml"] instanceof Uint8Array ? decoder.decode(entries["project.xml"]) : "";
  const referencedFiles = new Set(Array.from(projectXml.matchAll(/<File\s[^>]*?\bpath="([^"]*)"/g), (match) => match[1]));
  for (const [path, entry] of Object.entries(entries)) {
    if (entry instanceof Uint8Array) continue;
    entry.header = new Uint8Array(await entry.blob.slice(0, 44).arrayBuffer());
    // Only canonical float32 WAV stays file-backed. A clip's WAV in another format is decoded from memory, as another DAW wrote it.
    if (!referencedFiles.has(path)) continue;
    try {
      mediaFromWav(entry.blob, entry.header);
    } catch {
      entries[path] = new Uint8Array(await entry.blob.arrayBuffer());
    }
  }
  const first = parseDawProjectEntries(entries, decoded);
  const wanted = wavPcmFiles.get(first.project);
  if (!wanted?.size) return first;
  // A stretched clip needs the PCM of the window it plays from a WAV the first reading kept file-backed (and the renders the file holds): read those and read the archive again.
  const decodedWavs = new Map(decoded ?? []);
  try {
    for (const [key, { blob: wav, window }] of wanted) {
      if (!window) {
        decodedWavs.set(key, decodeWav(new Uint8Array(await wav.arrayBuffer())));
        continue;
      }
      // Only the window the stretch plays: the original itself stays on disk.
      const media = mediaFromWav(wav, new Uint8Array(await wav.slice(0, 44).arrayBuffer()));
      decodedWavs.set(key, { sampleRate: media.sampleRate, channels: await media.readFrames(window.from, window.to - window.from) });
    }
  } catch (error) {
    first.project.dispose();
    throw error;
  }
  first.project.dispose();
  return parseDawProjectEntries(entries, decodedWavs);
}

registerArchiveReaders({ bytes: readDawProjectBytes, blob: readDawProjectBlob });
registerKeptContent({
  shift: (project, edit, verb) => shiftKeptContent(project, sourceXml.get(project), edit, verb),
  spans: (project, trackId) => keptClipSpans(project, sourceXml.get(project), trackId),
  commit: (project, entry) => commitKeptShifts(sourceXml.get(project), entry),
  discard: (project) => discardKeptShifts(sourceXml.get(project)),
  step: (project, entry, applied) => stepKeptShifts(sourceXml.get(project), entry, applied),
});

function readExtensionRecord(bytes: Uint8Array): ExtensionRecord | undefined {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as { version?: unknown; data?: unknown };
    if (!value || typeof value !== "object" || !Number.isInteger(value.version) || (value.version as number) < 1 || !("data" in value))
      return undefined;
    return Object.freeze({ version: value.version as number, data: deepFreeze(value.data) as ExtensionRecord["data"] });
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function entryBytes(entries: ArchiveEntries, path: string): Uint8Array | undefined {
  const entry = entries[path];
  if (entry && !(entry instanceof Uint8Array)) throw new Error("Project archive has unsupported media path.");
  return entry;
}

function parseDawProjectEntries(entries: ArchiveEntries, decoded: DecodedAudioFiles | undefined): OpenDawProjectResult {
  const kept: string[] = [];
  keptSink = kept;
  try {
    return parseProjectEntries(entries, kept, decoded);
  } finally {
    keptSink = undefined;
  }
}

/** Content the file holds that the model cannot carry. Caught per clip: the clip stays in the file and is not played or edited. */
class Unmodeled extends Error {}
const skip = (message: string): never => {
  throw new Unmodeled(message);
};

const levelUnits = new Set(["linear", "decibel"]);
const boolText = (value: string | null) => (value === "true" ? true : value === "false" || value === null ? false : null);

/** A Volume or Send level as a linear gain; undefined for a unit the model does not carry. */
function levelOf(element: Element | undefined): { value: number; unit: "linear" | "decibel" } | undefined {
  if (!element) return undefined;
  const unit = element.getAttribute("unit");
  if (!unit || !levelUnits.has(unit) || !element.hasAttribute("value")) return undefined;
  const raw = numberAttr(element, "value", unit === "linear" ? 0 : -Infinity);
  return { value: unit === "linear" ? raw : 10 ** (raw / 20), unit: unit as "linear" | "decibel" };
}

function parseProjectEntries(entries: ArchiveEntries, kept: string[], browserAudio?: DecodedAudioFiles): OpenDawProjectResult {
  if (!entries["project.xml"] || !entries["metadata.xml"]) throw new Error("Project archive needs project.xml and metadata.xml.");
  const root = parseXml(entryBytes(entries, "project.xml")!, "Project");
  attributesOnly(root, ["version"]);
  // "0.1" is the version string the DAWproject reference library wrote until its 1.0 release (2023-09-26); Studio One 7 still writes it over
  // 1.0's structure. It is read as 1.0 and reported; any other version is refused.
  const version = attr(root, "version");
  if (version !== "1.0" && version !== "0.1") throw new Error("Project needs DAWproject version 1.0.");
  childrenOnly(root, ["Application", "Transport", "Structure", "Arrangement", "Scenes"]);
  const application = one(root, "Application")!;
  attributesOnly(application, ["name", "version"]);
  childrenOnly(application, []);
  const meta = parseXml(entryBytes(entries, "metadata.xml")!, "MetaData", "metadata.xml");
  const metadataFields = [
    "Title",
    "Artist",
    "Album",
    "OriginalArtist",
    "Composer",
    "Songwriter",
    "Producer",
    "Arranger",
    "Year",
    "Genre",
    "Copyright",
    "Website",
    "Comment",
  ];
  childrenOnly(meta, metadataFields);
  for (const field of metadataFields) {
    const element = one(meta, field, false);
    if (!element) continue;
    attributesOnly(element, []);
    childrenOnly(element, []);
    if (field !== "Title" && element.textContent?.trim()) note(`MetaData/${field}`);
  }
  const title = one(meta, "Title", false)?.textContent?.trim() || "Untitled";
  const transport = one(root, "Transport", false);
  if (transport) childrenOnly(transport, ["Tempo", "TimeSignature"]);
  const tempo = transport && one(transport, "Tempo", false);
  if (tempo) {
    attributesOnly(tempo, ["id", "unit", "value", "min", "max", "name", "color", "comment", "parameterID"]);
    childrenOnly(tempo, []);
    if (attr(tempo, "unit") !== "bpm") throw new Error("Project transport needs BPM tempo.");
  }
  const bpm = tempo ? numberAttr(tempo, "value", Number.EPSILON) : 120;
  const sig = transport && one(transport, "TimeSignature", false);
  if (sig) {
    attributesOnly(sig, ["id", "numerator", "denominator", "name", "color", "comment", "parameterID"]);
    childrenOnly(sig, []);
  }
  const signature = sig ? ([integerAttr(sig, "numerator", 1), integerAttr(sig, "denominator", 1)] as const) : ([4, 4] as const);
  const warnings: string[] = [];
  if (version === "0.1")
    warnings.push(
      'The file says DAWproject version "0.1", the label the reference library used before 1.0; it was read as version 1.0 and anything that does not fit it is reported.',
    );
  const stored = readPrivate(entryBytes(entries, "audiorective/state.json"), warnings);
  const hostManifest = readHostManifest(entryBytes(entries, "audiorective/host.json"), warnings);
  // A file an earlier Audiorective build wrote (an older sidecar) gave `interpolation` the leaving meaning; it is converted here, once, so everything
  // below reads the arriving meaning. No sidecar, or one of the current version, means another application's file or this format.
  if (stored && writesLeavingShapes(stored.version) && application.getAttribute("name") === "Audiorective") migrateLeavingToArrival(root);
  const project = new Project({ title, bpm, signature });
  const source: SourceXml = {
    project: root.ownerDocument!,
    metadata: meta.ownerDocument!,
    overlay: false,
    kept,
    keptTimed: [],
    keptShifts: [],
    keptTexts: new Map(),
    tracks: new Map(),
    channelToTrack: new Map(),
    clips: new Map(),
    gainCurves: new Map(),
    devices: new Map(),
    sends: new Map(),
    automation: new Map(),
    controllerLanes: new Map(),
    scenes: new Map(),
    recordings: new Map(),
    encodedAudio: new Map(),
    entries: new Map(),
  };
  const declaredNext = stored?.nextId;
  let next = typeof declaredNext === "number" && Number.isSafeInteger(declaredNext) && declaredNext > 0 ? declaredNext : 1;
  // Even an unusable sidecar record may hold an existing ID needed later in the import.
  for (const id of [
    ...(stored?.clips.map((clip) => clip.id) ?? []),
    ...Array.from(root.getElementsByTagName("*"), (element) => element.getAttribute("id") ?? ""),
  ]) {
    const suffix = /^(?:track|device|clip|scene)(\d+)(?:-|$)/.exec(id);
    const number = suffix && Number(suffix[1]);
    if (number && Number.isSafeInteger(number + 1)) next = Math.max(next, number + 1);
  }
  nextProjectId.set(project, next);
  const matchedAudio = new Set<StoredClip>();
  const decodedFiles = new Map<string, AudioClipSource>();
  const pendingFiles = new Map<string, Blob>();
  const wavPcmNeeded = new Map<string, { blob: Blob; window?: { from: number; to: number } }>();
  /** The renders of the file's sidecar, decoded once. A file-backed one is read into memory by `openDawProjectBlob`, which opens the archive again. */
  const renderFiles = new Map<string, ProjectAudio | undefined>();
  const loadRender = (path: string): ProjectAudio | undefined => {
    if (renderFiles.has(path)) return renderFiles.get(path);
    const entry = entries[path];
    let audio: ProjectAudio | undefined;
    try {
      if (entry instanceof Uint8Array) audio = decodeWav(entry);
      else if (entry) {
        audio = browserAudio?.get(path) ?? undefined;
        if (!audio && !browserAudio?.has(path)) wavPcmNeeded.set(path, { blob: entry.blob });
      }
    } catch {
      audio = undefined;
    }
    renderFiles.set(path, audio);
    return audio;
  };
  const untrusted = new Set<string>();
  importedBundles.set(project, untrusted);
  try {
    const usedPaths = new Set(["project.xml", "metadata.xml"]);
    // The renders of the sidecar are used or stale; either way the next save writes its own, so none is kept.
    for (const path of Object.keys(entries)) if (path.startsWith(renderPrefix)) usedPaths.add(path);
    if (entries["audiorective/state.json"]) usedPaths.add("audiorective/state.json");
    if (entries["audiorective/host.json"]) usedPaths.add("audiorective/host.json");
    const structure = one(root, "Structure", false);
    // Every channel of the file, in order, with the Track that holds it: a folder, a bare master or a track the model cannot carry is kept as it is.
    type ChannelEntry = { track: Element | null; channel: Element; tokens: string[] };
    const channelEntries: ChannelEntry[] = [];
    const collect = (parent: Element) => {
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (node.nodeType !== 1) continue;
        const child = node as Element;
        if (child.tagName === "Track") {
          const channel = one(child, "Channel", false);
          const tokens = (child.getAttribute("contentType") ?? "").split(/\s+/).filter(Boolean);
          if (channel) channelEntries.push({ track: child, channel, tokens });
          else note("Track without a Channel");
          collect(child);
        } else if (child.tagName === "Channel" && parent === structure) channelEntries.push({ track: null, channel: child, tokens: [] });
        else if (parent !== structure && child.tagName === "Channel") continue;
        else note(`${parent.tagName}/${child.tagName}`);
      }
    };
    if (structure) collect(structure);
    const channelDestination = new Map<string, string | null>();
    for (const { channel } of channelEntries) channelDestination.set(channel.getAttribute("id") ?? "", channel.getAttribute("destination"));
    let masterChannelId: string | undefined;
    type Pending = { trackId: string; destination: string | null; sends: Array<{ destination: string; gain: number; element: Element }> };
    const routes: Pending[] = [];
    const channelTracks = source.channelToTrack;
    const sourceTracks = new Map<string, string>();
    const usedSourceIds = new Set<string>();
    for (const { track: trackElement, channel, tokens } of channelEntries) {
      if (trackElement) attributesOnly(trackElement, ["id", "name", "contentType", "loaded", "color", "comment"]);
      attributesOnly(channel, ["id", "role", "destination", "audioChannels", "solo", "name", "color", "comment"]);
      childrenOnly(channel, ["Devices", "Mute", "Pan", "Sends", "Volume"]);
      const channelId = channel.getAttribute("id") ?? "";
      const role = channel.getAttribute("role") ?? "regular";
      const volumeElement = one(channel, "Volume", false);
      if (volumeElement) {
        attributesOnly(volumeElement, ["id", "unit", "value", "min", "max", "name", "color", "comment", "parameterID"]);
        childrenOnly(volumeElement, []);
      }
      const volume = levelOf(volumeElement);
      if (volumeElement && !volume) note("Volume in a unit other than linear or decibel");
      if (role === "master") {
        if (masterChannelId !== undefined) {
          note("A second master Channel");
          continue;
        }
        masterChannelId = channelId;
        if (volume) project.setMasterVolume(volume.value);
        source.master = { channel, volume: volume && volumeElement ? { element: volumeElement, unit: volume.unit } : undefined };
        const muteElement = one(channel, "Mute", false);
        const panElement = one(channel, "Pan", false);
        if (Array.from(one(channel, "Devices", false)?.childNodes ?? []).some((node) => node.nodeType === 1)) note("Master channel devices");
        if (muteElement?.getAttribute("value") === "true" || channel.getAttribute("solo") === "true") note("Master channel mute or solo");
        if (panElement && Math.abs(Number(panElement.getAttribute("value") ?? 0.5) - 0.5) > 1e-9) note("Master channel pan");
        if (channel.hasAttribute("destination") || one(channel, "Sends", false)) note("Master channel routing");
        continue;
      }
      const busRole = role === "submix" || role === "effect" ? role : undefined;
      const modelKind =
        tokens.length === 1 && (role === "regular" || busRole)
          ? tokens[0] === "audio"
            ? busRole
              ? "bus"
              : "audio"
            : tokens[0] === "notes" && !busRole
              ? "midi"
              : null
          : null;
      if (!trackElement || !modelKind) {
        note(trackElement ? `Track ${tokens.includes("tracks") ? "folder" : `of type "${tokens.join(" ") || role}"`}` : "Channel outside a Track");
        continue;
      }
      const volumeValue = volume?.value ?? 1;
      const muteElement = one(channel, "Mute", false);
      const panElement = one(channel, "Pan", false);
      if (muteElement) {
        attributesOnly(muteElement, ["id", "value", "name", "color", "comment", "parameterID"]);
        childrenOnly(muteElement, []);
      }
      const muted = muteElement ? boolText(muteElement.getAttribute("value")) : false;
      const solo = boolText(channel.getAttribute("solo"));
      if (muted === null || solo === null) throw new Error("Project has invalid channel mute or solo.");
      let pan = 0;
      let panLink: TrackLink["pan"];
      if (panElement) {
        attributesOnly(panElement, ["id", "unit", "value", "min", "max", "name", "color", "comment", "parameterID"]);
        childrenOnly(panElement, []);
        if (attr(panElement, "unit") !== "normalized") note("Pan in a unit other than normalized");
        else {
          const min = panElement.hasAttribute("min") ? numberAttr(panElement, "min", -Infinity) : 0;
          const max = panElement.hasAttribute("max") ? numberAttr(panElement, "max", -Infinity) : 1;
          const value = numberAttr(panElement, "value", -Infinity);
          if (!(max > min)) throw new Error("Project has invalid track pan.");
          pan = Math.max(-1, Math.min(1, ((value - min) / (max - min)) * 2 - 1));
          panLink = { element: panElement, min, max };
        }
      }
      const sourceId = trackElement.getAttribute("id") ?? "";
      const wanted = validProjectId(sourceId) && !usedSourceIds.has(sourceId) ? sourceId : undefined;
      usedSourceIds.add(sourceId);
      const rawName = trackElement.getAttribute("name") ?? channel.getAttribute("name") ?? "";
      let track: ProjectTrack;
      try {
        track = project.addTrack(rawName.trim() ? rawName : `Track ${project.tracks.length + 1}`, modelKind, {
          id: wanted,
          volume: volumeValue,
          muted,
          solo,
          pan,
          busRole,
        });
      } catch (error) {
        if (wanted && /unique XML IDs/.test((error as Error).message))
          track = project.addTrack(rawName.trim() ? rawName : `Track ${project.tracks.length + 1}`, modelKind, {
            volume: volumeValue,
            muted,
            solo,
            pan,
            busRole,
          });
        else throw error;
      }
      sourceTracks.set(sourceId, track.id);
      if (channelId) channelTracks.set(channelId, track.id);
      source.tracks.set(track.id, {
        track: trackElement,
        channel,
        sourceId,
        channelId: channelId || null,
        volume: volume && volumeElement ? { element: volumeElement, unit: volume.unit } : undefined,
        pan: panLink,
        mute: muteElement,
      });
      const sends = one(channel, "Sends", false);
      const route: Pending = { trackId: track.id, destination: channel.getAttribute("destination"), sends: [] };
      if (sends) {
        attributesOnly(sends, []);
        childrenOnly(sends, ["Send"]);
        for (const send of direct(sends, "Send")) {
          attributesOnly(send, ["id", "type", "destination", "name", "color", "comment"]);
          childrenOnly(send, ["Enable", "Pan", "Volume"]);
          const level = one(send, "Volume", false);
          if (level) {
            attributesOnly(level, ["id", "unit", "value", "min", "max", "name", "color", "comment", "parameterID"]);
            childrenOnly(level, []);
          }
          const enable = one(send, "Enable", false);
          const gain = levelOf(level);
          if (
            (send.getAttribute("type") ?? "post") !== "post" ||
            !gain ||
            gain.unit !== "linear" ||
            one(send, "Pan", false) ||
            !send.hasAttribute("destination")
          ) {
            note("Send that is pre-fader, panned or not in linear gain");
            continue;
          }
          if (enable && boolText(enable.getAttribute("value")) !== true) {
            note("Disabled send");
            continue;
          }
          route.sends.push({ destination: attr(send, "destination"), gain: gain.value, element: send });
        }
      }
      routes.push(route);
      const devices = one(channel, "Devices", false);
      if (devices) {
        childrenOnly(devices, [
          "ClapPlugin",
          "BuiltinDevice",
          "Vst3Plugin",
          "Vst2Plugin",
          "AuPlugin",
          "Device",
          "Equalizer",
          "Compressor",
          "NoiseGate",
          "Limiter",
        ]);
        const effects: RackEffect[] = [];
        let skippedEffect = false;
        for (let node = devices.firstChild; node; node = node.nextSibling) {
          if (node.nodeType !== 1) continue;
          const plugin = node as Element;
          const enabled = one(plugin, "Enabled", false);
          if (plugin.tagName === "BuiltinDevice" && (plugin.getAttribute("deviceID") ?? "").startsWith(rackDevicePrefix)) {
            attributesOnly(plugin, ["id", "deviceID", "deviceName", "deviceVendor", "deviceRole", "loaded", "name", "color", "comment"]);
            childrenOnly(plugin, ["State", "Enabled", "Parameters"]);
            const deviceId = attr(plugin, "deviceID");
            if (attr(plugin, "deviceRole") !== "audioFX" || !Object.keys(rackDeviceNames).some((type) => deviceId === rackDevicePrefix + type))
              throw new Error("Project has an unsupported built-in effect.");
            const stateRef = one(plugin, "State")!;
            attributesOnly(stateRef, ["path", "external"]);
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
            source.entries.set(path, bytes);
            continue;
          }
          const id = plugin.getAttribute("id") ?? "";
          const stateRef = one(plugin, "State", false);
          const statePath = stateRef?.getAttribute("path") ?? "";
          const role = plugin.getAttribute("deviceRole");
          const playable =
            plugin.tagName === "ClapPlugin" &&
            validProjectId(id) &&
            !project.tracks.some((item) => item.devices.some((device) => device.id === id)) &&
            plugin.hasAttribute("deviceID") &&
            role === (modelKind === "midi" ? "instrument" : "audioFX") &&
            !effects.length &&
            !skippedEffect &&
            (!enabled || boolText(enabled.getAttribute("value")) !== false) &&
            (!stateRef || (statePath.startsWith("plugins/") && stateRef.getAttribute("external") !== "true" && entries[statePath] !== undefined));
          if (!playable) {
            note(
              plugin.tagName === "ClapPlugin"
                ? "CLAP plug-in that is bypassed, has no state file or does not fit its track"
                : `Device ${plugin.tagName}`,
            );
            continue;
          }
          attributesOnly(plugin, [
            "id",
            "deviceID",
            "deviceName",
            "deviceVendor",
            "deviceRole",
            "pluginVersion",
            "loaded",
            "name",
            "color",
            "comment",
          ]);
          childrenOnly(plugin, ["State", "Enabled", "Parameters"]);
          let state: Uint8Array = new Uint8Array();
          if (stateRef) {
            attributesOnly(stateRef, ["path", "external"]);
            childrenOnly(stateRef, []);
            usedPaths.add(statePath);
            state = entryBytes(entries, statePath)!;
            source.entries.set(statePath, state);
          }
          const location = hostManifest?.devices[id];
          if (!location || location.kind !== "webclap" || typeof location.bundleUrl !== "string")
            warnings.push(`WebCLAP device ${id} needs a bundle location.`);
          const parameters = readDeviceParameters(one(plugin, "Parameters", false), location?.parameters, (message) =>
            warnings.push(`WebCLAP device ${id}: ${message}`),
          );
          project.addDevice(track.id, {
            kind: "webclap",
            id,
            pluginId: attr(plugin, "deviceID"),
            name: plugin.getAttribute("deviceName") ?? plugin.getAttribute("name") ?? attr(plugin, "deviceID"),
            vendor: plugin.getAttribute("deviceVendor") ?? "",
            version: plugin.getAttribute("pluginVersion") ?? "",
            bundleUrl: location?.kind === "webclap" && typeof location.bundleUrl === "string" ? location.bundleUrl : "",
            state,
            parameters,
          });
          source.devices.set(id, plugin);
          untrusted.add(id);
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
    // A destination can name a folder or a track the model does not carry: follow it to the first channel the model has.
    const resolve = (destination: string | null | undefined): string | null | undefined => {
      const seen = new Set<string>();
      let at = destination;
      while (at && !channelTracks.has(at) && at !== masterChannelId && channelDestination.has(at) && !seen.has(at)) {
        seen.add(at);
        at = channelDestination.get(at);
      }
      return at;
    };
    const busFor = (destination: string): string | undefined => {
      const trackId = channelTracks.get(resolve(destination) ?? "");
      const track = trackId ? project.tracks.find((item) => item.id === trackId) : undefined;
      return track?.kind === "bus" ? track.id : undefined;
    };
    for (const route of routes) {
      const outputBusId = route.destination && resolve(route.destination) !== masterChannelId ? (busFor(route.destination) ?? null) : null;
      if (route.destination && outputBusId === null && resolve(route.destination) !== masterChannelId)
        note("Output to a channel the model does not carry");
      const sends: Array<{ busId: string; gain: number }> = [];
      const sendElements = new Map<string, Element>();
      for (const send of route.sends) {
        const busId = busFor(send.destination);
        if (!busId || busId === route.trackId || sends.some((item) => item.busId === busId)) {
          note("Send to a channel that is not a bus or would loop");
          continue;
        }
        sends.push({ busId, gain: send.gain });
        sendElements.set(busId, send.element);
      }
      try {
        if (outputBusId !== null || sends.length) project.setTrackRouting(route.trackId, { outputBusId, sends });
        if (sendElements.size) source.sends.set(route.trackId, sendElements);
      } catch {
        note("Routing that forms a cycle");
      }
    }
    const foreign = application.getAttribute("name") !== "Audiorective";
    // A clip the model cannot carry is kept in the file as it is. In a file this package wrote itself the same content is an error.
    const fail = (error: Error): never => {
      throw foreign ? new Unmodeled(error.message) : error;
    };
    const arrangement = one(root, "Arrangement", false);
    if (arrangement) {
      attributesOnly(arrangement, ["id", "name", "color", "comment"]);
      childrenOnly(arrangement, ["Lanes", "Markers", "TempoAutomation", "TimeSignatureAutomation"]);
    }
    const nextIndex = new Map<string, number>();
    type SecondsMidi = { trackId: string; midi: ReturnType<typeof readMidi>; sceneId?: string; element: Element; container: Element };
    const secondsMidi: SecondsMidi[] = [];
    // Clips whose content is another clip's timeline (`reference`), added once every clip with content is known.
    const referenced: Array<{ trackId: string; clip: Element; index: number; unit: "seconds" | "beats"; container: Element; sceneId?: string }> = [];
    // The notes and Lanes timelines of the MIDI clips in the arrangement or a Session slot, by XML ID: what a `reference` can point at.
    const timelineOwners = new Map<string, { clipId: string; withEvents: boolean }>();
    const link = (clipId: string, element: Element, unit: "seconds" | "beats", container: Element, trackId: string, sceneId?: string) =>
      source.clips.set(clipId, { element, unit, container, trackId, sceneId });
    const readClip = (
      clip: Element,
      trackId: string,
      track: ProjectTrack,
      unit: "seconds" | "beats",
      index: number,
      container: Element,
      sceneId?: string,
    ): boolean => {
      attributesOnly(clip, [
        "name",
        "color",
        "comment",
        "time",
        "duration",
        "contentTimeUnit",
        "loopStart",
        "loopEnd",
        "playStart",
        "playStop",
        "fadeTimeUnit",
        "fadeInTime",
        "fadeOutTime",
        "enable",
        "reference",
      ]);
      try {
        if (clip.getAttribute("enable") === "false") skip("Disabled clip");
        // `duration` is optional in the schema and Studio One omits it on audio clips whose length is their content's; the model needs a length.
        if (foreign && !clip.hasAttribute("duration")) skip("Clip without a duration (its length is left to its content)");
        if (track.kind === "midi") {
          if (clip.hasAttribute("reference")) {
            if (unit !== "beats" || (clip.getAttribute("contentTimeUnit") ?? unit) !== unit)
              fail(new Error("Project MIDI clip reference needs beats time."));
            if (direct(clip, "Lanes").length || direct(clip, "Audio").length || direct(clip, "Notes").length)
              fail(new Error("Project MIDI clip reference cannot also hold content."));
            referenced.push({ trackId, clip, index, unit, container, sceneId });
            return true;
          }
          const midi = readMidi(clip, trackId, index, unit, stored, fail, (message) => {
            if (!warnings.includes(message)) warnings.push(message);
          });
          if (midi.unmatched && !foreign)
            warnings.push(`MIDI clip on ${trackId} has no matching Audiorective event details; original same-time order is unavailable.`);
          // Seconds content converts to beats once the tempo map is known, after the arrangement is read.
          if (unit === "beats") {
            const added = project.addMidiClip(trackId, midi, midi.time, { id: midi.id, name: midi.name });
            if (midi.loop) project.setClipLoop(added.id, { startBeat: midi.loop.start, endBeat: midi.loop.end });
            if (sceneId) adoptSlotClip(project, added.id, sceneId);
            link(added.id, clip, unit, container, trackId, sceneId);
            const [lanesId, notesId] = midi.timelines;
            if (lanesId) timelineOwners.set(lanesId, { clipId: added.id, withEvents: true });
            if (notesId) timelineOwners.set(notesId, { clipId: added.id, withEvents: false });
          } else secondsMidi.push({ trackId, midi, sceneId, element: clip, container });
          return true;
        }
        let flatGain: number | undefined;
        let foreignCurve: { points: Element; unit: "seconds" | "beats"; values: GainCurveValues } | undefined;
        let flatCurve: { points: Element; unit: "seconds" | "beats" } | undefined;
        let content = Array.from(clip.childNodes).filter((node): node is Element => node.nodeType === 1);
        // Bitwig's form: the audio sits in a Clip inside a Clips inside this clip. It is read once the clip's place and tempo are known.
        let nestedClips: Element | undefined;
        if (content.length === 1 && content[0].tagName === "Clips") {
          nestedClips = content[0];
          content = [];
        } else if (content.length === 1 && content[0].tagName === "Lanes") {
          // The standard form of clip gain: content lanes with the audio and a gain curve. With Audiorective's details for the clip they stay the
          // authority and the curve is ignored. Without them a flat curve is the clip's gain and a moving one is the clip's gain automation;
          // any other automation (pan, ...) keeps the clip unplayed.
          const lanes = content[0];
          attributesOnly(lanes, ["id", "timeUnit", "name", "color", "comment"]);
          childrenOnly(lanes, ["Audio", "Points"]);
          const audioId = direct(lanes, "Audio")[0]?.getAttribute("id");
          const curves = direct(lanes, "Points");
          const described = stored?.clips.some((item) => item.track === trackId && audioId === `${item.id}-audio`);
          if (!curves.every((points) => one(points, "Target", false)?.getAttribute("expression") === "gain"))
            skip("Audio clip with a gain curve or other automation");
          if (!described) {
            const flat = curves.length === 1 ? flatGainOf(curves[0]) : undefined;
            if (flat !== undefined) {
              flatGain = flat;
              const unit = gainCurveUnit(curves[0], lanes);
              if (unit) flatCurve = { points: curves[0], unit };
            } else if (curves.length === 1 && !clip.hasAttribute("loopStart")) {
              const read = readGainCurve(curves[0], lanes);
              if (!read) skip("Audio clip with a gain curve or other automation");
              foreignCurve = { points: curves[0], ...read! };
            } else skip("Audio clip with a gain curve or other automation");
          }
          content = direct(lanes, "Audio");
        }
        if (!nestedClips && (content.length !== 1 || content[0].tagName !== "Audio"))
          skip(content.some((item) => item.tagName === "Warps") ? "Audio clip with warps outside a nested clip" : "Audio clip without audio content");
        // The lane may be in beats (the file's timeline) while the audio content stays in seconds, which the clip must say.
        if ((!nestedClips && (clip.getAttribute("contentTimeUnit") ?? "seconds") !== "seconds") || clip.hasAttribute("reference"))
          fail(new Error("Project audio clip has unsupported content."));
        const tempoMap = project.tempoMap;
        const toSeconds = (beat: number) => (beat >= 0 ? tempoMap.beatToSeconds(beat) : (beat * 60) / tempoMap.initialBpm);
        const toBeat = (seconds: number) => (seconds >= 0 ? tempoMap.secondsToBeat(seconds) : (seconds * tempoMap.initialBpm) / 60);
        const startAttr = numberAttr(clip, "time");
        const lengthAttr = numberAttr(clip, "duration");
        // A clip in beats lands on the seconds the tempo map gives its beats; the conversion is exact to float noise, which is snapped away.
        const time = unit === "beats" ? snap12(toSeconds(startAttr)) : startAttr;
        const duration = unit === "beats" ? snap12(toSeconds(startAttr + lengthAttr) - toSeconds(startAttr)) : lengthAttr;
        const fadeUnit = clip.getAttribute("fadeTimeUnit") ?? "seconds";
        if (fadeUnit !== "seconds" && fadeUnit !== "beats") fail(new Error("Project audio fades need seconds or beats."));
        const fadeInAttr = clip.hasAttribute("fadeInTime") ? numberAttr(clip, "fadeInTime") : 0;
        const fadeOutAttr = clip.hasAttribute("fadeOutTime") ? numberAttr(clip, "fadeOutTime") : 0;
        let fadeIn = fadeInAttr;
        let fadeOut = fadeOutAttr;
        if (fadeUnit === "beats") {
          // A fade in beats runs over the tempo map from its edge: fade-in from the clip start, fade-out back from the clip end.
          const startBeat = unit === "beats" ? startAttr : toBeat(time);
          const endBeat = unit === "beats" ? startAttr + lengthAttr : toBeat(time + duration);
          fadeIn = fadeInAttr ? snap12(toSeconds(startBeat + fadeInAttr) - toSeconds(startBeat)) : 0;
          fadeOut = fadeOutAttr ? snap12(toSeconds(endBeat) - toSeconds(endBeat - fadeOutAttr)) : 0;
        }
        let nested: ReturnType<typeof readNestedAudio> | undefined;
        if (nestedClips) {
          nested = readNestedAudio({
            outer: clip,
            clips: nestedClips,
            unit,
            start: startAttr,
            length: lengthAttr,
            toSeconds,
            tempoBreaks: tempoMap.changes.map((change) => change.beat),
          });
          content = [nested.audio];
          flatGain = nested.gain;
          if (nested.curve) foreignCurve = nested.curve;
        }
        const audio = content[0];
        attributesOnly(audio, ["id", "timeUnit", "channels", "sampleRate", "duration", "algorithm", "name", "color", "comment"]);
        if ((audio.getAttribute("timeUnit") ?? "seconds") !== "seconds") fail(new Error("Project audio clip has unsupported content."));
        childrenOnly(audio, ["File"]);
        const file = one(audio, "File")!;
        attributesOnly(file, ["path", "external"]);
        childrenOnly(file, []);
        const path = attr(file, "path"),
          asset = entries[path];
        if (file.getAttribute("external") === "true" || !asset || (foreign ? false : !path.startsWith("audio/"))) {
          if (asset) skip("Audio file outside the archive");
          fail(new Error("Project audio asset is missing."));
        }
        // Clips that name one file share one decoded recording, so a piece can be extended into audio another piece hides.
        let decoded = decodedFiles.get(path);
        if (!decoded) {
          try {
            decodedFiles.set(path, (decoded = readAudioSource(asset!)));
          } catch (error) {
            if (!foreign) throw error;
            // Not a WAV the reader reads: the browser decodes it. Without its PCM the clip is pending, sized by what the file's Audio element states.
            const browser = browserAudio?.get(path);
            if (browser === null) throw new Unmodeled(`Audio file "${path}" that the browser could not decode`);
            const stated = ["sampleRate", "channels", "duration"].map((name) => audio.getAttribute(name));
            if (!browser && stated.some((value) => value === null || !(Number(value) > 0)))
              throw new Unmodeled(`Audio in a format the model cannot read, with no sampleRate, channels and duration stated: ${path}`);
            if (browser) decoded = { sampleRate: browser.sampleRate, channels: browser.channels };
            else {
              const [sampleRate, channelCount] = [Number(stated[0]), Number(stated[1])];
              const frameCount = Math.round(Number(stated[2]) * sampleRate);
              if (!Number.isInteger(sampleRate) || !Number.isInteger(channelCount) || channelCount > 32 || !(frameCount >= 1))
                throw new Unmodeled(`Audio in a format the model cannot read, with an unusable sampleRate, channels or duration: ${path}`);
              const blob = asset instanceof Uint8Array ? new Blob([asset as Uint8Array<ArrayBuffer>]) : asset!.blob;
              pendingFiles.set(path, blob);
              decoded = { sampleRate, media: encodedAudioMedia(blob, path, { sampleRate, channelCount, frameCount }), startFrame: 0, frameCount };
            }
            source.encodedAudio.set(path, { sampleRate: stated[0]!, channels: stated[1]!, duration: stated[2]! });
            decodedFiles.set(path, decoded);
          }
        }
        if (nested?.stretch && decoded.media && pendingFiles.has(path)) {
          // A stretched clip is made from PCM, and this compressed file is still pending: the browser decodes it first, as `openWorkspace` does, and
          // the file is read again with its PCM. (A WAV kept file-backed is read by window further down, so the original stays file-backed.)
          const pcm = browserAudio?.get(path);
          if (!pcm) {
            if (pcm === null || browserAudio) throw new Unmodeled(`Audio file "${path}" that the browser could not decode`);
            throw new Unmodeled(
              `Audio clip stretched by warp markers, whose audio ("${path}") is decoded when the file is opened with openWorkspace`,
            );
          }
          decoded = { sampleRate: pcm.sampleRate, channels: pcm.channels };
        }
        const channels = audioChannelCount(decoded);
        const frames = audioFrameCount(decoded);
        const rate = decoded.sampleRate;
        const loop = nested ? undefined : readLoop(clip);
        const windowed = nested !== undefined || clip.hasAttribute("playStart") || clip.hasAttribute("playStop");
        // A window that is not exactly the clip's length means the audio is stretched or looped: the model has a window and a loop, not a ratio.
        const slack = foreign ? 1.5 / rate : 1e-9;
        // A compressed file decodes a little shorter than the duration its encoder states (priming and padding frames at either end), so a window that
        // reaches the stated end is accepted up to this many frames past the decoded audio and clamped to it; a longer shortfall means the file is not the one the clip describes.
        const decoderSlack = browserAudio?.get(path) ? DECODER_PADDING_FRAMES : 0;
        let from = 0;
        let to = frames;
        if (nested?.stretch) {
          // The window is the stretch's: the part of the file the warp markers cover over the clip.
          from = Math.round(nested.startSeconds * rate);
          to = Math.round(nested.stopSeconds * rate);
          if (nested.startSeconds < -slack || from < 0 || from >= to || from >= frames || to > frames + 1 + decoderSlack)
            throw new Unmodeled("Audio clip whose warp markers reach outside its audio");
          to = Math.min(to, frames);
        } else if (nested) {
          // The window is the inner clip's: the warp was checked to leave the audio at its speed, so it is as long as the clip.
          from = Math.round(nested.startSeconds * rate);
          to = Math.round(nested.stopSeconds * rate);
          if (nested.startSeconds < 0 || from >= to || from >= frames || to > frames + 1 + decoderSlack)
            fail(new Error("Project audio asset does not match its XML metadata."));
          to = Math.min(to, frames);
        } else if (loop) {
          // A looped clip's window runs from playStart to the end of the recording and its length is `duration`; playStop is advisory (where the
          // content would stop without the loop) and only has to lie after playStart and inside the recording.
          const playStart = clip.hasAttribute("playStart") ? numberAttr(clip, "playStart") : 0;
          from = Math.round(playStart * rate);
          if (
            from >= frames ||
            loop.end > frames / rate + 1e-9 ||
            (clip.hasAttribute("playStop") && (numberAttr(clip, "playStop") <= playStart || numberAttr(clip, "playStop") > frames / rate + 1e-9))
          )
            fail(new Error("Project audio asset does not match its XML metadata."));
        } else if (windowed || foreign) {
          // One edge alone is valid DAWproject: a missing playStart is 0, and a missing playStop is the clip's length after playStart.
          const playStart = clip.hasAttribute("playStart") ? numberAttr(clip, "playStart") : 0;
          const playStop = clip.hasAttribute("playStop") ? numberAttr(clip, "playStop") : playStart + duration;
          from = Math.round(playStart * rate);
          to = Math.round(playStop * rate);
          if (
            !(playStart < playStop) ||
            from < 0 ||
            to > frames + (foreign ? 1 : 0) + decoderSlack ||
            from >= to ||
            Math.abs(playStop - playStart - duration) > slack
          )
            fail(new Error("Project audio asset does not match its XML metadata."));
          to = Math.min(to, frames);
        }
        if (
          (!foreign && rate !== integerAttr(audio, "sampleRate", 1)) ||
          (!foreign && channels !== integerAttr(audio, "channels", 1)) ||
          (!foreign && Math.abs(frames / rate - numberAttr(audio, "duration")) > 1e-9) ||
          (!foreign && !windowed && !loop && Math.abs(frames / rate - duration) > 1e-9)
        )
          fail(new Error("Project audio asset does not match its XML metadata."));
        usedPaths.add(path);
        const identity = audio.getAttribute("id");
        const match = stored?.clips.find(
          (item) =>
            !matchedAudio.has(item) &&
            item.track === trackId &&
            (identity === `${item.id}-audio` || (item.index === index && item.fingerprint === path)) &&
            (item.fingerprint === path || item.fingerprint === ""),
        );
        if (match) matchedAudio.add(match);

        const aligned = match !== undefined;
        const storedGain = aligned ? match.audioGain : undefined;
        const gain =
          typeof storedGain === "number" && Number.isFinite(storedGain) && storedGain >= 0
            ? storedGain
            : !aligned && flatGain !== undefined
              ? flatGain
              : 1;
        const originalPath = sourcePrefix + path.slice("audio/".length);
        const original = windowed ? undefined : path.startsWith("audio/") ? entries[originalPath] : undefined;
        let stretch: AudioClipStretchInit | undefined;
        if (!nested?.stretch && aligned && match.stretchRatio !== undefined) {
          if (!original) throw new Error("Project clip stretch source is missing.");
          stretch = { ratio: match.stretchRatio, source: readAudioSource(original), anchors: match.warpAnchors };
        } else if (original) {
          warnings.push("A rendered audio clip was opened without its Audiorective stretch settings.");
        } else if (!aligned && !foreign) {
          warnings.push(`Audio clip ${path} has no matching Audiorective details; standard project data was used.`);
        }
        if (original) usedPaths.add(originalPath);
        let gainAutomation: AudioClipGainAutomation | undefined;
        let curveLink: GainCurveLink | undefined;
        if (!aligned && flatCurve) {
          const startBeat = unit === "beats" ? startAttr : toBeat(time);
          curveLink = { ...flatCurve, secondsPerBeat: snap12(toSeconds(startBeat + 1) - toSeconds(startBeat)) };
        }
        if (!aligned && foreignCurve) {
          // A curve in beats runs over the clip's content at the tempo where the clip starts; its times are the recording's seconds.
          const startBeat = unit === "beats" ? startAttr : toBeat(time);
          const secondsPerBeat = snap12(toSeconds(startBeat + 1) - toSeconds(startBeat));
          const scale = foreignCurve.unit === "beats" ? secondsPerBeat : 1;
          const points = foreignCurve.values.map((point) => ({ ...point, time: snap12(point.time * scale) }));
          if (points.every((point) => point.time >= 0)) {
            gainAutomation = normalizeClipGainAutomation({ sourceStart: from / rate, points });
            // A nested clip's curve is written back through its link (`nested.gain`), not as a standard-form curve.
            if (!nested) curveLink = { points: foreignCurve.points, unit: foreignCurve.unit, secondsPerBeat };
          } else warnings.push("A negative time in a clip gain curve left it out of the model.");
        }
        if (aligned && match.gainAutomation !== undefined) {
          try {
            gainAutomation = normalizeClipGainAutomation(match.gainAutomation);
          } catch {
            warnings.push("Invalid Audiorective clip gain automation was skipped.");
          }
        }
        const options = {
          id: match?.id,
          name: clip.getAttribute("name") || undefined,
          envelope: { gain, fadeIn, fadeOut },
          stretch,
          gainAutomation,
        };
        let stretched: { ratio: number; knots: readonly ClipStretchAnchor[]; outputFrames: number } | undefined;
        if (nested?.stretch) {
          // Output frames are the clip's length on the timeline; the ratio makes the model's `round(frames * ratio)` that many.
          const sourceFrames = to - from;
          const outputFrames = Math.round(nested.stretch.knots[nested.stretch.knots.length - 1].output * rate);
          if (outputFrames < 1 || !Number.isSafeInteger(outputFrames)) throw new Unmodeled("Audio clip whose stretch leaves no audio");
          const interior: ClipStretchAnchor[] = [];
          for (const knot of nested.stretch.knots.slice(1, -1)) {
            const sourceFrame = Math.round(knot.content * rate) - from;
            const outputFrame = Math.round(knot.output * rate);
            const last = interior[interior.length - 1] ?? { sourceFrame: 0, outputFrame: 0 };
            if (sourceFrame > last.sourceFrame && outputFrame > last.outputFrame && sourceFrame < sourceFrames && outputFrame < outputFrames)
              interior.push({ sourceFrame, outputFrame });
          }
          // The warp's exact ratio is used when it puts the clip's end within a frame and a half of its length; else the frames' quotient is.
          const exact = nested.stretch.exactRatio;
          const ratio =
            exact !== undefined && interior.length === 0 && Math.abs(sourceFrames * exact - outputFrames) <= 1.5
              ? exact
              : outputFrames / sourceFrames;
          stretched = { ratio, knots: interior, outputFrames };
        }
        let added: AudioClip;
        // A WAV kept file-backed stays the stretch's original: the clip keeps a window of the file, and only the PCM of that window is read, once, to hash
        // and to make the placeholder (`openDawProjectBlob` reads it and opens the archive again).
        let windowPcm: ProjectAudio | undefined;
        const fileBacked = decoded.media ? decoded : undefined;
        if (stretched && nested?.stretch && fileBacked) {
          const key = `${path}#${from}:${to}`;
          windowPcm = browserAudio?.get(key) ?? undefined;
          if (!windowPcm) {
            if (asset instanceof Uint8Array) throw new Unmodeled(`Audio file "${path}" that the reader could not read as PCM`);
            wavPcmNeeded.set(key, { blob: asset!.blob, window: { from: fileBacked.startFrame + from, to: fileBacked.startFrame + to } });
            throw new Unmodeled(
              `Audio clip stretched by warp markers, whose audio ("${path}") is decoded when the file is opened with openWorkspace`,
            );
          }
        }
        if (stretched && nested?.stretch) {
          const pcmWindow: ProjectAudio = windowPcm ?? windowOfRecording(decoded as ProjectAudio, from, to);
          const mediaWindow = () =>
            Object.freeze({
              sampleRate: rate,
              media: fileBacked!.media!,
              startFrame: fileBacked!.startFrame + from,
              frameCount: to - from,
            }) as AudioClipSource;
          const stretch = { ratio: stretched.ratio, source: windowPcm ? mediaWindow() : pcmWindow, anchors: stretched.knots };
          // The file's own render of this clip, when it still describes this stretch: no placeholder, no engine, no warning.
          const stored = aligned ? readStoredRender(match.render) : undefined;
          const render =
            stored &&
            renderMatches(
              stored,
              { source: path, from, length: to - from, output: stretched.outputFrames, rate, channels, anchors: stretched.knots },
              () => hashPcm(pcmWindow.channels),
            )
              ? loadRender(stored.path)
              : undefined;
          if (
            stored?.path.startsWith(renderPrefix) &&
            render &&
            render.sampleRate === rate &&
            render.channels.length === channels &&
            render.channels[0].length >= stored.offset + stored.frames
          ) {
            const audio = {
              sampleRate: rate,
              channels: render.channels.map((channel) => channel.subarray(stored.offset, stored.offset + stored.frames)),
            };
            added = project.addAudioClip(trackId, audio, time, { ...options, stretch });
          } else {
            const placeholder = varispeedAudio(pcmWindow, [
              { sourceFrame: 0, outputFrame: 0 },
              ...stretched.knots,
              { sourceFrame: to - from, outputFrame: stretched.outputFrames },
            ]);
            added = project.addAudioClip(trackId, placeholder, time, {
              ...options,
              stretch: { ...stretch, source: windowPcm ? mediaWindow() : windowOfRecording(decoded as ProjectAudio, from, to) },
            });
            markVarispeed(added);
            if (nested.stretch.pitchPreserving) noteOpenedStretch(project, { clip: added, name: options.name ?? added.id });
          }
        } else
          added = decoded.media
            ? project.addAudioMediaClip(trackId, decoded.media, time, { ...options, startFrame: from, frameCount: to - from })
            : project.addAudioClip(trackId, windowOfRecording(decoded, from, to), time, options);
        if (loop) {
          project.setClipLoop(added.id, { startSeconds: loop.start, endSeconds: loop.end });
          project.resizeClip(added.id, { end: time + duration });
          // A resize drops a fade at the edge it moves, so the saved envelope is applied last.
          project.setAudioClipEnvelope(added.id, options.envelope);
        }
        if (sceneId) adoptSlotClip(project, added.id, sceneId);
        link(added.id, clip, unit, container, trackId, sceneId);
        if (nested) source.clips.get(added.id)!.nested = nested.link;
        source.recordings.set(audioRecording(nested?.stretch && added.stretch ? added.stretch.source : (added as AudioClip)).key, path);
        if (curveLink) source.gainCurves.set(added.id, curveLink);
        return true;
      } catch (error) {
        if (!(error instanceof Unmodeled)) throw error;
        note(error.message);
        return false;
      }
    };
    // Tempo is read first: a lane in beats converts its audio clips, fades and automation through the tempo map.
    const tempoAutomation = arrangement && one(arrangement, "TempoAutomation", false);
    if (tempoAutomation) {
      attributesOnly(tempoAutomation, ["id", "timeUnit", "unit", "name", "color", "comment"]);
      childrenOnly(tempoAutomation, ["Target", "RealPoint"]);
      const target = one(tempoAutomation, "Target", false);
      const points = direct(tempoAutomation, "RealPoint");
      // A segment is a ramp only when it arrives linearly at a later point at another value (a point's `interpolation` is how the value arrives
      // there); a same-time pair (how Bitwig writes a step) and a linear run between equal values are steps.
      const ramps = points.some((point, i) => {
        const next = points[i + 1];
        return (
          next !== undefined &&
          next.getAttribute("interpolation") !== "hold" &&
          Number(point.getAttribute("time")) !== Number(next.getAttribute("time")) &&
          Number(point.getAttribute("value")) !== Number(next.getAttribute("value"))
        );
      });
      const flat = points.every((point) => Math.abs(Number(point.getAttribute("value")) - bpm) < 1e-6 * bpm);
      if (flat) {
        // A tempo lane that never leaves the starting tempo changes nothing; it stays in the file.
      } else if (
        (tempoAutomation.getAttribute("timeUnit") ?? "beats") !== "beats" ||
        (tempoAutomation.getAttribute("unit") ?? "bpm") !== "bpm" ||
        ramps ||
        !target ||
        (tempo?.getAttribute("id") ?? "") !== target.getAttribute("parameter")
      ) {
        note("Tempo automation with ramps or in seconds");
      } else {
        attributesOnly(target, ["parameter"]);
        childrenOnly(target, []);
        const raw = points.map((point) => {
          attributesOnly(point, ["time", "value", "interpolation"]);
          childrenOnly(point, []);
          return { beat: numberAttr(point, "time"), bpm: numberAttr(point, "value", Number.EPSILON) };
        });
        // The value in force at each time is the last point's there; a point that repeats the running tempo changes nothing.
        const changes: Array<{ beat: number; bpm: number }> = [];
        let running = bpm;
        for (const [i, point] of raw.entries()) {
          if (raw[i + 1]?.beat === point.beat) continue;
          if (point.bpm !== running) {
            if (point.beat === 0) throw new Error("Project tempo automation disagrees with transport BPM.");
            changes.push(point);
            running = point.bpm;
          }
        }
        project.setTempoChanges(changes);
        source.tempoAutomation = tempoAutomation;
      }
    }
    const outerLanes = arrangement && one(arrangement, "Lanes", false);
    if (outerLanes) {
      attributesOnly(outerLanes, ["id", "timeUnit", "name", "color", "comment"]);
      childrenOnly(outerLanes, ["Lanes", "Clips", "Points"]);
      const outerUnit = outerLanes.getAttribute("timeUnit");
      // A track's content sits in a Lanes of its own, or loose in the arrangement's Lanes as a Clips or Points naming its track.
      const groups: Array<{ lane: Element; clips: Element[]; points: Element[] }> = [];
      for (const child of kids(outerLanes)) {
        if (child.tagName === "Lanes") {
          attributesOnly(child, ["id", "track", "timeUnit", "name", "color", "comment"]);
          childrenOnly(child, ["Clips", "Points"]);
          groups.push({ lane: child, clips: direct(child, "Clips"), points: direct(child, "Points") });
        } else if (child.tagName === "Clips" || child.tagName === "Points")
          groups.push({ lane: child, clips: child.tagName === "Clips" ? [child] : [], points: child.tagName === "Points" ? [child] : [] });
      }
      for (const { lane, clips: laneClips, points: lanePoints } of groups) {
        const trackId = sourceTracks.get(lane.getAttribute("track") ?? "");
        const track = trackId === undefined ? undefined : project.tracks.find((item) => item.id === trackId);
        if (!trackId || !track) {
          note("Lane of a track the model does not carry");
          continue;
        }
        const laneUnit = lane.getAttribute("timeUnit") ?? outerUnit ?? "beats";
        let index = nextIndex.get(trackId) ?? 0;
        for (const clips of laneClips) {
          attributesOnly(clips, ["id", "track", "timeUnit", "name", "color", "comment"]);
          const unit = clips.getAttribute("timeUnit") ?? laneUnit;
          childrenOnly(clips, ["Clip"]);
          if (unit !== "seconds" && unit !== "beats") throw new Error("Project clip lane needs seconds or beats time.");
          const found = direct(clips, "Clip");
          if (track.kind === "bus" && found.length) {
            note("Clips on a bus track");
            continue;
          }
          for (const clip of found) if (readClip(clip, trackId, track, unit, index, clips)) index++;
        }
        nextIndex.set(trackId, index);
        for (const automation of lanePoints) {
          // A MIDI controller of the track (Bitwig Studio writes sustain, mod wheel and pitch bend here, in absolute beats).
          if (one(automation, "Target", false)?.hasAttribute("expression")) {
            const lane = readControllerPoints(automation, 119);
            const timeUnit = automation.getAttribute("timeUnit") ?? laneUnit;
            if (typeof lane === "string") note(`Controller lane with ${lane}`);
            else if (track.kind !== "midi") note("Controller lane of a track that is not a MIDI track");
            else if (timeUnit !== "seconds" && timeUnit !== "beats") note("Controller lane without seconds or beats time");
            else if (source.controllerLanes.get(trackId)?.has(controllerLaneKey(lane))) note("Controller lane that repeats another's controller");
            else {
              const map = project.tempoMap;
              project.setControllerLane(trackId, {
                ...lane,
                points: lane.points.map((point) => ({ ...point, time: timeUnit === "beats" ? point.time : snap12(map.secondsToBeat(point.time)) })),
              });
              const links = source.controllerLanes.get(trackId) ?? new Map();
              links.set(controllerLaneKey(lane), { points: automation, unit: timeUnit });
              source.controllerLanes.set(trackId, links);
            }
            continue;
          }
          attributesOnly(automation, ["id", "track", "timeUnit", "unit", "name", "color", "comment"]);
          const target = one(automation, "Target", false);
          const unit = automation.getAttribute("timeUnit") ?? laneUnit;
          const volumeId = source.tracks.get(trackId)?.volume?.element.getAttribute("id");
          if (
            !target ||
            !volumeId ||
            target.getAttribute("parameter") !== volumeId ||
            (unit !== "seconds" && unit !== "beats") ||
            (automation.getAttribute("unit") ?? "linear") !== "linear" ||
            source.automation.has(trackId)
          ) {
            note("Automation of a parameter or in a unit the model does not carry");
            continue;
          }
          attributesOnly(target, ["parameter"]);
          childrenOnly(target, []);
          childrenOnly(automation, ["Target", "RealPoint"]);
          const points = direct(automation, "RealPoint").map((point) => {
            attributesOnly(point, ["time", "value", "interpolation"]);
            childrenOnly(point, []);
            const shape = point.getAttribute("interpolation") ?? "linear";
            const at = numberAttr(point, "time");
            return {
              time: unit === "beats" ? snap12(project.tempoMap.beatToSeconds(at)) : at,
              value: numberAttr(point, "value"),
              shape: shape === "hold" ? ("hold" as const) : shape === "linear" ? ("linear" as const) : null,
            };
          });
          if (points.some((point) => point.shape === null)) {
            note("Automation of a parameter or in a unit the model does not carry");
            continue;
          }
          // The model's curve has one value per time: a step that is not a hold (two points at one time after a ramp) or a point it cannot hold stays in the file as it is.
          points.sort((a, b) => a.time - b.time);
          const folded = foldSteps(points as Array<{ time: number; value: number; shape: "hold" | "linear" }>);
          if (!folded) {
            note("Volume automation with a step (two points at one time)");
            continue;
          }
          if (folded.some((point) => !Number.isFinite(point.time) || point.time < 0 || !Number.isFinite(point.value) || point.value < 0)) {
            note("Volume automation with a negative time or value");
            continue;
          }
          // The file's `interpolation` is how a value arrives at its point; the model's `shape` is how it leaves.
          const leaving = leavingShapes(folded.map((point) => point.shape));
          project.setVolumeAutomation(
            trackId,
            folded.map((point, i) => ({ ...point, shape: leaving[i] })),
          );
          source.automation.set(trackId, automation);
        }
      }
    }
    const markers = arrangement && one(arrangement, "Markers", false);
    if (markers) {
      attributesOnly(markers, ["id", "timeUnit", "name", "color", "comment"]);
      childrenOnly(markers, ["Marker"]);
      const inBeats = (markers.getAttribute("timeUnit") ?? outerLanes?.getAttribute("timeUnit") ?? "beats") !== "seconds";
      const map = project.tempoMap;
      project.setMarkers(
        direct(markers, "Marker").map((marker) => {
          attributesOnly(marker, ["time", "name", "color", "comment"]);
          childrenOnly(marker, []);
          const time = numberAttr(marker, "time");
          return { time: inBeats ? snap12(map.beatToSeconds(time)) : time, name: attr(marker, "name") };
        }),
      );
      source.markers = markers;
      source.markersInBeats = inBeats;
    }
    const timeSignatureAutomation = arrangement && one(arrangement, "TimeSignatureAutomation", false);
    if (timeSignatureAutomation) {
      attributesOnly(timeSignatureAutomation, ["id", "timeUnit", "unit", "name", "color", "comment"]);
      childrenOnly(timeSignatureAutomation, ["Target", "TimeSignaturePoint"]);
      const target = one(timeSignatureAutomation, "Target", false);
      const points = direct(timeSignatureAutomation, "TimeSignaturePoint");
      const flat = points.every(
        (point) => Number(point.getAttribute("numerator")) === signature[0] && Number(point.getAttribute("denominator")) === signature[1],
      );
      if (flat) {
        // A lane that never leaves the starting signature changes nothing; it stays in the file.
      } else if (
        (timeSignatureAutomation.getAttribute("timeUnit") ?? "beats") !== "beats" ||
        !target ||
        (sig?.getAttribute("id") ?? "") !== target.getAttribute("parameter")
      ) {
        note("Time signature automation in seconds");
      } else {
        attributesOnly(target, ["parameter"]);
        childrenOnly(target, []);
        const changes = points.map((point) => {
          attributesOnly(point, ["time", "numerator", "denominator"]);
          childrenOnly(point, []);
          return {
            beat: numberAttr(point, "time"),
            numerator: integerAttr(point, "numerator", 1),
            denominator: integerAttr(point, "denominator", 1),
          };
        });
        const initial = changes.find((point) => point.beat === 0);
        if (initial && (initial.numerator !== signature[0] || initial.denominator !== signature[1]))
          throw new Error("Project time signature automation disagrees with the transport time signature.");
        project.setTimeSignatureChanges(changes.filter((point) => point.beat !== 0));
        source.meterAutomation = timeSignatureAutomation;
      }
    }
    const scenesElement = one(root, "Scenes", false);
    if (scenesElement) {
      attributesOnly(scenesElement, []);
      childrenOnly(scenesElement, ["Scene"]);
      const sceneElements = direct(scenesElement, "Scene");
      const sceneIds = new Set<string>();
      restoreScenes(
        project,
        sceneElements.map((scene) => {
          attributesOnly(scene, ["id", "name", "comment", "color"]);
          childrenOnly(scene, ["Lanes"]);
          const id = scene.getAttribute("id");
          const usable = id !== null && validProjectId(id) && !sceneIds.has(id) && !project.tracks.some((track) => track.id === id);
          if (usable) sceneIds.add(id);
          return { id: usable ? id : undefined, name: scene.getAttribute("name") ?? undefined };
        }),
      );
      sceneElements.forEach((scene, sceneIndex) => {
        const sceneId = sessionFor(project).scenes[sceneIndex].id;
        source.scenes.set(sceneId, scene);
        const sceneLanes = direct(scene, "Lanes");
        if (sceneLanes.length > 1) throw new Error("Project scene needs one Lanes element.");
        if (!sceneLanes.length) return;
        attributesOnly(sceneLanes[0], ["id", "timeUnit", "name", "color", "comment"]);
        childrenOnly(sceneLanes[0], ["ClipSlot"]);
        const filled = new Set<string>();
        for (const slot of direct(sceneLanes[0], "ClipSlot")) {
          attributesOnly(slot, ["id", "track", "timeUnit", "hasStop", "name", "color", "comment"]);
          childrenOnly(slot, ["Clip"]);
          const trackId = sourceTracks.get(slot.getAttribute("track") ?? "");
          const track = trackId === undefined ? undefined : project.tracks.find((item) => item.id === trackId);
          const slotClips = direct(slot, "Clip");
          if (!trackId || !track) {
            if (slotClips.length) note("Clip slot of a track the model does not carry");
            continue;
          }
          if (!slotClips.length) continue;
          if (filled.has(trackId)) throw new Error("Project scene has two clip slots for one track.");
          filled.add(trackId);
          const unit = slot.getAttribute("timeUnit") ?? sceneLanes[0].getAttribute("timeUnit") ?? "beats";
          if (unit !== "seconds" && unit !== "beats") throw new Error("Project clip slot needs seconds or beats time.");
          if (track.kind === "bus") {
            note("Clips on a bus track");
            continue;
          }
          const index = nextIndex.get(trackId) ?? 0;
          if (readClip(slotClips[0], trackId, track, unit, index, slot, sceneId)) nextIndex.set(trackId, index + 1);
        }
      });
    }
    for (const { trackId, midi, sceneId, element, container } of secondsMidi) {
      const map = project.tempoMap;
      const first = map.secondsToBeat(midi.time);
      // Content before the clip's start (a negative playStart or note time) can land before project second 0, which the tempo map cannot
      // convert; there the first tempo continues backwards.
      const beatAt = (seconds: number) => (seconds >= 0 ? map.secondsToBeat(seconds) : (seconds * map.initialBpm) / 60);
      const beat = (local: number) => beatAt(midi.time + local) - first;
      const added = project.addMidiClip(
        trackId,
        {
          duration: beat(midi.duration),
          notes: midi.notes.map((note) => ({ ...note, start: beat(note.start), duration: beat(note.start + note.duration) - beat(note.start) })),
          events: midi.events.map((event) => ({ ...event, time: beat(event.time) })),
          sourceOffset: beat(midi.sourceOffset),
        },
        first,
        { id: midi.id, name: midi.name },
      );
      if (midi.loop) project.setClipLoop(added.id, { startBeat: beat(midi.loop.start), endBeat: beat(midi.loop.end) });
      if (sceneId) adoptSlotClip(project, added.id, sceneId);
      link(added.id, element, "seconds", container, trackId, sceneId);
    }
    for (const { trackId, clip, index, unit, container, sceneId } of referenced) {
      const id = attr(clip, "reference");
      const owner = timelineOwners.get(id);
      if (!owner) {
        if (!foreign) throw new Error(`Project clip reference "${id}" does not match any MIDI notes in the arrangement or a Session scene.`);
        note("Clip that refers to a timeline the model does not carry");
        continue;
      }
      const ownerClip = [...project.tracks.flatMap((track) => track.clips), ...readSession(project).slots.values()].find(
        (item) => item.id === owner.clipId,
      ) as MidiClip;
      const time = numberAttr(clip, "time");
      const loop = readLoop(clip);
      const added = project.addMidiClip(
        trackId,
        {
          notes: untracked(() => ownerClip.midi.notes.value),
          duration: numberAttr(clip, "duration"),
          events: owner.withEvents ? ownerClip.events : [],
          sourceOffset: readMidiWindow(clip),
        },
        time,
        {
          id:
            stored !== undefined && stored.version >= 3
              ? stored.clips.find((item) => item.track === trackId && item.index === index && item.fingerprint === `reference:${id}`)?.id
              : undefined,
          name: clip.getAttribute("name") || undefined,
          linkedTo: owner.clipId,
        },
      );
      if (loop) project.setClipLoop(added.id, { startBeat: loop.start, endBeat: loop.end });
      if (sceneId) adoptSlotClip(project, added.id, sceneId);
      link(added.id, clip, unit, container, trackId, sceneId);
    }
    // Extension data comes back as records; every other file this codec does not use is kept and written back unchanged on save.
    const records = new Map<string, ExtensionRecord>();
    const preserved = new Map<string, Uint8Array | Blob>();
    for (const [path, entry] of Object.entries(entries)) {
      if (usedPaths.has(path)) continue;
      const id = EXTENSION_PATH.exec(path)?.[1];
      const record = id !== undefined && EXTENSION_ID.test(id) && entry instanceof Uint8Array ? readExtensionRecord(entry) : undefined;
      if (record) records.set(id!, record);
      else {
        if (id !== undefined) warnings.push(`Extension data in ${path} could not be read and is kept unchanged.`);
        preserved.set(path, entry instanceof Uint8Array ? entry : entry.blob);
      }
    }
    if (records.size) extensionRecords(project, records);
    if (preserved.size) preservedEntries.set(project, preserved);
    if (stored?.clips.some((item) => !item.noteIds && !matchedAudio.has(item)))
      warnings.push("Audiorective audio clip details no longer match the arrangement and were skipped.");
    source.overlay = foreign || kept.length > 0;
    if (source.overlay) source.keptTimed = collectKeptTimed(source, arrangement);
    if (source.overlay) {
      for (const path of decodedFiles.keys()) {
        const entry = entries[path];
        if (entry) source.entries.set(path, entry instanceof Uint8Array ? entry : entry.blob);
      }
      sourceXml.set(project, source);
      source.baseline = freshKeys(project);
      if (kept.length) warnings.push(`Kept in the file unchanged, not played or edited: ${kept.join("; ")}.`);
    }
    if (pendingFiles.size) pendingAudioFiles.set(project, pendingFiles);
    if (wavPcmNeeded.size) {
      // The archive is read again with the PCM of these files; a clip that waited for its original has not looked at its render yet.
      for (const item of stored?.clips ?? []) {
        const render = readStoredRender(item.render);
        const entry = render && entries[render.path];
        if (render && entry && !(entry instanceof Uint8Array)) wavPcmNeeded.set(render.path, { blob: entry.blob });
      }
      wavPcmFiles.set(project, wavPcmNeeded);
    }
    return { project, warnings: Object.freeze(warnings) };
  } catch (error) {
    project.dispose();
    throw error;
  }
}

/** Whether a clip plays a recording that came from a compressed file of the opened archive, which a save writes back as it was. */
function keepsCompressedAudio(project: Project, clips: readonly ProjectClip[]): boolean {
  const source = sourceXml.get(project);
  if (!source?.encodedAudio.size) return false;
  return clips.some((clip) => {
    if (clip.kind !== "audio" || clip.stretch) return false;
    const path = source.recordings.get(audioRecording(clip).key);
    return path !== undefined && source.encodedAudio.has(path);
  });
}

/**
 * Describe what another DAW receives when `project` is saved with this codec.
 * `warnings` (for example `workspace.cells.warnings.value`) are appended to the limitations. An audio fallback is a separate export.
 */
export function portabilityReport(project: Project, warnings: readonly string[] = []): PortabilityReport {
  const tracks = project.tracks;
  const devices = tracks.flatMap((track) => track.devices);
  const clips = tracks.flatMap((track) => [...track.clips, ...slotClipsOf(project, track.id)]);
  return {
    standardContent: [
      ...(readSession(project).scenes.length ? ["Session scenes and clip slots"] : []),
      project.tempoMap.changes.length ? "DAWproject track layout and step tempo automation" : "DAWproject track layout and fixed tempo",
      ...(clips.some((clip) => clip.kind === "audio") ? ["audio clips"] : []),
      ...(keepsCompressedAudio(project, clips) ? ["audio clips that keep their original compressed files (Ogg, MP3, FLAC, ...) byte for byte"] : []),
      ...(clips.some((clip) => clip.kind === "audio" && (clip.envelope?.fadeIn || clip.envelope?.fadeOut)) ? ["audio clip fades"] : []),
      ...(clips.some(
        (clip) => clip.kind === "audio" && !clip.loop && ((clip.envelope && clip.envelope.gain !== 1) || (clip.gainAutomation && !clip.stretch)),
      )
        ? ["audio clip gain and gain automation"]
        : []),
      ...(clips.some((clip) => clip.kind === "audio" && clip.stretch)
        ? ["time-stretched audio clips as the original audio with warp markers (Bitwig Studio's form)"]
        : []),
      ...(clips.some((clip) => clip.kind === "midi") ? ["MIDI notes and supported controllers"] : []),
      ...(project.markers.length ? ["markers"] : []),
      ...(tracks.some((track) => track.volumeAutomation.length) ? ["track volume automation"] : []),
      ...(tracks.some((track) => track.controllerLanes.length) ? ["MIDI controller lanes (sustain, modulation, pitch bend, ...)"] : []),
    ],
    pluginDependencies: devices.map((device) => `${device.name} (${device.pluginId}) needs a matching CLAP plug-in in the receiving DAW`),
    limitations: [
      "Other DAWs may not preserve Audiorective-specific MIDI details or WebCLAP bundle locations.",
      ...(clips.some((clip) => clip.kind === "audio" && clip.envelope && clip.envelope.gain !== 1 && clip.loop)
        ? ["Gain of a looped audio clip is stored in Audiorective metadata. Use the rendered fallback to preserve it in other DAWs."]
        : []),
      ...(clips.some((clip) => clip.kind === "audio" && clip.gainAutomation && (clip.stretch || clip.loop))
        ? [
            "Gain automation of a stretched or looped audio clip is stored in Audiorective metadata. Use the rendered fallback to preserve it in other DAWs.",
          ]
        : []),
      ...(tracks.some((track) => track.effects.length) ? ["Audiorective built-in inserts require Audiorective or the rendered audio fallback."] : []),
      ...(clips.some((clip) => clip.kind === "audio" && clip.stretch)
        ? [
            "Time-stretched clips travel as the original audio with warp markers; another DAW stretches them with its own engine, so the sound can differ from Audiorective's. The pitch-correct render stays in the Audiorective package (audiorective/render/) and adds its size to the file; a DAW that saves the file drops it.",
          ]
        : []),
      "Editable import in a specific DAW needs an actual open-and-save test.",
      "A separate audio fallback is needed to hear hosted plug-ins without matching CLAP binaries.",
      ...(tracks.length > 15 ? ["Audio fallback includes a mix only when a project has more than 15 tracks."] : []),
      ...warnings,
    ],
  };
}
