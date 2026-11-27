/** Pure device-parameter data: the one row shape for WebCLAP devices and built-in rack effects. Loads in Node without Web Audio. */
import type { RackEffect } from "./rack-preset";

/**
 * What a `Project` stores for one parameter of a WebCLAP device (the device's `parameters` table). `id` is the CLAP parameter id as a decimal string; `min`, `max`,
 * `default` and `value` are in the plug-in's own units (the numbers the plug-in's `text` is made from). `step` is 1 when the plug-in marks the parameter stepped
 * (its values are whole numbers), else absent.
 */
export type DeviceParameterRecord = Readonly<{
  /** CLAP parameter ID as a decimal string, or a built-in rack parameter key. */
  id: string;
  name: string;
  /** Inclusive lower bound in the plug-in or rack parameter units. */
  min: number;
  /** Inclusive upper bound in the plug-in or rack parameter units. */
  max: number;
  /** Initial parameter value in the same units as min and max. */
  default: number;
  /** Current parameter value in its own units, within the inclusive min..max range. */
  value: number;
  /** 1 for integer-valued parameters; omitted for continuous values. */
  step?: 1;
  /**
   * Set on a row read from a file another application wrote with `unit="normalized"`: `value` is then a fraction (0..1, `min` 0 and `max` 1) of the plug-in's real range, which is
   * unknown until the plug-in loads. A running Workspace maps it into the real range at load and stores a plain row; never set on a row a plug-in reported.
   */
  normalized?: true;
}>;

/**
 * One parameter of a device, the same shape for a WebCLAP plug-in (`kind: "webclap"`, `deviceId` is the device's ID) and a built-in rack effect (`kind: "rack"`, `deviceId`
 * is `rackDeviceId(trackId, slotId)`). `value` is what is heard now; `id` is what `project.setDeviceParameter` and the `setDeviceParameter` edit take. `unit` names the
 * unit of `min`, `max`, `default` and `value` where one is known (`"hertz"`, `"seconds"`, `"decibel"`, `"normalized"`), absent for a plug-in's own scales, which `text` shows instead.
 * `text` is the display string of `value` (`"+15 ct"`, `"lowpass"`), present while the plug-in is running or for a rack effect.
 */
export type DeviceParameter = DeviceParameterRecord &
  Readonly<{
    kind: "webclap" | "rack";
    /** Known value unit such as hertz, seconds, decibel or normalized; omitted for plug-in-specific scales. */
    unit?: string;
    /** Formatted current value from the live plug-in or rack; omitted when no formatter is available. */
    text?: string;
  }>;

/** The device ID of a built-in rack effect: slot IDs are unique only within one track, so the ID joins the track and the slot with `:`. */
export function rackDeviceId(trackId: string, slotId: string): string {
  return `${trackId}:${slotId}`;
}

/** The track and slot a `rackDeviceId` names, or `undefined` when `deviceId` has no `:` (a Project track ID never contains one, so the first `:` splits it). */
export function splitRackDeviceId(deviceId: string): Readonly<{ trackId: string; slotId: string }> | undefined {
  const at = deviceId.indexOf(":");
  return at > 0 ? { trackId: deviceId.slice(0, at), slotId: deviceId.slice(at + 1) } : undefined;
}

type Spec = Readonly<{
  name: string;
  min: number;
  max: number;
  default: number;
  step?: 1;
  unit?: string;
  read(slot: RackEffect): number;
  text?(value: number): string;
}>;

const onOff = (value: number) => (value ? "on" : "off");
const band = (slot: RackEffect, index: number) => (slot.type === "eq" ? slot.bands[index] : undefined);

function specs(slot: RackEffect): ReadonlyMap<string, Spec> {
  const list: [string, Spec][] = [
    ["enabled", { name: "enabled", min: 0, max: 1, default: 1, step: 1, read: (s) => (s.enabled ? 1 : 0), text: onOff }],
    ["wet", { name: "wet", min: 0, max: 1, default: 1, unit: "normalized", read: (s) => s.wet }],
  ];
  if (slot.type === "filter") {
    list.push(
      [
        "mode",
        {
          name: "mode",
          min: 0,
          max: 1,
          default: 0,
          step: 1,
          read: (s) => (s.type === "filter" && s.mode === "highpass" ? 1 : 0),
          text: (v) => (v ? "highpass" : "lowpass"),
        },
      ],
      ["frequency", { name: "frequency", min: 20, max: 20_000, default: 350, unit: "hertz", read: (s) => (s.type === "filter" ? s.frequency : 0) }],
      ["q", { name: "q", min: 0.1, max: 20, default: 1, read: (s) => (s.type === "filter" ? s.q : 0) }],
    );
  } else if (slot.type === "delay") {
    list.push(
      ["delayTime", { name: "delay time", min: 0.01, max: 1, default: 0.25, unit: "seconds", read: (s) => (s.type === "delay" ? s.delayTime : 0) }],
      ["feedback", { name: "feedback", min: 0, max: 0.95, default: 0.2, read: (s) => (s.type === "delay" ? s.feedback : 0) }],
    );
  } else {
    for (let index = 0; index < slot.bands.length; index++) {
      list.push(
        [
          `band${index}.frequency`,
          { name: `band ${index} frequency`, min: 20, max: 20_000, default: 1000, unit: "hertz", read: (s) => band(s, index)?.frequency ?? 0 },
        ],
        [`band${index}.gain`, { name: `band ${index} gain`, min: -24, max: 24, default: 0, unit: "decibel", read: (s) => band(s, index)?.gain ?? 0 }],
        [`band${index}.q`, { name: `band ${index} q`, min: 0.1, max: 20, default: 1, read: (s) => band(s, index)?.q ?? 0 }],
      );
    }
  }
  return new Map(list);
}

