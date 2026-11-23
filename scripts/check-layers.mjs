#!/usr/bin/env node
// Architecture check: fails when a package's source breaks the layering rules
// documented in AGENTS.md. Pure Node, no dependencies.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@audiorective/";

// ---------------------------------------------------------------- rule data

/**
 * The headless capability packages: each imports only `@audiorective/core*`. `entry` is the module its root export
 * builds from; `helpers` maps a module to the relative targets it may import (`dir/*` = whole dir). Anything else
 * under `src/` is unclassified.
 */
const CAPABILITIES = {
  player: { entry: "WavePlayer.ts", helpers: { "WavePlayer.ts": ["source.ts"] }, private: ["source.ts"] },
  recorder: {
    entry: "AudioRecorder.ts",
    helpers: { "AudioRecorder.ts": ["recording/*", "MicrophoneInput.ts", "placement.ts"] },
    private: ["recording/*", "MicrophoneInput.ts", "placement.ts"],
  },
  samples: { entry: "SampleLibrary.ts", helpers: {}, private: [] },
  pads: { entry: "PadBank.ts", helpers: {}, private: [] },
  sequencer: {
    entry: "StepSequencer.ts",
    helpers: { "StepSequencer.ts": ["notation.ts", "sounds.ts"], "sounds.ts": ["notation.ts"] },
    private: ["notation.ts", "sounds.ts"],
  },
  launcher: { entry: "ClipLauncher.ts", helpers: { "ClipLauncher.ts": ["types.ts"] }, private: ["types.ts"] },
};

/** Packages that may import `@audiorective/core*` and nothing else of ours. */
const CORE_ONLY = ["clock", "midi", "host", "effects", "devtools", "react", "threejs", "playcanvas", ...Object.keys(CAPABILITIES)];

const DAW_PROJECT = [
  "project.ts",
  "model.ts",
  "rack-preset.ts",
  "media.ts",
  "clip-time-map.ts",
  "tempo-map.ts",
  "clip-envelope.ts",
  "project-persistence.ts",
  "project-edits.ts",
  "selection.ts",
];
const DAW_CODEC = ["dawproject.ts"];
const DAW_INTERNAL = ["internal/*"];
const DAW_RUNTIME = [
  "runtime.ts",
  "runtime-entry.ts",
  "audio-fallback.ts",
  "mix-range.ts",
  "opfs-media.ts",
  "audio-track-session.ts",
  "mixer-routing.ts",
  "schedule-clip-envelope.ts",
  "track-runtime.ts",
  "clip-scheduler.ts",
  "mixer.ts",
  "audition.ts",
  "clip-stretch.ts",
  "take-placement.ts",
  "track-reconcile.ts",
  "track-rack.ts",
  "rack-macro.ts",
  "project-lookup.ts",
];
const DAW_ROOT = ["index.ts", "compose.ts"];

const PROJECT_EXTERNAL = ["@audiorective/core", "@audiorective/midi", "@audiorective/effects/equalizer-bands"];
const CODEC_EXTERNAL = [...PROJECT_EXTERNAL, "fflate", "@xmldom/xmldom"];

// ---------------------------------------------------------------- parsing

