/** Project source ticks to denominator-beat and bar positions. */
import { tickToSeconds } from "./midi-file";
import type { MidiSignature, ParsedMidi } from "./midi-data";

const freeze = <T extends object>(v: T): Readonly<T> => Object.freeze(v);
/** Denominator-beat and bar grid, expressed in the same source seconds as notes. */
export function midiGrid(data: ParsedMidi): Readonly<{ beats: readonly number[]; downbeats: readonly number[] }> {
  if (
    !Number.isInteger(data.ppq) ||
    data.ppq <= 0 ||
    !Number.isSafeInteger(data.endTick) ||
    data.endTick < 0 ||
    data.signatures.some(
      (s) =>
        !Number.isInteger(s.tick) ||
        s.tick < 0 ||
        !Number.isInteger(s.numerator) ||
        s.numerator <= 0 ||
        !Number.isFinite(s.denominator) ||
        s.denominator <= 0,
    )
  )
    throw new RangeError("MIDI grid needs valid PPQ, end tick and time signatures.");
  const beats: number[] = [],
    downbeats: number[] = [];
  let tick = 0,
    index = 0,
    within = 0;
  let signature: MidiSignature = { tick: 0, numerator: 4, denominator: 4 };
  while (tick <= data.endTick) {
    if (beats.length >= 100_000) throw new RangeError("MIDI grid exceeds 100000 points.");
    while (index < data.signatures.length && data.signatures[index].tick <= tick) {
      signature = data.signatures[index++];
      within = 0;
    }
    const time = tickToSeconds(data.tempos, data.ppq, tick);
    beats.push(time);
    if (within === 0) downbeats.push(time);
    const next = tick + (data.ppq * 4) / signature.denominator,
      nextChange = data.signatures[index]?.tick;
    if (nextChange !== undefined && nextChange < next) {
      tick = nextChange;
      within = 0;
    } else {
      tick = next;
      within = (within + 1) % signature.numerator;
    }
  }
  return freeze({ beats: freeze(beats), downbeats: freeze(downbeats) });
}
