import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, FIELD_CHECKS, findUndocumented, matchKey } from "./check-jsdoc.mjs";
import { fixturePackage } from "./lib/fixture.mjs";

const keys = (text, extra = {}) =>
  findUndocumented(fixturePackage({ ".": "index.d.ts", ...extra.exports }, { "index.d.ts": text, ...extra.files }), "pkg", {
    fields: extra.fields ?? true,
  })
    .map((v) => `${v.line}:${v.key}`)
    .sort();

test("flags undocumented classes, public members, functions and consts with their line", () => {
  const src = [
    "export declare class Meter {",
    "  /** Peak level, linear 0..1. */",
    "  readonly peak: number;",
    "  reset(): void;",
    "  get level(): number;",
    "  private secret;",
    "  protected hook(): void;",
    "  constructor(x: number);",
    "}",
    "/** Linear gain for a dB value. */",
    "export declare function dbToGain(db: number): number;",
    "export declare function gainToDb(gain: number): number;",
    "export declare const DEFAULT_RATE = 48000;",
  ].join("\n");
  assert.deepEqual(
    keys(src),
    ["1:pkg/Meter", "13:pkg/DEFAULT_RATE", "12:pkg/gainToDb", "4:pkg/Meter.reset", "5:pkg/Meter.level", "7:pkg/Meter.hook"].sort(),
  );
});

test("a documented overload or accessor pair covers the others", () => {
  const src = [
    "/** A clip. */",
    "export declare class Clip {",
    "  /** Starts at `when` seconds. */",
    "  start(when?: number): void;",
    "  start(when: number, offset: number): void;",
    "  /** Position in beats. */",
    "  get position(): number;",
    "  set position(v: number);",
    "}",
    "/** Fn. */",
    "export declare function f(a: number): void;",
    "export declare function f(a: string): void;",
  ].join("\n");
  assert.deepEqual(keys(src), []);
});

test("field checks can be disabled while unexported declarations and scalar aliases are skipped", () => {
  const src = [
    "export interface Options { size: number }",
    "export type Mode = 'a' | 'b';",
    "declare class Hidden { run(): void }",
    "export {};",
  ].join("\n");
  assert.deepEqual(keys(src, { fields: false }), []);
});

test("follows an entry through a bundler chunk and `export *`", () => {
  const out = keys('export * from "./chunk";', { files: { "chunk.d.ts": "export declare class Deep {\n  go(): void;\n}\n" } });
  assert.deepEqual(out, ["1:pkg/Deep", "2:pkg/Deep.go"]);
});

test("matchKey treats * as a wildcard and everything else literally", () => {
  assert.ok(matchKey("*.dispose", "core/Cell.dispose"));
  assert.ok(matchKey("effects/*.type", "effects/Filter.type"));
  assert.ok(!matchKey("effects/*.type", "core/Filter.type"));
  assert.ok(!matchKey("a.b", "aXb"));
});

test("classify separates exempt and failing violations and reports unused exemptions", () => {
  const v = (key) => ({ key, kind: "member", file: "f", line: 1 });
  const out = classify(
    [v("core/A.dispose"), v("core/C.y")],
    [
      { pattern: "*.dispose", reason: "r" },
      { pattern: "*.nothing", reason: "r" },
    ],
  );
  assert.deepEqual(
    out.failing.map((x) => x.key),
    ["core/C.y"],
  );
  assert.deepEqual(
    out.exempted.map((x) => x.key),
    ["core/A.dispose"],
  );
  assert.deepEqual(
    out.unusedExemptions.map((x) => x.pattern),
    ["*.nothing"],
  );
});

test("checks interface properties, optional fields, methods and nested Readonly intersections", () => {
  const src = [
    "interface Base { inherited: number }",
    "export interface Options extends Base {",
    "  /** Width in pixels; defaults to 100. */",
    "  width?: number;",
    "  height: number;",
    "  run(): void;",
    "}",
    "type Hidden = { helper: number };",
    "export type Shape = Hidden & Readonly<{",
    "  nested: { leaf: number };",
    "}> & ({ left: number } | { right: number });",
    "type Unused = { ignored: number };",
    "export {};",
  ].join("\n");
  assert.deepEqual(
    keys(src),
    [
      "1:pkg/Base.inherited",
      "5:pkg/Options.height",
      "6:pkg/Options.run",
      "8:pkg/Hidden.helper",
      "10:pkg/Shape.nested",
      "10:pkg/Shape.nested.leaf",
      "11:pkg/Shape.left",
      "11:pkg/Shape.right",
    ].sort(),
  );
});

