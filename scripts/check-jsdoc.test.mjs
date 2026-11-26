import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, findUndocumented, matchKey } from "./check-jsdoc.mjs";
import { fixturePackage } from "./lib/fixture.mjs";

const keys = (text, extra = {}) =>
  findUndocumented(fixturePackage({ ".": "index.d.ts", ...extra.exports }, { "index.d.ts": text, ...extra.files }), "pkg")
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

test("interfaces and type aliases are not checked, and unexported classes are skipped", () => {
  const src = [
    "export interface Options { size: number }",
    "export type Mode = 'a' | 'b';",
    "declare class Hidden { run(): void }",
    "export {};",
  ].join("\n");
  assert.deepEqual(keys(src), []);
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
