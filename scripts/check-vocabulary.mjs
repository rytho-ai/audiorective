// Rule A4: one name and one unit per concept across the in-scope packages (docs/vocabulary.md).
// Scans the shipped declarations for forms the vocabulary disallows: parameter, property, method and exported names, plus
// the JSDoc of members whose unit is easy to get wrong (`time`, `velocity`).
//
// Exceptions are listed in scripts/check-vocabulary.exceptions.json (one reason each). A violation that is not excepted fails the check, in any package.
//
// Requires built output: run `pnpm build` first.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { IN_SCOPE, loadPackage, position, root, ts } from "./lib/entries.mjs";
import { matchKey } from "./check-jsdoc.mjs";

const here = join(root, "scripts");

/** Words in a doc that state a unit for a time value. */
const UNIT_WORDS =
  /\b(seconds?|secs?|beats?|ms|milliseconds?|samples?|frames?|bars?|ticks?|steps?|audio[- ]?clock|AudioContext|currentTime|quarter)\b/i;

/** A velocity range written the MIDI way (0-127, 0..127, 0 to 127); "velocity / 127" explaining the conversion is fine. */
const VELOCITY_127 = /velocity[^.;]{0,40}\b0\s*(?:-|–|\.\.|to)\s*127\b|\b0\s*(?:-|–|\.\.|to)\s*127\b[^.;]{0,20}velocity/i;

/**
 * Name rules: `test(name)` is true for a disallowed name; `use` is what to write instead.
 * Names are checked as written in the declaration (parameters, properties, methods, exported declarations).
 */
export const NAME_RULES = [
  { id: "teardown", test: (n) => /^(destroy|teardown|tearDown|unmount|deinit|cleanup|free)$/.test(n), use: "`dispose()`" },
  { id: "unsubscribe", test: (n) => /^(unsubscribe|off)$/.test(n), use: "the cleanup function that `subscribe`, `attach` and `on…` return" },
  {
    id: "seconds-suffix",
    test: (n) => /(Secs?|InSeconds|Sec[A-Z]|Seconds?[A-Z]|InSec)$/.test(n) && !/Seconds$/.test(n),
    use: "the `Seconds` suffix (`tailSeconds`)",
  },
  { id: "millis", test: (n) => /(Millis|Msec|Milliseconds)$/.test(n), use: "`Ms` for wall-clock timers only, otherwise `Seconds`" },
  { id: "tail", test: (n) => /^tail($|Ms$|Sec|Time$|Beats$)/.test(n) && n !== "tailSeconds", use: "`tailSeconds`" },
  { id: "preroll", test: (n) => /^pre[Rr]oll($|Ms$|Sec|Time$|Beats$)/.test(n) && n !== "prerollSeconds", use: "`prerollSeconds`" },
  { id: "lookahead", test: (n) => /^lookahead(Ms|Sec|Seconds|Time)?$/.test(n), use: "`lookAhead` (a clock's look-ahead window, in seconds)" },
  { id: "db-case", test: (n) => /(DB|Decibels?|dB)$/.test(n) || /^dB/.test(n), use: "the `Db` suffix (`gainDb`, `peakDbFS`)" },
  {
    id: "volume-forms",
    test: (n) => /^(vol|amp|amplitude|gainLinear|volumeDb|volumeDB)$/.test(n),
    use: "`gain` (linear) or `gainDb`; `volume` is a 0..1 user control",
  },
  { id: "velocity-forms", test: (n) => /^(vel|velocity127|midiVelocity|velocityMidi)$/.test(n), use: "`velocity` (0..1)" },
  { id: "pan-forms", test: (n) => /^(panning|panValue|balance)$/.test(n), use: "`pan` (-1..1)" },
  { id: "pitch-forms", test: (n) => /^(midiNote|midiPitch|pitchNumber|noteNumber)$/.test(n) && false, use: "`pitch` (MIDI note number)" },
  { id: "sample-rate", test: (n) => /^(samplerate|sr|fs|sampleRateHz|sample_rate)$/.test(n), use: "`sampleRate`" },
  { id: "channel-count", test: (n) => /^(numChannels|nChannels|channelsCount|numberOfChannels)$/.test(n), use: "`channelCount`" },
  { id: "frame-count", test: (n) => /^(numFrames|nFrames|framesCount|numberOfFrames)$/.test(n), use: "`frameCount`" },
  { id: "tempo-forms", test: (n) => /^(tempoBpm|beatsPerMinute|BPM|bpmValue)$/.test(n), use: "`bpm`" },
  {
    id: "range-forms",
    test: (n) => /^(begin|beginBeat|beginTime|stopBeat|stopTime|stopAt|endAt|startAt)$/.test(n),
    use: "`start`/`end`, `startBeat`/`endBeat`, `startSeconds`/`endSeconds`",
  },
  {
    id: "length-forms",
    test: (n) => /^(len|lengthSeconds|lengthMs|lengthSec|lengthTime)$/.test(n),
    use: "`duration…` for seconds (`durationSeconds`); `length` is a beat or frame extent",
  },
  { id: "bar-number", test: (n) => /^(barNumber|beatNumber|stepNumber)$/.test(n), use: "a zero-based `bar`, `beat` or `index`" },
];

/** Names that may take a `Ms` suffix: wall-clock timers, never audio quantities. Other `…Ms` names are flagged. */
const MS_OK = /^(intervalMs|timeoutMs|waitMs|reconnectMs|maxReconnectMs|debounceMs|delayMs)$/;

/** Text of the JSDoc attached to a node (comment text plus tag text), or "" when it has none. */
function docText(node) {
  return ts
    .getJSDocCommentsAndTags(node)
    .map((d) =>
      ts.isJSDoc(d)
        ? ts.getTextOfJSDocComment(d.comment) +
          " " +
          (d.tags ?? []).map((t) => `${t.tagName.text} ${ts.getTextOfJSDocComment(t.comment) ?? ""}`).join(" ")
        : "",
    )
    .join(" ");
}

