/** Pure rack settings and validation; loads in Node without Web Audio or any effect runtime. */
import type { AudioProcessor, Param, SchedulableParam, ValueRange } from "@audiorective/core";
import { normalizeEqualizerBands, type EqualizerBand } from "@audiorective/effects/equalizer-bands";
import type { DeviceParameterRecord } from "./device-parameters";

export type RackMacroParameter = "wet" | "frequency" | "q" | "delayTime" | "feedback";
export type RackMacroMapping = ValueRange &
  Readonly<{
    /** Opaque ID of the target insert slot within this track rack. */
    slotId: string;
    /** Insert parameter key; the selected effect must expose it. */
    parameter: RackMacroParameter;
    /** Interpolation from min to max; default linear, with positive endpoints required for exponential. */
    scale?: "linear" | "exponential";
  }>;
export type RackMacroSettings = Readonly<{
  id: string;
  /** Optional display label; omitted to use the macro ID as its control label. */
  label?: string;
  /** Normalized macro position 0..1, mapped to each target range. */
  value: number;
  /** Distinct insert-parameter mappings owned by this macro; empty for an unassigned control. */
  targets: readonly RackMacroMapping[];
}>;

export const isMacroValue = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

export type EffectSlot = Readonly<{
  id: string;
  /** Whether the insert processes audio; false bypasses its wet contribution. */
  enabled: boolean;
  /** Wet/dry blend 0..1, from fully dry to fully processed. */
  wet: number;
}>;
export type RackFilter = EffectSlot &
  Readonly<{
    type: "filter";
    /** Filter response, lowpass or highpass. */
    mode: "lowpass" | "highpass";
    /** Cutoff frequency in hertz, 20..20000. */
    frequency: number;
    /** Dimensionless resonance Q, 0.1..20. */
    q: number;
  }>;
export type RackDelay = EffectSlot &
  Readonly<{
    type: "delay";
    /** Delay duration in seconds, 0.01..1. */
    delayTime: number;
    /** Dimensionless repeat gain, 0..0.95. */
    feedback: number;
  }>;
export type RackEq = EffectSlot &
  Readonly<{
    type: "eq";
    /** Ordered equalizer bands, each validated in its own frequency, gain-in-dB and Q ranges. */
    bands: readonly EqualizerBand[];
  }>;
/**
 * An app-defined insert: `effect` names a `RackEffectDefinition` the app gives the Workspace (`WorkspaceOptions.effects`), and `parameters` is the table of its numeric
 * parameters with the song's current values. Build one with `definition.slot(...)`. Automation and macros cannot target its parameters; `enabled` and `wet` work as on the built-in kinds.
 */
export type RackCustom = EffectSlot &
  Readonly<{
    type: "custom";
    /** ID of the `RackEffectDefinition` that builds this insert; non-empty. */
    effect: string;
    /** The effect's parameters in definition order; IDs are unique and never `wet` or `enabled`, and each value lies within its row's `min` to `max`. */
    parameters: readonly DeviceParameterRecord[];
  }>;
/** The built-in kinds (filter, delay, EQ) and the app-defined custom kind. */
export type RackEffect = RackFilter | RackDelay | RackEq | RackCustom;

/** What a custom rack effect's `create` returns: an `Effect` from `@audiorective/effects` (or a subclass of it), whose `params` hold one numeric param per table parameter ID. */
export type RackEffectInstance = AudioProcessor &
  Readonly<{
    /** The effect's params: `wet` and `bypass` from `Effect`, plus one numeric param per table parameter ID. */
    params: Readonly<{
      /** Wet/dry mix 0..1, driven from the slot's `wet` and `enabled`. */
      wet: SchedulableParam;
      /** Fades the effect to dry; the rack leaves it alone. */
      bypass: Param<boolean>;
    }>;
  }>;
