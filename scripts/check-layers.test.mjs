import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLayers, loadWorkspace, parseImports } from "./check-layers.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dep = (...names) => ({ dependencies: Object.fromEntries(names.map((n) => [`@audiorective/${n}`, "workspace:^"])) });

/** Manifests that declare exactly what the clean fixture imports. */
const manifests = {
  core: {},
  clock: dep("core"),
  player: dep("core"),
  sequencer: dep("core"),
  widgets: dep("core", "midi", "player"),
  daw: dep("core", "midi", "effects", "player"),
};

const clean = {
  "packages/core/src/index.ts": `export const x = 1;`,
  "packages/clock/src/index.ts": `import { x } from "@audiorective/core";`,
  "packages/player/src/WavePlayer.ts": `import "@audiorective/core"; import { s } from "./source";`,
  "packages/player/src/source.ts": `export const s = 1;`,
  "packages/sequencer/src/StepSequencer.ts": `import "@audiorective/core"; import "./notation";`,
  "packages/sequencer/src/notation.ts": `export const n = 1;`,
  "packages/widgets/src/a.ts": `import type { P } from "@audiorective/player";\nimport "@audiorective/core"; import "@audiorective/midi";`,
  "packages/daw/src/project.ts": `import "./model"; import "@audiorective/core"; import "@audiorective/midi";`,
  "packages/daw/src/model.ts": `import "@audiorective/effects/equalizer-bands";`,
  "packages/daw/src/dawproject.ts": `import "./project"; import "fflate";`,
  "packages/daw/src/runtime.ts": `import "./project"; import "@audiorective/player";`,
  "packages/daw/src/compose.ts": `import "./runtime"; import "./dawproject";`,
  "packages/daw/src/index.ts": `export * from "./compose";`,
};

const run = (overrides, m = manifests) => checkLayers({ files: { ...clean, ...overrides }, manifests: m });
const rules = (vs) => vs.map((x) => x.rule);

test("clean fixture passes", () => {
  assert.deepEqual(run({}), []);
});

test("parser handles multi-line, type-only, export-from and dynamic imports", () => {
  const imps = parseImports(
    `// import "nope"\nimport {\n a,\n b\n} from "x";\nimport type { T } from "y";\nimport { type U } from "z";\nexport * from "w";\nconst m = await import("v");`,
  );
  assert.deepEqual(
    imps.map((i) => [i.specifier, i.line, i.typeOnly]),
    [
      ["x", 2, false],
      ["y", 6, true],
      ["z", 7, true],
      ["w", 8, false],
      ["v", 9, false],
    ],
  );
});

const cases = [
  ["1 core imports a package", { "packages/core/src/index.ts": `import "@audiorective/clock";` }, /core imports no/],
  ["2 clock imports effects", { "packages/clock/src/index.ts": `import "@audiorective/effects";` }, /clock may import only/],
  [
    "3 capability imports another package",
    { "packages/sequencer/src/StepSequencer.ts": `import "@audiorective/player";` },
    /sequencer may import only/,
  ],
  [
    "3 capability helper imports the entry",
    { "packages/player/src/source.ts": `import "./WavePlayer";` },
    /helpers must not import the package entry/,
  ],
  ["3 capability unlisted helper", { "packages/sequencer/src/StepSequencer.ts": `import "./source";` }, /allowlisted private helpers/],
  ["3 capability unclassified file", { "packages/sequencer/src/Extra.ts": `` }, /unclassified sequencer file/],
  ["4 widgets value import from player", { "packages/widgets/src/a.ts": `import { P } from "@audiorective/player";` }, /import type/],
  ["4 widgets imports daw", { "packages/widgets/src/a.ts": `import type { P } from "@audiorective/daw";` }, /never import @audiorective\/daw/],
  ["5 project imports runtime", { "packages/daw/src/project.ts": `import "./runtime";` }, /only other project files/],
  ["5 project imports effects root", { "packages/daw/src/project.ts": `import "@audiorective/effects";` }, /project files may import only/],
  ["5 codec imports runtime", { "packages/daw/src/dawproject.ts": `import "./runtime";` }, /codec files may import only/],
  ["5 runtime imports codec", { "packages/daw/src/runtime.ts": `import "./dawproject";` }, /must not import the DAWproject codec/],
  ["5 daw imports widgets", { "packages/daw/src/runtime.ts": `import "@audiorective/widgets";` }, /never imports @audiorective\/widgets/],
  ["5 mcp imports codec", { "packages/daw/src/mcp.ts": `import "./dawproject";` }, /mcp files must not import the DAWproject codec/],
  ["5 mcp imports midi", { "packages/daw/src/mcp.ts": `import "@audiorective/midi";` }, /mcp files may import only/],
  ["5 mcp imports audiorective", { "packages/mcp/src/index.ts": `import "@audiorective/core";` }, /mcp imports no @audiorective/],
  ["5 unclassified daw file", { "packages/daw/src/new-thing.ts": `` }, /unclassified daw file/],
];
for (const [name, files, re] of cases) {
  test(`rule ${name}`, () => {
    const vs = run(files);
    assert.ok(
      rules(vs).some((r) => re.test(r)),
      `expected ${re}, got ${JSON.stringify(vs)}`,
    );
  });
}

test("rule 6 undeclared and unused dependencies", () => {
  const undeclared = run({}, { ...manifests, clock: {} });
  assert.ok(rules(undeclared).some((r) => /missing from dependencies/.test(r)));
  const unused = run({}, { ...manifests, clock: dep("core", "effects") });
  assert.ok(rules(unused).some((r) => /never imported/.test(r)));
});

test("repository at HEAD is clean", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkLayers(loadWorkspace(root)), []);
});
