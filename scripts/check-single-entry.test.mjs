import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicateExports, isAllowed } from "./check-single-entry.mjs";
import { fixturePackage } from "./lib/fixture.mjs";

const pkg = (files) => fixturePackage({ ".": "index.d.ts", "./web": "web.d.ts" }, files);

test("reports a name exported by two entries, with both entries", () => {
  const dir = pkg({
    "index.d.ts": "export declare class Take {}\nexport declare function only(): void;\n",
    "web.d.ts": 'export { Take } from "./index";\nexport declare function webOnly(): void;\n',
  });
  assert.deepEqual(duplicateExports(dir), [{ name: "Take", entries: [".", "./web"] }]);
});

test("follows re-exports through a shared chunk and `export *`", () => {
  const dir = pkg({
    "chunk.d.ts": "export declare const shared: number;\n",
    "index.d.ts": 'export * from "./chunk";\n',
    "web.d.ts": 'export { shared } from "./chunk";\n',
  });
  assert.deepEqual(
    duplicateExports(dir).map((d) => d.name),
    ["shared"],
  );
});

test("a name that is unique to each entry is clean", () => {
  const dir = pkg({ "index.d.ts": "export declare const a: number;\n", "web.d.ts": "export declare const b: number;\n" });
  assert.deepEqual(duplicateExports(dir), []);
});

test("allow-list entries match by name or by re-exporting entry, per package", () => {
  const dup = { name: "Take", entries: [".", "./web"] };
  assert.ok(isAllowed("midi", dup, [{ package: "midi", name: "Take", reason: "r" }]));
  assert.ok(isAllowed("midi", dup, [{ package: "midi", from: ".", reason: "r" }]));
  assert.ok(!isAllowed("core", dup, [{ package: "midi", name: "Take", reason: "r" }]));
  assert.ok(!isAllowed("midi", dup, [{ package: "midi", from: "./other", reason: "r" }]));
});