/** Blank out comments, keeping newlines so line numbers survive. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, (m) => " ".repeat(m.length));
}

const STATIC_RE = /\b(import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+|\*)\s*from\s*)?(["'])([^"'\n]+)\4/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/** @returns {{specifier: string, line: number, typeOnly: boolean}[]} */
export function parseImports(source) {
  const src = stripComments(source);
  const out = [];
  const lineAt = (idx) => src.slice(0, idx).split("\n").length;
  for (const m of src.matchAll(STATIC_RE)) {
    const clause = m[3] ?? "";
    const braces = clause.match(/\{([^}]*)\}/);
    const items = braces
      ? braces[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const allInlineType = items.length > 0 && !/^[\w$]+\s*,/.test(clause) && items.every((s) => /^type\s/.test(s));
    out.push({ specifier: m[5], line: lineAt(m.index), typeOnly: Boolean(m[2]) || allInlineType });
  }
  for (const m of src.matchAll(DYNAMIC_RE)) {
    out.push({ specifier: m[2], line: lineAt(m.index), typeOnly: false });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------- helpers

const isRelative = (s) => s.startsWith("./") || s.startsWith("../");
const isScoped = (s) => s.startsWith(SCOPE);
const pkgOf = (s) => s.slice(SCOPE.length).split("/")[0];
/** `@audiorective/core/peaks` is within `@audiorective/core`. */
const within = (spec, base) => spec === base || spec.startsWith(base + "/");
const matchesAny = (spec, list) => list.some((b) => within(spec, b));
const stripExt = (p) => p.replace(/\.(d\.)?(tsx?|jsx?|mjs|cjs)$/, "");

/** Does a src-relative path match a pattern (`a/b.ts` exact, `dir/*` whole dir)? */
function matchPattern(path, pattern) {
  if (pattern.endsWith("/*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}
const inGroup = (path, group) => group.some((p) => matchPattern(path, p));

/** Resolve a relative specifier to a src-relative file path (with extension), or null if unresolvable. */
function resolveRelative(fromRel, spec, srcFiles) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  const stem = stripExt(base);
  for (const cand of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
    if (srcFiles.has(cand)) return cand;
  }
  return null;
}

// ---------------------------------------------------------------- core check

/**
 * @param {{ files: Record<string, string>, manifests: Record<string, { dependencies?: Record<string,string>, peerDependencies?: Record<string,string> }> }} input
 *   files: `packages/<pkg>/src/<path>` -> source text. manifests: `<pkg>` -> package.json contents.
 * @returns {{ file: string, line: number, specifier: string, rule: string }[]}
 */
export function checkLayers({ files, manifests }) {
  const violations = [];
  const used = {}; // pkg -> Set of scoped package names imported
  const byPkg = {};
  for (const [file, content] of Object.entries(files)) {
    const m = file.match(/^packages\/([^/]+)\/src\/(.+)$/);
    if (!m) continue;
    (byPkg[m[1]] ??= new Map()).set(m[2], { file, content });
  }

  for (const [pkg, srcMap] of Object.entries(byPkg)) {
    const srcFiles = new Set(srcMap.keys());
    used[pkg] = new Set();
    for (const [rel, { file, content }] of srcMap) {
      const v = (imp, rule) => violations.push({ file, line: imp.line, specifier: imp.specifier, rule });
      for (const imp of parseImports(content)) {
        const spec = imp.specifier;
        if (isScoped(spec) && pkgOf(spec) !== pkg) used[pkg].add(SCOPE + pkgOf(spec));
        const target = isRelative(spec) ? resolveRelative(rel, spec, srcFiles) : null;

        if (pkg === "core") {
          if (isScoped(spec)) v(imp, "core imports no @audiorective/* package");
        } else if (CORE_ONLY.includes(pkg)) {
          if (isScoped(spec) && pkgOf(spec) !== pkg && !within(spec, "@audiorective/core")) v(imp, `${pkg} may import only @audiorective/core*`);
          if (CAPABILITIES[pkg]) checkCapabilityRelative(pkg, rel, imp, target, v);
        } else if (pkg === "widgets") {
          checkWidgets(imp, v);
        } else if (pkg === "daw") {
          checkDaw(rel, imp, target, v);
        }
      }
      if (CAPABILITIES[pkg] && rel !== CAPABILITIES[pkg].entry && !inGroup(rel, CAPABILITIES[pkg].private)) {
        violations.push({
          file,
          line: 1,
          specifier: "",
          rule: `unclassified ${pkg} file: add it to its entry or private helpers in CAPABILITIES in scripts/check-layers.mjs`,
        });
      }
      if (pkg === "daw" && !dawGroup(rel)) {
        violations.push({
          file,
          line: 1,
          specifier: "",
          rule: "unclassified daw file: place it in a group in scripts/check-layers.mjs",
        });
      }
    }
  }

  // Rule 6: declared vs used @audiorective/* dependencies.
  for (const [pkg, usedSet] of Object.entries(used)) {
    const manifest = manifests[pkg];
    if (!manifest) continue;
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})].filter(isScoped));
    const manifestFile = `packages/${pkg}/package.json`;
    for (const name of [...usedSet].sort()) {
      if (!declared.has(name))
        violations.push({
          file: manifestFile,
          line: 1,
          specifier: name,
          rule: "imported by src but missing from dependencies/peerDependencies",
        });
    }
    for (const name of [...declared].sort()) {
      if (!usedSet.has(name))
        violations.push({
          file: manifestFile,
          line: 1,
          specifier: name,
          rule: "declared in dependencies/peerDependencies but never imported by src",
        });
    }
  }
  return violations;
}

