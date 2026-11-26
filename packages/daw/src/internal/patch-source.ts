import { XMLSerializer } from "@xmldom/xmldom";
import type { Element } from "@xmldom/xmldom";
import type { TempoMap } from "../tempo-map";
import { foldSteps, leavingShapes, type PointShape } from "./point-shape";
import { identityWarpPoints, readWarpPoints, warpTolerance, warpVerdict } from "./nested-audio";
import { controllerFromNormalized, type ControllerExpression } from "../controller-lane";
import { unmodeledPoints, type ClipLink, type Snapshot, type SourceXml, type TrackLink } from "./source-xml";

/** The elements the model would write for the current project, by entity key (`clip:clip3`, `volume:track1`, ...). */
export type FreshIndex = Map<string, Element>;

const serializer = new XMLSerializer();
const serialize = (element: Element) => serializer.serializeToString(element);

/** The values an entity has right now, for comparing with the same snapshot taken when the file was opened or last saved. */
export function snapshot(index: FreshIndex): Map<string, Snapshot> {
  const out = new Map<string, Snapshot>();
  for (const [key, element] of index) {
    const attrs: Record<string, string> = {};
    for (let i = 0; i < element.attributes.length; i++) attrs[element.attributes.item(i)!.name] = element.attributes.item(i)!.value;
    const childXml: Record<string, string> = {};
    let children = "";
    for (const child of kids(element)) {
      const xml = serialize(child);
      children += xml;
      childXml[child.tagName] = (childXml[child.tagName] ?? "") + xml;
    }
    out.set(key, { attrs, xml: serialize(element), children, childXml });
  }
  return out;
}

const kids = (element: Element): Element[] => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
const kid = (element: Element, tag: string): Element | undefined => kids(element).find((child) => child.tagName === tag);
const kidsOf = (element: Element, tag: string): Element[] => kids(element).filter((child) => child.tagName === tag);