/** One parameter of a custom rack effect as its definition declares it; `step: 1` marks a whole-number parameter. */
export type RackEffectParameter = Readonly<{
  /** Key of the matching `params` entry on the created effect; not `wet`, `enabled`, or containing `:`. */
  id: string;
  name: string;
  /** Inclusive lower bound in the parameter's units. */
  min: number;
  /** Inclusive upper bound in the parameter's units. */
  max: number;
  /** Value a new slot starts with, within `min` to `max`. */
  default: number;
  /** 1 for a whole-number parameter, which snaps a set value to the nearest whole step from `min`; omitted for a continuous one. */
  step?: 1;
  /** Unit of the values such as `"hertz"`, `"seconds"` or `"decibel"`; omitted for a plain number. */
  unit?: string;
}>;
/** An app-defined rack effect: what `defineRackEffect` returns. Give it to `WorkspaceOptions.effects`; put it on a track with `definition.slot(...)` and `project.setTrackEffects`. */
export type RackEffectDefinition = Readonly<{
  /** Unique name saved in the song as the slot's `effect`. */
  id: string;
  /** Display name. */
  name: string;
  /** The parameters a slot of this effect carries. */
  parameters: readonly RackEffectParameter[];
  /** Builds the live effect for one slot, once per slot; later edits change `params` on it without calling this again. May be asynchronous. */
  create(context: BaseAudioContext, slot: RackCustom): RackEffectInstance | Promise<RackEffectInstance>;
  /** A valid custom slot of this effect: every parameter at its default unless `values` names it; `enabled` defaults to true and `wet` to 1. */
  slot(
    options: Readonly<{
      /** Slot ID, unique within the track. */
      id: string;
      /** Whether the insert processes audio; default true. */
      enabled?: boolean;
      /** Wet/dry blend 0..1; default 1. */
      wet?: number;
      /** Parameter values by ID, each within its range; omitted parameters take their defaults. */
      values?: Readonly<Record<string, number>>;
    }>,
  ): RackCustom;
}>;
export type RackPreset = Readonly<{
  /** Preset format marker; omitted is treated as version 1. */
  version?: 1;
  /** Ordered built-in insert settings; empty for a dry rack. */
  effects: readonly RackEffect[];
  /** Normalized controls and their insert mappings; omitted for no macros. */
  macros?: readonly RackMacroSettings[];
}>;

const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
const reservedParameter = (id: string) => id === "wet" || id === "enabled" || id.includes(":");

/** A frozen copy of a custom slot's parameter table, or `undefined` when a row is malformed, reserved or repeated. */
function normalizeParameterTable(table: unknown): readonly DeviceParameterRecord[] | undefined {
  if (!Array.isArray(table)) return undefined;
  const ids = new Set<string>();
  const rows: DeviceParameterRecord[] = [];
  for (const row of table as readonly DeviceParameterRecord[]) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      reservedParameter(row.id) ||
      ids.has(row.id) ||
      typeof row.name !== "string" ||
      !row.name ||
      !Number.isFinite(row.min) ||
      !between(row.max, row.min, Infinity) ||
      !between(row.default, row.min, row.max) ||
      !between(row.value, row.min, row.max) ||
      (row.step !== undefined && row.step !== 1) ||
      (row.unit !== undefined && typeof row.unit !== "string")
    )
      return undefined;
    ids.add(row.id);
    rows.push(
      Object.freeze({
        id: row.id,
        name: row.name,
        min: row.min,
        max: row.max,
        default: row.default,
        value: row.value,
        ...(row.step === undefined ? {} : { step: row.step }),
        ...(row.unit === undefined ? {} : { unit: row.unit }),
      }),
    );
  }
  return Object.freeze(rows);
}

/**
 * Describe an app-defined rack effect. `parameters` lists the numeric parameters a slot carries (IDs unique, not `wet` or `enabled`, no `:`; `min <= default <= max`); `create` builds the
 * `Effect` for one slot. Pass the result in `WorkspaceOptions.effects`, and build the slot with `definition.slot({ id })`.
 */
