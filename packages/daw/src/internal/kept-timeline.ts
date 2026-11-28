import type { Element } from "@xmldom/xmldom";
import type { Project } from "../model";
import type { SourceXml } from "./source-xml";
import type { SongEdit } from "../project-persistence";
import type { TempoMap } from "../tempo-map";

/**
 * Timed content an opened file keeps verbatim because the model does not carry it: clips it cannot play, automation of parameters it does not model, and so on.
 * A song-wide edit (`rippleDelete`, an inserting `copyRange`) moves the content the model carries, so it must move this content the same way, in the
 * unit the element is written in, or the saved arrangement would no longer line up. An edit that cannot move it correctly is refused before it changes anything.
 */
export type KeptTimed = {
  /** A clip, or a `Points` (or tempo or time signature automation) whose points each have a `time`. */
  kind: "clip" | "points";
  /** Preserved clip or Points XML element whose timeline positions must follow song edits. */
  element: Element;
  /** The unit of `time` and `duration` (or of each point's `time`); anything but seconds or beats cannot be moved. */
  unit: string;
  /** The Track element this content belongs to in the file, when it says. */
  sourceTrack: string | null;
  name: string;
  /** What moves: the clip element, or each point element, with the time the file had. */
  times: Map<Element, number>;
};

/** What one edit moved: the new `time` of each element, and whether the edit is in force (an undone one is not). */
export type KeptShiftRecord = {
  /** New positions by XML element, in each element original seconds or beats unit. */
  moves: Map<Element, number>;
  /** True while this edit movement is in force; false after Undo. */
  applied: boolean;
  /** Owning Undo entry identity; omitted when the edit has no history entry. */
  owner?: object;
  /** True until the staged movement is committed to an edit or discarded. */
  pending: boolean;
};

const BEAT_EPSILON = 1e-9;
const SECOND_EPSILON = 1e-6;
const text = (element: Element, name: string) => element.getAttribute(name);
const num = (element: Element, name: string): number | undefined => {
  const raw = element.getAttribute(name);
  const value = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const children = (element: Element, tag: string): Element[] =>
  Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).tagName === tag);

/** Every timed element of the arrangement that no part of the model owns. Read once, when the file opens, so a later save cannot make a written element look kept. */
export function collectKeptTimed(source: SourceXml, arrangement: Element | undefined): KeptTimed[] {
  const found: KeptTimed[] = [];
  if (!arrangement) return found;
  const owned = new Set<Element>();
  for (const link of source.clips.values()) owned.add(link.element);
  for (const element of source.automation.values()) owned.add(element);
  for (const lanes of source.controllerLanes.values()) for (const link of lanes.values()) owned.add(link.points);
  for (const element of [source.markers, source.tempoAutomation, source.meterAutomation]) if (element) owned.add(element);
  const trackOf = (element: Element): string | null => {
    for (let node: Element | null = element; node; node = node.parentNode as Element | null) {
      const track = node.nodeType === 1 ? text(node, "track") : null;
      if (track) return track;
    }
    return null;
  };
  const walk = (node: Element, unit: string) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      if (element.tagName === "Lanes") walk(element, text(element, "timeUnit") ?? unit);
      else if (element.tagName === "Clips") {
        const clipsUnit = text(element, "timeUnit") ?? unit;
        for (const clip of children(element, "Clip"))
          if (!owned.has(clip))
            found.push({
              kind: "clip",
              element: clip,
              unit: clipsUnit,
              sourceTrack: trackOf(clip),
              name: text(clip, "name") ?? "unnamed",
              times: new Map([[clip, num(clip, "time") ?? 0]]),
            });
      } else if (element.tagName === "Points" && !owned.has(element)) points(element, text(element, "timeUnit") ?? unit, "automation lane");
    }
  };
  const points = (element: Element, unit: string, label: string) => {
    const timed = Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).hasAttribute("time"));
    if (!timed.length) return;
    const target = children(element, "Target")[0];
    const controller = target ? text(target, "controller") : null;
    const what = target ? `${text(target, "expression") ?? text(target, "parameter")}${controller ? ` controller ${controller}` : ""}` : null;
    found.push({
      kind: "points",
      element,
      unit,
      sourceTrack: trackOf(element),
      name: `${text(element, "name") ?? label}${what ? ` of ${what}` : ""}`,
      times: new Map(timed.map((point) => [point, num(point, "time") ?? 0])),
    });
  };
  const lanes = children(arrangement, "Lanes")[0];
  if (lanes) walk(lanes, text(lanes, "timeUnit") ?? "beats");
  // Tempo and time signature lanes the model does not read (ramps, seconds) stay in the file; one that never leaves its starting value changes nothing.
  for (const tag of ["TempoAutomation", "TimeSignatureAutomation"]) {
    const element = children(arrangement, tag)[0];
    if (!element || owned.has(element)) continue;
    const values = Array.from(element.childNodes)
      .filter((node): node is Element => node.nodeType === 1 && (node as Element).hasAttribute("time"))
      .map((point) => `${text(point, "value")}/${text(point, "numerator")}/${text(point, "denominator")}`);
    if (new Set(values).size > 1)
      points(element, text(element, "timeUnit") ?? "beats", tag === "TempoAutomation" ? "tempo automation" : "time signature automation");
  }
  return found;
}