const rootOrder = ["Application", "Transport", "Structure", "Arrangement", "Scenes"];
const channelOrder = ["Devices", "Mute", "Pan", "Sends", "Volume"];
const deviceOrder = ["Parameters", "Enabled", "State"];
const arrangementOrder = ["Lanes", "Markers", "TempoAutomation", "TimeSignatureAutomation"];
const transportOrder = ["Tempo", "TimeSignature"];
const metadataOrder = [
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
/** The Clip attributes the model writes; everything else on a source clip (`color`, `comment`, `enable`) is left alone. */
const modeledClipAttributes = new Set([
  "name",
  "time",
  "duration",
  "contentTimeUnit",
  "playStart",
  "playStop",
  "loopStart",
  "loopEnd",
  "fadeTimeUnit",
  "fadeInTime",
  "fadeOutTime",
  "reference",
]);

type Args = {
  source: SourceXml;
  index: FreshIndex;
  entries: Record<string, Uint8Array>;
  mediaEntries: Map<string, unknown>;
  preserved: Array<[string, Uint8Array | Blob]>;
  /** Project seconds to beats under the project's current tempo map, for markers the source keeps in beats. */
  secondsToBeat: (seconds: number) => number;
  /** The project's tempo map, for audio clips the source writes in beats. */
  tempoMap: TempoMap;
};

/** Put `wanted` into the places the same elements hold among `parent`'s children, in the order given; everything else stays where it is. */
function reorderAmong(parent: Element, wanted: readonly Element[]): void {
  const children = kids(parent);
  const set = new Set(wanted.filter((element) => element.parentNode === parent));
  const ordered = wanted.filter((element) => set.has(element));
  let next = 0;
  const target = children.map((child) => (set.has(child) ? ordered[next++] : child));
  if (target.every((child, i) => child === children[i])) return;
  for (const child of children) parent.removeChild(child);
  for (const child of target) parent.appendChild(child);
}

const noteAttributes = new Set(["time", "duration", "channel", "key", "vel"]);
const sameNumber = (a: string | null, b: string | null) => a !== null && b !== null && Math.abs(Number(a) - Number(b)) < 1e-9;
/** A note the edit left in place keeps the attributes the model has no field for (`rel`, a MIDI-CI id...) from the note it replaces. */
function carryNoteAttributes(before: Element[], clip: Element): void {
  const pool = before.filter((note) =>
    Array.from({ length: note.attributes.length }, (_, i) => note.attributes.item(i)!.name).some((name) => !noteAttributes.has(name)),
  );
  for (const note of Array.from(clip.getElementsByTagName("Note"))) {
    const at = pool.findIndex(
      (old) =>
        sameNumber(old.getAttribute("time"), note.getAttribute("time")) &&
        sameNumber(old.getAttribute("key"), note.getAttribute("key")) &&
        sameNumber(old.getAttribute("channel"), note.getAttribute("channel")),
    );
    if (at < 0) continue;
    const [old] = pool.splice(at, 1);
    for (let i = 0; i < old.attributes.length; i++) {
      const name = old.attributes.item(i)!.name;
      if (!noteAttributes.has(name) && !note.hasAttribute(name)) note.setAttribute(name, old.attributes.item(i)!.value);
    }
  }
}

/**
 * Apply what the project changed since the file was opened (or last saved) to the file's own XML, element by element: a changed clip
 * replaces its own attributes and content, a new track is inserted, a removed one is taken out, and every other element, attribute
 * and archive entry stays as the other application wrote it. Returns the project.xml and metadata.xml text.
 */
export function applySourcePatch({ source, index, entries, mediaEntries, preserved, secondsToBeat, tempoMap }: Args): {
  projectXml: string;
  metadataXml: string;
} {
  const doc = source.project;
  const root = doc.documentElement!;
  const base = source.baseline ?? new Map<string, Snapshot>();
  const cur = snapshot(index);
  const ids = new Set<string>();
  for (const element of Array.from(root.getElementsByTagName("*"))) {
    const id = element.getAttribute("id");
    if (id) ids.add(id);
  }
  const usedPaths = () =>
    new Set(Array.from(root.getElementsByTagName("*")).flatMap((element) => (element.hasAttribute("path") ? [element.getAttribute("path")!] : [])));
  const freshOwned = new Set<string>();

  const changed = (key: string) => base.get(key)?.xml !== cur.get(key)?.xml;
  const create = (tag: string, attrs: Record<string, string> = {}) => {
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  };
  const setAttr = (element: Element, name: string, value: string | undefined | null) => {
    if (value === undefined || value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  };
  const insertOrdered = (parent: Element, node: Element, order: readonly string[]) => {
    const rank = order.indexOf(node.tagName);
    const later = kids(parent).find((child) => order.indexOf(child.tagName) > rank && rank >= 0);
    if (later) parent.insertBefore(node, later);
    else parent.appendChild(node);
  };
  const remove = (element: Element | undefined | null) => {
    element?.parentNode?.removeChild(element);
  };
  /** A deep copy of a fresh element in the source document, with IDs that are free there and file paths that do not clash. */
  const adopt = (element: Element): Element => {
    const copy = (from: Element): Element => {
      const next = doc.createElement(from.tagName);
      for (let i = 0; i < from.attributes.length; i++) next.setAttribute(from.attributes.item(i)!.name, from.attributes.item(i)!.value);
      for (const child of kids(from)) next.appendChild(copy(child));
      return next;
    };
    const clone = copy(element);
    const renames = new Map<string, string>();
    const all = [clone, ...Array.from(clone.getElementsByTagName("*"))];
    for (const node of all) {
      const id = node.getAttribute("id");
      if (!id) continue;
      let free = id;
      for (let n = 2; ids.has(free); n++) free = `${id}-${n}`;
      if (free !== id) {
        renames.set(id, free);
        node.setAttribute("id", free);
      }
      ids.add(free);
    }
    if (renames.size)
      for (const node of all)
        for (const name of ["reference", "destination", "parameter"]) {
          const value = node.getAttribute(name);
          if (value && renames.has(value)) node.setAttribute(name, renames.get(value)!);
        }
    // Bytes this save writes belong to the new element; a path the file already uses for something else moves aside.
    const taken = usedPaths();
    for (const node of all) {
      const path = node.getAttribute("path");
      if (!path) continue;
      const wrote = path in entries || mediaEntries.has(path);
      if (wrote && taken.has(path)) {
        const dot = path.lastIndexOf(".");
        let next = path;
        for (let n = 2; next in entries || mediaEntries.has(next) || taken.has(next) || source.entries.has(next); n++)
          next = `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
        if (path in entries) {
          entries[next] = entries[path];
          delete entries[path];
        } else {
          mediaEntries.set(next, mediaEntries.get(path));
          mediaEntries.delete(path);
        }
        node.setAttribute("path", next);
        freshOwned.add(next);
      } else if (wrote) freshOwned.add(path);
    }
    return clone;
  };
  const mergeAttrs = (
    target: Element,
    before: Record<string, string>,
    after: Record<string, string>,
    skip: readonly string[] = [],
    map?: (name: string, value: string) => string | undefined | null,
  ) => {
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (skip.includes(name) || before[name] === after[name]) continue;
      const value = after[name];
      if (value === undefined) target.removeAttribute(name);
      else {
        const mapped = map ? map(name, value) : value;
        setAttr(target, name, mapped);
      }
    }
  };
  const ensureId = (element: Element, wanted: string): string => {
    const existing = element.getAttribute("id");
    if (existing) return existing;
    let free = wanted;
    for (let n = 2; ids.has(free); n++) free = `${wanted}-${n}`;
    ids.add(free);
    element.setAttribute("id", free);
    return free;
  };

  // --- Title -----------------------------------------------------------------------------------------------------------------------
  if (changed("title")) {
    const metaRoot = source.metadata.documentElement!;
    let title = kid(metaRoot, "Title");
    if (!title) {
      title = source.metadata.createElement("Title");
      const later = kids(metaRoot).find((child) => metadataOrder.indexOf(child.tagName) > 0);
      if (later) metaRoot.insertBefore(title, later);
      else metaRoot.appendChild(title);
    }
    title.textContent = index.get("title")!.textContent;
  }

  // --- Transport ---------------------------------------------------------------------------------------------------------------------
  const transportOf = () => {
    let transport = kid(root, "Transport");
    if (!transport) {
      transport = create("Transport");
      insertOrdered(root, transport, rootOrder);
    }
    return transport;
  };
  for (const [key, tag] of [
    ["tempo", "Tempo"],
    ["signature", "TimeSignature"],
  ] as const) {
    if (!changed(key)) continue;
    const transport = transportOf();
    let element = kid(transport, tag);
    if (!element) {
      element = adopt(index.get(key)!);
      insertOrdered(transport, element, transportOrder);
    } else mergeAttrs(element, base.get(key)!.attrs, cur.get(key)!.attrs, ["id", "unit"]);
  }

  // --- Structure -----------------------------------------------------------------------------------------------------------------------
  const trackKeys = (snapshots: Map<string, Snapshot>) => [...snapshots.keys()].filter((key) => key.startsWith("track:")).map((key) => key.slice(6));
  const baseTracks = new Set(trackKeys(base));
  const curTracks = trackKeys(cur);
  const laneOf = (trackId: string, create_ = false): Element | undefined => {
    const sourceId = source.tracks.get(trackId)?.sourceId ?? trackId;
    let arrangement = kid(root, "Arrangement");
    if (!arrangement) {
      if (!create_) return undefined;
      arrangement = create("Arrangement", { id: freshId("arrangement") });
      insertOrdered(root, arrangement, rootOrder);
    }
    let outer = kid(arrangement, "Lanes");
    if (!outer) {
      if (!create_) return undefined;
      outer = create("Lanes", { id: freshId("projectLanes"), timeUnit: "seconds" });
      insertOrdered(arrangement, outer, arrangementOrder);
    }
    let lane = kidsOf(outer, "Lanes").find((item) => item.getAttribute("track") === sourceId);
    if (!lane && create_) {
      lane = create("Lanes", { id: freshId(`${sourceId}-lane`), track: sourceId, timeUnit: "seconds" });
      outer.appendChild(lane);
    }
    return lane;
  };
  const freshId = (wanted: string) => {
    let free = wanted;
    for (let n = 2; ids.has(free); n++) free = `${wanted}-${n}`;
    ids.add(free);
    return free;
  };
  const mapChannelRef = (value: string): string | null => {
    if (value === "masterChannel") return source.master ? ensureId(source.master.channel, "masterChannel") : null;
    if (value.endsWith("-channel")) {
      const link = source.tracks.get(value.slice(0, -"-channel".length));
      if (link?.channel) return ensureId(link.channel, `${link.sourceId}-channel`);
    }
    return value;
  };
  const structureOf = () => {
    let structure = kid(root, "Structure");
    if (!structure) {
      structure = create("Structure");
      insertOrdered(root, structure, rootOrder);
    }
    return structure;
  };
  const writeLevel = (
    link: { element: Element; unit: "linear" | "decibel" } | undefined,
    fresh: Element | undefined,
    parent: Element,
    order: readonly string[],
  ) => {
    if (!fresh) return;
    const value = Number(fresh.getAttribute("value"));
    if (link) link.element.setAttribute("value", String(link.unit === "decibel" ? (value <= 0 ? -144 : 20 * Math.log10(value)) : value));
    else insertOrdered(parent, adopt(fresh), order);
  };

  const removeTrack = (trackId: string) => {
    const link = source.tracks.get(trackId);
    if (!link) return;
    remove(link.track ?? link.channel);
    remove(laneOf(trackId));
    for (const slot of Array.from(root.getElementsByTagName("ClipSlot"))) if (slot.getAttribute("track") === link.sourceId) remove(slot);
    for (const [clipId, clip] of source.clips) if (clip.trackId === trackId) source.clips.delete(clipId);
    source.tracks.delete(trackId);
    source.automation.delete(trackId);
    source.controllerLanes.delete(trackId);
    source.sends.delete(trackId);
  };
  const addTrack = (trackId: string) => {
    const element = adopt(index.get(`track:${trackId}`)!);
    const master = source.master?.channel.parentNode as Element | null | undefined;
    const structure = structureOf();
    // The model lists the master apart, so the new track goes after the last other track: before a master that comes last, after
    // the tracks when it comes first.
    const last = kidsOf(structure, "Track")
      .filter((track) => track !== master && track !== element)
      .pop();
    if (last) structure.insertBefore(element, last.nextSibling);
    else if (master && master.tagName === "Track" && master.parentNode === structure && kidsOf(structure, "Track")[0] !== master)
      structure.insertBefore(element, master);
    else structure.appendChild(element);
    const channel = kid(element, "Channel")!;
    const destination = channel.getAttribute("destination");
    if (destination !== null) setAttr(channel, "destination", mapChannelRef(destination));
    for (const send of Array.from(channel.getElementsByTagName("Send")))
      setAttr(send, "destination", mapChannelRef(send.getAttribute("destination") ?? ""));
    const link: TrackLink = {
      track: element,
      channel,
      sourceId: element.getAttribute("id")!,
      channelId: channel.getAttribute("id"),
      volume: kid(channel, "Volume") ? { element: kid(channel, "Volume")!, unit: "linear" } : undefined,
      pan: kid(channel, "Pan") ? { element: kid(channel, "Pan")!, min: 0, max: 1 } : undefined,
      mute: kid(channel, "Mute"),
    };
    source.tracks.set(trackId, link);
    if (link.channelId) source.channelToTrack.set(link.channelId, trackId);
    const sends = new Map<string, Element>();
    for (const send of Array.from(channel.getElementsByTagName("Send"))) {
      const bus = [...source.tracks].find(([, item]) => item.channelId === send.getAttribute("destination"))?.[0];
      if (bus) sends.set(bus, send);
    }
    if (sends.size) source.sends.set(trackId, sends);
  };
  const deviceNodes = (channel: Element) => kids(kid(channel, "Devices") ?? create("Devices"));
  const devicesOf = (channel: Element) => {
    let devices = kid(channel, "Devices");
    if (!devices) {
      devices = create("Devices");
      insertOrdered(channel, devices, channelOrder);
    }
    return devices;
  };
  const patchTrack = (trackId: string) => {
    const link = source.tracks.get(trackId);
    if (!link) return;
    const key = (kind: string) => `${kind}:${trackId}`;
    if (link.track) mergeAttrs(link.track, base.get(key("track"))!.attrs, cur.get(key("track"))!.attrs, ["id", "contentType"]);
    mergeAttrs(link.channel, base.get(key("channel"))!.attrs, cur.get(key("channel"))!.attrs, ["id", "role", "audioChannels"], (name, value) =>
      name === "destination" ? mapChannelRef(value) : value,
    );
    if (changed(key("mute"))) {
      const fresh = index.get(key("mute"))!;
      if (link.mute) link.mute.setAttribute("value", fresh.getAttribute("value")!);
      else {
        link.mute = adopt(fresh);
        insertOrdered(link.channel, link.mute, channelOrder);
      }
    }
    if (changed(key("pan"))) {
      const fresh = index.get(key("pan"))!;
      if (link.pan) {
        const { min, max } = link.pan;
        link.pan.element.setAttribute("value", String(min + Number(fresh.getAttribute("value")) * (max - min)));
      } else {
        const element = adopt(fresh);
        insertOrdered(link.channel, element, channelOrder);
        link.pan = { element, min: 0, max: 1 };
      }
    }
    if (changed(key("volume"))) {
      const before = link.volume;
      writeLevel(link.volume, index.get(key("volume")), link.channel, channelOrder);
      if (!before) link.volume = { element: kid(link.channel, "Volume")!, unit: "linear" };
    }
    if (changed(key("sends"))) patchSends(trackId, link);
    patchDevices(trackId, link);
  };
  const patchSends = (trackId: string, link: TrackLink) => {
    const wanted = new Map<string, number>();
    for (const send of kids(index.get(`sends:${trackId}`) ?? create("Sends")))
      wanted.set((send.getAttribute("destination") ?? "").slice(0, -"-channel".length), Number(kid(send, "Volume")?.getAttribute("value") ?? 0));
    const sends = source.sends.get(trackId) ?? new Map<string, Element>();
    source.sends.set(trackId, sends);
    for (const [bus, element] of sends)
      if (!wanted.has(bus)) {
        remove(element);
        sends.delete(bus);
      }
    for (const [bus, gain] of wanted) {
      const existing = sends.get(bus);
      if (existing) {
        const volume = kid(existing, "Volume");
        if (volume && Number(volume.getAttribute("value")) !== gain) volume.setAttribute("value", String(gain));
        continue;
      }
      const fresh = kids(index.get(`sends:${trackId}`)!).find((send) => send.getAttribute("destination") === `${bus}-channel`)!;
      const element = adopt(fresh);
      setAttr(element, "destination", mapChannelRef(`${bus}-channel`));
      let container = kid(link.channel, "Sends");
      if (!container) {
        container = create("Sends");
        insertOrdered(link.channel, container, channelOrder);
      }
      container.appendChild(element);
      sends.set(bus, element);
    }
  };
  const patchDevices = (trackId: string, link: TrackLink) => {
    const prefix = `device:${trackId}:`;
    const baseIds = [...base.keys()].filter((key) => key.startsWith(prefix));
    const curIds = [...cur.keys()].filter((key) => key.startsWith(prefix));
    for (const key of baseIds) {
      if (cur.has(key)) continue;
      const id = key.slice(prefix.length);
      remove(deviceNodes(link.channel).find((node) => node.getAttribute("id") === id));
      source.devices.delete(id);
    }
    for (const key of curIds) {
      const id = key.slice(prefix.length);
      if (!base.has(key)) {
        const element = adopt(index.get(key)!);
        // Devices keep the order the file gave them; the model's WebCLAP devices come before its built-in inserts.
        const devices = devicesOf(link.channel);
        const firstInsert = kids(devices).find((node) => (node.getAttribute("deviceID") ?? "").startsWith("audiorective.insert."));
        if (firstInsert) devices.insertBefore(element, firstInsert);
        else devices.appendChild(element);
        source.devices.set(id, element);
      } else if (changed(key)) {
        const existing = deviceNodes(link.channel).find((node) => node.getAttribute("id") === id);
        if (!existing) continue;
        const before = base.get(key)!;
        const after = cur.get(key)!;
        mergeAttrs(existing, before.attrs, after.attrs, ["id"]);
        for (const tag of ["State"])
          if (before.childXml[tag] !== after.childXml[tag]) {
            remove(kid(existing, tag));
            const fresh = kid(index.get(key)!, tag);
            if (fresh) insertOrdered(existing, adopt(fresh), deviceOrder);
          }
      }
      // A plug-in's state bytes can change while its State element stays the same: the file's own entry takes the model's bytes.
      const element = deviceNodes(link.channel).find((node) => node.getAttribute("id") === id);
      const freshPath = kid(index.get(key)!, "State")?.getAttribute("path");
      const keptPath = element && kid(element, "State")?.getAttribute("path");
      const bytes = freshPath ? entries[freshPath] : undefined;
      const original = keptPath ? source.entries.get(keptPath) : undefined;
      // A file-backed (Blob) entry is not read here: the model's bytes, which were read from that same entry, are written instead.
      const differs = original instanceof Uint8Array ? bytes?.length !== original.length || bytes.some((byte, i) => byte !== original[i]) : true;
      if (keptPath && bytes && original && differs) {
        if (freshPath !== keptPath) delete entries[freshPath!];
        entries[keptPath] = bytes;
        freshOwned.add(keptPath);
      }
    }
    const order = curIds.map((key) => deviceNodes(link.channel).find((node) => node.getAttribute("id") === key.slice(prefix.length)));
    const devicesElement = kid(link.channel, "Devices");
    if (devicesElement)
      reorderAmong(
        devicesElement,
        order.filter((node): node is Element => node !== undefined),
      );
    const effects = (snapshots: Map<string, Snapshot>) =>
      [...snapshots].filter(([key]) => key.startsWith(`fx:${trackId}:`)).map(([, value]) => value.xml);
    if (JSON.stringify(effects(base)) !== JSON.stringify(effects(cur))) {
      for (const node of deviceNodes(link.channel)) if ((node.getAttribute("deviceID") ?? "").startsWith("audiorective.insert.")) remove(node);
      for (const key of [...cur.keys()].filter((item) => item.startsWith(`fx:${trackId}:`)))
        devicesOf(link.channel).appendChild(adopt(index.get(key)!));
    }
  };

  for (const trackId of baseTracks) if (!curTracks.includes(trackId)) removeTrack(trackId);
  for (const trackId of curTracks) {
    if (!baseTracks.has(trackId)) addTrack(trackId);
    else patchTrack(trackId);
  }
  if (changed("master")) {
    if (!source.master) throw new Error("Project master volume cannot be saved: the file has no master channel.");
    const before = source.master.volume;
    writeLevel(before, index.get("master"), source.master.channel, channelOrder);
    if (!before) source.master.volume = { element: kid(source.master.channel, "Volume")!, unit: "linear" };
  }

  // --- Scenes -----------------------------------------------------------------------------------------------------------------------
  const sceneKeys = (snapshots: Map<string, Snapshot>) => [...snapshots.keys()].filter((key) => key.startsWith("scene:")).map((key) => key.slice(6));
  const baseScenes = new Set(sceneKeys(base));
  for (const sceneId of baseScenes) {
    if (cur.has(`scene:${sceneId}`)) continue;
    remove(source.scenes.get(sceneId));
    source.scenes.delete(sceneId);
  }
  for (const sceneId of sceneKeys(cur)) {
    const key = `scene:${sceneId}`;
    if (baseScenes.has(sceneId)) {
      const element = source.scenes.get(sceneId);
      if (element) mergeAttrs(element, base.get(key)!.attrs, cur.get(key)!.attrs, ["id"]);
      continue;
    }
    // A new scene arrives empty: its clips come in with the clips below.
    const fresh = index.get(key)!;
    const element = adopt(
      create(
        fresh.tagName,
        Object.fromEntries(
          Array.from({ length: fresh.attributes.length }, (_, i) => [fresh.attributes.item(i)!.name, fresh.attributes.item(i)!.value]),
        ),
      ),
    );
    element.appendChild(create("Lanes", { id: freshId(`${sceneId}-lanes`), timeUnit: "seconds" }));
    let scenes = kid(root, "Scenes");
    if (!scenes) {
      scenes = create("Scenes");
      insertOrdered(root, scenes, rootOrder);
    }
    scenes.appendChild(element);
    source.scenes.set(sceneId, element);
  }

  const scenesElement = kid(root, "Scenes");
  if (scenesElement)
    reorderAmong(
      scenesElement,
      sceneKeys(cur).flatMap((id) => source.scenes.get(id) ?? []),
    );

  // --- Clips ----------------------------------------------------------------------------------------------------------------------------
  const clipKeys = (snapshots: Map<string, Snapshot>) => [...snapshots.keys()].filter((key) => key.startsWith("clip:")).map((key) => key.slice(5));
  const baseClips = new Set(clipKeys(base));
  const curClips = clipKeys(cur);
  const effectiveUnit = (element: Element | null): "seconds" | "beats" => {
    for (let node: Element | null = element; node; node = node.parentNode as Element | null) {
      const unit = node.getAttribute?.("timeUnit");
      if (unit === "seconds" || unit === "beats") return unit;
    }
    return "beats";
  };
  /** Where a clip of the fresh document goes in the source: the lane's Clips of its unit, or the scene's slot for its track. */
  const containerFor = (
    fresh: Element,
    forceUnit?: "seconds" | "beats",
  ): { container: Element; trackId: string; unit: "seconds" | "beats"; sceneId?: string } => {
    const holder = fresh.parentNode as Element;
    if (holder.tagName === "ClipSlot") {
      const trackId = holder.getAttribute("track")!;
      const scene = ((holder.parentNode as Element).parentNode as Element).getAttribute("id")!;
      const sceneElement = source.scenes.get(scene);
      if (!sceneElement) throw new Error("Project scene is missing from the file it was opened from.");
      let lanes = kid(sceneElement, "Lanes");
      if (!lanes) {
        lanes = create("Lanes", { id: freshId(`${scene}-lanes`), timeUnit: "seconds" });
        sceneElement.appendChild(lanes);
      }
      const sourceTrack = source.tracks.get(trackId)?.sourceId ?? trackId;
      const unit = holder.getAttribute("timeUnit") === "beats" ? "beats" : "seconds";
      let slot = kidsOf(lanes, "ClipSlot").find((item) => item.getAttribute("track") === sourceTrack);
      if (!slot) {
        slot = create("ClipSlot", { id: freshId(`${scene}-${sourceTrack}-slot`), track: sourceTrack, timeUnit: unit });
        lanes.appendChild(slot);
      }
      if (kid(slot, "Clip")) throw new Error("Project scene slot holds content the model does not carry; remove it in the other application first.");
      slot.setAttribute("timeUnit", unit);
      return { container: slot, trackId, unit, sceneId: scene };
    }
    const trackId = (holder.parentNode as Element).getAttribute("track")!;
    const unit = forceUnit ?? (holder.getAttribute("timeUnit") === "beats" ? "beats" : "seconds");
    const lane = laneOf(trackId, true)!;
    let clips = kidsOf(lane, "Clips").find((item) => effectiveUnit(item) === unit);
    if (!clips) {
      clips = create("Clips", { id: freshId(`${trackId}-clips${unit === "beats" ? "-beats" : ""}`), timeUnit: unit });
      lane.appendChild(clips);
    }
    return { container: clips, trackId, unit };
  };
  // --- Audio clips in the nested form ---------------------------------------------------------------------------------------------
  const fmt = (value: number) => String(Math.round(value * 1e12) / 1e12);
  /** Set a number attribute only when it differs by more than `tolerance`, so a value the source wrote (a float32 beat count) stays as written. */
  const setNumber = (element: Element, name: string, value: number, tolerance: number, absentDefault?: number) => {
    const old = element.getAttribute(name);
    if (old === null) {
      if (absentDefault !== undefined && Math.abs(value - absentDefault) <= tolerance) return;
      element.setAttribute(name, fmt(value));
    } else if (Math.abs(Number(old) - value) > tolerance) element.setAttribute(name, fmt(value));
  };
  const firstNamed = (element: Element, tag: string): Element | undefined => element.getElementsByTagName(tag)[0] ?? undefined;
  /**
   * Write the model's moving gain curve (`fresh`: points in source seconds, `interpolation` how each value arrives) into the nested clip's own
   * `Points`, in that element's time unit (a unit it does not state is the timeline's, as Bitwig writes it; the unit is stated on a rewritten curve,
   * because Bitwig reads a curve without one in seconds). A curve that already means the same stays as the file wrote it; otherwise only the points
   * that differ are new elements. `start` is the clip's place in seconds, where a curve in beats runs at the tempo of its first beat.
   */
  const writeMovingCurve = (curve: Element, fresh: Element, start: number, timeline: "seconds" | "beats") => {
    const stated = curve.getAttribute("timeUnit") ?? (curve.parentNode as Element | null)?.getAttribute?.("timeUnit") ?? timeline;
    const inBeatsUnit = stated === "beats";
    const startBeat = tempoMap.secondsToBeat(start);
    const secondsPerBeat = inBeatsUnit ? Math.round((tempoMap.beatToSeconds(startBeat + 1) - tempoMap.beatToSeconds(startBeat)) * 1e12) / 1e12 : 1;
    type Meaning = { time: number; value: number; shape: PointShape };
    const meaningOf = (points: Element[], scale: number): Meaning[] => {
      const raw = points
        .map((point) => ({
          time: Number(point.getAttribute("time")) * scale,
          value: Number(point.getAttribute("value")),
          shape: (point.getAttribute("interpolation") === "hold" ? "hold" : "linear") as PointShape,
        }))
        .sort((a, b) => a.time - b.time);
      const folded = foldSteps(raw) ?? raw.filter((point, i) => raw[i + 1]?.time !== point.time);
      const leaving = leavingShapes(folded.map((point) => point.shape));
      return folded.map((point, i) => ({ time: point.time, value: point.value, shape: leaving[i] }));
    };
    const wanted = meaningOf(kidsOf(fresh, "RealPoint"), 1);
    const have = meaningOf(kidsOf(curve, "RealPoint"), secondsPerBeat);
    if (
      have.length === wanted.length &&
      have.every(
        (point, i) =>
          Math.abs(point.time - wanted[i].time) <= 1e-6 && Math.abs(point.value - wanted[i].value) <= 1e-6 && point.shape === wanted[i].shape,
      )
    )
      return;
    const old = kidsOf(curve, "RealPoint");
    for (const point of old) remove(point);
    for (const [i, point] of kidsOf(fresh, "RealPoint").entries()) {
      const time = inBeatsUnit ? Math.round((Number(point.getAttribute("time")) / secondsPerBeat) * 1e12) / 1e12 : Number(point.getAttribute("time"));
      const value = Number(point.getAttribute("value"));
      const interpolation = point.getAttribute("interpolation") ?? "linear";
      const same = old.findIndex(
        (item) =>
          Math.abs(Number(item.getAttribute("time")) - time) <= 1e-6 &&
          Math.abs(Number(item.getAttribute("value")) - value) <= 1e-6 &&
          // Nothing arrives at the first point, so its `interpolation` says nothing (Bitwig writes `linear`).
          (i === 0 || (item.getAttribute("interpolation") ?? "linear") === interpolation),
      );
      if (same >= 0) curve.appendChild(old.splice(same, 1)[0]);
      else curve.appendChild(create("RealPoint", { time: fmt(time), value: fmt(value), interpolation }));
    }
    if (!curve.hasAttribute("timeUnit")) curve.setAttribute("timeUnit", stated);
  };
  /**
   * Write the values of the model's clip (`fresh`, in seconds) into a clip that keeps Bitwig's nested form: place and length on the outer and
   * inner clip, name, fades, the file window, the gain curve. Only a value that changed is written. False, with nothing written, for a clip this
   * form cannot say (a loop, another file, a moving gain), which the caller writes in the model's own form instead.
   */
  const syncNested = (link: ClipLink, fresh: Element): boolean => {
    const nested = link.nested!;
    const outer = link.element;
    const { inner, audio } = nested;
    const unit = link.unit;
    const freshAudio = firstNamed(fresh, "Audio");
    const freshFile = freshAudio && firstNamed(freshAudio, "File");
    const freshWarps = firstNamed(fresh, "Warps");
    const file = firstNamed(audio, "File");
    if (fresh.hasAttribute("loopStart") || !freshAudio || !freshFile || !file) return false;
    if (
      file.getAttribute("path") !== freshFile.getAttribute("path") ||
      audio.getAttribute("channels") !== freshAudio.getAttribute("channels") ||
      audio.getAttribute("sampleRate") !== freshAudio.getAttribute("sampleRate")
    )
      return false;
    let gain = 1;
    let movingPoints: Element | undefined;
    const freshPoints = firstNamed(fresh, "Points");
    if (freshPoints) {
      const values = kidsOf(freshPoints, "RealPoint").map((point) => Number(point.getAttribute("value")));
      if (!values.length) return false;
      if (values.some((value) => value !== values[0])) {
        // A moving curve stays in this form where the reader models it: unstretched audio that starts at the file's start.
        if (freshWarps || Number(fresh.getAttribute("playStart") ?? 0) !== 0) return false;
        movingPoints = freshPoints;
      } else gain = values[0];
    }
    const t = Number(fresh.getAttribute("time"));
    const d = Number(fresh.getAttribute("duration"));
    const rate = Number(audio.getAttribute("sampleRate"));
    const recording = Number(audio.getAttribute("duration"));
    const inUnit = (seconds: number) => (unit === "beats" ? tempoMap.secondsToBeat(seconds) : seconds);
    const elapsed = (position: number) => (unit === "beats" ? tempoMap.beatToSeconds(position) : position);
    let plan: ReturnType<typeof planNested>;
    try {
      plan = planNested();
    } catch {
      return false;
    }
    function planNested() {
      const start = inUnit(t);
      const length = inUnit(t + d) - start;
      const fadeIn = Number(fresh.getAttribute("fadeInTime") ?? 0);
      const fadeOut = Number(fresh.getAttribute("fadeOutTime") ?? 0);
      const fadeUnit = outer.getAttribute("fadeTimeUnit") ?? (fadeIn || fadeOut ? unit : "seconds");
      const beat = (seconds: number) => tempoMap.secondsToBeat(seconds);
      const inB = fadeUnit === "beats" ? (fadeIn ? beat(t + fadeIn) - beat(t) : 0) : fadeIn;
      const outB = fadeUnit === "beats" ? (fadeOut ? beat(t + d) - beat(t + d - fadeOut) : 0) : fadeOut;
      const playStart = Number(fresh.getAttribute("playStart") ?? 0);
      const playStop = fresh.hasAttribute("playStop") ? Number(fresh.getAttribute("playStop")) : recording;
      // Where the clip's own place falls in the outer clip's unit, for the window's start.
      const outerStart = freshWarps ? (outer.hasAttribute("playStart") ? Number(outer.getAttribute("playStart")) : 0) : inUnit(t + playStart) - start;
      const innerStart = inner.hasAttribute("time") ? Number(inner.getAttribute("time")) : 0;
      const tempoBreaks = tempoMap.changes.map((change) => change.beat);
      const warps = nested.warps;
      let points: Array<{ time: number; contentTime: number }> | undefined;
      if (warps) {
        const from = inner.hasAttribute("playStart") ? Number(inner.getAttribute("playStart")) : 0;
        const verdict = warpVerdict({
          points: readWarpPoints(warps),
          from,
          length,
          start: start + innerStart,
          elapsed,
          tempoBreaks: unit === "beats" ? tempoBreaks : [],
          tolerance: warpTolerance(rate),
        });
        if (!verdict.identity || Math.abs(verdict.contentStart - playStart) > warpTolerance(rate))
          points = identityWarpPoints({
            from,
            length,
            start: start + innerStart,
            contentStart: playStart,
            elapsed,
            tempoBreaks: unit === "beats" ? tempoBreaks : [],
          });
      }
      // A stretched clip: the warp points the model's time map asks for, in the file's unit from the inner clip's own start.
      let stretchPoints: Array<{ time: number; contentTime: number }> | undefined;
      if (freshWarps) {
        const base = warps && inner.hasAttribute("playStart") ? Number(inner.getAttribute("playStart")) : 0;
        stretchPoints = kidsOf(freshWarps, "Warp").map((point) => ({
          time: base + inUnit(t + Number(point.getAttribute("time"))) - start,
          contentTime: Number(point.getAttribute("contentTime")),
        }));
      }
      const curveUnit =
        (nested.gain?.getAttribute("timeUnit") ?? (nested.gain?.parentNode as Element | undefined)?.getAttribute?.("timeUnit") ?? unit) === "beats"
          ? "beats"
          : "seconds";
      const curveEnd = curveUnit === "beats" ? beat(t + d) - beat(t) : d;
      return { start, length, fadeUnit, inB, outB, fadeIn, fadeOut, playStart, playStop, outerStart, points, curveEnd, stretchPoints };
    }
    // A stretched clip's length is a whole number of frames of its audio, so a length within a frame and a half is the one the file states.
    const frame = plan.stretchPoints ? inUnit(t + 1.5 / rate) - inUnit(t) : 0;
    const lengthTolerance = Math.max(1e-6 + 1e-7 * plan.length, frame);
    const windowTolerance = 0.5 / rate;
    const name = fresh.getAttribute("name");
    if ((outer.getAttribute("name") ?? null) !== name) {
      if (name === null) outer.removeAttribute("name");
      else outer.setAttribute("name", name);
    }
    setNumber(outer, "time", plan.start, 1e-9);
    setNumber(outer, "duration", plan.length, lengthTolerance);
    setNumber(inner, "duration", plan.length, lengthTolerance);
    if (plan.fadeIn || plan.fadeOut || outer.hasAttribute("fadeInTime") || outer.hasAttribute("fadeOutTime")) {
      for (const element of [outer, inner]) if (!element.hasAttribute("fadeTimeUnit")) element.setAttribute("fadeTimeUnit", plan.fadeUnit);
      setNumber(outer, "fadeInTime", plan.inB, 1e-6, 0);
      setNumber(outer, "fadeOutTime", plan.outB, 1e-6, 0);
      // Bitwig repeats a fade on the inner clip as the outer value over the seconds one beat lasts (a 0.5 s fade is 0.8333 beats outside and
      // 1.3889 inside at 100 BPM); an inner clip without fades stays without.
      const inside = (outerFade: number, seconds: number) => (plan.fadeUnit === "beats" && seconds ? (outerFade * outerFade) / seconds : outerFade);
      if (inner.hasAttribute("fadeInTime") || plan.fadeIn) setNumber(inner, "fadeInTime", inside(plan.inB, plan.fadeIn), 1e-6, 0);
      if (inner.hasAttribute("fadeOutTime") || plan.fadeOut) setNumber(inner, "fadeOutTime", inside(plan.outB, plan.fadeOut), 1e-6, 0);
    }
    if (outer.hasAttribute("playStart") || plan.playStart > 0) setNumber(outer, "playStart", plan.outerStart, 1e-4, 0);
    if (plan.stretchPoints) {
      let warps = nested.warps;
      if (!warps) {
        // The file's clip holds its audio directly: the audio (with its gain lanes) moves into a Warps and the window becomes the warp.
        const content = kids(inner).find((child) => child.tagName === "Audio" || child.tagName === "Lanes")!;
        warps = create("Warps", { id: freshId(`nested-warps`), contentTimeUnit: "seconds", timeUnit: unit });
        inner.insertBefore(warps, content);
        warps.appendChild(content);
        inner.removeAttribute("playStart");
        inner.removeAttribute("playStop");
        inner.setAttribute("contentTimeUnit", unit);
        nested.warps = warps;
        audio.setAttribute("algorithm", "stretch");
        for (const point of plan.stretchPoints) warps.appendChild(create("Warp", { time: fmt(point.time), contentTime: fmt(point.contentTime) }));
      } else {
        const have = readWarpPoints(warps);
        const same =
          have.length === plan.stretchPoints.length &&
          have.every(
            (point, i) =>
              Math.abs(point.time - plan.stretchPoints![i].time) <= lengthTolerance &&
              Math.abs(point.contentTime - plan.stretchPoints![i].contentTime) <= 1.5 / rate,
          );
        if (!same) {
          for (const point of kidsOf(warps, "Warp")) remove(point);
          for (const point of plan.stretchPoints) warps.appendChild(create("Warp", { time: fmt(point.time), contentTime: fmt(point.contentTime) }));
        }
      }
    } else if (nested.warps) {
      if (plan.points) {
        for (const point of kidsOf(nested.warps, "Warp")) remove(point);
        for (const point of plan.points) nested.warps.appendChild(create("Warp", { time: fmt(point.time), contentTime: fmt(point.contentTime) }));
      }
    } else {
      setNumber(inner, "playStart", plan.playStart, windowTolerance, 0);
      setNumber(inner, "playStop", plan.playStop, windowTolerance, plan.playStart + d);
    }
    if (outer.hasAttribute("loopStart") && outer.hasAttribute("loopEnd")) {
      setNumber(outer, "loopStart", Math.min(Number(outer.getAttribute("loopStart")), plan.outerStart), 1e-6);
      setNumber(outer, "loopEnd", plan.outerStart + plan.length, lengthTolerance);
    }
    let curve = nested.gain;
    if (movingPoints) {
      if (!curve) {
        const parent = audio.parentNode as Element;
        let lanes = parent;
        if (parent.tagName !== "Lanes") {
          lanes = create("Lanes", { id: freshId(`nested-content`) });
          parent.insertBefore(lanes, audio);
          lanes.appendChild(audio);
        }
        curve = create("Points", { unit: "linear", id: freshId(`nested-gain`) });
        curve.appendChild(create("Target", { expression: "gain" }));
        lanes.appendChild(curve);
        nested.gain = curve;
      }
      writeMovingCurve(curve, movingPoints, t, unit);
    } else if (!curve && gain !== 1) {
      const parent = audio.parentNode as Element;
      let lanes = parent;
      if (parent.tagName !== "Lanes") {
        lanes = create("Lanes", { id: freshId(`nested-content`) });
        parent.insertBefore(lanes, audio);
        lanes.appendChild(audio);
      }
      curve = create("Points", { unit: "linear", id: freshId(`nested-gain`) });
      curve.appendChild(create("Target", { expression: "gain" }));
      for (const time of [0, plan.curveEnd]) curve.appendChild(create("RealPoint", { value: fmt(gain), interpolation: "linear", time: fmt(time) }));
      lanes.appendChild(curve);
      nested.gain = curve;
    } else if (curve) {
      let points = kidsOf(curve, "RealPoint");
      if (points.length > 2 && Math.abs(Number(points[points.length - 1].getAttribute("time")) - plan.curveEnd) > lengthTolerance) {
        for (const point of points.slice(1, -1)) remove(point);
        points = kidsOf(curve, "RealPoint");
      }
      for (const point of points) setNumber(point, "value", gain, 1e-9);
      if (points.length > 1) setNumber(points[points.length - 1], "time", plan.curveEnd, lengthTolerance);
    }
    return true;
  };
  /** A clip the source did not have, in the nested form of the clips it has, when it has any in this track's lane: false when it has none. */
  const placeNested = (clipId: string, fresh: Element, carry?: Element): boolean => {
    const holder = fresh.parentNode as Element;
    if (holder.tagName !== "Clips" || !firstNamed(fresh, "Audio")) return false;
    const trackId = (holder.parentNode as Element).getAttribute("track")!;
    const peers = [...source.clips.values()].filter((item) => item.nested && item.sceneId === undefined);
    const peer = peers.find((item) => item.trackId === trackId) ?? peers[0];
    if (!peer) return false;
    const where = containerFor(fresh, peer.unit);
    const freshAudio = firstNamed(fresh, "Audio")!;
    const outer = create("Clip", { time: "0", duration: "0", enable: "true" });
    const clips = create("Clips", { id: freshId(`${clipId}-nested`) });
    const inner = create("Clip", { time: "0.0", duration: "0", contentTimeUnit: "seconds" });
    const audio = adopt(freshAudio);
    audio.setAttribute("algorithm", firstNamed(fresh, "Warps") ? "stretch" : "raw");
    audio.removeAttribute("timeUnit");
    inner.appendChild(audio);
    clips.appendChild(inner);
    outer.appendChild(clips);
    const link: ClipLink = { element: outer, unit: where.unit, container: where.container, trackId, nested: { inner, audio } };
    if (!syncNested(link, fresh)) return false;
    if (carry)
      for (let i = 0; i < carry.attributes.length; i++) {
        const name = carry.attributes.item(i)!.name;
        if (!modeledClipAttributes.has(name)) outer.setAttribute(name, carry.attributes.item(i)!.value);
      }
    where.container.appendChild(outer);
    source.clips.set(clipId, link);
    return true;
  };
  const place = (clipId: string, fresh: Element, carry?: Element, nestedAllowed = true) => {
    if (nestedAllowed && placeNested(clipId, fresh, carry)) return;
    const where = containerFor(fresh);
    const element = adopt(fresh);
    if (carry)
      for (let i = 0; i < carry.attributes.length; i++) {
        const name = carry.attributes.item(i)!.name;
        if (!modeledClipAttributes.has(name)) element.setAttribute(name, carry.attributes.item(i)!.value);
      }
    where.container.appendChild(element);
    source.clips.set(clipId, {
      element,
      unit: where.unit,
      container: where.container,
      trackId: where.trackId,
      sceneId: where.sceneId,
    } satisfies ClipLink);
  };
  for (const clipId of baseClips) {
    if (cur.has(`clip:${clipId}`)) continue;
    const link = source.clips.get(clipId);
    remove(link?.element);
    source.clips.delete(clipId);
  }
  for (const clipId of curClips) {
    const key = `clip:${clipId}`;
    const fresh = index.get(key)!;
    if (!baseClips.has(clipId) || !source.clips.has(clipId)) {
      place(clipId, fresh);
      continue;
    }
    if (!changed(key)) continue;
    const link = source.clips.get(clipId)!;
    const before = base.get(key)!;
    const after = cur.get(key)!;
    if (link.nested) {
      const holder = fresh.parentNode as Element;
      const lane = holder.tagName === "ClipSlot" ? holder : (holder.parentNode as Element);
      const sameHome =
        lane.getAttribute("track") === link.trackId &&
        (holder.tagName === "ClipSlot"
          ? link.sceneId !== undefined && ((holder.parentNode as Element).parentNode as Element).getAttribute("id") === link.sceneId
          : link.sceneId === undefined);
      if (sameHome && syncNested(link, fresh)) continue;
      // A clip that cannot stay in the nested form (a loop, a moving gain, other audio) goes back in the model's own form; one that only
      // moved to another track keeps the form its new neighbours have.
      remove(link.element);
      source.clips.delete(clipId);
      place(clipId, fresh, link.element, !sameHome);
      continue;
    }
    const curve = source.gainCurves.get(clipId);
    const freshPoints = kid(fresh, "Lanes") && kidsOf(kid(fresh, "Lanes")!, "Points")[0];
    const withoutGain = (xml: string | undefined) => (xml ?? "").replace(/<Points\b[\s\S]*?<\/Points>/g, "");
    const lanesOf = (snap: Snapshot) => snap.childXml.Lanes ?? "";
    if (
      curve?.points.parentNode &&
      freshPoints &&
      before.children !== after.children &&
      JSON.stringify(before.attrs) === JSON.stringify(after.attrs) &&
      withoutGain(lanesOf(before)) === withoutGain(lanesOf(after)) &&
      before.children.replace(lanesOf(before), "") === after.children.replace(lanesOf(after), "")
    ) {
      // Only the gain curve moved: the source's own lanes, audio and curve element stay, and its points are written in its own time unit.
      for (const point of kidsOf(curve.points, "RealPoint")) remove(point);
      for (const point of kidsOf(freshPoints, "RealPoint")) {
        const next = adopt(point);
        if (curve.unit === "beats")
          next.setAttribute("time", String(Math.round((Number(point.getAttribute("time")) / curve.secondsPerBeat) * 1e12) / 1e12));
        curve.points.appendChild(next);
      }
      continue;
    }
    const holder = fresh.parentNode as Element;
    const freshUnit = holder.getAttribute("timeUnit") === "beats" ? "beats" : "seconds";
    const sameScene = (holder.tagName === "ClipSlot") === (link.sceneId !== undefined);
    if (link.unit !== freshUnit || !sameScene) {
      source.gainCurves.delete(clipId);
      remove(link.element);
      place(clipId, fresh, link.element);
      continue;
    }
    mergeAttrs(link.element, before.attrs, after.attrs);
    if (before.children !== after.children) {
      source.gainCurves.delete(clipId);
      const oldNotes = Array.from(link.element.getElementsByTagName("Note"));
      // Controller `Points` the model could not read stay in the clip's content.
      const unread = Array.from(link.element.getElementsByTagName("Points")).filter((points) => unmodeledPoints.has(points));
      for (const child of kids(link.element)) remove(child);
      for (const child of kids(fresh)) link.element.appendChild(adopt(child));
      const content = kid(link.element, "Lanes");
      if (content) for (const points of unread) content.appendChild(points);
      carryNoteAttributes(oldNotes, link.element);
    }
  }
  // A clip that shares another's notes points at that clip's timeline by the id the source gives it.
  for (const clipId of curClips) {
    const fresh = index.get(`clip:${clipId}`)!;
    const reference = fresh.getAttribute("reference");
    const link = source.clips.get(clipId);
    if (!reference || !link) continue;
    const suffix = reference.endsWith("-content") ? "-content" : "-notes";
    const owner = source.clips.get(reference.slice(0, -suffix.length));
    if (!owner) continue;
    const lanes = kid(owner.element, "Lanes");
    const target = suffix === "-content" ? (lanes ?? kid(owner.element, "Notes")) : kid(lanes ?? owner.element, "Notes");
    if (target) link.element.setAttribute("reference", ensureId(target, `${reference.slice(0, -suffix.length)}${suffix}`));
  }

  // --- Volume automation, markers, tempo ------------------------------------------------------------------------------------------
  for (const key of new Set([...base.keys(), ...cur.keys()])) {
    if (!key.startsWith("auto:") || !changed(key)) continue;
    const trackId = key.slice(5);
    const link = source.tracks.get(trackId);
    const points = source.automation.get(trackId);
    const fresh = index.get(key);
    if (!link) continue;
    if (!fresh) {
      remove(points);
      source.automation.delete(trackId);
    } else if (points) {
      for (const point of kidsOf(points, "RealPoint")) remove(point);
      for (const point of kidsOf(fresh, "RealPoint")) points.appendChild(adopt(point));
    } else {
      const element = adopt(fresh);
      const volumeId = link.volume ? ensureId(link.volume.element, `${link.sourceId}-volume`) : undefined;
      const target = kid(element, "Target");
      if (target && volumeId) target.setAttribute("parameter", volumeId);
      laneOf(trackId, true)!.appendChild(element);
      source.automation.set(trackId, element);
    }
  }
  // --- MIDI controller lanes of a track ---------------------------------------------------------------------------------------------
  for (const key of new Set([...base.keys(), ...cur.keys()])) {
    const parts = /^ctl:(.*):([A-Za-z]+:\d+:\d+)$/.exec(key);
    if (!parts || !changed(key)) continue;
    const [, trackId, laneKey] = parts;
    if (!source.tracks.get(trackId)) continue;
    const links = source.controllerLanes.get(trackId);
    const link = links?.get(laneKey);
    const fresh = index.get(key);
    if (!fresh) {
      remove(link?.points);
      links?.delete(laneKey);
    } else if (link?.points.parentNode) {
      // The lane stays where and how the file wrote it: its own `Points`, its time unit, and IntegerPoint when it used them.
      const expression = kid(fresh, "Target")!.getAttribute("expression") as ControllerExpression;
      const integer = kidsOf(link.points, "IntegerPoint").length > 0 && kidsOf(link.points, "RealPoint").length === 0;
      const old = [...kidsOf(link.points, "RealPoint"), ...kidsOf(link.points, "IntegerPoint")];
      for (const point of old) remove(point);
      // A point the edit left alone keeps its own element, so the file's own digits stay.
      const meaning = (point: Element) => {
        const at = Number(point.getAttribute("time"));
        const value = Number(point.getAttribute("value"));
        return {
          beat: link.unit === "beats" ? at : tempoMap.secondsToBeat(at),
          value: point.tagName === "IntegerPoint" ? value : controllerFromNormalized(expression, value),
          shape: point.tagName === "IntegerPoint" ? "hold" : (point.getAttribute("interpolation") ?? "linear"),
        };
      };
      for (const point of kidsOf(fresh, "RealPoint")) {
        const beat = Number(point.getAttribute("time"));
        const value = controllerFromNormalized(expression, Number(point.getAttribute("value")));
        const shape = point.getAttribute("interpolation");
        const same = old.findIndex((item) => {
          const was = meaning(item);
          return Math.abs(was.beat - beat) < 1e-9 && was.value === value && was.shape === shape;
        });
        if (same >= 0) {
          link.points.appendChild(old.splice(same, 1)[0]);
          continue;
        }
        const time = link.unit === "beats" ? beat : Math.round(tempoMap.beatToSeconds(beat) * 1e12) / 1e12;
        if (integer) link.points.appendChild(create("IntegerPoint", { time: String(time), value: String(value) }));
        else {
          const next = adopt(point);
          next.setAttribute("time", String(time));
          link.points.appendChild(next);
        }
      }
    } else {
      const element = adopt(fresh);
      laneOf(trackId, true)!.appendChild(element);
      const next = source.controllerLanes.get(trackId) ?? new Map();
      next.set(laneKey, { points: element, unit: "beats" as const });
      source.controllerLanes.set(trackId, next);
    }
  }
  if (changed("markers") || (source.markersInBeats && (changed("tempo") || changed("tempoauto")))) {
    const arrangement = kid(root, "Arrangement");
    const fresh = index.get("markers");
    if (!fresh) {
      remove(source.markers);
      source.markers = undefined;
    } else if (source.markers && source.markersInBeats) {
      // The file keeps markers in beats; the model's seconds go back through the project's tempo map.
      const pool = kidsOf(source.markers, "Marker");
      for (const marker of pool) remove(marker);
      const take = (match: (item: Element) => boolean) => {
        const at = pool.findIndex(match);
        return at < 0 ? undefined : pool.splice(at, 1)[0];
      };
      for (const marker of kids(fresh)) {
        const name = marker.getAttribute("name") ?? "";
        const beat = Math.round(secondsToBeat(Number(marker.getAttribute("time"))) * 1e9) / 1e9;
        const exact = take((item) => item.getAttribute("name") === name && Math.abs(Number(item.getAttribute("time")) - beat) < 1e-6);
        const moved = exact ?? take((item) => item.getAttribute("name") === name);
        const renamed = moved ?? take((item) => Math.abs(Number(item.getAttribute("time")) - beat) < 1e-6);
        const element = renamed ?? create("Marker");
        if (!exact) {
          element.setAttribute("time", String(beat));
          element.setAttribute("name", name);
        }
        source.markers.appendChild(element);
      }
    } else if (source.markers) {
      const pool = kidsOf(source.markers, "Marker");
      for (const marker of pool) remove(marker);
      for (const marker of kids(fresh)) {
        const same = pool.find(
          (item) => item.getAttribute("time") === marker.getAttribute("time") && item.getAttribute("name") === marker.getAttribute("name"),
        );
        source.markers.appendChild(same ?? adopt(marker));
      }
    } else {
      let target = arrangement;
      if (!target) {
        target = create("Arrangement", { id: freshId("arrangement") });
        insertOrdered(root, target, rootOrder);
      }
      const element = adopt(fresh);
      insertOrdered(target, element, arrangementOrder);
      source.markers = element;
    }
  }
  if (changed("tempoauto")) {
    const arrangement = kid(root, "Arrangement");
    const fresh = index.get("tempoauto");
    if (!source.tempoAutomation && arrangement && kid(arrangement, "TempoAutomation"))
      throw new Error(
        "Project tempo changes cannot be saved: the file's tempo automation has ramps or is in seconds, which the model does not carry.",
      );
    if (!fresh) {
      remove(source.tempoAutomation);
      source.tempoAutomation = undefined;
    } else if (source.tempoAutomation) {
      const lane = source.tempoAutomation;
      const pool = kidsOf(lane, "RealPoint");
      // A file that writes a step as two points at one time (Bitwig) gets its steps back the same way.
      const pairs = pool.some((point) => point.getAttribute("interpolation") !== "hold");
      for (const point of pool) remove(point);
      const steps = kidsOf(fresh, "RealPoint");
      const wanted: Array<{ time: string; value: string }> = [];
      for (const [i, step] of steps.entries()) {
        const time = step.getAttribute("time")!,
          value = step.getAttribute("value")!;
        if (!pairs) wanted.push({ time, value });
        else if (i > 0) wanted.push({ time, value: steps[i - 1].getAttribute("value")! }, { time, value });
      }
      for (const point of wanted) {
        const at = pool.findIndex(
          (item) => Number(item.getAttribute("time")) === Number(point.time) && Number(item.getAttribute("value")) === Number(point.value),
        );
        const element = at >= 0 ? pool.splice(at, 1)[0] : create("RealPoint", { ...point, interpolation: pairs ? "linear" : "hold" });
        lane.appendChild(element);
      }
    } else {
      let target = arrangement;
      if (!target) {
        target = create("Arrangement", { id: freshId("arrangement") });
        insertOrdered(root, target, rootOrder);
      }
      const element = adopt(fresh);
      const tempoId = kid(transportOf(), "Tempo");
      if (tempoId) kid(element, "Target")?.setAttribute("parameter", ensureId(tempoId, "transportTempo"));
      insertOrdered(target, element, arrangementOrder);
      source.tempoAutomation = element;
    }
  }
  if (changed("meterauto")) {
    const arrangement = kid(root, "Arrangement");
    const fresh = index.get("meterauto");
    if (!source.meterAutomation && arrangement && kid(arrangement, "TimeSignatureAutomation"))
      throw new Error(
        "Project time signature changes cannot be saved: the file's time signature automation is in seconds, which the model does not carry.",
      );
    if (!fresh) {
      remove(source.meterAutomation);
      source.meterAutomation = undefined;
    } else if (source.meterAutomation) {
      for (const point of kidsOf(source.meterAutomation, "TimeSignaturePoint")) remove(point);
      for (const point of kidsOf(fresh, "TimeSignaturePoint")) source.meterAutomation.appendChild(adopt(point));
    } else {
      let target = arrangement;
      if (!target) {
        target = create("Arrangement", { id: freshId("arrangement") });
        insertOrdered(root, target, rootOrder);
      }
      const element = adopt(fresh);
      const signatureElement = kid(transportOf(), "TimeSignature");
      if (signatureElement) kid(element, "Target")?.setAttribute("parameter", ensureId(signatureElement, "transportSignature"));
      insertOrdered(target, element, arrangementOrder);
      source.meterAutomation = element;
    }
  }

  // --- Archive entries ------------------------------------------------------------------------------------------------------------------
  // A file the source still points at keeps the bytes it came with; only what a new or replaced element points at is written from the model.
  const referenced = usedPaths();
  for (const path of Object.keys(entries))
    if ((path.startsWith("audio/") || path.startsWith("plugins/")) && !referenced.has(path)) delete entries[path];
  for (const path of [...mediaEntries.keys()]) if (!referenced.has(path)) mediaEntries.delete(path);
  for (const path of referenced) {
    const original = source.entries.get(path);
    if (original && !freshOwned.has(path)) {
      delete entries[path];
      mediaEntries.delete(path);
      preserved.push([path, original]);
    }
  }
  source.baseline = cur;
  return {
    projectXml: `<?xml version="1.0" encoding="UTF-8"?>${serializer.serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, "")}`,
    metadataXml: `<?xml version="1.0" encoding="UTF-8"?>${serializer.serializeToString(source.metadata).replace(/^<\?xml[^>]*\?>\s*/, "")}`,
  };
}