export function defineRackEffect(definition: {
  id: string;
  name: string;
  parameters: readonly RackEffectParameter[];
  create: (context: BaseAudioContext, slot: RackCustom) => RackEffectInstance | Promise<RackEffectInstance>;
}): RackEffectDefinition {
  if (typeof definition?.id !== "string" || !definition.id.trim() || typeof definition.name !== "string" || !definition.name.trim())
    throw new RangeError("Rack effect needs a non-empty id and name.");
  const { id } = definition;
  if (typeof definition.create !== "function") throw new TypeError(`Rack effect "${id}" needs a create function.`);
  const table = normalizeParameterTable(
    Array.isArray(definition.parameters) ? definition.parameters.map((parameter) => ({ ...parameter, value: parameter?.default })) : undefined,
  );
  if (!table)
    throw new RangeError(
      `Rack effect "${id}" needs parameters with unique IDs (not "wet", "enabled" or containing ":"), a name, and finite min <= default <= max.`,
    );
  const parameters = Object.freeze(table.map(({ value: _value, ...row }) => Object.freeze(row)));
  const create = definition.create;
  return Object.freeze({
    id,
    name: definition.name,
    parameters,
    create: (context, slot) => create(context, slot),
    slot: (options) => {
      const values = options.values ?? {};
      for (const key of Object.keys(values))
        if (!parameters.some((parameter) => parameter.id === key)) throw new RangeError(`Rack effect "${id}" has no parameter "${key}".`);
      const [slot] = normalizeRackEffects([
        {
          id: options.id,
          enabled: options.enabled ?? true,
          wet: options.wet ?? 1,
          type: "custom",
          effect: id,
          parameters: parameters.map((parameter) => ({
            ...parameter,
            value: Object.hasOwn(values, parameter.id) ? values[parameter.id] : parameter.default,
          })),
        },
      ]);
      return slot as RackCustom;
    },
  });
}

/** Validate a complete ordered settings snapshot before changing effects or routing. */
export function normalizeRackEffects(effects: readonly RackEffect[]): readonly RackEffect[] {
  const invalid = () => new RangeError("TrackRack needs unique slot IDs and valid Filter, Delay or EQ settings.");
  if (!Array.isArray(effects)) throw invalid();
  const ids = new Set<string>();
  return Object.freeze(
    Array.from(effects, (slot: RackEffect) => {
      if (
        !slot ||
        typeof slot.id !== "string" ||
        !slot.id.trim() ||
        ids.has(slot.id) ||
        typeof slot.enabled !== "boolean" ||
        !between(slot.wet, 0, 1)
      )
        throw invalid();
      ids.add(slot.id);
      const base = { id: slot.id, enabled: slot.enabled, wet: slot.wet };
      if (
        slot.type === "filter" &&
        (slot.mode === "lowpass" || slot.mode === "highpass") &&
        between(slot.frequency, 20, 20_000) &&
        between(slot.q, 0.1, 20)
      ) {
        return Object.freeze({ ...base, type: slot.type, mode: slot.mode, frequency: slot.frequency, q: slot.q });
      }
      if (slot.type === "delay" && between(slot.delayTime, 0.01, 1) && between(slot.feedback, 0, 0.95)) {
        return Object.freeze({ ...base, type: slot.type, delayTime: slot.delayTime, feedback: slot.feedback });
      }
      if (slot.type === "eq") return Object.freeze({ ...base, type: slot.type, bands: normalizeEqualizerBands(slot.bands) });
      if (slot.type === "custom") {
        const parameters = typeof slot.effect === "string" && slot.effect.trim() ? normalizeParameterTable(slot.parameters) : undefined;
        if (!parameters)
          throw new RangeError(
            `TrackRack custom effect slot "${slot.id}" needs a non-empty effect ID and a parameter table with unique IDs (not "wet", "enabled" or containing ":") and finite min <= default <= max, value within min..max.`,
          );
        return Object.freeze({ ...base, type: slot.type, effect: slot.effect, parameters });
      }
      throw invalid();
    }),
  );
}

export const noMacros: readonly RackMacroSettings[] = Object.freeze([]);
const ranges = {
  filter: { frequency: [20, 20_000], q: [0.1, 20] },
  delay: { delayTime: [0.01, 1], feedback: [0, 0.95] },
  eq: {},
  custom: {},
} satisfies Record<RackEffect["type"], Partial<Record<RackMacroParameter, readonly [number, number]>>>;

