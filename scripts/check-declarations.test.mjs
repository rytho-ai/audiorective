import assert from "node:assert/strict";
import { test } from "node:test";
import { scanDeclaration } from "./check-declarations.mjs";

const messages = (src) => scanDeclaration(src).map((i) => `${i.line}:${i.message}`);

test("flags underscore members, exported names and @internal tags with line numbers", () => {
  const src = [
    "declare class A {",
    "  readonly value: number;",
    "  _launch(clip: A): void;",
    "  get _curve(): number;",
    "  /** @internal */",
    "}",
    "export { A, B as _hidden };",
    "export declare function _helper(): void;",
  ].join("\n");
  assert.deepEqual(messages(src), [
    "3:member `_launch` starts with an underscore",
    "4:member `_curve` starts with an underscore",
    "5:`@internal` tag in a shipped declaration",
    "7:exported name `_hidden` starts with an underscore",
    "8:exported name `_helper` starts with an underscore",
  ]);
});

test("ignores private stubs and comment text", () => {
  const src = [
    "declare class A {",
    "  private _events;",
    "  private readonly _now: () => number;",
    "  /**",
    "   * _start() anchors the clock",
    "   */",
    "  run(): void;",
    "}",
  ].join("\n");
  assert.deepEqual(messages(src), []);
});

test("skips mangled export aliases in bundler chunks", () => {
  const src = "export { Cell as _, tag as _t };";
  assert.deepEqual(messages(src), ["1:exported name `_` starts with an underscore", "1:exported name `_t` starts with an underscore"]);
  assert.deepEqual(scanDeclaration(src, "dist/model-Dqid4iXN.d.ts"), []);
});
