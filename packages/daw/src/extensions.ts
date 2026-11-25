/** App extensions of a Project: typed data saved in the song file, and named operations an app or agent can list and call.
 * Reads: core cells. Pure: no DOM or AudioContext, so Node tools and agents use it too.
 */
import type { Project } from "./model";

/** A JSON value, as extension data is stored. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * App data that belongs to the song: `const chain = defineExtension({ id: "groovebox.chain", defaultValue: () => [] as number[] })`, then `project.extension(chain)`.
 * It is saved inside the `.dawproject` file (other DAWs ignore it) and kept intact by apps that do not define it.
 */
export interface ExtensionDefinition<T> {
  /** Unique name, such as "groovebox.chain" (letters, digits, dots, dashes); it names the data's folder in the file. */
  readonly id: string;
  /** Format version saved with the data; raise it when the shape changes and migrate in `validate`. Default 1. */
  readonly version: number;
  /** The value of a song that has no data for this extension yet. */
  defaultValue(): T;
  /** Check data read from a file and return it as `T` (migrating from `version` when older); throw to fall back to `defaultValue()`. Default: accept it as is. */
  validate?(data: unknown, version: number): T;
}

/** Define app data that belongs to a song. Read and change it with `project.extension(definition)`. */
export function defineExtension<T>(definition: {
  id: string;
  version?: number;
  defaultValue: () => T;
  validate?: (data: unknown, version: number) => T;
}): ExtensionDefinition<T> {
  if (typeof definition?.id !== "string" || !EXTENSION_ID.test(definition.id))
    throw new RangeError('Extension id must be letters, digits, dots and dashes, such as "groovebox.chain".');
  const version = definition.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new RangeError("Extension version must be a positive integer.");
  if (typeof definition.defaultValue !== "function") throw new TypeError("Extension needs a defaultValue function.");
  return Object.freeze({ id: definition.id, version, defaultValue: definition.defaultValue, validate: definition.validate });
}

export const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;

/**
 * A song's data for one extension: read `value` (tracked) or `subscribe`; change it with `set` or `update`, which make a song change like any Project method.
 * Inside `project.edit(label, () => …)` the change joins that Undo step; on its own it is not an Undo step.
 */
export interface ProjectExtension<T> {
  readonly definition: ExtensionDefinition<T>;
  /** The data now (tracked by an effect). */
  readonly value: T;
  /** Call `listener` with the data whenever it changes, including after undo, redo and opening; returns the unsubscribe function. */
  subscribe(listener: (value: T) => void, options?: { immediate?: boolean }): () => void;
  /** Replace the data. It must be JSON (no functions, dates or undefined); it is stored as a frozen copy. Data equal to the current value is no change. Throws when the file holds data from a newer version of this extension. */
  set(value: T): void;
  /** Change a mutable copy of the data in place, or return the new value: `chain.update((scenes) => { scenes.push(2); })`, `count.update((n) => n + 1)`. Data left equal is no change. */
  update(recipe: (draft: Mutable<T>) => T | Mutable<T> | void): void;
}

/** A deep mutable view of JSON data, for `update` recipes. */
export type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

/** The JSON Schema subset an operation's `input` uses; the same shape AI tool calls take. */
export type JsonSchema = Readonly<{
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  /** An object with `properties` accepts only those names; `true` lets other names through. Default: unknown names are rejected. */
  additionalProperties?: boolean;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly JsonValue[];
  minimum?: number;
  maximum?: number;
}>;

/**
 * A named edit an app adds to its songs: `project.operations.register(removeGap)`, then `project.operations.call("podcast.remove-gap", { start: 10, end: 20 })`.
 * `run` edits the song with Project methods; each call is one Undo step labelled `label` (default `description`), and if `run` throws, nothing changes.
 */
export interface ProjectOperation<Args extends object = Readonly<Record<string, unknown>>, Result = unknown> {
  /** Unique name callers use, such as "podcast.remove-gap". */
  readonly name: string;
  /** One sentence saying what it does, for a menu or an AI assistant. */
  readonly description: string;
  /** The arguments as a JSON Schema object; `call` checks types, required names, number ranges and unknown field names before `run`. */
  readonly input: JsonSchema & { readonly type: "object" };
  /** The Undo label. Default `description`. */
  readonly label?: string;
  run(project: Project, args: Args): Result;
}