test("each union variant needs its own field documentation, even with the same name", () => {
  assert.deepEqual(
    keys(`export type Event = {
    /** Elapsed seconds. */
    time: number;
  } | { time: number };`),
    ["4:pkg/Event.time"],
  );
});

test("follows exported type aliases across declaration chunks and handles recursive types once", () => {
  assert.deepEqual(
    keys('export { Options as PublicOptions } from "./chunk";', {
      files: { "chunk.d.ts": 'export interface Options { child?: Options; "sample-rate": number }' },
    }),
    ['1:pkg/Options."sample-rate"', "1:pkg/Options.child"],
  );
});

test("every in-scope package checks fields as well as classes", () => {
  assert.equal(FIELD_CHECKS.daw, "enabled");
  assert.equal(Object.values(FIELD_CHECKS).filter((value) => value === "enabled").length, 11);
  const dir = fixturePackage(
    { ".": "index.d.ts" },
    {
      "index.d.ts": "export interface Options { count: number }\nexport declare class Meter {}",
    },
  );
  assert.deepEqual(
    findUndocumented(dir, "daw").map((v) => v.key),
    ["daw/Options.count", "daw/Meter"],
  );
  assert.deepEqual(
    findUndocumented(dir, "core").map((v) => v.key),
    ["core/Options.count", "core/Meter"],
  );
});

test("owner comments, plain comments and empty JSDoc do not document fields", () => {
  assert.deepEqual(
    keys(`/** Options. */
export interface Options {
  // Count in frames.
  count: number;
  /** */
  size: number;
  /** Optional duration in seconds; defaults to 1. */
  duration?: number;
}`),
    ["4:pkg/Options.count", "6:pkg/Options.size"],
  );
});

test("interface overloads and accessor pairs share documentation, independently of union variants", () => {
  assert.deepEqual(
    keys(`export interface Controls {
  /** Starts at absolute AudioContext seconds. */
  start(when: number): void;
  start(): void;
  /** Current amount, 0..1. */
  get value(): number;
  set value(amount: number);
  get missing(): number;
}`),
    ["8:pkg/Controls.missing"],
  );
});

test("nested arrays and utility wrappers retain field checks while entries are deduplicated", () => {
  assert.deepEqual(
    keys(
      `export type Settings = Readonly<{
  /** Point list; empty means no automation. */
  points: readonly { time: number }[];
}> & Partial<{ enabled: boolean }>;
`,
      { exports: { "./web": "index.d.ts" } },
    ),
    ["3:pkg/Settings.points.time", "4:pkg/Settings.enabled"],
  );
});

test("dependency types and re-exports remain documented upstream", () => {
  assert.deepEqual(
    keys(
      `import type { Foreign } from "./node_modules/vendor/index";
export type { Foreign } from "./node_modules/vendor/index";
export interface Options extends Foreign { local: number }
`,
      { files: { "node_modules/vendor/index.d.ts": "export interface Foreign { upstream: number }" } },
    ),
    ["3:pkg/Options.local"],
  );
});

test("new field violations use the existing exemption classification", () => {
  const dir = fixturePackage({ ".": "index.d.ts" }, { "index.d.ts": "export type Point = Readonly<{ id: string; seconds: number }>;" });
  const result = classify(findUndocumented(dir, "core"), [{ pattern: "core/Point.id", reason: "Stable string identity." }]);
  assert.deepEqual(
    result.exempted.map((v) => v.key),
    ["core/Point.id"],
  );
  assert.deepEqual(
    result.failing.map((v) => v.key),
    ["core/Point.seconds"],
  );
  assert.deepEqual(result.unusedExemptions, []);
});
