import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkErrors, collectThrown, extractMessages, loadWorkspace, parseDocMessages } from "./check-errors.mjs";

const W = "\u0001";
const messages = (src) => extractMessages("a.ts", src).map((m) => m.message ?? `dynamic:${m.dynamic}`);
const table = (...rows) => `## Common errors\n\n| Message | Fix |\n| --- | --- |\n${rows.map((r) => `| ${r} | fix |`).join("\n")}\n`;
const run = (files, docs) => checkErrors({ files, docs: { "docs/x.md": docs } });

test("extracts string, template and concatenated messages; ignores comments", () => {
  assert.deepEqual(
    messages(
      `// throw new Error("commented")\nthrow new Error("plain");\nthrow new RangeError(\`bad \${value}\`);\nthrow new TypeError("a " + b + " c");\nthrow new Error(ok ? "yes" : "no");`,
    ),
    ["plain", `bad ${W}value${W}`, `a ${W}${W} c`, "yes", "no"],
  );
});

test("resolves constants and arrow helpers; flags unresolvable arguments", () => {
  assert.deepEqual(messages(`const E = "from const";\nthrow new Error(E);`), ["from const"]);
  assert.deepEqual(messages('const M = (n: string) => `${n} is V2`;\nthrow new Error(M("x"));'), [`${W}n${W} is V2`]);
  assert.deepEqual(messages(`throw new Error(err.message);`), ["dynamic:err.message"]);
  assert.deepEqual(messages(`throw new Error();`), []);
});

test("reads messages passed to super() in Error subclasses, not custom constructors", () => {
  assert.deepEqual(messages(`class E extends Error { constructor(n) { super(\`\${n} broke\`); } }\nthrow new E("x");`), [`${W}n${W} broke`]);
});

test("unresolvable messages need an allowlist entry", () => {
  const { issues } = collectThrown({ "packages/a/src/a.ts": `throw new Error(err.message);` });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /unresolvable/);
});

test("exact rows, abbreviated rows and placeholders cover messages", () => {
  const files = {
    "packages/a/src/a.ts": [
      `throw new Error("Exact message.");`,
      `throw new Error("Long message that a row abbreviates after the start.");`,
      "throw new Error(`Failed to fetch ${url} (${status})`);",
    ].join("\n"),
  };
  assert.deepEqual(
    run(files, table("`Exact message.`", "`Long message that a row abbreviates…`", "`Failed to fetch <url> (<status>)`")).uncovered,
    [],
  );
});

test("an undocumented message is reported with file and line", () => {
  const { uncovered } = run({ "packages/a/src/a.ts": `\nthrow new Error("Nobody wrote this down.");` }, table("`Something else.`"));
  assert.deepEqual(uncovered, [{ file: "packages/a/src/a.ts", line: 2, message: "Nobody wrote this down." }]);
});

test("rows outside error tables do not count", () => {
  const docs = "| Name | Notes |\n| --- | --- |\n| `Nobody wrote this down.` | prose |\n";
  assert.equal(run({ "packages/a/src/a.ts": `throw new Error("Nobody wrote this down.");` }, docs).uncovered.length, 1);
});

test("a leading runtime part is not covered by an unrelated abbreviated row", () => {
  const files = { "packages/a/src/a.ts": "throw new RangeError(`${name} must be positive`);" };
  assert.equal(run(files, table("`Piano roll needs a model…`")).uncovered.length, 1);
});

test("plugin host messages expand to each widget that creates a host", () => {
  const files = {
    "packages/widgets/src/plugin-host.ts":
      "export function createPluginHost(name, f) { const title = name; throw new Error(`${title} is destroyed.`); throw new Error(`Plugin is already attached to this ${name}.`); }",
    "packages/widgets/src/grid.ts": `createPluginHost("step grid", f);`,
    "packages/widgets/src/roll.ts": `createPluginHost<Ctx>("piano roll", f);`,
  };
  const { messages: expanded } = collectThrown(files);
  assert.deepEqual(expanded.map((m) => m.message).sort(), [
    "Piano roll is destroyed.",
    "Plugin is already attached to this piano roll.",
    "Plugin is already attached to this step grid.",
    "Step grid is destroyed.",
  ]);
  const docs = table("`Step grid is destroyed.`", "`Plugin is already attached to this step grid.`", "`Piano roll is destroyed.`");
  assert.deepEqual(
    run(files, docs).uncovered.map((u) => u.message),
    ["Plugin is already attached to this piano roll."],
  );
});

test("a createPluginHost call with a non-literal name is reported", () => {
  const { issues } = collectThrown({
    "packages/widgets/src/plugin-host.ts": `export function createPluginHost(name, f) {}`,
    "packages/widgets/src/x.ts": `createPluginHost(label, f);`,
  });
  assert.equal(issues.length, 1);
});

test("doc parser takes abbreviations, placeholders and error prefixes", () => {
  const docs = parseDocMessages(table("`FooError: X's path is unknown…`", "`A <id> is bad.` / `Second one.`"));
  assert.deepEqual(docs, [
    { text: `${W}${W}'s path is unknown`, prefix: true },
    { text: `A ${W}${W} is bad.`, prefix: false },
    { text: "Second one.", prefix: false },
  ]);
});

test("repository at HEAD is clean", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { uncovered, issues } = checkErrors(loadWorkspace(root));
  assert.deepEqual([...issues, ...uncovered], []);
});
