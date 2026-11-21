/** Denominator-beat and bar positions of a parsed file's time signatures, in beats. */
import type { ParsedMidi } from "./midi-data";

const freeze = <T extends object>(v: T): Readonly<T> => Object.freeze(v);
const EPS = 1e-9;
/** Denominator-beat (`beats`) and bar (`downbeats`) positions, in beats from the file's start up to its end. */
export function midiGrid(data: ParsedMidi): Readonly<{ beats: readonly number[]; downbeats: readonly number[] }> {
  if (
    !Number.isFinite(data.duration) ||
    data.duration < 0 ||
    data.signatures.some(
      (s) =>
        !Number.isFinite(s.beat) ||
        s.beat < 0 ||
        !Number.isInteger(s.numerator) ||
        s.numerator <= 0 ||
        !Number.isFinite(s.denominator) ||
        s.denominator <= 0,
    )
  )
    throw new RangeError("MIDI grid needs a valid duration and time signatures.");
  const beats: number[] = [],
    downbeats: number[] = [];
  let at = 0,
    index = 0,
    within = 0;
  let signature: { numerator: number; denominator: number } = { numerator: 4, denominator: 4 };
  while (at <= data.duration + EPS) {
    if (beats.length >= 100_000) throw new RangeError("MIDI grid exceeds 100000 points.");
    while (index < data.signatures.length && data.signatures[index].beat <= at + EPS) {
      signature = data.signatures[index++];
      within = 0;
    }
    beats.push(at);
    if (within === 0) downbeats.push(at);
    const next = at + 4 / signature.denominator,
      nextChange = data.signatures[index]?.beat;
    if (nextChange !== undefined && nextChange < next - EPS) {
      at = nextChange;
      within = 0;
    } else {
      at = next;
      within = (within + 1) % signature.numerator;
    }
  }
  return freeze({ beats: freeze(beats), downbeats: freeze(downbeats) });
}