/** Define a named operation; register it on a song with `project.operations.register(operation)`. */
export function defineOperation<Args extends object, Result>(operation: ProjectOperation<Args, Result>): ProjectOperation<Args, Result> {
  if (typeof operation?.name !== "string" || !operation.name.trim()) throw new RangeError("Operation needs a name.");
  if (typeof operation.description !== "string" || !operation.description.trim())
    throw new RangeError(`Operation "${operation.name}" needs a description.`);
  if (operation.input?.type !== "object") throw new RangeError(`Operation "${operation.name}" input must be a JSON Schema with type "object".`);
  if (typeof operation.run !== "function") throw new TypeError(`Operation "${operation.name}" needs a run function.`);
  return Object.freeze({ ...operation });
}

/** What `project.operations.list()` reports for each operation. */
export type OperationInfo = Readonly<{ name: string; description: string; input: JsonSchema }>;

/** The operations registered on one song. */
export interface ProjectOperations {
  /** Add an operation; returns a function that removes it. A name already registered throws. */
  register(operation: ProjectOperation<never, unknown>): () => void;
  /** Every registered operation's name, description and input schema. */
  list(): readonly OperationInfo[];
  /** Check `args` against the operation's input, run it as one Undo step and return its result. Unknown names and invalid arguments throw. */
  call<Result = unknown>(name: string, args?: object): Result;
}

/** Throws a RangeError naming the first argument that does not match `schema`, or the first field an object with `properties` does not list. */
export function checkArguments(operation: string, schema: JsonSchema, value: unknown, path = "args"): void {
  const fail = (why: string) => {
    throw new RangeError(`Operation "${operation}": ${path} ${why}.`);
  };
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
    fail(`must be one of ${JSON.stringify(schema.enum)}`);
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) fail("must be an object");
      const record = value as Record<string, unknown>;
      const own = (name: string) => (Object.hasOwn(record, name) ? record[name] : undefined);
      for (const name of schema.required ?? []) if (own(name) === undefined) fail(`needs "${name}"`);
      if (schema.properties && schema.additionalProperties !== true) {
        const allowed = Object.keys(schema.properties);
        const unknown = Object.keys(record).find((name) => !allowed.includes(name));
        if (unknown !== undefined) fail(`has unknown field "${unknown}"; allowed: ${allowed.join(", ") || "none"}`);
      }
      for (const [name, child] of Object.entries(schema.properties ?? {}))
        if (own(name) !== undefined) checkArguments(operation, child, own(name), `${path}.${name}`);
      return;
    }
    case "array":
      if (!Array.isArray(value)) fail("must be an array");
      if (schema.items) (value as unknown[]).forEach((item, index) => checkArguments(operation, schema.items!, item, `${path}[${index}]`));
      return;
    case "string":
      if (typeof value !== "string") fail("must be a string");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("must be a boolean");
      return;
    case "null":
      if (value !== null) fail("must be null");
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a finite number");
      if (schema.type === "integer" && !Number.isInteger(value)) fail("must be an integer");
      if (schema.minimum !== undefined && (value as number) < schema.minimum) fail(`must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && (value as number) > schema.maximum) fail(`must be at most ${schema.maximum}`);
      return;
  }
}

/** A frozen deep copy of JSON data; throws for anything JSON cannot hold. */
export function freezeJson(value: unknown, where: string): JsonValue {
  const visit = (item: unknown): JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError(`${where} must be JSON: numbers must be finite.`);
      return item;
    }
    // Array.from visits holes as undefined, so a sparse array is rejected instead of keeping a hole.
    if (Array.isArray(item)) return Object.freeze(Array.from(item, visit));
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype)
      return Object.freeze(Object.fromEntries(Object.entries(item as object).map(([key, child]) => [key, visit(child)])));
    throw new TypeError(`${where} must be JSON: plain objects, arrays, strings, finite numbers, booleans and null.`);
  };
  return visit(value);
}

/** A mutable deep copy of frozen JSON, for an `update` recipe. */
export function thawJson<T>(value: T): T {
  return value === null || typeof value !== "object" ? value : (JSON.parse(JSON.stringify(value)) as T);
}
