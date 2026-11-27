/** Where a performance controller rests, and the message that puts it back. Pure. */

/**
 * The performance controllers that have a rest value, as `[controller, rest]` pairs: modulation (1), breath (2) and foot (4) at 0, volume (7) at 100,
 * balance (8) and pan (10) at 64, expression (11) at 127, the pedals 64 to 69 at 0 and the sound controllers 71 to 74 at 64. Pitch bend (centre, 8192) and
 * channel and poly pressure (0) rest too. Everything else is never reset: bank select (0, 32), data entry (6, 38), data increment and decrement (96, 97),
 * NRPN and RPN selectors (98 to 101) and every other controller keep the value they were last given, and playback restores them only by sending the value
 * the song needs at the new position.
 */
const controllerRests: ReadonlyMap<number, number> = new Map([
  [1, 0],
  [2, 0],
  [4, 0],
  [7, 100],
  [8, 64],
  [10, 64],
  [11, 127],
  ...[64, 65, 66, 67, 68, 69].map((controller): [number, number] => [controller, 0]),
  ...[71, 72, 73, 74].map((controller): [number, number] => [controller, 64]),
]);

/** What a channel message moves: a key for the controller it belongs to, the message that puts it back at rest, and whether it already is one. Undefined for notes, program changes, channel-mode messages and every controller without a rest value (see `controllerRestValue`). */
export function restOf(data: Uint8Array | readonly number[]): { key: string; rest: Uint8Array; atRest: boolean } | undefined {
  const channel = data[0] & 15;
  switch (data[0] & 0xf0) {
    case 0xb0: {
      if (data.length < 3) return undefined;
      const rest = controllerRests.get(data[1]);
      if (rest === undefined) return undefined;
      return { key: `cc:${channel}:${data[1]}`, rest: Uint8Array.of(0xb0 | channel, data[1], rest), atRest: data[2] === rest };
    }
    case 0xe0: {
      const value = (data[1] ?? 0) | ((data[2] ?? 0) << 7);
      return { key: `bend:${channel}`, rest: Uint8Array.of(0xe0 | channel, 0, 64), atRest: value === 8192 };
    }
    case 0xd0:
      return { key: `pressure:${channel}`, rest: Uint8Array.of(0xd0 | channel, 0), atRest: (data[1] ?? 0) === 0 };
    case 0xa0:
      return { key: `poly:${channel}:${data[1]}`, rest: Uint8Array.of(0xa0 | channel, data[1], 0), atRest: (data[2] ?? 0) === 0 };
    default:
      return undefined;
  }
}

/**
 * A key for whatever a channel message sets, whether or not it rests: `cc:<channel>:<controller>` for every controller (bank select, data entry and
 * RPN selectors included), `bend:<channel>`, `pressure:<channel>`, `poly:<channel>:<pitch>` and `program:<channel>`. Undefined for notes and channel-mode
 * messages (controllers 120 and up). Two messages with one key replace each other: the later one is the state in force.
 */
export function controllerStateKey(data: Uint8Array | readonly number[]): string | undefined {
  const channel = data[0] & 15;
  switch (data[0] & 0xf0) {
    case 0xb0:
      return data.length < 3 || data[1] >= 120 ? undefined : `cc:${channel}:${data[1]}`;
    case 0xe0:
      return `bend:${channel}`;
    case 0xd0:
      return `pressure:${channel}`;
    case 0xa0:
      return `poly:${channel}:${data[1]}`;
    case 0xc0:
      return `program:${channel}`;
    default:
      return undefined;
  }
}

/**
 * The state a position needs: of `events` (`beat` and raw channel `data`, in play order), the latest message for each `controllerStateKey` that comes before
 * beat `before` (exclusive), ordered as they were played, so a bank select still comes before the program change it belongs to. Notes and channel-mode
 * messages are ignored. Of two messages at one beat the later one in the list wins. A message at `before` itself is not included: playback sends it on time.
 * Sending the result puts a device where the song would have left it, from a start, a seek or a loop wrap, without replaying the messages in between.
 */
export function chaseMessages<T extends { beat: number; data: Uint8Array | readonly number[] }>(events: Iterable<T>, before: number): T[] {
  const latest = new Map<string, { event: T; index: number }>();
  let index = 0;
  for (const event of events) {
    const at = index++;
    if (!(event.beat < before)) continue;
    const key = controllerStateKey(event.data);
    if (key === undefined) continue;
    const held = latest.get(key);
    if (!held || event.beat >= held.event.beat) latest.set(key, { event, index: at });
  }
  return [...latest.values()].sort((a, b) => a.event.beat - b.event.beat || a.index - b.index).map(({ event }) => event);
}

/** The kinds of controller movement a rest value is asked for; the same names as the DAW's `ControllerExpression`. */
export type RestExpression = "channelController" | "pitchBend" | "channelPressure" | "polyPressure" | "programChange";

/**
 * The value a performance controller rests at when nothing drives it: 8192 for pitch bend (centre), 0 for channel and poly pressure, and for a channel controller
 * the entry of the curated list: 0 for modulation (1), breath (2), foot (4) and the pedals (64 to 69), 100 for volume (7), 64 for balance (8), pan (10) and the
 * sound controllers 71 to 74, 127 for expression (11). Undefined for every other controller (bank select, data entry, RPN and NRPN selectors, ...), which is
 * never reset, and for `programChange`, which has no rest.
 */
export function controllerRestValue(expression: RestExpression, controller: number): number | undefined {
  if (expression === "programChange") return undefined;
  if (expression === "pitchBend") return 8192;
  if (expression !== "channelController") return 0;
  return controllerRests.get(controller);
}
