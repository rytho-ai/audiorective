import type { MidiNote } from "@audiorective/midi";
import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { BeatRange, SecondsRange } from "./project-edits";

/** A looped audio clip's loop in whole frames of its recording, and the frame its first pass starts from. */
export type AudioLoopFrames = Readonly<{ loopStart: number; loopEnd: number; entry: number }>;

/**
 * Where a looped audio clip plays in its recording. It starts at `sourceOffset` and runs to the loop end; a start past the loop end enters the
 * loop at its start instead. From the loop end it repeats `[loopStart, loopEnd)`.
 */
export function audioLoopFrames(clip: Readonly<{ loop: SecondsRange; sampleRate: number; sourceOffset: number }>): AudioLoopFrames {
  const rate = clip.sampleRate;
  const loopStart = Math.round(clip.loop.startSeconds * rate);
  const loopEnd = Math.max(loopStart + 1, Math.round(clip.loop.endSeconds * rate));
  const offset = Math.round(clip.sourceOffset * rate);
  return { loopStart, loopEnd, entry: offset >= loopEnd ? loopStart : offset };
}

/** The recording frame that plays `localFrame` frames after the clip's start. A negative `localFrame` reaches back before the entry. */
export function audioLoopSourceFrame(plan: AudioLoopFrames, localFrame: number): number {
  const first = plan.loopEnd - plan.entry;
  if (localFrame < first) return plan.entry + localFrame;
  return plan.loopStart + ((localFrame - first) % (plan.loopEnd - plan.loopStart));
}

/**
 * A MIDI clip's notes as they play when it loops: the first pass runs from the clip's start to the loop end, then the notes that start inside the
 * loop repeat until `duration`. Every note is cut at the loop end of its pass and at `duration`; repeats get the ID `<id>@<pass>`.
 */
export function loopedNotes(notes: readonly MidiNote[], loop: BeatRange, duration: number): MidiNote[] {
  const out: MidiNote[] = [];
  const first = Math.min(loop.endBeat, duration);
  for (const note of notes) {
    if (note.start >= first) continue;
    const end = Math.min(note.start + note.duration, first);
    if (end > note.start) out.push({ ...note, duration: end - note.start });
  }
  const region = notes.filter((note) => note.start >= loop.startBeat && note.start < loop.endBeat);
  const length = loop.endBeat - loop.startBeat;
  for (let pass = 1; ; pass++) {
    const base = loop.endBeat + (pass - 1) * length;
    if (base >= duration - 1e-9) break;
    for (const note of region) {
      const start = base + (note.start - loop.startBeat);
      const end = Math.min(start + Math.min(note.duration, loop.endBeat - note.start), duration);
      if (start < duration && end > start) out.push({ ...note, id: `${note.id}@${pass}`, start, duration: end - start });
    }
  }
  return out;
}

/** Every time in `[0, duration]` at which a non-note message of a looped clip plays, given its time in the clip's own content. */
export function loopedTimes(time: number, loop: BeatRange, duration: number): number[] {
  const out: number[] = [];
  if (time <= Math.min(loop.endBeat, duration) && (time < loop.endBeat || loop.endBeat >= duration)) out.push(time);
  if (time < loop.startBeat || time >= loop.endBeat) return out;
  const length = loop.endBeat - loop.startBeat;
  for (let pass = 1; ; pass++) {
    const at = loop.endBeat + (pass - 1) * length + (time - loop.startBeat);
    if (loop.endBeat + (pass - 1) * length >= duration - 1e-9) break;
    if (at <= duration) out.push(at);
  }
  return out;
}

/**
 * A looped audio clip's gain automation in clip-local seconds. The curve is read at the clip's position in its recording, so every pass of the
 * loop repeats it: the first pass covers `sourceOffset` to the loop end, later passes the loop start to its end. At a wrap the value steps from the
 * curve at the loop's last frame to the curve at its first.
 */
export function loopedGainPoints(
  clip: Readonly<{ loop: SecondsRange; sampleRate: number; sourceOffset: number; duration: number }>,
  automation: Readonly<{ sourceStart: number; points: readonly AutomationPoint[] }>,
): AutomationPoint[] {
  const rate = clip.sampleRate;
  const plan = audioLoopFrames(clip);
  const curve = new AutomationCurve(automation.points);
  const shift = automation.sourceStart - clip.sourceOffset;
  const valueAt = (frame: number) => curve.valueAt(frame / rate + shift);
  const total = Math.round(clip.duration * rate);
  const byTime = new Map<number, AutomationPoint>();
  const put = (time: number, value: number, shape: AutomationPoint["shape"]) => byTime.set(time, { time, value, shape });
  let local = 0;
  let source = plan.entry;
  let end = plan.loopEnd;
  while (local < total) {
    const length = Math.min(end - source, total - local);
    const last = local + length >= total;
    const time = source / rate + shift;
    const governing = curve.value.filter((point) => point.time <= time).at(-1);
    put(local / rate, valueAt(source), governing?.shape ?? "linear");
    for (const point of curve.value) {
      const frame = (point.time - shift) * rate;
      if (frame > source && frame < source + length - 1) put((local + frame - source) / rate, point.value, point.shape);
    }
    if (last) put((local + length) / rate, valueAt(source + length), "linear");
    else put((local + length - 1) / rate, valueAt(source + length - 1), "hold");
    local += length;
    source = plan.loopStart;
    end = plan.loopEnd;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
