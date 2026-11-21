/** A step length or duration: "16n" note, "16n." dotted, "8t" triplet, "1m" bar (all in beats), or "250ms", "2s", a number (seconds). */
export type Time = number | `${number}n` | `${number}n.` | `${number}t` | `${number}m` | `${number}ms` | `${number}s`;
/** Steps as text (X = 1, x = 0.8, 1-9 = tenths, . = rest; spaces ignored) or one velocity per step. */
export type Pattern = string | readonly number[];

const PATTERN_ERROR = (char: string, position: number) =>
  `Step Sequencer pattern has an invalid character "${char}" at position ${position}: use X, x, 1-9 or . (spaces are ignored).`;

/** Velocity of one pattern character, or undefined when the character is not pattern notation. */
function charVelocity(char: string): number | undefined {
  if (char === "X") return 1;
  if (char === "x") return 0.8;
  if (char === "." || char === "0") return 0;
  if (char >= "1" && char <= "9") return Number(char) / 10;
  return undefined;
}

/** Parse `Pattern` into one velocity per step. Throws on unknown characters, an empty pattern or velocities outside 0..1. */
export function parsePattern(pattern: Pattern): number[] {
  const out: number[] = [];
  if (typeof pattern === "string") {
    let position = 0;
    for (const char of pattern) {
      position++;
      if (/\s/.test(char)) continue;
      const velocity = charVelocity(char);
      if (velocity === undefined) throw new RangeError(PATTERN_ERROR(char, position));
      out.push(velocity);
    }
  } else if (Array.isArray(pattern)) {
    for (const velocity of pattern) {
      if (typeof velocity !== "number") throw new TypeError("Step Sequencer pattern velocities need numbers from 0 to 1.");
      if (!Number.isFinite(velocity) || velocity < 0 || velocity > 1)
        throw new RangeError("Step Sequencer pattern velocities need numbers from 0 to 1.");
      out.push(velocity);
    }
  } else {
    throw new TypeError('Step Sequencer pattern needs a string like "X...x..." or an array of velocities from 0 to 1.');
  }
  if (out.length === 0 || out.length > 128) throw new RangeError("Step Sequencer pattern needs from 1 to 128 steps.");
  return out;
}

/** The compact text for velocities that notation can express (X, x, 1-9, .), else the number array. */
export function describePattern(velocities: readonly number[]): Pattern {
  let text = "";
  for (const v of velocities) {
    if (v === 0) text += ".";
    else if (v === 1) text += "X";
    else if (v === 0.8) text += "x";
    else {
      const tenth = Math.round(v * 10);
      if (tenth >= 1 && tenth <= 9 && Math.abs(v * 10 - tenth) < 1e-9) text += String(tenth);
      else return [...velocities];
    }
  }
  return text;
}

/** A parsed `Time`: either beats (a note value) or seconds. */
export type ParsedTime = { readonly unit: "beats"; readonly value: number } | { readonly unit: "seconds"; readonly value: number };

const TIME_ERROR = () => 'Step Sequencer needs a Time such as "16n", "16n.", "8t", "1m", "250ms", "2s" or a number of seconds.';

/**
 * Parse `Time`. Note values are beats (a beat is a quarter note): "16n" = 0.25, "16n." dotted = 0.375, "8t" triplet = 1/3,
 * "1m" = 4. "250ms", "2s" and plain numbers are seconds.
 */
export function parseTime(time: Time): ParsedTime {
  if (typeof time === "number") {
    if (!Number.isFinite(time)) throw new RangeError(TIME_ERROR());
    return { unit: "seconds", value: time };
  }
  if (typeof time !== "string") throw new TypeError(TIME_ERROR());
  const match = /^(\d+(?:\.\d+)?|\.\d+)(n\.?|t|m|ms|s)$/.exec(time.trim());
  if (!match) throw new TypeError(TIME_ERROR());
  const n = Number(match[1]);
  switch (match[2]) {
    case "n":
    case "n.":
    case "t": {
      if (n <= 0) throw new RangeError(TIME_ERROR());
      const straight = 4 / n;
      return { unit: "beats", value: match[2] === "n" ? straight : match[2] === "t" ? (straight * 2) / 3 : straight * 1.5 };
    }
    case "m":
      return { unit: "beats", value: n * 4 };
    case "ms":
      return { unit: "seconds", value: n / 1000 };
    default:
      return { unit: "seconds", value: n };
  }
}

/** `Time` as beats; seconds convert through `bpm` (beats per minute). */
export function timeToBeats(time: Time, bpm: number): number {
  const parsed = parseTime(time);
  return parsed.unit === "beats" ? parsed.value : (parsed.value * bpm) / 60;
}

/** Swing as 0..1 from a number or a "30%" string. */
export function parseSwing(swing: number | `${number}%`): number {
  let value: number;
  if (typeof swing === "number") value = swing;
  else if (typeof swing === "string" && /^\d+(?:\.\d+)?%$/.test(swing.trim())) value = Number.parseFloat(swing) / 100;
  else throw new TypeError('Step Sequencer swing needs a number from 0 to 1 or a percentage like "30%".');
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new RangeError('Step Sequencer swing needs a number from 0 to 1 or a percentage like "30%".');
  return value;
}
