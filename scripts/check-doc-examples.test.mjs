import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { check, dist, exampleBlocks, generate, markerProblems, exportIndex, PRELUDE } from "./check-doc-examples.mjs";

const md = (...blocks) => blocks.map(([info, code]) => `Text.\n\n\`\`\`${info}\n${code}\n\`\`\`\n`).join("\n");

test("extracts ts and js blocks with the line of their first code line, and ignores other languages", () => {
  const text = ["# T", "", "```ts", "const a = 1;", "```", "", "```json", "{}", "```", "", "```js", "let b;", "```"].join("\n");
  const blocks = exampleBlocks("x.md", text);
  assert.deepEqual(
    blocks.map((b) => [b.lang, b.line, b.fragment]),
    [
      ["ts", 4, false],
      ["js", 12, false],
    ],
  );
});

test("a fragment with a reason opts the block out", () => {
  const [a, b] = exampleBlocks("x.md", md(["ts fragment: partial class body", "foo();"], ["typescript", "bar();"]));
  assert.equal(a.fragment, true);
  assert.equal(a.reason, "partial class body");
  assert.deepEqual(markerProblems([a, b]), []);
  assert.equal(b.fragment, false);
});

/** A workspace with one package, `@audiorective/core`, whose declaration exports `add`. */
const temporary = [];
after(() => temporary.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function workspace() {
  const base = mkdtempSync(join(tmpdir(), "ar-doc-"));
  temporary.push(base);
  const dir = join(base, "packages", "core");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@audiorective/core", exports: { ".": "./dist/index.js", "./peaks": "./dist/peaks.js" } }),
  );
  writeFileSync(join(dir, "dist", "index.d.ts"), "export declare function add(a: number, b: number): number;");
  writeFileSync(join(dir, "dist", "peaks.d.ts"), "export declare const peak: number;");
  return base;
}

const run = (base, text) => {
  const blocks = exampleBlocks("doc.md", text).filter((b) => !b.fragment);
  const out = join(base, "out");
  const gen = generate(blocks, out, base, "declare const placeholder: number;");
  return check(gen.tsconfig, gen.files);
};

test("maps every package entry to its declaration", () => {
  const paths = dist(workspace());
  assert.deepEqual(Object.keys(paths).sort(), ["@audiorective/core", "@audiorective/core/peaks"]);
});

test("a correct block passes, with the shared prelude and a module-less block both accepted", () => {
  const problems = run(
    workspace(),
    md(["ts", 'import { add } from "@audiorective/core";\nadd(placeholder, 2);'], ["ts", "const x: number = placeholder;"]),
  );
  assert.deepEqual(problems, []);
});

test("a wrong call fails with the doc file and the markdown line of the error", () => {
  const problems = run(workspace(), md(["ts", "const ok = 1;"], ["ts", 'import { add } from "@audiorective/core";\nconst ok = 1;\nadd("a", 2);']));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, "doc.md");
  assert.equal(problems[0].line, 12);
});

test("a missing export and a missing entry both fail", () => {
  const problems = run(workspace(), md(["ts", 'import { sub } from "@audiorective/core";\nsub;'], ["ts", 'import "@audiorective/core/missing";']));
  assert.equal(problems.length, 2);
});

test("a fragment is not type-checked", () => {
  assert.deepEqual(run(workspace(), md(["ts fragment: intentional invalid call", "add(1, 2, 3)"])), []);
});

test("bare and empty fragment markers fail at the fence line", () => {
  for (const info of ["ts fragment", "ts fragment:", "ts fragment:   "]) {
    const problems = markerProblems(exampleBlocks("bad.md", md([info, "not valid code"])));
    assert.equal(problems.length, 1);
    assert.equal(problems[0].line, 3);
    assert.match(problems[0].message, /requires a reason/);
  }
  assert.equal(exampleBlocks("x.md", md(["ts not-a-fragment", "foo();"]))[0].fragment, false);
});

test("imports missing public names and still rejects wrong arguments", () => {
  const base = workspace();
  assert.deepEqual(run(base, md(["ts", "add(1, 2); peak.toFixed();"])), []);
  const [problem] = run(base, md(["ts", 'add("wrong", 2);']));
  assert.equal(problem.code, 2345);
  assert.equal(problem.line, 4); // auto-import lines never leak into Markdown coordinates
});