/** The `[min, max]` a macro can drive for one rack slot's parameter (`wet` is 0 to 1; a custom slot has no macro range; Filter `frequency` 20 to 20000 Hz and `q` 0.1 to 20; Delay `delayTime` 0.01 to 1 s and `feedback` 0 to 0.95), or `undefined` when the slot's type has no such parameter. */
export function rackMacroRange(slot: RackEffect, parameter: RackMacroParameter): readonly [number, number] | undefined {
  if (slot.type === "custom") return undefined;
  if (parameter === "wet") return [0, 1];
  const parameters: Partial<Record<RackMacroParameter, readonly [number, number]>> = ranges[slot.type];
  const range = Object.hasOwn(parameters, parameter) ? parameters[parameter] : undefined;
  return range && [range[0], range[1]];
}

function validMapping(effects: readonly RackEffect[], mapping: RackMacroSettings["targets"][number]): boolean {
  if (!mapping || typeof mapping.slotId !== "string" || typeof mapping.parameter !== "string") return false;
  const slot = effects.find(({ id }) => id === mapping.slotId);
  const range = slot && rackMacroRange(slot, mapping.parameter);
  return (
    !!range &&
    between(mapping.min, ...range) &&
    between(mapping.max, ...range) &&
    (mapping.scale === undefined ||
      mapping.scale === "linear" ||
      (mapping.scale === "exponential" && Math.fround(mapping.min) > 0 && Math.fround(mapping.max) > 0))
  );
}

/** Drop mappings to removed or replaced slots while retaining unrelated settings. */
export function retainRackMacroTargets(effects: readonly RackEffect[], macros: readonly RackMacroSettings[]): readonly RackMacroSettings[] {
  if (macros.every(({ targets }) => targets.every((mapping) => validMapping(effects, mapping)))) return macros;
  return Object.freeze(
    macros.map((macro) => {
      const targets = macro.targets.filter((mapping) => validMapping(effects, mapping));
      return targets.length === macro.targets.length ? macro : Object.freeze({ ...macro, targets: Object.freeze(targets) });
    }),
  );
}

/** Validate unique control ownership and copy data before allocating any effect nodes. */
function normalizeRackMacros(effects: readonly RackEffect[], macros: readonly RackMacroSettings[] = noMacros): readonly RackMacroSettings[] {
  if (macros === noMacros) return noMacros;
  const invalid = () => new RangeError("TrackRack macros need unique IDs, normalized values, and distinct valid targets.");
  if (!Array.isArray(macros)) throw invalid();
  const ids = new Set<string>();
  const claimed = new Map<string, Set<RackMacroParameter>>();
  return Object.freeze(
    Array.from(macros, (macro: RackMacroSettings) => {
      if (
        !macro ||
        typeof macro.id !== "string" ||
        !macro.id.trim() ||
        ids.has(macro.id) ||
        (macro.label !== undefined && typeof macro.label !== "string") ||
        !isMacroValue(macro.value) ||
        !Array.isArray(macro.targets)
      )
        throw invalid();
      ids.add(macro.id);
      const targets = Object.freeze(
        Array.from(macro.targets, (mapping: RackMacroSettings["targets"][number]) => {
          if (mapping && effects.find(({ id }) => id === mapping.slotId)?.type === "custom")
            throw new RangeError("TrackRack macros cannot target a custom effect slot.");
          if (!validMapping(effects, mapping)) throw invalid();
          let parameters = claimed.get(mapping.slotId);
          if (!parameters) claimed.set(mapping.slotId, (parameters = new Set()));
          if (parameters.has(mapping.parameter)) throw invalid();
          parameters.add(mapping.parameter);
          return Object.freeze({
            slotId: mapping.slotId,
            parameter: mapping.parameter,
            min: mapping.min,
            max: mapping.max,
            ...(mapping.scale === undefined ? {} : { scale: mapping.scale }),
          });
        }),
      );
      return Object.freeze({ id: macro.id, ...(macro.label === undefined ? {} : { label: macro.label }), value: macro.value, targets });
    }),
  );
}

export function normalizeRackPreset(preset: RackPreset): Required<RackPreset> {
  if (!preset || (preset.version !== undefined && preset.version !== 1)) throw new RangeError("TrackRack preset version must be 1.");
  const effects = normalizeRackEffects(preset.effects);
  return Object.freeze({ version: 1, effects, macros: normalizeRackMacros(effects, preset.macros) });
}