/** Docs of a node and of every enclosing declaration up to the top level: a nested `time` inherits the unit its owner states. */
function docChain(node) {
  const parts = [];
  for (let n = node; n && !ts.isSourceFile(n); n = n.parent) parts.push(docText(n));
  return parts.join(" ");
}

/** Doc that states what a parameter means: its own `@param` text and the docs of the enclosing declarations. */
function paramDoc(param) {
  const own = ts
    .getJSDocParameterTags(param)
    .map((t) => ts.getTextOfJSDocComment(t.comment) ?? "")
    .join(" ");
  return `${own} ${docChain(param.parent)}`;
}

/** True for a numeric member or parameter: a `string`-typed `offset` (a label) carries no unit. */
function isNumeric(node) {
  const text = node.type?.getText() ?? "";
  return /\bnumber\b/.test(text) && !/\bstring\b/.test(text);
}

/** Violations of one package: `[{ key, rule, message, file, line }]`. */
export function scanPackage(pkgDir, pkgName) {
  const { exports } = loadPackage(pkgDir);
  const out = [];
  const done = new Set();
  const report = (path, rule, message, node) => out.push({ key: `${pkgName}/${path}#${rule}`, rule, message, ...position(node) });

  const checkName = (path, name, node) => {
    for (const rule of NAME_RULES) if (rule.test(name)) report(path, rule.id, `\`${name}\` is not allowed; use ${rule.use}`, node);
    if (/Ms$/.test(name) && !MS_OK.test(name))
      report(
        path,
        "ms-unit",
        `\`${name}\`: audio quantities use seconds; \`Ms\` is for wall-clock timers (${MS_OK.source.slice(2, -3).replaceAll("|", ", ")})`,
        node,
      );
  };

  const visit = (node, path) => {
    if (done.has(node)) return;
    done.add(node);
    let here = path;
    if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      here = node.name.text;
      checkName(here, here, node.name);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      here = node.name.text;
      checkName(here, here, node.name);
    } else if (
      (ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessor(node)) &&
      node.name &&
      !ts.isPrivateIdentifier(node.name) &&
      !(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword))
    ) {
      const name = ts.isComputedPropertyName(node.name) ? undefined : node.name.getText();
      if (name === undefined) return;
      here = `${path}.${name}`;
      checkName(here, name, node.name);
      const doc = docChain(node);
      if (/^(time|offset|duration|position|length)$/.test(name) && !isFunctionLike(node) && isNumeric(node) && !UNIT_WORDS.test(doc))
        report(here, "unit-doc", `\`${name}\` has no unit in its JSDoc (seconds, beats, ms, frames…)`, node.name);
      if (name === "velocity" && VELOCITY_127.test(doc))
        report(here, "velocity-range", "`velocity` is 0..1 everywhere; the JSDoc mentions 127", node.name);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      here = `${path}(${name})`;
      checkName(here, name, node.name);
      if (/^(time|offset|duration|position|length)$/.test(name) && isNumeric(node) && !UNIT_WORDS.test(paramDoc(node)))
        report(here, "unit-doc", `parameter \`${name}\` has no unit in its JSDoc (seconds, beats, ms, frames…)`, node.name);
      if (name === "velocity" && VELOCITY_127.test(paramDoc(node)))
        report(here, "velocity-range", "`velocity` is 0..1 everywhere; the JSDoc mentions 127", node.name);
    }
    ts.forEachChild(node, (c) => visit(c, here));
  };
  for (const { symbol } of exports)
    for (const d of symbol.declarations ?? []) {
      if (d.getSourceFile().fileName.includes("/node_modules/")) continue;
      visit(d, "");
    }
  return out;
}

function isFunctionLike(node) {
  return ts.isMethodSignature(node) || ts.isMethodDeclaration(node);
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

/** Split violations into failing and excepted; also report exceptions that match nothing. */
export function classify(violations, exceptions) {
  const failing = [];
  const excepted = [];
  const usedEx = new Set();
  for (const v of violations) {
    const ex = exceptions.findIndex((e) => matchKey(e.pattern, v.key));
    if (ex >= 0) {
      usedEx.add(ex);
      excepted.push(v);
    } else failing.push(v);
  }
  return { failing, excepted, unusedExceptions: exceptions.filter((_, i) => !usedEx.has(i)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = [];
  let built = 0;
  for (const pkg of IN_SCOPE) {
    const dir = join(root, "packages", pkg);
    if (!existsSync(join(dir, "dist"))) continue;
    built++;
    all.push(...scanPackage(dir, pkg));
  }
  if (built === 0) {
    console.error("check:vocabulary: no built declarations found. Run `pnpm build` first.");
    process.exit(1);
  }
  const exceptions = readJson(join(here, "check-vocabulary.exceptions.json"), []);
  if (process.argv.includes("--list")) {
    for (const v of all) console.log(`${relative(root, v.file)}:${v.line}\t${v.key}\t${v.message}`);
    process.exit(0);
  }
  const { failing, excepted, unusedExceptions } = classify(all, exceptions);
  for (const v of failing) console.error(`${relative(root, v.file)}:${v.line}: ${v.message} [${v.key}]`);
  for (const e of unusedExceptions) console.error(`check:vocabulary: exception \`${e.pattern}\` matches nothing; remove it`);
  if (failing.length || unusedExceptions.length) {
    console.error(`check:vocabulary: ${failing.length} violation(s), ${unusedExceptions.length} unused exception(s).`);
    process.exit(1);
  }
  console.log(`check:vocabulary: clean (${excepted.length} excepted).`);
}