/** The time an element has now: what the latest edit in force moved it to, else the time the file had. */
function currentTime(source: SourceXml, item: KeptTimed, element: Element): number {
  for (let i = source.keptShifts.length - 1; i >= 0; i--) {
    const record = source.keptShifts[i];
    if (record.applied && record.moves.has(element)) return record.moves.get(element)!;
  }
  return item.times.get(element)!;
}

/** A clip's length in its own unit: its `duration`, else the part of its content it plays (Studio One omits `duration` on audio), else none. */
function clipLength(item: KeptTimed, start: number, tempo: TempoMap): number {
  const element = item.element;
  const duration = num(element, "duration");
  if (duration !== undefined) return Math.max(0, duration);
  const stop = num(element, "playStop");
  if (stop === undefined) return 0;
  const content = stop - (num(element, "playStart") ?? 0);
  const contentUnit = text(element, "contentTimeUnit") ?? "seconds";
  if (!(content > 0) || contentUnit === item.unit) return Math.max(0, content);
  try {
    if (item.unit === "beats" && contentUnit === "seconds") return tempo.secondsToBeat(tempo.beatToSeconds(start) + content) - start;
    if (item.unit === "seconds" && contentUnit === "beats") return tempo.beatToSeconds(tempo.secondsToBeat(start) + content) - start;
  } catch {
    return 0;
  }
  return 0;
}

type Outcome = { move: number } | { block: string } | undefined;

function placeUnder(edit: SongEdit, item: KeptTimed, time: number, length: number): Outcome {
  const beats = item.unit === "beats";
  const epsilon = beats ? BEAT_EPSILON : SECOND_EPSILON;
  const clip = item.kind === "clip";
  const end = time + length;
  if (edit.kind === "delete") {
    const { from, to } = beats ? edit.beats : edit.seconds;
    if (clip ? end <= from + epsilon : time < from - epsilon) return undefined;
    if (time >= to - epsilon) return { move: Math.max(0, time - (to - from)) };
    return { block: clip ? "lies across the removed range" : "has a point inside the removed range" };
  }
  const { start, end: stop, at } = beats ? edit.beats : edit.seconds;
  const inside = clip && length > 0 ? time < stop - epsilon && end > start + epsilon : time >= start - epsilon && time < stop - epsilon;
  if (inside) return { block: "lies inside the copied range, which it cannot be copied into" };
  if (clip && length > 0 && time < at - epsilon && end > at + epsilon) return { block: "lies across the insert point, where it cannot be split" };
  if (time < at - epsilon) return undefined;
  if (beats) return { move: time + (edit.beats.end - edit.beats.start) };
  return { move: edit.after.beatToSeconds(edit.before.secondsToBeat(time) + (edit.beats.end - edit.beats.start)) };
}

const trackName = (project: Project, source: SourceXml, sourceTrack: string | null): string => {
  for (const [id, link] of source.tracks) if (link.sourceId === sourceTrack) return project.tracks.find((track) => track.id === id)?.name ?? id;
  return sourceTrack ?? "no track";
};

/**
 * Move the kept timed content of an opened file as `edit` moves the content the model carries, in each element's own unit, or throw before anything
 * changes when some of it cannot move correctly. The move is recorded, so it follows undo and redo of the edit that asked for it and is written by the next save.
 * `verb` names the edit in the error. A project that was not opened from a file with kept content does nothing.
 */
