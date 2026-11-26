import assert from "node:assert/strict";
import { test } from "node:test";
import { NAME_RULES, classify, scanPackage } from "./check-vocabulary.mjs";
import { fixturePackage } from "./lib/fixture.mjs";

const hits = (text) =>
  scanPackage(fixturePackage({ ".": "index.d.ts" }, { "index.d.ts": text }), "pkg")
    .map((v) => `${v.line}:${v.key}`)
    .sort();

test("flags disallowed teardown, unit-suffix and tail names with their line", () => {
  const src = [
    "export declare class Voice {",
    "  destroy(): void;",
    "  tail: number;",
    "  releaseSec: number;",
    "  fadeMs: number;",
    "  tailSeconds: number;",
    "}",
  ].join("\n");
  assert.deepEqual(hits(src), [
    "2:pkg/Voice.destroy#teardown",
    "3:pkg/Voice.tail#tail",
    "4:pkg/Voice.releaseSec#seconds-suffix",
    "5:pkg/Voice.fadeMs#ms-unit",
  ]);
});

test("allows wall-clock Ms timers and the canonical names", () => {
  const src = "export interface Options { intervalMs: number; timeoutMs?: number; prerollSeconds: number; gainDb: number; sampleRate: number; }";
  assert.deepEqual(hits(src), []);
});

test("a time or duration parameter needs a unit in its JSDoc", () => {
  const src = [
    "export interface Clockish {",
    "  /** Value at `time`. */",
    "  toBeat(time: number): number;",
    "  /** Beat at audio-context `time` (seconds). */",
    "  toBeatSeconds(time: number): number;",
    "  /** @param duration Length in beats. */",
    "  hold(duration: number): void;",
    "}",
  ].join("\n");
  assert.deepEqual(hits(src), ["3:pkg/Clockish.toBeat(time)#unit-doc"]);
});

test("a time property inherits the unit from its owner, a string-typed offset needs none", () => {
  const src = ["/** Position in beats. */", "export interface Point { time: number }", "export interface Bare { time: number; offset: string }"].join(
    "\n",
  );
  assert.deepEqual(hits(src), ["3:pkg/Bare.time#unit-doc"]);
});

test("velocity documented as 0-127 is flagged, the /127 conversion note is not", () => {
  const src = [
    "export interface A {",
    "  /** MIDI velocity 0-127. */",
    "  velocity: number;",
    "  /** 0..1 (MIDI velocity / 127). */",
    "  gain: number;",
    "}",
  ].join("\n");
  assert.deepEqual(hits(src), ["3:pkg/A.velocity#velocity-range"]);
});

test("every name rule has an id and a replacement, and ids are unique", () => {
  assert.equal(new Set(NAME_RULES.map((r) => r.id)).size, NAME_RULES.length);
  for (const r of NAME_RULES) assert.ok(r.use.length > 0);
});

test("classify honours exceptions and reports unused ones", () => {
  const v = (key) => ({ key, line: 1, file: "f", message: "m" });
  const out = classify(
    [v("core/A.x#millis"), v("core/C.z#tail")],
    [
      { pattern: "core/A.*", reason: "r" },
      { pattern: "none", reason: "r" },
    ],
  );
  assert.deepEqual(
    out.failing.map((x) => x.key),
    ["core/C.z#tail"],
  );
  assert.equal(out.excepted.length, 1);
  assert.deepEqual(
    out.unusedExceptions.map((e) => e.pattern),
    ["none"],
  );
});