/**
 * The parameters of a built-in rack effect slot as device-parameter rows: `enabled` (0 or 1) and `wet` (0 to 1) on every effect; `mode` (0 lowpass, 1 highpass), `frequency` (20 to 20000 Hz) and `q`
 * (0.1 to 20) on a filter; `delayTime` (0.01 to 1 s) and `feedback` (0 to 0.95) on a delay; `band<i>.frequency`, `band<i>.gain` (dB, -24 to 24) and `band<i>.q` on an equalizer.
 * `default` is the value a new effect of that type starts with.
 */
export function rackSlotParameters(slot: RackEffect): readonly DeviceParameter[] {
  return [...specs(slot)].map(([id, spec]) => {
    const value = spec.read(slot);
    return Object.freeze({
      id,
      name: spec.name,
      kind: "rack" as const,
      min: spec.min,
      max: spec.max,
      default: spec.default,
      value,
      ...(spec.step === undefined ? {} : { step: spec.step }),
      ...(spec.unit === undefined ? {} : { unit: spec.unit }),
      ...(spec.text ? { text: spec.text(value) } : {}),
    });
  });
}

/** Validates `value` against the range (and whole-number step) of `parameter`; throws a RangeError naming the allowed values. */
export function assertParameterValue(parameter: Pick<DeviceParameterRecord, "id" | "min" | "max" | "step">, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < parameter.min || value > parameter.max)
    throw new RangeError(`Project device parameter "${parameter.id}" needs a number from ${parameter.min} to ${parameter.max}.`);
  if (parameter.step === 1 && !Number.isInteger(value))
    throw new RangeError(`Project device parameter "${parameter.id}" is stepped and needs a whole number from ${parameter.min} to ${parameter.max}.`);
}

/**
 * The slot with one parameter set to `value`, validated like `setTrackEffects` would. Throws for a parameter the slot's type does not have (the message lists the ones it has)
 * or a value outside its range.
 */
export function withRackParameter(slot: RackEffect, parameterId: string, value: number): RackEffect {
  const spec = specs(slot).get(parameterId);
  if (!spec)
    throw new Error(
      `Project effect "${slot.id}" has no parameter "${parameterId}"; it has ${[...specs(slot).keys()].map((id) => `"${id}"`).join(", ")}.`,
    );
  assertParameterValue({ id: parameterId, min: spec.min, max: spec.max, step: spec.step }, value);
  if (parameterId === "enabled") return Object.freeze({ ...slot, enabled: value === 1 });
  if (parameterId === "wet") return Object.freeze({ ...slot, wet: value });
  if (slot.type === "filter")
    return Object.freeze({ ...slot, ...(parameterId === "mode" ? { mode: value === 1 ? "highpass" : "lowpass" } : { [parameterId]: value }) });
  if (slot.type === "delay") return Object.freeze({ ...slot, [parameterId]: value });
  const [, index, field] = /^band(\d+)\.(frequency|gain|q)$/.exec(parameterId)!;
  const bands = slot.bands.map((item, at) => (at === Number(index) ? Object.freeze({ ...item, [field]: value }) : item));
  return Object.freeze({ ...slot, bands: Object.freeze(bands) });
}

/** The rows of a WebCLAP device's parameter table as device-parameter rows (no live text); `parameterText` gives the display string of a value when the plug-in is running. */
export function tableParameters(
  table: readonly DeviceParameterRecord[],
  parameterText?: (id: string) => string | undefined,
): readonly DeviceParameter[] {
  return table.map((record) => {
    const text = parameterText?.(record.id);
    const { normalized, ...row } = record;
    return Object.freeze({
      ...row,
      kind: "webclap" as const,
      ...(normalized ? { unit: "normalized" } : {}),
      ...(text === undefined ? {} : { text }),
    });
  });
}

/** Whether two parameter tables hold the same parameters in the same order with the same values (name, range and default included). */
export function sameParameterTables(a: readonly DeviceParameterRecord[], b: readonly DeviceParameterRecord[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((item, index) => {
        const other = b[index];
        return (
          item === other ||
          (item.id === other.id &&
            item.name === other.name &&
            item.min === other.min &&
            item.max === other.max &&
            item.default === other.default &&
            item.value === other.value &&
            item.step === other.step &&
            item.normalized === other.normalized)
        );
      }))
  );
}

/**
 * `now` with the values of the parameters in `ids` taken from `side`; every other parameter keeps the value it has in `now`. Returns `now` itself when nothing differs.
 * Undo and Redo use it so a step puts back only the parameters it changed, not a value the plug-in moved by itself since.
 */
export function mergeParameterValues(
  now: readonly DeviceParameterRecord[],
  side: readonly DeviceParameterRecord[],
  ids: readonly string[],
): readonly DeviceParameterRecord[] {
  if (!ids.length) return now;
  let changed = false;
  const next = now.map((record) => {
    if (!ids.includes(record.id)) return record;
    const wanted = side.find((item) => item.id === record.id);
    if (!wanted || wanted.value === record.value) return record;
    changed = true;
    return Object.freeze({ ...record, value: wanted.value });
  });
  return changed ? Object.freeze(next) : now;
}
