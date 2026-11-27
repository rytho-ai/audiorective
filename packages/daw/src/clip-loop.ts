import { AutomationCurve, type AutomationPoint } from "@audiorective/core/automation";
import type { BeatRange, SecondsRange } from "./project-edits";

/** A looped audio clip's loop in whole frames of its recording, and the frame its first pass starts from. */
export type AudioLoopFrames = Readonly<{
  /** Inclusive loop start in whole sample frames of the recording. */
  loopStart: number;
  /** Exclusive loop end in whole sample frames of the recording; at least one frame after the start. */
  loopEnd: number;
  /** Recording frame of the first pass; an offset at or beyond the loop end enters at the loop start. */
  entry: number;
}>;

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

/** The content beat a MIDI clip's first pass starts from: its `sourceOffset`, or the loop start when that is at or past the loop end. */
export function midiLoopEntry(sourceOffset: number, loop: BeatRange | undefined): number {
  return loop && sourceOffset >= loop.endBeat ? loop.startBeat : sourceOffset;
}

/** The content beat that plays `local` beats after a MIDI clip's start (a negative `local` reaches back before the entry). */
export function midiContentAt(sourceOffset: number, loop: BeatRange | undefined, local: number): number {
  if (!loop) return sourceOffset + local;
  const entry = midiLoopEntry(sourceOffset, loop);
  const first = loop.endBeat - entry;
  if (local < first) return entry + local;
  return loop.startBeat + ((local - first) % (loop.endBeat - loop.startBeat));
}

/** One stretch of a MIDI clip's content that plays: content beats `[from, to)` starting `local` beats after the clip's start. */
export type MidiPass = Readonly<{
  /** Inclusive start of this pass in content beats. */
  from: number;
  /** Exclusive end of this pass in content beats, cut at the clip end when necessary. */
  to: number;
  /** Offset of this pass from the clip start in beats. */
  local: number;
  /** Zero-based pass index; 0 is the initial pass before any wrap. */
  pass: number;
  /** True when the pass begins at the clip window start and should retrigger notes already held there. */
  first: boolean;
  /** True when the clip end cuts or coincides with this pass end; always true without a loop. */
  clipped: boolean;
}>;

/**
 * The passes of content a MIDI clip plays: `[sourceOffset, sourceOffset + duration)`, or with a loop the first pass from the entry to the loop end and
 * then `[start, end)` again until `duration`. Each pass is cut at `duration`; `clipped` marks the pass the clip's end cuts. `first` marks a pass that
 * starts at the clip's window start, so notes already sounding there are played from it.
 */
export function midiPasses(sourceOffset: number, loop: BeatRange | undefined, duration: number): MidiPass[] {
  if (!loop) return [{ from: sourceOffset, to: sourceOffset + duration, local: 0, pass: 0, first: true, clipped: true }];
  const entry = midiLoopEntry(sourceOffset, loop);
  const out: MidiPass[] = [];
  let local = 0;
  for (let pass = 0; local < duration - 1e-9; pass++) {
    const from = pass === 0 ? entry : loop.startBeat;
    const span = loop.endBeat - from;
    const clipped = local + span >= duration - 1e-9;
    out.push({ from, to: from + Math.min(span, duration - local), local, pass, first: pass === 0 && sourceOffset < loop.endBeat, clipped });
    local += span;
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