function checkCapabilityRelative(pkg, rel, imp, target, v) {
  const spec = imp.specifier;
  if (!isRelative(spec)) return;
  const { entry, helpers, private: priv } = CAPABILITIES[pkg];
  const resolved = target ?? posix.normalize(posix.join(posix.dirname(rel), spec));
  // Helpers may import siblings within their own directory group (e.g. recording/*).
  const sameDirHelper = inGroup(rel, priv) && rel.includes("/") && resolved.startsWith(posix.dirname(rel) + "/");
  if (sameDirHelper || inGroup(resolved, helpers[rel] ?? [])) return;
  v(
    imp,
    resolved === entry || stripExt(resolved) === stripExt(entry)
      ? `${pkg} helpers must not import the package entry`
      : `${pkg} relative imports are limited to the module's allowlisted private helpers`,
  );
}

function checkWidgets(imp, v) {
  const spec = imp.specifier;
  if (!isScoped(spec)) return;
  if (within(spec, "@audiorective/core") || within(spec, "@audiorective/midi")) return;
  if (within(spec, "@audiorective/player")) {
    if (spec !== "@audiorective/player") v(imp, "widgets may import only @audiorective/player (type-only)");
    else if (!imp.typeOnly) v(imp, "widgets must import @audiorective/player as `import type`");
    return;
  }
  if (within(spec, "@audiorective/daw")) v(imp, "widgets never import @audiorective/daw");
  else v(imp, "widgets may import only core*, midi and type-only @audiorective/player");
}

function dawGroup(rel) {
  if (inGroup(rel, DAW_PROJECT)) return "project";
  if (inGroup(rel, DAW_CODEC)) return "codec";
  if (inGroup(rel, DAW_INTERNAL)) return "internal";
  if (inGroup(rel, DAW_RUNTIME)) return "runtime";
  if (inGroup(rel, DAW_ROOT)) return "root";
  return null;
}

function checkDaw(rel, imp, target, v) {
  const spec = imp.specifier;
  const group = dawGroup(rel);
  if (!group) return;
  if (isScoped(spec) && within(spec, "@audiorective/widgets")) {
    v(imp, "daw never imports @audiorective/widgets");
    return;
  }
  const targetGroup = target ? dawGroup(target) : null;
  if (isRelative(spec) && !target) {
    v(imp, "unresolvable relative import");
    return;
  }
  switch (group) {
    case "project":
      if (isRelative(spec)) {
        if (targetGroup !== "project") v(imp, "daw project files may import only other project files");
      } else if (!matchesAny(spec, PROJECT_EXTERNAL)) {
        v(imp, "daw project files may import only core*, midi, effects/equalizer-bands and each other");
      }
      break;
    case "codec":
    case "internal":
      if (isRelative(spec)) {
        const ok = targetGroup === "project" || targetGroup === "internal";
        if (!ok) v(imp, `daw ${group} files may import only project files and internal/*`);
      } else if (!matchesAny(spec, CODEC_EXTERNAL)) {
        v(imp, `daw ${group} files may import only core*, midi, effects/equalizer-bands, fflate and @xmldom/xmldom`);
      }
      break;
    case "runtime":
      if (isRelative(spec) && targetGroup === "codec") v(imp, "daw runtime files must not import the DAWproject codec");
      if (isRelative(spec) && targetGroup === "root") v(imp, "daw runtime files must not import the root composition");
      if (isScoped(spec) && within(spec, "@audiorective/daw")) v(imp, "daw runtime files must not import the daw package entries");
      break;
    case "root":
      break;
  }
}

// ---------------------------------------------------------------- filesystem

const SKIP_DIRS = new Set(["node_modules", "dist", "tests", "__tests__"]);
const SRC_FILE = /\.(ts|tsx|js)$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (SRC_FILE.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
  return out;
}

export function loadWorkspace(root) {
  const files = {};
  const manifests = {};
  const pkgsDir = join(root, "packages");
  for (const pkg of readdirSync(pkgsDir)) {
    const pkgDir = join(pkgsDir, pkg);
    if (!statSync(pkgDir).isDirectory()) continue;
    const manifestPath = join(pkgDir, "package.json");
    if (existsSync(manifestPath)) manifests[pkg] = JSON.parse(readFileSync(manifestPath, "utf8"));
    const src = join(pkgDir, "src");
    if (!existsSync(src)) continue;
    for (const f of walk(src)) files[relative(root, f).split("\\").join("/")] = readFileSync(f, "utf8");
  }
  return { files, manifests };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = checkLayers(loadWorkspace(root));
  if (violations.length === 0) {
    console.log("check-layers: ok");
    return;
  }
  for (const x of violations) console.error(`${x.file}:${x.line}  ${x.specifier}  — ${x.rule}`);
  console.error(`\ncheck-layers: ${violations.length} violation(s)`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