export function shiftKeptContent(project: Project, source: SourceXml | undefined, edit: SongEdit, verb: string): void {
  if (!source?.keptTimed.length) return;
  const tempo = project.tempoMap;
  const moves = new Map<Element, number>();
  const blocks: string[] = [];
  for (const item of source.keptTimed) {
    const owner = `${item.kind === "clip" ? "clip" : ""} "${item.name}" on track "${trackName(project, source, item.sourceTrack)}"`.trim();
    if (item.unit !== "seconds" && item.unit !== "beats") {
      blocks.push(`${owner} is written in ${item.unit} time, which cannot be moved`);
      continue;
    }
    for (const element of item.times.keys()) {
      const time = currentTime(source, item, element);
      const outcome = placeUnder(edit, item, time, item.kind === "clip" ? clipLength(item, time, tempo) : 0);
      if (!outcome) continue;
      if ("block" in outcome) {
        blocks.push(
          `${item.kind === "clip" ? "clip" : "the"} "${item.name}" on track "${trackName(project, source, item.sourceTrack)}" ${outcome.block}`,
        );
        break;
      }
      moves.set(element, outcome.move);
    }
  }
  if (blocks.length)
    throw new Error(
      `Project ${verb} is blocked by kept content: ${blocks[0]}${blocks.length > 1 ? ` (and ${blocks.length - 1} more)` : ""}. ` +
        "The file keeps content the model does not carry unchanged, and only content the model carries can be trimmed, copied or split.",
    );
  if (moves.size) source.keptShifts.push({ moves, applied: true, pending: true });
}

/** An edit that moved kept content ended: its records belong to the history entry it made (or, with none, are permanent). */
export function commitKeptShifts(source: SourceXml | undefined, entry: object | undefined): void {
  if (!source) return;
  for (const record of source.keptShifts)
    if (record.pending) {
      record.pending = false;
      record.owner = entry;
    }
}

/** An edit that moved kept content failed and was rolled back: its records go with it. */
export function discardKeptShifts(source: SourceXml | undefined): void {
  if (source) source.keptShifts = source.keptShifts.filter((record) => !record.pending);
}

/** Undo (`applied: false`) or redo (`true`) of a history entry puts the kept content it moved back or forward again. */
export function stepKeptShifts(source: SourceXml | undefined, entry: object, applied: boolean): void {
  if (source) for (const record of source.keptShifts) if (record.owner === entry) record.applied = applied;
}

/** The kept clips on a model track, where they are now, in seconds: a clip the edit puts there must not land on them. */
export function keptClipSpans(project: Project, source: SourceXml | undefined, trackId: string): Array<{ name: string; start: number; end: number }> {
  if (!source?.keptTimed.length) return [];
  const sourceId = source.tracks.get(trackId)?.sourceId;
  if (!sourceId) return [];
  const tempo = project.tempoMap;
  const spans: Array<{ name: string; start: number; end: number }> = [];
  for (const item of source.keptTimed) {
    if (item.kind !== "clip" || item.sourceTrack !== sourceId || (item.unit !== "seconds" && item.unit !== "beats")) continue;
    const time = currentTime(source, item, item.element);
    const length = clipLength(item, time, tempo);
    try {
      if (item.unit === "beats") spans.push({ name: item.name, start: tempo.beatToSeconds(time), end: tempo.beatToSeconds(time + length) });
      else spans.push({ name: item.name, start: time, end: time + length });
    } catch {
      continue;
    }
  }
  return spans;
}

/** Write the times of every kept element as the edits in force leave them (an element no edit in force moved gets the text the file had). Safe to repeat. */
export function writeKeptShifts(source: SourceXml): void {
  const format = (value: number) => String(Number(value.toPrecision(15)));
  for (const item of source.keptTimed)
    for (const [element, original] of item.times) {
      const time = currentTime(source, item, element);
      if (time === original) {
        const saved = source.keptTexts.get(element);
        if (saved !== undefined && element.getAttribute("time") !== saved) element.setAttribute("time", saved);
      } else {
        if (!source.keptTexts.has(element)) source.keptTexts.set(element, element.getAttribute("time") ?? "");
        element.setAttribute("time", format(time));
      }
    }
}
