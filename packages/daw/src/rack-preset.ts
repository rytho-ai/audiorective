/** Pure rack settings and validation; loads in Node without Web Audio or any effect runtime. */
import type { ValueRange } from "@audiorective/core";
import { normalizeEqualizerBands, type EqualizerBand } from "@audiorective/effects/equalizer-bands";

export type RackMacroParameter = "wet" | "frequency" | "q" | "delayTime" | "feedback";
export type RackMacroMapping = ValueRange &
  Readonly<{
    slotId: string;
    parameter: RackMacroParameter;
    scale?: "linear" | "exponential";
  }>;
export type RackMacroSettings = Readonly<{
  id: string;
  label?: string;
  value: number;
  targets: readonly RackMacroMapping[];
}>;

export const isMacroValue = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

export type EffectSlot = Readonly<{ id: string; enabled: boolean; wet: number }>;
export type RackFilter = EffectSlot & Readonly<{ type: "filter"; mode: "lowpass" | "highpass"; frequency: number; q: number }>;
export type RackDelay = EffectSlot & Readonly<{ type: "delay"; delayTime: number; feedback: number }>;
export type RackEq = EffectSlot & Readonly<{ type: "eq"; bands: readonly EqualizerBand[] }>;
export type RackEffect = RackFilter | RackDelay | RackEq;
export type RackPreset = Readonly<{ version?: 1; effects: readonly RackEffect[]; macros?: readonly RackMacroSettings[] }>;

const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;

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
      throw invalid();
    }),
  );
}

export const noMacros: readonly RackMacroSettings[] = Object.freeze([]);
const ranges = {
  filter: { frequency: [20, 20_000], q: [0.1, 20] },
  delay: { delayTime: [0.01, 1], feedback: [0, 0.95] },
  eq: {},
} satisfies Record<RackEffect["type"], Partial<Record<RackMacroParameter, readonly [number, number]>>>;

/** The `[min, max]` a macro can drive for one rack slot's parameter (`wet` is 0 to 1; Filter `frequency` 20 to 20000 Hz and `q` 0.1 to 20; Delay `delayTime` 0.01 to 1 s and `feedback` 0 to 0.95), or `undefined` when the slot's type has no such parameter. */
export function rackMacroRange(slot: RackEffect, parameter: RackMacroParameter): readonly [number, number] | undefined {
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