test("follows export-star barrels and aliases into the export index", () => {
  const base = workspace();
  const dir = join(base, "packages/core/dist");
  writeFileSync(join(dir, "internal.d.ts"), "export declare const original: number;");
  writeFileSync(join(dir, "peaks.d.ts"), 'export { original as renamed } from "./internal.js";');
  writeFileSync(join(dir, "index.d.ts"), 'export * from "./peaks.js";');
  assert.deepEqual(exportIndex(dist(base)).get("renamed"), ["@audiorective/core", "@audiorective/core/peaks"]);
  assert.deepEqual(run(base, md(["ts", "renamed.toFixed();"])), []);
});

test("prefers a page's named import, then its entry, then the root", () => {
  const base = workspace();
  writeFileSync(
    join(base, "packages/core/dist/peaks.d.ts"),
    "export declare const peak: number; export declare function add(a: string, b: string): string;",
  );
  assert.deepEqual(run(base, md(["ts", "add(1, 2);"])), []);
  assert.deepEqual(
    run(base, md(["ts fragment: import context only", 'import { peak } from "@audiorective/core/peaks";'], ["ts", 'add("a", "b");'])),
    [],
  );
  assert.deepEqual(
    run(
      base,
      md(
        ["ts fragment: import context only", 'import { peak } from "@audiorective/core/peaks";'],
        ["ts fragment: import context only", 'import { add } from "@audiorective/core";'],
        ["ts", "add(1, 2);"],
      ),
    ),
    [],
  );
});

test("does not import a block's own declarations or property names", () => {
  const base = workspace();
  const blocks = exampleBlocks(
    "local.md",
    md([
      "ts",
      `
const { add } = { add: (value: string) => value };
add("local");
function nested(peak: number) { return peak; }
const obj = { peak: 1 };
obj.peak;
interface OnlyHere { add: string }
`,
    ]),
  );
  const gen = generate(blocks, join(base, "out"), base, "");
  assert.deepEqual(check(gen.tsconfig, gen.files), []);
  assert.doesNotMatch(readFileSync([...gen.files.keys()][0], "utf8"), /import/);
  assert.equal(run(base, md(["ts", "type add = number; add(1, 2);"]))[0].code, 2693);
});

test("keeps blocks isolated, and only imports unresolved uses outside nested scopes", () => {
  const base = workspace();
  const problems = run(
    base,
    md(["ts", "const privateName = 1;"], ["ts", "privateName;"], ["ts", "function f(add: string) { return add; } add(1, 2);"]),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /privateName/);
});

test("checks JavaScript with typed placeholders and inferred imports", () => {
  const base = workspace();
  assert.deepEqual(run(base, md(["js", "add(placeholder, 2);"])), []);
  const problems = run(base, md(["js", 'add("bad", 2);']));
  assert.equal(problems[0].code, 2345);
  assert.equal(problems[0].line, 4);
});

test("explicit prelude selection shadows browser globals without replacing locals", () => {
  const base = workspace();
  const blocks = exampleBlocks(
    "choice.md",
    md(["ts prelude=name", "name.toFixed();"], ["ts prelude=name", 'const name = "local"; name.toUpperCase();']),
  );
  const gen = generate(blocks, join(base, "out"), base, "declare const name: number;");
  assert.deepEqual(check(gen.tsconfig, gen.files), []);
  assert.throws(() => generate(exampleBlocks("x.md", md(["ts prelude=typo", "typo;"])), join(base, "bad"), base, ""), /unknown prelude selection/);
});

test("all shared placeholders use valid, real declaration types", () => {
  const base = workspace();
  const names = [...PRELUDE.matchAll(/declare const (\w+)/g)].map((m) => m[1]);
  const blocks = exampleBlocks("prelude.md", md([`ts prelude=${names.join(",")}`, names.join(";\n")]));
  // Use the repository's real dist entries, rather than the synthetic package.
  const gen = generate(blocks, join(base, "out"));
  assert.deepEqual(check(gen.tsconfig, gen.files), []);
});

test("an explicit type disambiguates the clip placeholder", () => {
  const base = workspace();
  const blocks = exampleBlocks(
    "choice.md",
    md(
      ["ts prelude=clip:LauncherClip", "clip.configure({ loop: true });"],
      ["ts prelude=clip:MidiClip", "clip.edit((notes) => { notes[0].velocity = 0.5; });"],
    ),
  );
  const gen = generate(blocks, join(base, "out"));
  assert.deepEqual(check(gen.tsconfig, gen.files), []);
});

test("missing dist entries fail with an actionable build instruction", () => {
  const base = workspace();
  rmSync(join(base, "packages/core/dist/peaks.d.ts"));
  assert.throws(() => dist(base), /pnpm build.*@audiorective\/core\/peaks/);
});
